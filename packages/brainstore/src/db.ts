/**
 * The derived index (§5.11): one SQLite file, bun:sqlite, FTS5 with porter.
 * Gitignored, rebuilt by `brain rebuild`. Not byte-reproducible and not
 * meant to be (§8.3) — equivalence is asserted over content, not bytes.
 */

import { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  created      TEXT NOT NULL,
  updated      TEXT NOT NULL,
  status       TEXT NOT NULL,
  confidence   TEXT NOT NULL,
  provenance   TEXT NOT NULL,
  summary      TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  file_path    TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  tags_json    TEXT NOT NULL DEFAULT '[]',
  sources_json TEXT NOT NULL DEFAULT '[]'
);

-- One row per on-disk edge direction (§5.3); the reverse direction is a
-- query concern, served by the edges_to index. Dangling targets are kept
-- for lint to find.
CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL,
  rel     TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  PRIMARY KEY (from_id, rel, to_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS edges_to ON edges (to_id, rel);

CREATE TABLE IF NOT EXISTS aliases (
  alias   TEXT NOT NULL,
  node_id TEXT NOT NULL,
  PRIMARY KEY (alias, node_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS episodes (
  episode_id  TEXT,
  basename    TEXT PRIMARY KEY,
  started_at  TEXT,
  ended_at    TEXT,
  surface     TEXT,
  harness     TEXT,
  trust       TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  file_path   TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS pins (
  pin_id     TEXT PRIMARY KEY,
  node_id    TEXT NOT NULL,
  correction TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created    TEXT NOT NULL
);

-- Usage counter with decay (§5.5). Lives ONLY here, never in frontmatter
-- (§5.2). Deliberately preserved across rebuilds: the vault can reproduce
-- everything else, but usage history exists nowhere else.
CREATE TABLE IF NOT EXISTS salience (
  node_id    TEXT PRIMARY KEY,
  value      REAL NOT NULL DEFAULT 1.0,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id UNINDEXED,
  title,
  aliases,
  tags,
  summary,
  tokenize = 'porter unicode61'
);
`;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | null;
  if (!row) {
    db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
  } else if (Number(row.value) !== SCHEMA_VERSION) {
    throw new Error(
      `brain.db schema_version ${row.value} != ${SCHEMA_VERSION} — delete the index and run brain rebuild (it is a pure cache, §5.1)`,
    );
  }
  return db;
}
