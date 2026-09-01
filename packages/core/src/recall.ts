/**
 * brain.recall (§5.5, §5.10): seed → traverse → pack, orchestrated purely —
 * storage behind RecallStore, time as a value. Recall never writes: salience
 * accrues on brain.expand (demand), not on rendering (exposure) — §5.5.
 */

import type { BrainRecallInput, BrainRecallResult, NodeType } from "@brain/contracts";
import { degreeStats } from "./graph-stats.ts";
import { pack } from "./pack.ts";
import { DEFAULT_RECALL_PARAMS } from "./params.ts";
import { traverse } from "./traverse.ts";
import type { GraphSlice, RecallParams, RecallStore } from "./types.ts";

export interface RecallOutcome {
  result: BrainRecallResult;
  /** Ids rendered at full tier. Informational — salience bumps on expand, not render (§5.5). */
  fullTier: string[];
}

export function sanitizeQueryTerms(query: string): string[] {
  return query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Function words carrying no topical signal. Used by the abstention features
 * (§5.5) and the paraphrase eval's zero-overlap enforcement (§8.5) — never
 * by the seed search itself, which sees the full query exactly as typed.
 * Kept small and boring on purpose: anything content-bearing must count.
 */
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a an the and or but if then else when while of in on at to from by for with without " +
    "about into over under again further once here there all any both each few more most " +
    "other some such no nor not only own same so than too very can will just should now " +
    "do does did doing have has had having be is are was were been being it its this " +
    "that these those i me my we our you your he she they them their what which who whom " +
    "how why where whats dont am get got as before after out up down off"
  ).split(/\s+/),
);

/** Content terms of a query: sanitized exactly as seed search does, minus stopwords. */
export function contentTerms(query: string): string[] {
  return sanitizeQueryTerms(query).filter((t) => !QUERY_STOPWORDS.has(t));
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
  const stats = degreeStats(graph);
  const scored = traverse(graph, seeds, now, { ...params.traversal, hops }, stats);
  const packed = pack(graph, scored, budget, params.pack, (ids) => store.getBodies(ids), {
    hops: new Map([...scored.values()].map((s) => [s.id, s.hops])),
    hubs: stats.hubs,
    fullEligibilityMaxHops: params.pack.fullEligibilityMaxHops,
    hubFullCap: params.pack.hubFullCap,
  });

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
