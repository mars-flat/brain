/**
 * The graph as core sees it: plain data in, plain data out. No I/O, no
 * clock, no randomness (§8.2) — time arrives as a value, storage hides
 * behind RecallStore.
 */

import type {
  Confidence,
  EdgeRecord,
  EdgeRelation,
  NodeType,
  Provenance,
} from "@brain/contracts";

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
}

export interface TraversalParams {
  hops: number;
  edgeDecay: Record<EdgeRelation, number>;
  saliencePow: number;
  recencyPow: number;
  recencyHalfLifeDays: number;
  /** θ_prune — a path contribution below this is not propagated further. */
  pruneThreshold: number;
  /** Frontier cap per hop (§5.5). */
  frontierCap: number;
  /** θ_seed — best raw BM25 below this falls back to cold behavior (§5.5). */
  seedThreshold: number;
  seedK: number;
}

export interface PackParams {
  /** Nominal rank bands (§5.5): ranks 1..fullRanks full, ..summaryRanks summaries, rest stubs. */
  fullRanks: number;
  summaryRanks: number;
  /** Graphs smaller than this signal cold_start (§5.6). */
  coldStartMinNodes: number;
}

export interface RecallParams {
  traversal: TraversalParams;
  pack: PackParams;
  defaultBudget: number;
}
