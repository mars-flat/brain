/**
 * Entity resolution without embeddings (§5.7): three cheap signals in
 * order — exact id/alias match → FTS5 BM25 on title+aliases → trigram
 * similarity over titles. Ambiguity above a threshold goes to quarantine
 * rather than guessing. Pure decision logic; the caller supplies the FTS
 * matches.
 */

import type { NodeType } from "@brain/contracts";
import { titleSimilarity } from "./trigram.ts";

export interface ExistingNodeRef {
  id: string;
  title: string;
  aliases: string[];
  type: NodeType;
}

export interface ResolutionInput {
  idHint: string;
  title: string;
  aliases: string[];
  type: NodeType;
}

export type Resolution =
  | { kind: "existing"; id: string; via: "id" | "alias" | "similarity" }
  | { kind: "new"; id: string }
  | { kind: "ambiguous"; options: string[]; reason: string };

export interface ResolveParams {
  /** Similarity at or above this merges into the existing node (§5.9 uses the same 0.85). */
  mergeThreshold: number;
  /** Similarity in [ambiguousThreshold, mergeThreshold) quarantines rather than guessing. */
  ambiguousThreshold: number;
}

export const DEFAULT_RESOLVE_PARAMS: ResolveParams = {
  mergeThreshold: 0.85,
  ambiguousThreshold: 0.6,
};

export function resolveCandidate(
  cand: ResolutionInput,
  existingById: Map<string, ExistingNodeRef>,
  aliasIndex: Map<string, string[]>,
  ftsMatches: ExistingNodeRef[],
  takenIds: Set<string>,
  params: ResolveParams = DEFAULT_RESOLVE_PARAMS,
): Resolution {
  // 1 — exact id.
  const byId = existingById.get(cand.idHint);
  if (byId) {
    if (byId.type === cand.type) return { kind: "existing", id: byId.id, via: "id" };
    return {
      kind: "ambiguous",
      options: [byId.id],
      reason: `id "${cand.idHint}" exists with type ${byId.type}, candidate is ${cand.type}`,
    };
  }

  // 2 — alias (candidate title or aliases against the existing alias table).
  const aliasHits = new Set<string>();
  for (const needle of [cand.title, ...cand.aliases]) {
    for (const id of aliasIndex.get(needle.toLowerCase()) ?? []) aliasHits.add(id);
  }
  if (aliasHits.size === 1) {
    const id = [...aliasHits][0] as string;
    const hit = existingById.get(id);
    if (hit && hit.type === cand.type) return { kind: "existing", id, via: "alias" };
    return {
      kind: "ambiguous",
      options: [id],
      reason: `alias matches ${id} of type ${hit?.type ?? "?"}, candidate is ${cand.type}`,
    };
  }
  if (aliasHits.size > 1) {
    return {
      kind: "ambiguous",
      options: [...aliasHits].sort(),
      reason: "alias matches multiple existing nodes",
    };
  }

  // 3 — FTS candidates verified by trigram similarity, same type only.
  let best: { id: string; sim: number } | null = null;
  for (const m of ftsMatches) {
    if (m.type !== cand.type) continue;
    const sim = Math.max(
      titleSimilarity(cand.title, m.title),
      ...m.aliases.map((a) => titleSimilarity(cand.title, a)),
    );
    if (!best || sim > best.sim || (sim === best.sim && m.id < best.id)) best = { id: m.id, sim };
  }
  if (best) {
    if (best.sim >= params.mergeThreshold)
      return { kind: "existing", id: best.id, via: "similarity" };
    if (best.sim >= params.ambiguousThreshold)
      return {
        kind: "ambiguous",
        options: [best.id],
        reason: `title similarity ${best.sim.toFixed(2)} to ${best.id} — too close to guess`,
      };
  }

  // New node: deterministic unique id from the hint.
  let id = cand.idHint;
  for (let n = 2; takenIds.has(id); n++) id = `${cand.idHint}-${n}`;
  return { kind: "new", id };
}

/** kebab-case a title into an id hint. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "node";
}
