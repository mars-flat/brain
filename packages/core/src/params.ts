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
    seedThreshold: 0.0,
    seedK: 8,
  },
  pack: {
    fullRanks: 3,
    summaryRanks: 12,
    coldStartMinNodes: 5,
  },
  defaultBudget: 4000,
};
