/**
 * §8.3 property tests over random graphs — the claims the system makes,
 * asserted with fast-check rather than examples:
 *
 *   Budget · Supersedes · Contradicts · Pins · No drop · Determinism
 *
 * Graph-size note: ≤24 nodes with short texts means all-stubs costs well
 * under 800 tokens, so the properties scoped to budget ≥ 800 never hit the
 * explicit-omission path — which is exercised separately in pack.test.ts.
 */

import { describe, expect, test } from "bun:test";
import type { EdgeRecord, EdgeRelation } from "@brain/contracts";
import { EDGE_RELATIONS } from "@brain/contracts";
import fc from "fast-check";
import {
  DEFAULT_RECALL_PARAMS,
  estimateTokens,
  type GraphNode,
  type GraphSlice,
  pack,
  terminalSuccessor,
  traverse,
} from "../src/index.ts";

const NOW = new Date("2026-08-25T12:00:00Z");

const nodeId = (i: number) => `n${String(i).padStart(2, "0")}`;

function mkNode(i: number, status: "active" | "superseded"): GraphNode {
  return {
    id: nodeId(i),
    type: "concept",
    title: `Node ${i} title with some words`,
    created: `2026-0${(i % 6) + 1}-10`,
    updated: `2026-0${(i % 6) + 1}-15`,
    status,
    confidence: "medium",
    provenance: "trusted",
    summary: `Summary text for node ${i}, a couple of clauses long so tiers differ meaningfully.`,
  };
}

interface ArbGraph {
  graph: GraphSlice;
  seeds: Array<{ id: string; weight: number }>;
  bodies: Map<string, string>;
}

const arbGraphInput = fc
  .record({
    nodeCount: fc.integer({ min: 1, max: 24 }),
    statuses: fc.array(fc.boolean(), { minLength: 24, maxLength: 24 }),
    edgeSpecs: fc.array(
      fc.record({
        from: fc.nat({ max: 23 }),
        to: fc.nat({ max: 23 }),
        rel: fc.constantFrom(...(EDGE_RELATIONS as readonly EdgeRelation[])),
      }),
      { maxLength: 60 },
    ),
    salienceSpecs: fc.array(
      fc.record({ idx: fc.nat({ max: 23 }), value: fc.double({ min: 0.1, max: 30, noNaN: true }) }),
      { maxLength: 10 },
    ),
    pinIdxs: fc.uniqueArray(fc.nat({ max: 23 }), { maxLength: 2 }),
    seedSpecs: fc.array(
      fc.record({
        idx: fc.nat({ max: 23 }),
        weight: fc.double({ min: 0.05, max: 1, noNaN: true }),
      }),
      { minLength: 1, maxLength: 5 },
    ),
  })
  .map(({ nodeCount, statuses, edgeSpecs, salienceSpecs, pinIdxs, seedSpecs }): ArbGraph => {
    const nodes = new Map<string, GraphNode>();
    for (let i = 0; i < nodeCount; i++) {
      nodes.set(nodeId(i), mkNode(i, statuses[i] ? "superseded" : "active"));
    }
    const inRange = (i: number) => i < nodeCount;
    const edges: EdgeRecord[] = edgeSpecs
      .filter((e) => e.from !== e.to && inRange(e.from) && inRange(e.to))
      .map((e) => ({ from: nodeId(e.from), rel: e.rel, to: nodeId(e.to) }));
    const salience = new Map<string, number>();
    for (const s of salienceSpecs) if (inRange(s.idx)) salience.set(nodeId(s.idx), s.value);
    const pins = pinIdxs
      .filter(inRange)
      .map((i) => ({ pinId: `pin-${i}`, nodeId: nodeId(i), correction: `Correction for ${i}.` }));
    const seeds = seedSpecs
      .filter((s) => inRange(s.idx))
      .map((s) => ({ id: nodeId(s.idx), weight: s.weight }));
    const bodies = new Map<string, string>();
    for (let i = 0; i < nodeCount; i++) {
      bodies.set(nodeId(i), `Body detail for node ${i}. `.repeat((i % 4) + 1).trim());
    }
    return { graph: { nodes, edges, salience, pins }, seeds, bodies };
  })
  .filter(({ seeds }) => seeds.length > 0);

function runPack({ graph, seeds, bodies }: ArbGraph, budget: number) {
  const scored = traverse(graph, seeds, NOW, DEFAULT_RECALL_PARAMS.traversal);
  return pack(graph, scored, budget, DEFAULT_RECALL_PARAMS.pack, (ids) => {
    const out = new Map<string, string>();
    for (const id of ids) out.set(id, bodies.get(id) ?? "");
    return out;
  });
}

describe("§8.3 invariants", () => {
  test("Budget: tokens(pack) ≤ budget for every graph, query, and budget", () => {
    fc.assert(
      fc.property(arbGraphInput, fc.integer({ min: 0, max: 6000 }), (input, budget) => {
        const result = runPack(input, budget);
        expect(result.tokens).toBeLessThanOrEqual(budget === 0 ? 0 : budget);
        expect(estimateTokens(result.pack)).toBeLessThanOrEqual(Math.max(budget, 0));
      }),
      { numRuns: 150 },
    );
  });

  test("Supersedes: any packed node's terminal successor is also packed", () => {
    fc.assert(
      fc.property(arbGraphInput, fc.integer({ min: 800, max: 6000 }), (input, budget) => {
        const result = runPack(input, budget);
        const packed = new Set(result.entries.map((e) => e.id));
        const nodeIds = new Set(input.graph.nodes.keys());
        for (const id of packed) {
          for (const succ of terminalSuccessor(id, input.graph.edges, nodeIds)) {
            expect(packed.has(succ)).toBe(true);
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  test("Contradicts: counterparts are packed together and the conflict is labeled", () => {
    fc.assert(
      fc.property(arbGraphInput, fc.integer({ min: 800, max: 6000 }), (input, budget) => {
        const result = runPack(input, budget);
        const packed = new Set(result.entries.map((e) => e.id));
        const conflictKeys = new Set(result.conflicts.map((c) => `${c.a} ${c.b}`));
        for (const e of input.graph.edges) {
          if (e.rel !== "contradicts") continue;
          if (!input.graph.nodes.has(e.from) || !input.graph.nodes.has(e.to)) continue;
          if (packed.has(e.from) || packed.has(e.to)) {
            expect(packed.has(e.from)).toBe(true);
            expect(packed.has(e.to)).toBe(true);
            const [a, b] = e.from < e.to ? [e.from, e.to] : [e.to, e.from];
            expect(conflictKeys.has(`${a} ${b}`)).toBe(true);
            expect(result.pack).toContain(`⚠ CONFLICT: ${a} contradicts ${b}`);
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  test("Pins: a pinned node renders at full tier whenever included (generous budget)", () => {
    fc.assert(
      fc.property(arbGraphInput, fc.integer({ min: 2000, max: 8000 }), (input, budget) => {
        const result = runPack(input, budget);
        const pinned = new Set(input.graph.pins.map((p) => p.nodeId));
        for (const e of result.entries) {
          if (pinned.has(e.id)) {
            expect(e.tier).toBe("full");
            const pin = input.graph.pins.find((p) => p.nodeId === e.id);
            expect(result.pack).toContain(`📌 PIN: ${pin?.correction}`);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  test("No drop: with an unconstrained budget every reachable node appears, none omitted", () => {
    fc.assert(
      fc.property(arbGraphInput, (input) => {
        const scored = traverse(input.graph, input.seeds, NOW, DEFAULT_RECALL_PARAMS.traversal);
        const result = runPack(input, 1_000_000);
        expect(result.omitted).toEqual([]);
        const packed = new Set(result.entries.map((e) => e.id));
        for (const id of scored.keys()) expect(packed.has(id)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  test("Determinism: identical inputs and shuffled input orderings give byte-identical packs", () => {
    fc.assert(
      fc.property(
        arbGraphInput,
        fc.integer({ min: 200, max: 5000 }),
        fc.infiniteStream(fc.nat({ max: 1_000_000 })),
        (input, budget, randoms) => {
          const a = runPack(input, budget);
          const b = runPack(input, budget);
          expect(b.pack).toBe(a.pack);

          // Shuffle edge/pin order and node insertion order — output must not move.
          const it = randoms[Symbol.iterator]();
          const rnd = () => (it.next().value as number) % 7919;
          const shuffledEdges = [...input.graph.edges]
            .map((e) => ({ e, k: rnd() }))
            .sort((x, y) => x.k - y.k)
            .map((x) => x.e);
          const shuffledNodes = new Map(
            [...input.graph.nodes.entries()]
              .map((n) => ({ n, k: rnd() }))
              .sort((x, y) => x.k - y.k)
              .map((x) => x.n),
          );
          const shuffled: ArbGraph = {
            ...input,
            graph: {
              nodes: shuffledNodes,
              edges: shuffledEdges,
              salience: input.graph.salience,
              pins: [...input.graph.pins].reverse(),
            },
          };
          const c = runPack(shuffled, budget);
          expect(c.pack).toBe(a.pack);
        },
      ),
      { numRuns: 75 },
    );
  });
});
