/**
 * Default tuning (§5.5). All starting values, tuned against the eval set
 * (§8.5); a vault's BRAIN.md may override at load time.
 */

import { DEFAULT_EDGE_DECAY } from "@brain/contracts";
import type { RecallParams } from "./types.ts";

export const DEFAULT_RECALL_PARAMS: RecallParams = {
  traversal: {
    hops: 3,
    edgeDecay: { ...DEFAULT_EDGE_DECAY },
    saliencePow: 0.3,
    recencyPow: 0.2,
    recencyHalfLifeDays: 180,
    pruneThreshold: 0.02,
    frontierCap: 200,
    // θ_seed on raw -bm25 of the BEST hit (§5.5): below it, no seeds — an
    // empty pack instead of a one-rare-word neighborhood explosion. Tuned
    // against the eval set (§8.5): false-positive tops measured ≈4.0,
    // legitimate tops ≥6.3 on the example vault.
    seedThreshold: 5.0,
    seedThresholdMinNodes: 50,
    seedK: 8,
    // Hub damp α (§5.5): validated by `brain tune` against both eval suites
    // (original held at 1.0; paraphrase placement is what it buys).
    degreeDampAlpha: 0.5,
  },
  pack: {
    fullRanks: 3,
    summaryRanks: 12,
    coldStartMinNodes: 5,
    // Query-anchored full-band eligibility (§5.5): seeds and their 1-hop
    // neighborhood may hold full slots; long-path hubs share one.
    fullEligibilityMaxHops: 1,
    hubFullCap: 1,
  },
  defaultBudget: 4000,
};
