/**
 * Seed → traverse → score (§5.5, steps 1–2).
 *
 *   score(n) = Σ over paths s→n [ bm25_norm(s) · Π δ_rel(e) ]
 *              · salience(n)^0.3 · recency(n)^0.2
 *
 * Edges are traversed in BOTH directions with the relation's decay — one
 * direction on disk, both in the index (§5.3). All iteration is over
 * canonically sorted data, so the result is identical for any input
 * ordering — that's what makes the §8.3 determinism invariant hold as
 * byte-equality, not approximately.
 */

import type { EdgeRecord } from "@brain/contracts";
import type { GraphSlice, TraversalParams } from "./types.ts";

export interface ScoredNode {
  id: string;
  /** Σ paths bm25_norm · Π δ — before salience/recency. */
  contribution: number;
  score: number;
  /** Hop distance at first reach (0 = seed). */
  hops: number;
}

interface Adjacency {
  /** node id → sorted [otherId, rel] pairs, both directions. */
  neighbors: Map<string, Array<{ other: string; rel: EdgeRecord["rel"] }>>;
}

export function buildAdjacency(edges: EdgeRecord[], nodeIds: Set<string>): Adjacency {
  const neighbors = new Map<string, Array<{ other: string; rel: EdgeRecord["rel"] }>>();
  const push = (a: string, b: string, rel: EdgeRecord["rel"]) => {
    if (!nodeIds.has(a) || !nodeIds.has(b)) return; // dangling edges don't traverse
    const list = neighbors.get(a) ?? [];
    list.push({ other: b, rel });
    neighbors.set(a, list);
  };
  const sorted = [...edges].sort(
    (x, y) => x.from.localeCompare(y.from) || x.rel.localeCompare(y.rel) || x.to.localeCompare(y.to),
  );
  for (const e of sorted) {
    push(e.from, e.to, e.rel);
    push(e.to, e.from, e.rel);
  }
  for (const list of neighbors.values())
    list.sort((a, b) => a.other.localeCompare(b.other) || a.rel.localeCompare(b.rel));
  return { neighbors };
}

export function ageDays(now: Date, dateStr: string): number {
  const then = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, (now.getTime() - then) / 86_400_000);
}

export function traverse(
  graph: GraphSlice,
  seeds: Array<{ id: string; weight: number }>,
  now: Date,
  params: TraversalParams,
): Map<string, ScoredNode> {
  const nodeIds = new Set(graph.nodes.keys());
  const { neighbors } = buildAdjacency(graph.edges, nodeIds);

  const contribution = new Map<string, number>();
  const firstHop = new Map<string, number>();

  // Canonical seed order; duplicate seeds accumulate.
  const sortedSeeds = [...seeds]
    .filter((s) => nodeIds.has(s.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  let frontier = new Map<string, number>();
  for (const s of sortedSeeds) {
    contribution.set(s.id, (contribution.get(s.id) ?? 0) + s.weight);
    frontier.set(s.id, (frontier.get(s.id) ?? 0) + s.weight);
    if (!firstHop.has(s.id)) firstHop.set(s.id, 0);
  }

  for (let hop = 1; hop <= params.hops; hop++) {
    const next = new Map<string, number>();
    const frontierIds = [...frontier.keys()].sort();
    for (const id of frontierIds) {
      const c = frontier.get(id) as number;
      for (const { other, rel } of neighbors.get(id) ?? []) {
        const add = c * params.edgeDecay[rel];
        if (add < params.pruneThreshold) continue;
        next.set(other, (next.get(other) ?? 0) + add);
      }
    }
    // Frontier cap (§5.5): keep the strongest, ties by id.
    const capped = [...next.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, params.frontierCap);
    frontier = new Map(capped);
    for (const [id, add] of capped) {
      contribution.set(id, (contribution.get(id) ?? 0) + add);
      if (!firstHop.has(id)) firstHop.set(id, hop);
    }
    if (frontier.size === 0) break;
  }

  const out = new Map<string, ScoredNode>();
  for (const id of [...contribution.keys()].sort()) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    const contrib = contribution.get(id) as number;
    const salience = graph.salience.get(id) ?? 1.0;
    const recency = Math.exp(-ageDays(now, node.updated) / params.recencyHalfLifeDays);
    out.set(id, {
      id,
      contribution: contrib,
      score: contrib * salience ** params.saliencePow * recency ** params.recencyPow,
      hops: firstHop.get(id) ?? params.hops,
    });
  }
  return out;
}

/**
 * Follow the supersedes chain FORWARD (an incoming `supersedes` edge means
 * someone replaced you) to the terminal node — unconditionally, ignoring
 * budget and hop limits (§5.3 hard rule 1). Cycle-safe: a malformed cycle
 * terminates at the lowest-id node already visited.
 */
export function terminalSuccessor(id: string, edges: EdgeRecord[], nodeIds: Set<string>): string[] {
  const successorsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (e.rel !== "supersedes") continue;
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    const list = successorsOf.get(e.to) ?? [];
    list.push(e.from);
    successorsOf.set(e.to, list);
  }
  for (const list of successorsOf.values()) list.sort();

  const chain: string[] = [];
  const visited = new Set<string>([id]);
  let current = id;
  for (;;) {
    const nexts = successorsOf.get(current) ?? [];
    const next = nexts.find((n) => !visited.has(n));
    if (!next) break;
    chain.push(next);
    visited.add(next);
    current = next;
  }
  return chain;
}
