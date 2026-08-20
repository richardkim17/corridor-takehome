import "dotenv/config";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb } from "../db/client.mjs";
import { normalizeClientName } from "../lib/normalize.mjs";
import { FACT_KEYS } from "../config/facts.mjs";

const server = new McpServer({
  name: "client-context",
  title: "Corridor Client Context",
  version: "0.1.0",
});

interface FactRow {
  fact_key: string;
  value: string;
  valid_from: string;
  source_meeting_id: string;
  source_excerpt: string | null;
  display_name: string;
  data_type: string;
  meeting_date: string | null;
  version_count: number;
  prev_value: string | null;
}

const FACTS_QUERY = `
  WITH stats AS (
    SELECT fact_key, COUNT(*) AS version_count
    FROM fact_versions WHERE client_id = @clientId GROUP BY fact_key
  ),
  prev AS (
    SELECT fact_key, value AS prev_value, MAX(version_id) AS prev_version_id
    FROM fact_versions
    WHERE client_id = @clientId AND valid_to IS NOT NULL
    GROUP BY fact_key
  )
  SELECT
    fv.fact_key, fv.value, fv.valid_from, fv.source_meeting_id, fv.source_excerpt,
    fd.display_name, fd.data_type,
    json_extract(m.raw_payload, '$.created_at') AS meeting_date,
    stats.version_count, prev.prev_value
  FROM fact_versions fv
  JOIN fact_definitions fd ON fd.fact_key = fv.fact_key
  JOIN meetings m ON m.meeting_id = fv.source_meeting_id
  LEFT JOIN stats ON stats.fact_key = fv.fact_key
  LEFT JOIN prev ON prev.fact_key = fv.fact_key
  WHERE fv.client_id = @clientId AND fv.valid_to IS NULL
  ORDER BY fv.fact_key
`;

function toolError(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

server.registerTool(
  "get_client_context",
  {
    title: "Corridor Client Context",
    description:
      "Look up the current structured facts known about a client's benefits. When asked " +
      "to look up or summarize a client, present just the current facts and values by " +
      "default — don't proactively surface provenance, update dates, or revision " +
      "history unless the question specifically asks for it (e.g. 'when was this " +
      "updated', 'has this changed', 'where did this come from'). The response " +
      "includes that detail for when it's needed: each fact's 'as_of' is the full " +
      "timestamp (date and time) it was actually confirmed in a meeting — use it to " +
      "answer 'when was this last updated' for that fact, and include the time, not " +
      "just the date, since more than one update can land on the same day — round to " +
      "the minute (e.g. 'May 20, 2026 at 7:00 PM'), seconds aren't meaningful here. " +
      "If asked when the client's data as a whole was last " +
      "updated (not one specific fact), use the most recent 'as_of' across facts, but " +
      "phrase it as when the most recent change happened — e.g. 'the most recent " +
      "update was on the 21st, to the budget and incumbent pricing' — never imply " +
      "every fact was confirmed on that date. 'version' counts how many " +
      "times the value has actually been revised (unchanged restatements don't count); " +
      "'previous_value' is what it was before the most recent revision; 'source' gives " +
      "the originating meeting and a short supporting quote. Read-only; always reads " +
      "the database directly, never a cached copy. 'context_fingerprint' changes iff " +
      "anything about this client changed — useful for comparing across calls to " +
      "detect a change; it is not a date and should not be read as one.",
    inputSchema: { client: z.string().min(1, "client must not be empty") },
  },
  async ({ client }) => {
    const db = getDb();
    const normalized = normalizeClientName(client);

    const clientRow = db
      .prepare("SELECT client_id, canonical_name FROM clients WHERE client_id = ? OR normalized_name = ?")
      .get(client, normalized) as { client_id: string; canonical_name: string } | undefined;

    if (!clientRow) {
      return toolError(`not_found: no client matching "${client}"`);
    }

    const rows = db
      .prepare(FACTS_QUERY)
      .all({ clientId: clientRow.client_id }) as unknown as FactRow[];

    const facts = rows.map((r) => ({
      key: r.fact_key,
      display_name: r.display_name,
      value: JSON.parse(r.value),
      as_of: r.meeting_date,
      version: r.version_count,
      previous_value: r.prev_value ? JSON.parse(r.prev_value) : null,
      source: {
        meeting_id: r.source_meeting_id,
        excerpt: r.source_excerpt,
      },
    }));

    const contextFingerprint = createHash("sha256")
      .update(rows.map((r) => `${r.fact_key}:${r.valid_from}`).sort().join("|"))
      .digest("hex")
      .slice(0, 16);

    const result = {
      client_id: clientRow.client_id,
      client_name: clientRow.canonical_name,
      context_fingerprint: contextFingerprint,
      facts,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

interface HistoryRow {
  value: string;
  valid_to: string | null;
  source_meeting_id: string;
  source_excerpt: string | null;
  meeting_date: string | null;
}

const HISTORY_QUERY = `
  SELECT
    fv.value, fv.valid_to, fv.source_meeting_id, fv.source_excerpt,
    json_extract(m.raw_payload, '$.created_at') AS meeting_date
  FROM fact_versions fv
  JOIN meetings m ON m.meeting_id = fv.source_meeting_id
  WHERE fv.client_id = @clientId AND fv.fact_key = @factKey
  ORDER BY fv.version_id ASC
`;

server.registerTool(
  "get_fact_history",
  {
    title: "Corridor Fact History",
    description:
      "Look up the full change history of one specific fact for a client — every value " +
      "it has ever had, in chronological order, each with the meeting it came from and " +
      "a supporting quote. Use this for audit/history questions ('how has X changed " +
      "over time', 'what was the employee count before this'); get_client_context only " +
      "returns the current value plus one step back, not the full chain. Each entry's " +
      "'as_of' is a full timestamp, not just a date — include the time (rounded to the " +
      "minute; seconds aren't meaningful) when describing entries, since more than one " +
      "entry can land on the same day and the time is what distinguishes them. " +
      "Read-only; always reads the database directly, never a cached copy.",
    inputSchema: {
      client: z.string().min(1, "client must not be empty"),
      fact_key: z.string().min(1, "fact_key must not be empty"),
    },
  },
  async ({ client, fact_key }) => {
    const db = getDb();
    const normalized = normalizeClientName(client);

    const clientRow = db
      .prepare("SELECT client_id, canonical_name FROM clients WHERE client_id = ? OR normalized_name = ?")
      .get(client, normalized) as { client_id: string; canonical_name: string } | undefined;

    if (!clientRow) {
      return toolError(`not_found: no client matching "${client}"`);
    }

    if (!FACT_KEYS.includes(fact_key)) {
      return toolError(
        `invalid_request: unknown fact_key "${fact_key}". Valid keys: ${FACT_KEYS.join(", ")}`,
      );
    }

    const rows = db
      .prepare(HISTORY_QUERY)
      .all({ clientId: clientRow.client_id, factKey: fact_key }) as unknown as HistoryRow[];

    const history = rows.map((r) => ({
      value: JSON.parse(r.value),
      as_of: r.meeting_date,
      is_current: r.valid_to === null,
      source: {
        meeting_id: r.source_meeting_id,
        excerpt: r.source_excerpt,
      },
    }));

    const result = {
      client_id: clientRow.client_id,
      client_name: clientRow.canonical_name,
      fact_key,
      history,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp] client-context server ready on stdio");
