/**
 * brain.recall (§5.5, §5.10): seed → traverse → pack, orchestrated purely —
 * storage behind RecallStore, time as a value. Recall never writes: salience
 * accrues on brain.expand (demand), not on rendering (exposure) — §5.5.
 */

import type { BrainRecallInput, BrainRecallResult, NodeType } from "@brain/contracts";
import { degreeStats } from "./graph-stats.ts";
import { pack } from "./pack.ts";
import { DEFAULT_RECALL_PARAMS } from "./params.ts";
import { estimateTokens } from "./tokens.ts";
import { buildAdjacency, traverse } from "./traverse.ts";
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

/**
 * Seed cohesion (§5.5): do the top seeds live in one linked neighborhood
 * (a real topic) or scatter across unrelated clusters (word coincidence)?
 * Fraction of seed pairs within 2 hops; a single seed is neutral evidence.
 */
function seedCohesion(graph: GraphSlice, ids: string[]): number {
  if (ids.length < 2) return 0.5;
  const { neighbors } = buildAdjacency(graph.edges, new Set(graph.nodes.keys()));
  const hood = new Map<string, Set<string>>();
  for (const id of ids) {
    const s = new Set([id]);
    for (const { other } of neighbors.get(id) ?? []) s.add(other);
    for (const first of [...s]) for (const { other } of neighbors.get(first) ?? []) s.add(other);
    hood.set(id, s);
  }
  let close = 0;
  let total = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      total++;
      if (hood.get(ids[i] as string)?.has(ids[j] as string)) close++;
    }
  }
  return total ? close / total : 0.5;
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
  if (coldStart) {
    return {
      result: { pack: "", nodes: [], conflicts: [], expand_handles: [], cold_start: true },
      fullTier: [],
    };
  }

  // ── abstain: the catalog fallback (§5.5) — never a fabricated neighborhood
  const abstain = (): RecallOutcome => {
    const entries = store.catalogEntries?.() ?? [];
    let packText = "";
    if (entries.length && budget > 0) {
      const hint =
        "→ no seed cleared the abstention gate — pick ids from the catalog and re-recall with seeds, or rephrase";
      const build = (n: number): string => {
        const lines = [
          `── NO CONFIDENT MATCH — vault catalog (${entries.length} nodes) ──`,
          ...entries.slice(0, n).map((e) => `[STUB]    ${e.type}/${e.id} — ${e.title}`),
        ];
        if (n < entries.length) lines.push(`(+${entries.length - n} more — truncated by budget)`);
        lines.push(hint);
        return lines.join("\n");
      };
      // ~8 tokens/line is generous; shrink until the budget invariant holds.
      let n = Math.min(entries.length, Math.max(0, Math.floor(budget / 8)));
      let candidate = build(n);
      while (n > 0 && estimateTokens(candidate) > budget) candidate = build(--n);
      packText = n > 0 && estimateTokens(candidate) <= budget ? candidate : "";
    }
    return {
      result: {
        pack: packText,
        nodes: [],
        conflicts: [],
        expand_handles: [],
        cold_start: false,
        confidence: "none",
      },
      fullTier: [],
    };
  };

  // ── seed (§5.5 step 1) ────────────────────────────────────────────────
  const stats = degreeStats(graph);
  const hits = store.seedSearch(input.query, params.traversal.seedK, input.types as NodeType[]);
  const inGraph = hits.filter((h) => graph.nodes.has(h.id));
  const best = inGraph[0]?.raw ?? 0;
  const explicit = (input.seeds ?? []).filter((id) => graph.nodes.has(id));

  const cal = store.calibration?.() ?? null;
  const armed = graph.nodes.size >= params.traversal.seedThresholdMinNodes;
  let confidence: "high" | "low" | "none";
  if (explicit.length) {
    // The caller named its seeds — it knows something the gate doesn't.
    confidence = "high";
  } else if (!armed) {
    // Young graph: prefer recall over precision (§5.6).
    confidence = inGraph.length ? "high" : "none";
  } else if (!cal) {
    // Pre-calibration index: the legacy scalar θ_seed.
    confidence = inGraph.length && best > params.traversal.seedThreshold ? "high" : "none";
  } else {
    // The abstention score (§5.5): four deterministic features over the
    // index and the graph — no model, no network, no wall clock.
    const z = (best - cal.mu) / Math.max(cal.sigma, 0.5);
    const terms = contentTerms(input.query);
    const matched = terms.filter((t) => store.seedSearch(t, 1).length > 0);
    const coverage = terms.length ? matched.length / terms.length : 0;
    const topSeeds = inGraph.map((h) => h.id);
    const cohesion = seedCohesion(graph, topSeeds);
    const hubFrac = topSeeds.length
      ? topSeeds.filter((id) => stats.hubs.has(id)).length / topSeeds.length
      : 0;
    const w = params.abstention;
    const a = w.wZ * z + w.wCoverage * coverage + w.wCohesion * cohesion - w.wHubFrac * hubFrac;
    confidence = !inGraph.length || a < w.tauLow ? "none" : a < w.tauHigh ? "low" : "high";
  }
  if (confidence === "none") return abstain();

  const seeds: Array<{ id: string; weight: number }> = [];
  if (inGraph.length) {
    const max = best;
    for (const h of inGraph) seeds.push({ id: h.id, weight: max > 0 ? h.raw / max : 0 });
  }
  for (const id of explicit) seeds.push({ id, weight: 1.0 });
  if (seeds.length === 0) return abstain();

  // ── traverse (step 2) + pack (step 3) ─────────────────────────────────
  // Hedged packs (§5.5) flatten to summaries/stubs behind a banner: a weak
  // lexical match must not be dressed up as a ranked answer.
  const banner =
    "── LOW CONFIDENCE — weak lexical match; treat ranking as a hint: re-query with synonyms or expand stubs ──";
  const packBudget =
    confidence === "low" ? Math.max(0, budget - estimateTokens(banner) - 1) : budget;
  const scored = traverse(graph, seeds, now, { ...params.traversal, hops }, stats);
  const packed = pack(graph, scored, packBudget, params.pack, (ids) => store.getBodies(ids), {
    hops: new Map([...scored.values()].map((s) => [s.id, s.hops])),
    hubs: stats.hubs,
    fullEligibilityMaxHops: params.pack.fullEligibilityMaxHops,
    hubFullCap: params.pack.hubFullCap,
    maxTier: confidence === "low" ? "summary" : undefined,
  });

  return {
    result: {
      pack: confidence === "low" && packed.pack ? `${banner}\n${packed.pack}` : packed.pack,
      nodes: packed.entries.map((e) => ({ id: e.id, tier: e.tier, score: e.score })),
      conflicts: packed.conflicts,
      expand_handles: packed.expandHandles,
      cold_start: false,
      confidence,
    },
    fullTier: packed.fullTier,
  };
}
