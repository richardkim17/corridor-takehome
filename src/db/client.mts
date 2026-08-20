import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FACT_DEFINITIONS } from "../config/facts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

let db: DatabaseSync | undefined;

/**
 * Opens (creating if needed) the SQLite database, applies WAL mode + the
 * schema, and seeds fact_definitions from the config. Idempotent — safe to
 * call from both the pipeline and the MCP server on every startup.
 *
 * Uses Node's built-in node:sqlite rather than a native addon (e.g.
 * better-sqlite3) — no compilation step, so there's nothing for a reviewer
 * to fail to build on their machine.
 */
export function getDb(): DatabaseSync {
  if (db) return db;

  const dbPath = process.env.DB_PATH ?? "./data/client_context.db";
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  seedFactDefinitions(db);

  return db;
}

/** node:sqlite's DatabaseSync has no built-in transaction() wrapper (unlike
 * better-sqlite3) — this is the manual BEGIN/COMMIT/ROLLBACK equivalent. */
export function withTransaction<T>(database: DatabaseSync, fn: () => T): T {
  database.exec("BEGIN");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}

function seedFactDefinitions(database: DatabaseSync) {
  const upsert = database.prepare(`
    INSERT INTO fact_definitions (fact_key, display_name, description, data_type, extraction_hint, active)
    VALUES (@fact_key, @display_name, @description, @data_type, @extraction_hint, 1)
    ON CONFLICT(fact_key) DO UPDATE SET
      display_name = excluded.display_name,
      description = excluded.description,
      data_type = excluded.data_type,
      extraction_hint = excluded.extraction_hint
  `);
  withTransaction(database, () => {
    for (const def of FACT_DEFINITIONS) {
      upsert.run({ ...def }); // spread: node:sqlite requires a plain Record, not a typed interface
    }
  });
}
