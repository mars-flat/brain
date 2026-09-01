/**
 * The brain MCP contract (§5.10). Inputs and results for the eight brain
 * tools. Scope mapping (§4.3): recall/expand/neighbors/timeline/trace are
 * `brain:read`; note/pin/ingest are `brain:write`.
 */

import type { EpisodeEnvelope } from "./episode.ts";
import type { EdgeRelation, NodeType } from "./node.ts";

export const RENDER_TIERS = ["full", "summary", "stub"] as const;
/**
 * Tiering is the whole trick (§5.5): a node is never dropped for scoring
 * low — it is downgraded. full ≈600t, summary ≈140t, stub ≈15t.
 */
export type RenderTier = (typeof RENDER_TIERS)[number];

export interface BrainRecallInput {
  query: string;
  /** Hard ceiling on pack size. Default 4000. */
  budget_tokens?: number;
  /** Max traversal depth. Default 3. */
  hops?: number;
  /** Restrict seed matching to these node types. */
  types?: NodeType[];
  /** Seed traversal from these node ids instead of (or in addition to) FTS matches. */
  seeds?: string[];
  /**
   * Cheap time travel (§5.10): filter to nodes created ≤ as_of and ignore
   * supersedes edges created after it. YYYY-MM-DD.
   */
  as_of?: string;
}

export interface PackedNodeRef {
  id: string;
  tier: RenderTier;
  score: number;
}

/** Both endpoints of a contradicts edge that landed in the pack, labeled (§5.3). */
export interface PackConflict {
  a: string;
  b: string;
}

export interface BrainRecallResult {
  /** The rendered context pack, ≤ budget_tokens. */
  pack: string;
  nodes: PackedNodeRef[];
  conflicts: PackConflict[];
  /** Ids the model may promote with brain.expand. */
  expand_handles: string[];
  /** True on an empty/thin graph — an explicit signal, never fabricated context (§5.6). */
  cold_start: boolean;
  /**
   * Graded retrieval confidence (§5.5): "high" = normal tiered pack; "low" =
   * weak lexical match, pack flattened to summaries/stubs with a banner —
   * treat ranking as a hint, re-query or expand; "none" = abstained, pack
   * carries the vault catalog instead of a fabricated neighborhood. Absent
   * only from packs produced before the field existed.
   */
  confidence?: "high" | "low" | "none";
}

export interface BrainExpandInput {
  ids: string[];
  /** Target tier. Default "full". */
  tier?: RenderTier;
}

export interface BrainExpandResult {
  renders: Array<{ id: string; tier: RenderTier; content: string }>;
  /** Requested ids that don't resolve. */
  missing: string[];
}

export interface BrainNeighborsInput {
  id: string;
  /** Restrict to these relations. Default: all. */
  rels?: EdgeRelation[];
  /** Default 1. */
  depth?: number;
}

export interface EdgeRecord {
  from: string;
  rel: EdgeRelation;
  to: string;
}

export interface BrainNeighborsResult {
  edges: EdgeRecord[];
}

export interface BrainNoteInput {
  text: string;
  /** Node ids this note relates to. */
  links?: string[];
  type?: NodeType;
}

/** brain.note enqueues for the consolidator — it never writes the graph directly (§5.10). */
export interface BrainNoteResult {
  pending_id: string;
}

/**
 * brain.ingest (P5, §6.4): a harness delivers a full §5.7 episode envelope
 * remotely — the HTTP replacement for `brain ingest --now` on the box.
 * Validation, the trust gate, and the token guard all live in the
 * consolidator's ingest path; redelivery is idempotent (§5.7 ledger).
 */
export interface BrainIngestInput {
  episode: EpisodeEnvelope;
}

export interface BrainIngestResult {
  episode_id: string;
  /** Episodes the consolidator run processed (0 when redelivered after success). */
  processed: number;
  retried: number;
  /**
   * True when the server runs batched consolidation (§5.8): the episode is
   * stored + enqueued and the background cadence extracts it — nothing was
   * consolidated inline.
   */
  queued?: boolean;
}

export interface BrainPinInput {
  node_id: string;
  correction: string;
  reason: string;
}

/** A pin survives all future generation; violations quarantine, never overwrite (§5.7). */
export interface BrainPinResult {
  pin_id: string;
}

export interface BrainTimelineInput {
  query?: string;
  /** YYYY-MM-DD bounds, inclusive. */
  from?: string;
  to?: string;
}

export interface EpisodeRef {
  episode_id: string;
  started_at: string;
  ended_at: string;
  surface: string;
  harness: string;
  labels: string[];
}

export interface BrainTimelineResult {
  /** Chronological, oldest first. */
  episodes: EpisodeRef[];
}

export interface BrainTraceInput {
  node_id: string;
}

/** Provenance chain to source episodes — every claim gets a citation (§5.10). */
export interface BrainTraceResult {
  node_id: string;
  /** Episode ids from the node's sources frontmatter. */
  episodes: EpisodeRef[];
  /** derived_from edges walked to reach them. */
  edges: EdgeRecord[];
}
