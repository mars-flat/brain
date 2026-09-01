/**
 * The graph as core sees it: plain data in, plain data out. No I/O, no
 * clock, no randomness (§8.2) — time arrives as a value, storage hides
 * behind RecallStore.
 */

import type { Confidence, EdgeRecord, EdgeRelation, NodeType, Provenance } from "@brain/contracts";

export interface GraphNode {
  id: string;
  type: NodeType;
  title: string;
  created: string;
  updated: string;
  status: "active" | "superseded";
  confidence: Confidence;
  provenance: Provenance;
  summary: string;
}

export interface PinInfo {
  pinId: string;
  nodeId: string;
  correction: string;
}

export interface GraphSlice {
  nodes: Map<string, GraphNode>;
  edges: EdgeRecord[];
  /** Effective salience per node; absent means 1.0. */
  salience: Map<string, number>;
  pins: PinInfo[];
}

/**
 * The seam between the pure engine and storage. brainstore implements it
 * over SQLite; tests implement it over in-memory fixtures. Everything is
 * synchronous — bun:sqlite is synchronous and determinism is easier to
 * reason about without interleaving.
 */
export interface RecallStore {
  /** BM25 seed search over title+aliases+tags+summary (§5.5). raw > 0, higher = better. */
  seedSearch(query: string, k: number, types?: NodeType[]): Array<{ id: string; raw: number }>;
  /** The graph without bodies — cheap at O(10^4) nodes (§5.11). */
  loadGraph(): GraphSlice;
  /** Bodies only for the nodes that render at full tier. */
  getBodies(ids: string[]): Map<string, string>;
  /**
   * The stored noise floor (§5.5): distribution of top-1 BM25 scores for
   * out-of-domain probe queries against THIS index, written at rebuild.
   * Optional — absent (or null) falls back to the legacy θ_seed constant.
   */
  calibration?(): { mu: number; sigma: number; battery: number } | null;
  /** One line per node for the abstention catalog fallback (§5.5). Optional. */
  catalogEntries?(): Array<{ id: string; type: string; title: string }>;
}

export interface TraversalParams {
  hops: number;
  edgeDecay: Record<EdgeRelation, number>;
  saliencePow: number;
  recencyPow: number;
  recencyHalfLifeDays: number;
  /**
   * α in the hub damp (1 + degree/medianDegree)^-α, applied when path mass
   * arrives at a node (§5.5). 0 disables — recovers pre-damping behavior
   * exactly. Counters the Σ-over-paths funnel that let high-degree nodes
   * outscore query-relevant ones on every query.
   */
  degreeDampAlpha: number;
  /** θ_prune — a path contribution below this is not propagated further. */
  pruneThreshold: number;
  /** Frontier cap per hop (§5.5). */
  frontierCap: number;
  /** θ_seed — best raw BM25 below this falls back to cold behavior (§5.5). */
  seedThreshold: number;
  /**
   * θ_seed only arms at this graph size: BM25 magnitudes scale with corpus
   * IDF, and a young graph prefers recall over precision anyway (§5.6).
   */
  seedThresholdMinNodes: number;
  seedK: number;
}

export interface PackParams {
  /** Nominal rank bands (§5.5): ranks 1..fullRanks full, ..summaryRanks summaries, rest stubs. */
  fullRanks: number;
  summaryRanks: number;
  /** Graphs smaller than this signal cold_start (§5.6). */
  coldStartMinNodes: number;
  /**
   * Full-band eligibility (§5.5): a node may take a scarce full slot only if
   * it was reached within this many hops of a seed (or is pinned). Hubs that
   * qualify only via long-path accumulation share `hubFullCap` slots. Once
   * every eligible node is full and budget remains, the restriction lifts —
   * scarcity is the thing being protected.
   */
  fullEligibilityMaxHops: number;
  hubFullCap: number;
}

/**
 * The abstention score (§5.5): A = wZ·z + wCoverage·coverage +
 * wCohesion·cohesion − wHubFrac·hubFrac, banded by τ. Replaces the scalar
 * θ_seed, whose real-query and garbage-query score bands overlapped in both
 * directions (measured 2026-08-31: starved real questions at 4.2–4.6 raw,
 * confidently answered a foreign probe at 5.5).
 */
export interface AbstentionParams {
  wZ: number;
  wCoverage: number;
  wCohesion: number;
  wHubFrac: number;
  /** A below tauLow abstains (catalog); below tauHigh answers hedged (§5.5). */
  tauLow: number;
  tauHigh: number;
}

export interface RecallParams {
  traversal: TraversalParams;
  pack: PackParams;
  abstention: AbstentionParams;
  defaultBudget: number;
}
