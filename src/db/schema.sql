-- Client Context Store schema (SQLite, WAL mode). Mirrors DESIGN.md §4.3.
-- Idempotent: safe to run on every startup.

CREATE TABLE IF NOT EXISTS fact_definitions (
  fact_key        TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  description     TEXT NOT NULL,
  data_type       TEXT NOT NULL,      -- 'number' | 'string' | 'date' | 'money' | 'plan_list'
  extraction_hint TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS clients (
  client_id       TEXT PRIMARY KEY,
  canonical_name  TEXT NOT NULL,
  normalized_name TEXT UNIQUE NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS meetings (
  meeting_id  TEXT PRIMARY KEY,
  raw_payload TEXT NOT NULL,
  fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  run_id       TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,        -- 'cron' | 'manual' | 'demo'
  status       TEXT NOT NULL,        -- 'running' | 'succeeded' | 'partial' | 'failed'
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  watermark    TEXT,
  error_message TEXT
);

-- No FK to meetings(meeting_id): this table must also be able to record a
-- failed *fetch* attempt (meeting_id known from the list response, but no
-- payload ever landed), so it can't require a landing row to already exist.
CREATE TABLE IF NOT EXISTS meetings_processed (
  meeting_id       TEXT PRIMARY KEY,
  content_hash     TEXT NOT NULL,
  status           TEXT NOT NULL,    -- 'success' | 'failed'
  error_message    TEXT,
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  processed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS fact_versions (
  version_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id         TEXT NOT NULL REFERENCES clients(client_id),
  fact_key          TEXT NOT NULL REFERENCES fact_definitions(fact_key),
  value             TEXT NOT NULL,   -- JSON-encoded
  source_meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id),
  source_excerpt    TEXT,
  ingestion_run_id  TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  valid_from        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  valid_to          TEXT              -- NULL = currently active
);

CREATE UNIQUE INDEX IF NOT EXISTS one_current_fact
  ON fact_versions (client_id, fact_key)
  WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS fact_versions_client_idx ON fact_versions (client_id);
