import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb, withTransaction } from "../db/client.mjs";
import { getMeeting, listMeetings } from "../lib/transcriptApiClient.mjs";
import { normalizeClientName } from "../lib/normalize.mjs";
import { extractFacts } from "./extract.mjs";
import type { Meeting } from "../lib/types.mjs";

const triggerArg = process.argv.find((a) => a.startsWith("--trigger="));
const triggerType = triggerArg ? triggerArg.split("=")[1] : "manual";

function contentHash(meeting: Meeting): string {
  return createHash("sha256").update(JSON.stringify(meeting)).digest("hex");
}

function resolveClientId(db: DatabaseSync, canonicalName: string): string {
  const normalized = normalizeClientName(canonicalName);
  const existing = db
    .prepare("SELECT client_id FROM clients WHERE normalized_name = ?")
    .get(normalized) as { client_id: string } | undefined;
  if (existing) return existing.client_id;

  const client_id = randomUUID();
  db.prepare(
    "INSERT INTO clients (client_id, canonical_name, normalized_name) VALUES (?, ?, ?)",
  ).run(client_id, canonicalName, normalized);
  return client_id;
}

/** Stores the landing copy of a fetched meeting, independent of whether
 * extraction later succeeds — DESIGN.md §4.1 step 4b happens before (c)
 * extraction precisely so a failed extraction still leaves durable, audit-
 * able proof of what the API returned, and so meetings_processed can always
 * find a landing row to (informally) relate to. No-ops on conflict rather than
 * overwriting: relies on the meeting-content-is-immutable-per-id assumption
 * (DESIGN.md §8 item 5) — a real transcript API/contract would presumably
 * guarantee a meeting_id's content never changes upstream, so a repeat land of
 * an already-known meeting_id is expected to be identical content, always.
 *
 * Returns true if that assumption is ever violated (existing payload differs
 * from what was just fetched). Deliberately does NOT throw or write any
 * meetings_processed row for this case — since this is a mock scenario built
 * on the assumption that the API will never actually push new content for an
 * existing meeting_id, treating it as a normal per-meeting failure (with its
 * own retry-queue/status bookkeeping) would overbuild for something that, by
 * that assumption, should be unreachable. The one thing kept regardless is
 * the console.error below: a tripwire so a genuine break in the assumed
 * contract doesn't pass by completely silently, even though the pipeline
 * otherwise just no-ops and moves on. */
function storeMeetingLanding(db: DatabaseSync, meeting: Meeting): boolean {
  const serialized = JSON.stringify(meeting);
  const existing = db
    .prepare("SELECT raw_payload FROM meetings WHERE meeting_id = ?")
    .get(meeting.id) as { raw_payload: string } | undefined;

  const contentChanged = existing !== undefined && existing.raw_payload !== serialized;
  if (contentChanged) {
    console.error(
      `[ingest] ANOMALY: meeting ${meeting.id} was re-fetched with different content than ` +
        `what's already landed — this violates the meeting-content-is-immutable-per-id ` +
        `assumption (DESIGN.md §8 item 5). Keeping the original payload and skipping ` +
        `extraction for this meeting this run; not treated as a per-meeting failure since ` +
        `this is expected to never happen under that assumption.`,
    );
  }

  db.prepare(
    `INSERT INTO meetings (meeting_id, raw_payload, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(meeting_id) DO NOTHING`,
  ).run(meeting.id, serialized, new Date().toISOString());

  return contentChanged;
}

/** Writes one meeting's resolved facts + processed-checkpoint row in a single
 * synchronous transaction (DESIGN.md §4.1 step 4f). The async LLM call already
 * happened before this is invoked, since node:sqlite transactions must be
 * synchronous. Assumes storeMeetingLanding() already ran for this meeting. */
function writeMeetingResult(
  db: DatabaseSync,
  args: {
    meeting: Meeting;
    hash: string;
    runId: string;
    clientId: string;
    facts: { fact_key: string; value: unknown; quote: string }[];
  },
) {
  const { meeting, hash, runId, clientId, facts } = args;
  const now = new Date().toISOString();

  withTransaction(db, () => {
    for (const fact of facts) {
      const current = db
        .prepare(
          "SELECT version_id, value FROM fact_versions WHERE client_id = ? AND fact_key = ? AND valid_to IS NULL",
        )
        .get(clientId, fact.fact_key) as { version_id: number; value: string } | undefined;

      const serializedValue = JSON.stringify(fact.value);
      if (current && current.value === serializedValue) {
        continue; // unchanged — don't inflate history with a no-op version
      }

      if (current) {
        db.prepare(
          "UPDATE fact_versions SET valid_to = ? WHERE version_id = ?",
        ).run(now, current.version_id);
      }

      db.prepare(
        `INSERT INTO fact_versions
           (client_id, fact_key, value, source_meeting_id, source_excerpt, ingestion_run_id, valid_from, valid_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(clientId, fact.fact_key, serializedValue, meeting.id, fact.quote, runId, now);
    }

    db.prepare(
      `INSERT INTO meetings_processed (meeting_id, content_hash, status, error_message, ingestion_run_id, processed_at)
       VALUES (?, ?, 'success', NULL, ?, ?)
       ON CONFLICT(meeting_id) DO UPDATE SET
         content_hash = excluded.content_hash, status = 'success', error_message = NULL,
         ingestion_run_id = excluded.ingestion_run_id, processed_at = excluded.processed_at`,
    ).run(meeting.id, hash, runId, now);
  });
}

function markMeetingFailed(
  db: DatabaseSync,
  meetingId: string,
  hash: string,
  runId: string,
  errorMessage: string,
) {
  db.prepare(
    `INSERT INTO meetings_processed (meeting_id, content_hash, status, error_message, ingestion_run_id, processed_at)
     VALUES (?, ?, 'failed', ?, ?, ?)
     ON CONFLICT(meeting_id) DO UPDATE SET
       content_hash = excluded.content_hash, status = 'failed', error_message = excluded.error_message,
       ingestion_run_id = excluded.ingestion_run_id, processed_at = excluded.processed_at`,
  ).run(meetingId, hash, errorMessage, runId, new Date().toISOString());
}

async function main() {
  const db = getDb();

  const inFlight = db
    .prepare("SELECT run_id FROM ingestion_runs WHERE status = 'running'")
    .get();
  if (inFlight) {
    console.log("[ingest] another run is already in progress, exiting");
    return;
  }

  const runId = randomUUID();
  db.prepare(
    "INSERT INTO ingestion_runs (run_id, trigger_type, status) VALUES (?, ?, 'running')",
  ).run(runId, triggerType);

  const priorWatermarkRow = db
    .prepare(
      "SELECT MAX(watermark) as watermark FROM ingestion_runs WHERE status IN ('succeeded','partial') AND run_id != ?",
    )
    .get(runId) as { watermark: string | null };
  const priorWatermark = priorWatermarkRow.watermark;

  let meetingList;
  try {
    meetingList = await listMeetings(priorWatermark ? { updatedAfter: priorWatermark } : {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      "UPDATE ingestion_runs SET status = 'failed', completed_at = ?, error_message = ? WHERE run_id = ?",
    ).run(new Date().toISOString(), message, runId);
    console.error(`[ingest] could not reach transcript API, run failed: ${message}`);
    return;
  }

  const failedRetryIds = (
    db
      .prepare("SELECT meeting_id FROM meetings_processed WHERE status = 'failed'")
      .all() as { meeting_id: string }[]
  ).map((r) => r.meeting_id);

  const candidateIds = Array.from(
    new Set([...meetingList.map((m) => m.id), ...failedRetryIds]),
  );

  let succeeded = 0;
  let failed = 0;

  // Fetch every candidate first, then process in chronological order by
  // meeting.created_at (when the meeting actually happened) — NOT API list
  // order, which api.md explicitly says is unordered ("fixture order").
  // Facts are "supersede current, write new" (last write wins), so processing
  // order determines the stored "current" value: processing out of order can
  // let an earlier real-world statement overwrite a later correction. Sorting
  // here is what makes "last write" mean "most recent real-world statement."
  // (created_at, not updated_at — updated_at drives the watermark/polling
  // logic above and answers "did this record change," a different question
  // from "when did the meeting happen.")
  const fetchedMeetings: Meeting[] = [];
  for (const meetingId of candidateIds) {
    try {
      fetchedMeetings.push(await getMeeting(meetingId));
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] failed to fetch ${meetingId}: ${message}`);
      // no content to hash if the fetch itself failed; use a placeholder so a
      // later successful fetch always looks "changed" and gets reprocessed.
      markMeetingFailed(db, meetingId, "fetch-failed", runId, message);
    }
  }
  fetchedMeetings.sort((a, b) => a.created_at.localeCompare(b.created_at));

  for (const meeting of fetchedMeetings) {
    const meetingId = meeting.id;
    const hash = contentHash(meeting);
    const already = db
      .prepare("SELECT status, content_hash FROM meetings_processed WHERE meeting_id = ?")
      .get(meetingId) as { status: string; content_hash: string } | undefined;
    if (already?.status === "success" && already.content_hash === hash) {
      continue; // unchanged since last successful ingest
    }

    const contentChanged = storeMeetingLanding(db, meeting);
    if (contentChanged) {
      continue; // logged inside storeMeetingLanding; skip extraction, not tracked as a failure
    }

    try {
      const extraction = await extractFacts(meeting);
      const clientId = resolveClientId(db, extraction.clientName);
      writeMeetingResult(db, {
        meeting,
        hash,
        runId,
        clientId,
        facts: extraction.facts,
      });
      succeeded++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] failed to process ${meetingId}: ${message}`);
      markMeetingFailed(db, meetingId, hash, runId, message);
    }
  }

  const newWatermark =
    meetingList.length > 0
      ? meetingList.reduce((max, m) => (m.updated_at > max ? m.updated_at : max), meetingList[0].updated_at)
      : priorWatermark;

  const status = failed === 0 ? "succeeded" : succeeded > 0 ? "partial" : "failed";
  db.prepare(
    "UPDATE ingestion_runs SET status = ?, completed_at = ?, watermark = ? WHERE run_id = ?",
  ).run(status, new Date().toISOString(), newWatermark, runId);

  console.log(
    `[ingest] run ${runId} (${triggerType}) ${status}: ${succeeded} succeeded, ${failed} failed, watermark=${newWatermark ?? "none"}`,
  );
}

main().catch((err) => {
  console.error("[ingest] unexpected error", err);
  process.exitCode = 1;
});
