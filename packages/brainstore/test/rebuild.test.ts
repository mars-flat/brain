/**
 * Rebuild invariants (§8.3): semantic equivalence, not byte equality —
 * identical node/edge/alias/episode content and identical pack output for
 * sample queries across independent rebuilds. Plus basename uniqueness as
 * a hard error, and salience surviving a rebuild.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall } from "@brain/core";
import { BrainStore, loadVault, openDb, RebuildError, rebuild, renderNote } from "../src/index.ts";

const EXAMPLE = join(import.meta.dir, "..", "..", "..", "examples", "vault-example");
const NOW = new Date("2026-08-25T12:00:00Z");

function dump(db: Database, table: string, orderBy: string): unknown[] {
  return db.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
}

describe("rebuild", () => {
  test("example vault loads clean and indexes fully", () => {
    const vault = loadVault(EXAMPLE);
    expect(vault.errors).toEqual([]);
    const db = openDb(":memory:");
    const report = rebuild(db, vault);
    const store = new BrainStore(db);
    expect(report.nodes).toBe(vault.nodes.length);
    expect(report.episodes).toBe(vault.episodes.length);
    expect(report.danglingEdges).toEqual([]);
    expect(store.counts().nodes).toBe(report.nodes);
    expect(store.counts().edges).toBe(report.edges);
  });

  test("two independent rebuilds are semantically equivalent — tables and packs", () => {
    const vault = loadVault(EXAMPLE);
    const db1 = openDb(":memory:");
    const db2 = openDb(":memory:");
    rebuild(db1, vault);
    rebuild(db2, vault);
    for (const [table, order] of [
      ["nodes", "id"],
      ["edges", "from_id, rel, to_id"],
      ["aliases", "alias, node_id"],
      ["episodes", "basename"],
      ["pins", "pin_id"],
    ] as const) {
      expect(dump(db2, table, order)).toEqual(dump(db1, table, order));
    }
    const s1 = new BrainStore(db1);
    const s2 = new BrainStore(db2);
    for (const query of [
      "jquery prototype ui",
      "backup strategy after the disk died",
      "when did boris get fed",
    ]) {
      const r1 = recall(s1, { query }, NOW);
      const r2 = recall(s2, { query }, NOW);
      expect(r2.result.pack).toBe(r1.result.pack);
    }
  });

  test("salience survives a rebuild; rows for deleted nodes are dropped", () => {
    const vault = loadVault(EXAMPLE);
    const db = openDb(":memory:");
    rebuild(db, vault);
    const store = new BrainStore(db);
    store.bumpSalience(["home-lab"], "2026-08-25T12:00:00Z");
    store.bumpSalience(["home-lab"], "2026-08-25T12:01:00Z");
    const before = store.loadGraph().salience.get("home-lab");
    expect(before).toBe(3);
    rebuild(db, vault);
    expect(store.loadGraph().salience.get("home-lab")).toBe(3);
    const orphans = db
      .query("SELECT COUNT(*) AS c FROM salience WHERE node_id NOT IN (SELECT id FROM nodes)")
      .get() as { c: number };
    expect(orphans.c).toBe(0);
  });

  test("basename collision across type folders is a hard error (§5.2)", () => {
    const root = mkdtempSync(join(tmpdir(), "brain-collision-"));
    try {
      const note = (type: "concept" | "decision") =>
        renderNote(
          {
            id: "duplicate-name",
            type,
            title: "Same basename twice",
            created: "2026-01-01",
            updated: "2026-01-01",
            status: "active",
            summary: "Collides on purpose.",
          },
          "",
        );
      mkdirSync(join(root, "nodes", "concept"), { recursive: true });
      mkdirSync(join(root, "nodes", "decision"), { recursive: true });
      writeFileSync(join(root, "nodes", "concept", "duplicate-name.md"), note("concept"));
      writeFileSync(join(root, "nodes", "decision", "duplicate-name.md"), note("decision"));
      const vault = loadVault(root);
      expect(vault.errors.length).toBe(1);
      expect(vault.errors[0]?.message).toContain("collision");
      expect(() => rebuild(openDb(":memory:"), vault)).toThrow(RebuildError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("id != basename is a hard error", () => {
    const root = mkdtempSync(join(tmpdir(), "brain-idmismatch-"));
    try {
      mkdirSync(join(root, "nodes", "concept"), { recursive: true });
      writeFileSync(
        join(root, "nodes", "concept", "actual-name.md"),
        renderNote(
          {
            id: "different-name",
            type: "concept",
            title: "Mismatch",
            created: "2026-01-01",
            updated: "2026-01-01",
            status: "active",
            summary: "Id and basename disagree.",
          },
          "",
        ),
      );
      const vault = loadVault(root);
      expect(vault.errors.length).toBe(1);
      expect(vault.errors[0]?.message).toContain("basename");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
