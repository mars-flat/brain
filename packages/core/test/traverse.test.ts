import { describe, expect, test } from "bun:test";
import type { EdgeRecord } from "@brain/contracts";
import {
  DEFAULT_RECALL_PARAMS,
  type GraphNode,
  type GraphSlice,
  pack,
  terminalSuccessor,
  traverse,
} from "../src/index.ts";

const NOW = new Date("2026-08-25T12:00:00Z");
const T = DEFAULT_RECALL_PARAMS.traversal;

function node(id: string, over: Partial<GraphNode> = {}): [string, GraphNode] {
  return [
    id,
    {
      id,
      type: "concept",
      title: `Title of ${id}`,
      created: "2026-06-01",
      updated: "2026-08-01",
      status: "active",
      confidence: "medium",
      provenance: "trusted",
      summary: `Summary of ${id}.`,
      ...over,
    },
  ];
}

function slice(ids: string[], edges: EdgeRecord[]): GraphSlice {
  return {
    nodes: new Map(ids.map((id) => node(id))),
    edges,
    salience: new Map(),
    pins: [],
  };
}

describe("traverse", () => {
  test("decay weights order the neighborhood; both directions traversed", () => {
    const g = slice(
      ["seed", "strong", "weak", "incoming"],
      [
        { from: "seed", rel: "caused_by", to: "strong" }, // δ .85
        { from: "seed", rel: "mentioned_with", to: "weak" }, // δ .30
        { from: "incoming", rel: "about", to: "seed" }, // reverse, δ .60
      ],
    );
    const scored = traverse(g, [{ id: "seed", weight: 1 }], NOW, T);
    const s = (id: string) => scored.get(id)?.score ?? 0;
    expect(s("strong")).toBeGreaterThan(s("incoming"));
    expect(s("incoming")).toBeGreaterThan(s("weak"));
    expect(scored.get("incoming")?.hops).toBe(1);
  });

  test("hop limit bounds reach; contributions accumulate over multiple paths", () => {
    const g = slice(
      ["a", "b", "c", "d", "e"],
      [
        { from: "a", rel: "depends_on", to: "b" },
        { from: "b", rel: "depends_on", to: "c" },
        { from: "c", rel: "depends_on", to: "d" },
        { from: "d", rel: "depends_on", to: "e" },
        { from: "a", rel: "about", to: "c" }, // second path to c
      ],
    );
    const scored = traverse(g, [{ id: "a", weight: 1 }], NOW, { ...T, hops: 2 });
    expect(scored.has("d")).toBe(true); // via a→c(about)→d at hop 2
    expect(scored.has("e")).toBe(false); // needs hop 3
    const single = traverse({ ...g, edges: g.edges.slice(0, 4) }, [{ id: "a", weight: 1 }], NOW, {
      ...T,
      hops: 2,
    });
    expect(scored.get("c")?.contribution ?? 0).toBeGreaterThan(single.get("c")?.contribution ?? 0);
  });

  test("recency and salience shape the score gently", () => {
    const g: GraphSlice = {
      nodes: new Map([
        node("fresh", { updated: "2026-08-24" }),
        node("stale", { updated: "2024-01-01" }),
      ]),
      edges: [],
      salience: new Map([["stale", 20]]),
      pins: [],
    };
    const scored = traverse(
      g,
      [
        { id: "fresh", weight: 1 },
        { id: "stale", weight: 1 },
      ],
      NOW,
      T,
    );
    // salience^0.3 on 20 ≈ 2.45x vs recency penalty exp(-968/180)^0.2 ≈ 0.34x
    expect(scored.get("stale")?.score).toBeLessThan(20 * (scored.get("fresh")?.score ?? 0));
    expect(scored.get("stale")?.score).toBeGreaterThan(0);
  });

  test("terminalSuccessor follows chains and survives cycles", () => {
    const nodeIds = new Set(["v1", "v2", "v3", "x", "y"]);
    const edges: EdgeRecord[] = [
      { from: "v2", rel: "supersedes", to: "v1" },
      { from: "v3", rel: "supersedes", to: "v2" },
      { from: "x", rel: "supersedes", to: "y" },
      { from: "y", rel: "supersedes", to: "x" }, // malformed cycle
    ];
    expect(terminalSuccessor("v1", edges, nodeIds)).toEqual(["v2", "v3"]);
    expect(terminalSuccessor("v3", edges, nodeIds)).toEqual([]);
    expect(terminalSuccessor("y", edges, nodeIds)).toEqual(["x"]); // terminates
  });
});

describe("pack — explicit omission and tier mechanics", () => {
  test("tight budget omits explicitly — never silently", () => {
    const ids = Array.from({ length: 15 }, (_, i) => `node-${String(i).padStart(2, "0")}`);
    const g = slice(ids, []);
    const scored = traverse(
      g,
      ids.map((id) => ({ id, weight: 1 })),
      NOW,
      T,
    );
    const tiny = pack(g, scored, 120, DEFAULT_RECALL_PARAMS.pack, () => new Map());
    expect(tiny.tokens).toBeLessThanOrEqual(120);
    expect(tiny.omitted.length).toBeGreaterThan(0);
    expect(tiny.entries.length + tiny.omitted.length).toBe(15);
    expect(tiny.pack).toContain("omitted by budget");
    // (Since the capped omission footer, leftover budget may legitimately
    // upgrade the top-ranked survivor above stub — that's headroom spend,
    // not a downgrade bug.)
  });

  test("long node ids at tight budgets still yield a pack — omission footer is capped", () => {
    // Regression (2026-09-01): the footer listed every omitted id, so with
    // ~45-char real-vault ids each omission moved cost into the footer
    // instead of freeing it, and the fit loop spiraled to an empty pack.
    const ids = Array.from(
      { length: 60 },
      (_, i) => `very-long-descriptive-node-identifier-with-date-2026-09-01-number-${String(i).padStart(2, "0")}`,
    );
    const g = slice(ids, []);
    const scored = traverse(
      g,
      ids.map((id) => ({ id, weight: 1 })),
      NOW,
      T,
    );
    const tight = pack(g, scored, 300, DEFAULT_RECALL_PARAMS.pack, () => new Map());
    expect(tight.tokens).toBeLessThanOrEqual(300);
    expect(tight.entries.length).toBeGreaterThan(0); // never empty when stubs could fit
    expect(tight.omitted.length).toBeGreaterThan(0); // still explicit in the result
  });

  test("headroom upgrades in rank order up to full", () => {
    const g = slice(["a", "b"], []);
    const scored = traverse(
      g,
      [
        { id: "a", weight: 1 },
        { id: "b", weight: 0.5 },
      ],
      NOW,
      T,
    );
    const roomy = pack(g, scored, 4000, DEFAULT_RECALL_PARAMS.pack, (reqIds) => {
      return new Map(reqIds.map((id) => [id, `Body of ${id}.`]));
    });
    expect(roomy.entries.map((e) => e.tier)).toEqual(["full", "full"]);
    expect(roomy.fullTier).toEqual(["a", "b"]);
  });
});
