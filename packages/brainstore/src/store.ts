/**
 * The query surface over the index — implements core's RecallStore, plus
 * the reads brain.timeline / brain.trace need (§5.10) and the salience
 * write recall triggers (§5.5).
 */

import type { Database } from "bun:sqlite";
import type { Confidence, EdgeRecord, EpisodeRef, NodeType, Provenance } from "@brain/contracts";
import type { GraphNode, GraphSlice, PinInfo, RecallStore } from "@brain/core";
import { toFtsQuery } from "@brain/core";
import { type CalibrationInfo, readCalibration } from "./calibration.ts";

interface NodeRow {
  id: string;
  type: string;
  title: string;
  created: string;
  updated: string;
  status: string;
  confidence: string;
  provenance: string;
  summary: string;
}

export class BrainStore implements RecallStore {
  constructor(readonly db: Database) {}

  seedSearch(query: string, k: number, types?: NodeType[]): Array<{ id: string; raw: number }> {
    const match = toFtsQuery(query);
    if (!match) return [];
    const typeFilter = types?.length ? ` AND n.type IN (${types.map(() => "?").join(", ")})` : "";
    const sql = `
      SELECT f.id AS id, -bm25(nodes_fts) AS raw
      FROM nodes_fts f JOIN nodes n ON n.id = f.id
      WHERE nodes_fts MATCH ?${typeFilter}
      ORDER BY raw DESC, id ASC
      LIMIT ?`;
    const args = [match, ...(types ?? []), k];
    try {
      return this.db.query(sql).all(...(args as [string, ...string[], number])) as Array<{
        id: string;
        raw: number;
      }>;
    } catch {
      // A query of only FTS5 stopword-ish tokens can still throw on syntax;
      // treat as no match rather than erroring recall.
      return [];
    }
  }

  loadGraph(): GraphSlice {
    const nodes = new Map<string, GraphNode>();
    for (const r of this.db
      .query(
        "SELECT id, type, title, created, updated, status, confidence, provenance, summary FROM nodes ORDER BY id",
      )
      .all() as NodeRow[]) {
      nodes.set(r.id, {
        id: r.id,
        type: r.type as NodeType,
        title: r.title,
        created: r.created,
        updated: r.updated,
        status: r.status as GraphNode["status"],
        confidence: r.confidence as Confidence,
        provenance: r.provenance as Provenance,
        summary: r.summary,
      });
    }
    const edges = (
      this.db
        .query("SELECT from_id, rel, to_id FROM edges ORDER BY from_id, rel, to_id")
        .all() as Array<{ from_id: string; rel: EdgeRecord["rel"]; to_id: string }>
    ).map((e) => ({ from: e.from_id, rel: e.rel, to: e.to_id }));
    const salience = new Map<string, number>();
    for (const r of this.db.query("SELECT node_id, value FROM salience").all() as Array<{
      node_id: string;
      value: number;
    }>) {
      salience.set(r.node_id, r.value);
    }
    const pins: PinInfo[] = (
      this.db.query("SELECT pin_id, node_id, correction FROM pins ORDER BY pin_id").all() as Array<{
        pin_id: string;
        node_id: string;
        correction: string;
      }>
    ).map((p) => ({ pinId: p.pin_id, nodeId: p.node_id, correction: p.correction }));
    return { nodes, edges, salience, pins };
  }

  /** The stored noise floor (§5.5), written by rebuild. Null on a pre-calibration index. */
  calibration(): CalibrationInfo | null {
    return readCalibration(this.db);
  }

  /** One line per node, for the abstention catalog fallback (§5.5). */
  catalogEntries(): Array<{ id: string; type: string; title: string }> {
    return this.db
      .query("SELECT id, type, title FROM nodes ORDER BY id")
      .all() as Array<{ id: string; type: string; title: string }>;
  }

  getBodies(ids: string[]): Map<string, string> {
    if (!ids.length) return new Map();
    const rows = this.db
      .query(`SELECT id, body FROM nodes WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .all(...ids) as Array<{ id: string; body: string }>;
    return new Map(rows.map((r) => [r.id, r.body]));
  }

  /** Bump salience for full-tier renders (§5.5). Decay happens at lint (§5.9). */
  bumpSalience(ids: string[], nowIso: string): void {
    if (!ids.length) return;
    const q = this.db.query(
      `INSERT INTO salience (node_id, value, updated_at) VALUES (?, 2.0, ?)
       ON CONFLICT (node_id) DO UPDATE SET value = value + 1.0, updated_at = excluded.updated_at`,
    );
    const tx = this.db.transaction(() => {
      for (const id of ids) q.run(id, nowIso);
    });
    tx();
  }

  edgesTouching(id: string): EdgeRecord[] {
    return (
      this.db
        .query(
          "SELECT from_id, rel, to_id FROM edges WHERE from_id = ? OR to_id = ? ORDER BY from_id, rel, to_id",
        )
        .all(id, id) as Array<{ from_id: string; rel: EdgeRecord["rel"]; to_id: string }>
    ).map((e) => ({ from: e.from_id, rel: e.rel, to: e.to_id }));
  }

  episodes(filter: { from?: string; to?: string; basenames?: string[] } = {}): EpisodeRef[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.from) {
      clauses.push("started_at >= ?");
      args.push(filter.from);
    }
    if (filter.to) {
      clauses.push("started_at <= ?");
      args.push(`${filter.to}T23:59:59Z`);
    }
    if (filter.basenames?.length) {
      clauses.push(`basename IN (${filter.basenames.map(() => "?").join(", ")})`);
      args.push(...filter.basenames);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.db
        .query(
          `SELECT episode_id, basename, started_at, ended_at, surface, harness, labels_json
           FROM episodes${where} ORDER BY started_at ASC, basename ASC`,
        )
        .all(...args) as Array<{
        episode_id: string | null;
        basename: string;
        started_at: string | null;
        ended_at: string | null;
        surface: string | null;
        harness: string | null;
        labels_json: string;
      }>
    ).map((r) => ({
      episode_id: r.episode_id ?? r.basename,
      started_at: r.started_at ?? "",
      ended_at: r.ended_at ?? "",
      surface: r.surface ?? "",
      harness: r.harness ?? "",
      labels: JSON.parse(r.labels_json) as string[],
    }));
  }

  /** id/title/type/aliases for every node — the resolution working set (§5.7). */
  nodeRefs(): Array<{ id: string; title: string; type: NodeType; aliases: string[] }> {
    return (
      this.db.query("SELECT id, title, type, aliases_json FROM nodes ORDER BY id").all() as Array<{
        id: string;
        title: string;
        type: string;
        aliases_json: string;
      }>
    ).map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type as NodeType,
      aliases: JSON.parse(r.aliases_json) as string[],
    }));
  }

  /** Vault-relative file path of a node. */
  nodeFile(id: string): string | null {
    const row = this.db.query("SELECT file_path FROM nodes WHERE id = ?").get(id) as {
      file_path: string;
    } | null;
    return row?.file_path ?? null;
  }

  nodeSources(id: string): string[] {
    const row = this.db.query("SELECT sources_json FROM nodes WHERE id = ?").get(id) as {
      sources_json: string;
    } | null;
    if (!row) return [];
    return (JSON.parse(row.sources_json) as string[])
      .map((l) => l.replace(/^\[\[/, "").replace(/\]\]$/, ""))
      .filter(Boolean);
  }

  counts(): { nodes: number; edges: number; episodes: number; pins: number } {
    const one = (sql: string) => (this.db.query(sql).get() as { c: number }).c;
    return {
      nodes: one("SELECT COUNT(*) AS c FROM nodes"),
      edges: one("SELECT COUNT(*) AS c FROM edges"),
      episodes: one("SELECT COUNT(*) AS c FROM episodes"),
      pins: one("SELECT COUNT(*) AS c FROM pins"),
    };
  }
}
