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
    // Legacy θ_seed on raw -bm25 of the BEST hit — now only the FALLBACK for
    // an index with no stored calibration (§5.5). The abstention score
    // replaced it: real-query and garbage tops overlapped (4.2–4.6 vs 5.5).
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
  // Chosen by `brain tune` (2026-08-31, 1620-candidate grid, 95 feasible):
  // best feasible objective 3.67 — ¶-recall 1.0, recovery 1.0, placement
  // 1.0, abstention 2/3 on the paraphrase suite, original suite held at
  // 1.0 as the hard constraint. The one leaked probe is coverage-carried
  // (its words genuinely appear in the vault) and lands hedged, not
  // confident. Rerun `brain tune` before touching any of these.
  abstention: {
    wZ: 0.5,
    wCoverage: 1.0,
    wCohesion: 0.5,
    wHubFrac: 0.5,
    tauLow: 2.0,
    tauHigh: 2.5,
  },
  defaultBudget: 4000,
};
