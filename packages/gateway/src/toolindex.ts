/**
 * Tool index (§4.2 box 4, §4.4): the same FTS5 BM25 the brain uses, over
 * tool names + descriptions + parameter names. Rebuilt from the pool's
 * catalog at startup. Lives in the gateway's own SQLite file alongside
 * confirm tokens.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { toFtsQuery } from "@brain/core";
import type { UpstreamTool } from "./pool.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tools (
  urn          TEXT PRIMARY KEY,
  server       TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  input_schema TEXT NOT NULL,
  kind         TEXT NOT NULL
) WITHOUT ROWID;

CREATE VIRTUAL TABLE IF NOT EXISTS tools_fts USING fts5(
  urn UNINDEXED, name, description, params,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS confirm_tokens (
  token       TEXT PRIMARY KEY,
  urn         TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  expires     INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
`;

export function openGatewayDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

function paramNames(schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  return Object.keys(props).join(" ");
}

export function rebuildToolIndex(db: Database, catalog: UpstreamTool[]): void {
  const tx = db.transaction(() => {
    db.exec("DELETE FROM tools; DELETE FROM tools_fts;");
    const insTool = db.query(
      "INSERT INTO tools (urn, server, name, description, input_schema, kind) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insFts = db.query(
      "INSERT INTO tools_fts (urn, name, description, params) VALUES (?, ?, ?, ?)",
    );
    for (const t of catalog) {
      insTool.run(t.urn, t.server, t.name, t.description, JSON.stringify(t.inputSchema), t.kind);
      insFts.run(t.urn, t.name.replace(/[_-]/g, " "), t.description, paramNames(t.inputSchema));
    }
  });
  tx();
}

export interface IndexedTool {
  urn: string;
  server: string;
  name: string;
  description: string;
  kind: string;
  raw: number;
}

export function searchTools(db: Database, query: string, k: number, kind?: string): IndexedTool[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  const kindFilter = kind ? " AND t.kind = ?" : "";
  const args: Array<string | number> = kind ? [match, kind, k] : [match, k];
  try {
    return db
      .query(
        `SELECT t.urn, t.server, t.name, t.description, t.kind, -bm25(tools_fts) AS raw
         FROM tools_fts f JOIN tools t ON t.urn = f.urn
         WHERE tools_fts MATCH ?${kindFilter}
         ORDER BY raw DESC, t.urn ASC LIMIT ?`,
      )
      .all(...args) as IndexedTool[];
  } catch {
    return [];
  }
}
