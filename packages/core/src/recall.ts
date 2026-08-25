/**
 * brain.recall (§5.5, §5.10): seed → traverse → pack, orchestrated purely —
 * storage behind RecallStore, time as a value. Salience bumping is the
 * caller's job (it's a write); `fullTier` in the result says what to bump.
 */

import type { BrainRecallInput, BrainRecallResult, NodeType } from "@brain/contracts";
import { pack } from "./pack.ts";
import { DEFAULT_RECALL_PARAMS } from "./params.ts";
import { traverse } from "./traverse.ts";
import type { GraphSlice, RecallParams, RecallStore } from "./types.ts";

export interface RecallOutcome {
  result: BrainRecallResult;
  /** Ids rendered at full tier — bump their salience (§5.5). */
  fullTier: string[];
}

export function sanitizeQueryTerms(query: string): string[] {
  return query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Terms OR-joined; porter stems both sides, so no prefix stars (§5.5 note). */
export function toFtsQuery(query: string): string | null {
  const terms = sanitizeQueryTerms(query);
  return terms.length ? terms.join(" OR ") : null;
}

function applyAsOf(graph: GraphSlice, asOf: string): GraphSlice {
  // Cheap time travel (§5.10): nodes created after as_of don't exist yet,
  // and supersedes edges from them don't either — which falls out of
  // dropping the nodes, since dangling edges never traverse.
  const nodes = new Map([...graph.nodes].filter(([, n]) => n.created <= asOf));
  return {
    nodes,
    edges: graph.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)),
    salience: graph.salience,
    pins: graph.pins,
  };
}

export function recall(
  store: RecallStore,
  input: BrainRecallInput,
  now: Date,
  params: RecallParams = DEFAULT_RECALL_PARAMS,
): RecallOutcome {
  const budget = input.budget_tokens ?? params.defaultBudget;
  const hops = input.hops ?? params.traversal.hops;

  let graph = store.loadGraph();
  if (input.as_of) graph = applyAsOf(graph, input.as_of);

  const coldStart = graph.nodes.size < params.pack.coldStartMinNodes;
  const empty = (): RecallOutcome => ({
    result: {
      pack: "",
      nodes: [],
      conflicts: [],
      expand_handles: [],
      cold_start: coldStart,
    },
    fullTier: [],
  });
  if (coldStart) return empty();

  // ── seed (§5.5 step 1) ────────────────────────────────────────────────
  const seeds: Array<{ id: string; weight: number }> = [];
  const hits = store.seedSearch(input.query, params.traversal.seedK, input.types as NodeType[]);
  const inGraph = hits.filter((h) => graph.nodes.has(h.id));
  const best = inGraph[0]?.raw ?? 0;
  const threshold =
    graph.nodes.size >= params.traversal.seedThresholdMinNodes ? params.traversal.seedThreshold : 0;
  if (inGraph.length && best > threshold) {
    const max = best;
    for (const h of inGraph) seeds.push({ id: h.id, weight: max > 0 ? h.raw / max : 0 });
  }
  for (const id of input.seeds ?? []) {
    if (graph.nodes.has(id)) seeds.push({ id, weight: 1.0 });
  }
  if (seeds.length === 0) return empty();

  // ── traverse (step 2) + pack (step 3) ─────────────────────────────────
  const scored = traverse(graph, seeds, now, { ...params.traversal, hops });
  const packed = pack(graph, scored, budget, params.pack, (ids) => store.getBodies(ids));

  return {
    result: {
      pack: packed.pack,
      nodes: packed.entries.map((e) => ({ id: e.id, tier: e.tier, score: e.score })),
      conflicts: packed.conflicts,
      expand_handles: packed.expandHandles,
      cold_start: false,
    },
    fullTier: packed.fullTier,
  };
}
