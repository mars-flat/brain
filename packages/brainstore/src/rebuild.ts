/**
 * `brain rebuild` (§5.11): vault markdown → derived SQLite index, in one
 * transaction. Refuses on hard errors (invalid nodes, basename collisions).
 * Salience survives — it exists nowhere else (see db.ts).
 */

import type { Database } from "bun:sqlite";
import { EDGE_RELATIONS, wikilinkTarget } from "@brain/contracts";
import type { LoadedVault } from "./vault.ts";

export interface RebuildReport {
  nodes: number;
  edges: number;
  episodes: number;
  pins: number;
  aliases: number;
  danglingEdges: Array<{ from: string; rel: string; to: string }>;
  warnings: string[];
}

export class RebuildError extends Error {
  constructor(readonly problems: Array<{ filePath: string; message: string }>) {
    super(
      `vault has ${problems.length} hard error(s):\n${problems
        .map((p) => `  ${p.filePath}: ${p.message}`)
        .join("\n")}`,
    );
  }
}

export function rebuild(db: Database, vault: LoadedVault): RebuildReport {
  if (vault.errors.length) throw new RebuildError(vault.errors);

  const report: RebuildReport = {
    nodes: 0,
    edges: 0,
    episodes: 0,
    pins: 0,
    aliases: 0,
    danglingEdges: [],
    warnings: vault.warnings.map((w) => `${w.filePath}: ${w.message}`),
  };

  const nodeIds = new Set(vault.nodes.map((n) => n.fm.id));
  const episodeIds = new Set(vault.episodes.map((e) => e.basename));

  const tx = db.transaction(() => {
    for (const table of ["nodes", "edges", "aliases", "episodes", "pins", "nodes_fts"]) {
      db.exec(`DELETE FROM ${table};`);
    }

    const insNode = db.query(
      `INSERT INTO nodes (id, type, title, created, updated, status, confidence, provenance,
         summary, body, file_path, aliases_json, tags_json, sources_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insFts = db.query(
      "INSERT INTO nodes_fts (id, title, aliases, tags, summary) VALUES (?, ?, ?, ?, ?)",
    );
    const insEdge = db.query(
      "INSERT OR IGNORE INTO edges (from_id, rel, to_id) VALUES (?, ?, ?)",
    );
    const insAlias = db.query("INSERT OR IGNORE INTO aliases (alias, node_id) VALUES (?, ?)");
    const insEpisode = db.query(
      `INSERT INTO episodes (episode_id, basename, started_at, ended_at, surface, harness, trust,
         labels_json, file_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insPin = db.query(
      "INSERT INTO pins (pin_id, node_id, correction, reason, created) VALUES (?, ?, ?, ?, ?)",
    );
    const insSalience = db.query(
      "INSERT OR IGNORE INTO salience (node_id, value, updated_at) VALUES (?, 1.0, ?)",
    );

    for (const n of [...vault.nodes].sort((a, b) => a.fm.id.localeCompare(b.fm.id))) {
      const fm = n.fm;
      insNode.run(
        fm.id,
        fm.type,
        fm.title,
        fm.created,
        fm.updated,
        fm.status,
        n.confidence,
        n.provenance,
        fm.summary,
        n.body,
        n.filePath,
        JSON.stringify(fm.aliases ?? []),
        JSON.stringify(fm.tags ?? []),
        JSON.stringify(fm.sources ?? []),
      );
      insFts.run(
        fm.id,
        fm.title,
        (fm.aliases ?? []).join(" "),
        (fm.tags ?? []).join(" "),
        fm.summary,
      );
      report.nodes++;

      for (const alias of fm.aliases ?? []) {
        insAlias.run(alias.toLowerCase(), fm.id);
        report.aliases++;
      }

      const addEdge = (rel: string, target: string) => {
        insEdge.run(fm.id, rel, target);
        report.edges++;
        if (!nodeIds.has(target) && !episodeIds.has(target)) {
          report.danglingEdges.push({ from: fm.id, rel, to: target });
        }
      };
      for (const rel of EDGE_RELATIONS) {
        for (const link of fm[rel] ?? []) {
          const target = wikilinkTarget(link);
          if (target) addEdge(rel, target);
        }
      }
      // sources: is the canonical provenance notation — materialize as
      // derived_from edges (§5.3).
      for (const link of fm.sources ?? []) {
        const target = wikilinkTarget(link);
        if (target && !(fm.derived_from ?? []).includes(link)) addEdge("derived_from", target);
      }

      insSalience.run(fm.id, `${fm.updated}T00:00:00Z`);
    }

    for (const ep of [...vault.episodes].sort((a, b) => a.basename.localeCompare(b.basename))) {
      insEpisode.run(
        ep.meta.episode_id ?? null,
        ep.basename,
        ep.meta.started_at ?? null,
        ep.meta.ended_at ?? null,
        ep.meta.surface ?? null,
        ep.meta.harness ?? null,
        ep.meta.trust ?? null,
        JSON.stringify(ep.meta.labels ?? []),
        ep.filePath,
      );
      report.episodes++;
    }

    for (const pin of [...vault.pins].sort((a, b) => a.meta.pin_id.localeCompare(b.meta.pin_id))) {
      if (!nodeIds.has(pin.meta.node_id)) {
        report.warnings.push(`${pin.filePath}: pin targets unknown node ${pin.meta.node_id}`);
      }
      insPin.run(pin.meta.pin_id, pin.meta.node_id, pin.correction, pin.meta.reason, pin.meta.created);
      report.pins++;
    }

    // Salience rows for deleted nodes are dropped; survivors keep history.
    db.exec(`DELETE FROM salience WHERE node_id NOT IN (SELECT id FROM nodes);`);
  });
  tx();

  return report;
}
