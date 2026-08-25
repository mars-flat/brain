/**
 * Recall behavior over the real example vault: cold start (§5.6), the
 * cheap as_of filter (§5.10), alias-only seeds, conflicts, and the
 * salience-bump write path (§5.5).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall } from "@brain/core";
import { BrainStore, loadVault, openDb, rebuild, renderNote } from "../src/index.ts";

const EXAMPLE = join(import.meta.dir, "..", "..", "..", "examples", "vault-example");
const NOW = new Date("2026-08-25T12:00:00Z");

let store: BrainStore;

beforeAll(() => {
  const db = openDb(":memory:");
  rebuild(db, loadVault(EXAMPLE));
  store = new BrainStore(db);
});

describe("recall on the example vault", () => {
  test("empty vault → cold_start, no fabricated context (§5.6)", () => {
    const empty = new BrainStore(openDb(":memory:"));
    const out = recall(empty, { query: "anything at all" }, NOW);
    expect(out.result.cold_start).toBe(true);
    expect(out.result.pack).toBe("");
    expect(out.result.nodes).toEqual([]);
  });

  test("thin vault (< 5 nodes) → cold_start", () => {
    const root = mkdtempSync(join(tmpdir(), "brain-thin-"));
    mkdirSync(join(root, "nodes", "concept"), { recursive: true });
    for (const id of ["one-node", "two-node", "three-node"]) {
      writeFileSync(
        join(root, "nodes", "concept", `${id}.md`),
        renderNote(
          {
            id,
            type: "concept",
            title: `The ${id}`,
            created: "2026-01-01",
            updated: "2026-01-01",
            status: "active",
            summary: `About ${id}.`,
          },
          "",
        ),
      );
    }
    const db = openDb(":memory:");
    rebuild(db, loadVault(root));
    const out = recall(new BrainStore(db), { query: "one node" }, NOW);
    expect(out.result.cold_start).toBe(true);
  });

  test("unanswerable query on a rich graph → empty pack, NOT cold_start", () => {
    const out = recall(store, { query: "quantum chromodynamics lattice simulation" }, NOW);
    expect(out.result.cold_start).toBe(false);
    expect(out.result.pack).toBe("");
    expect(out.result.nodes).toEqual([]);
  });

  test("alias-only hit: 'boris' finds the rye starter", () => {
    const out = recall(store, { query: "when did boris get fed" }, NOW);
    expect(out.result.nodes.map((n) => n.id)).toContain("rye-starter-boris");
  });

  test("as_of hides later nodes and their supersedes edges (§5.10)", () => {
    const current = recall(store, { query: "reverse proxy certificates" }, NOW);
    const currentIds = current.result.nodes.map((n) => n.id);
    expect(currentIds).toContain("caddy-reverse-proxy");

    const past = recall(
      store,
      { query: "reverse proxy certificates", as_of: "2025-12-31" },
      NOW,
    );
    const pastIds = past.result.nodes.map((n) => n.id);
    expect(pastIds).toContain("nginx-reverse-proxy");
    expect(pastIds).not.toContain("caddy-reverse-proxy"); // created 2026-01-15
    expect(past.result.pack).not.toContain("superseded by caddy-reverse-proxy");
  });

  test("contradiction is served two-sided and labeled", () => {
    const out = recall(store, { query: "offline logging conflicts with server state" }, NOW);
    const ids = out.result.nodes.map((n) => n.id);
    expect(ids).toContain("local-first-sync");
    expect(ids).toContain("server-authoritative-state");
    expect(out.result.conflicts).toContainEqual({
      a: "local-first-sync",
      b: "server-authoritative-state",
    });
  });

  test("budget is respected and expand handles cover non-full nodes", () => {
    const out = recall(store, { query: "home lab hardware services", budget_tokens: 600 }, NOW);
    expect(Math.ceil(out.result.pack.length / 4)).toBeLessThanOrEqual(600);
    for (const n of out.result.nodes) {
      if (n.tier !== "full") expect(out.result.expand_handles).toContain(n.id);
    }
  });

  test("full-tier renders bump salience via the store (§5.5)", () => {
    const out = recall(store, { query: "what frontend does the garden tracker use" }, NOW);
    expect(out.fullTier.length).toBeGreaterThan(0);
    const target = out.fullTier[0] as string;
    const before = store.loadGraph().salience.get(target) ?? 1;
    store.bumpSalience(out.fullTier, NOW.toISOString());
    const after = store.loadGraph().salience.get(target) ?? 1;
    expect(after).toBe(before + 1);
  });
});
