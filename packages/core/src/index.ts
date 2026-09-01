export {
  type EdgeAddition,
  type ExtractedCandidate,
  type MergePlan,
  type PlanContext,
  type PlannedNode,
  planMerge,
  type QuarantinedCandidate,
} from "./consolidate.ts";
export {
  type DuplicatePair,
  decaySalience,
  findBrokenLinks,
  findMissingPinTargets,
  findNearDuplicates,
  findOrphans,
  formatProposalFile,
  type LintFinding,
} from "./lint.ts";
export { type PackedEntry, type PackResult, pack, type Tier } from "./pack.ts";
export { DEFAULT_RECALL_PARAMS } from "./params.ts";
export {
  type ComposedDecision,
  decide,
  evaluatePolicy,
  globToRegExp,
  type PolicyDecision,
  type PolicyRequest,
  stricterEffect,
  trustMatrixEffect,
} from "./policy.ts";
export {
  contentTerms,
  QUERY_STOPWORDS,
  type RecallOutcome,
  recall,
  sanitizeQueryTerms,
  toFtsQuery,
} from "./recall.ts";
export {
  DEFAULT_RESOLVE_PARAMS,
  type ExistingNodeRef,
  type Resolution,
  type ResolutionInput,
  type ResolveParams,
  resolveCandidate,
  slugify,
} from "./resolve.ts";
export { estimateTokens } from "./tokens.ts";
export {
  ageDays,
  buildAdjacency,
  type ScoredNode,
  terminalSuccessor,
  traverse,
} from "./traverse.ts";
export { jaccard, titleSimilarity, trigrams } from "./trigram.ts";
export type {
  GraphNode,
  GraphSlice,
  PackParams,
  PinInfo,
  RecallParams,
  RecallStore,
  TraversalParams,
} from "./types.ts";
