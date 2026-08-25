/**
 * Merge planning (§5.7): pure translation of extracted candidates +
 * resolutions into a plan the consolidator executes. The load-bearing
 * rules:
 *
 *  - The consolidator NEVER rewrites existing node content. It creates
 *    nodes, appends edges/sources to existing frontmatter, and flips
 *    status to superseded — superseding is the documented way to change a
 *    decision (§5.10).
 *  - Pins survive: a candidate whose plan would supersede or status-flip a
 *    pinned node goes to quarantine, never through (§5.7).
 *  - Trust gates memory (§6.5): only high-trust episodes write directly;
 *    medium/low quarantine everything; untrusted never reaches this code.
 *  - Low confidence quarantines (§5.7).
 */

import type {
  Confidence,
  EdgeRelation,
  NodeFrontmatter,
  NodeType,
  TrustTier,
} from "@brain/contracts";
import { EDGE_RELATIONS } from "@brain/contracts";
import type { Resolution } from "./resolve.ts";

export interface ExtractedCandidate {
  type: NodeType;
  title: string;
  id_hint: string;
  aliases: string[];
  tags: string[];
  summary: string;
  detail: string;
  confidence: Confidence;
  edges: Array<{ rel: EdgeRelation; target: string }>;
}

export interface PlannedNode {
  fm: NodeFrontmatter;
  body: string;
}

export interface EdgeAddition {
  nodeId: string;
  rel: EdgeRelation | "sources";
  /** Bare basename target (node id or episode basename). */
  target: string;
}

export interface QuarantinedCandidate {
  candidate: ExtractedCandidate;
  reason: string;
}

export interface MergePlan {
  newNodes: PlannedNode[];
  /** Frontmatter appends on EXISTING nodes (plus an `updated` bump). */
  edgeAdditions: EdgeAddition[];
  statusChanges: Array<{ nodeId: string; to: "superseded" }>;
  quarantined: QuarantinedCandidate[];
  warnings: string[];
}

export interface PlanContext {
  today: string; // YYYY-MM-DD, from the injected clock
  episodeBasename: string;
  trust: TrustTier;
  /** Ids of pinned nodes — changes against them quarantine. */
  pinnedIds: Set<string>;
  /** Existing node ids (for edge-target resolution). */
  existingIds: Set<string>;
  /** Existing alias (lowercased) → node id, unambiguous entries only. */
  aliasToId: Map<string, string>;
  /** Existing edges as "from rel to" strings, for idempotent no-ops. */
  existingEdgeKeys: Set<string>;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function planMerge(
  candidates: ExtractedCandidate[],
  resolutions: Resolution[],
  ctx: PlanContext,
): MergePlan {
  const plan: MergePlan = {
    newNodes: [],
    edgeAdditions: [],
    statusChanges: [],
    quarantined: [],
    warnings: [],
  };

  if (ctx.trust === "untrusted") {
    plan.warnings.push("untrusted episode reached planMerge — dropping everything");
    return plan;
  }
  const quarantineAll = ctx.trust !== "high";

  // Final id per candidate index (for cross-candidate edge targets).
  const finalId = new Map<number, string>();
  resolutions.forEach((r, i) => {
    if (r?.kind === "existing" || r?.kind === "new") finalId.set(i, r.id);
  });
  const hintToIndex = new Map<string, number>();
  candidates.forEach((cand, i) => {
    if (!hintToIndex.has(cand.id_hint)) hintToIndex.set(cand.id_hint, i);
  });

  const resolveTarget = (target: string): string | null => {
    const viaHint = hintToIndex.get(target);
    if (viaHint !== undefined && finalId.has(viaHint)) return finalId.get(viaHint) as string;
    if (ctx.existingIds.has(target)) return target;
    const viaAlias = ctx.aliasToId.get(target.toLowerCase());
    if (viaAlias) return viaAlias;
    return null;
  };

  candidates.forEach((cand, i) => {
    const r = resolutions[i];
    if (!r) return;

    if (quarantineAll) {
      plan.quarantined.push({
        candidate: cand,
        reason: `episode trust is ${ctx.trust} — memory writes quarantine (§6.5)`,
      });
      return;
    }
    if (r.kind === "ambiguous") {
      plan.quarantined.push({ candidate: cand, reason: `ambiguous resolution: ${r.reason}` });
      return;
    }
    if (CONFIDENCE_RANK[cand.confidence] < CONFIDENCE_RANK.medium) {
      plan.quarantined.push({ candidate: cand, reason: "low-confidence extraction (§5.7)" });
      return;
    }

    // Resolve this candidate's edges; a supersedes/status change against a
    // pinned target quarantines the whole candidate.
    const resolvedEdges: Array<{ rel: EdgeRelation; target: string }> = [];
    let pinViolation: string | null = null;
    for (const e of cand.edges) {
      if (!EDGE_RELATIONS.includes(e.rel)) {
        plan.warnings.push(`${cand.id_hint}: unknown relation ${String(e.rel)} dropped`);
        continue;
      }
      const target = resolveTarget(e.target);
      if (!target) {
        plan.warnings.push(`${cand.id_hint}: edge ${e.rel} → unresolved "${e.target}" dropped`);
        continue;
      }
      if (e.rel === "supersedes" && ctx.pinnedIds.has(target)) {
        pinViolation = target;
        break;
      }
      resolvedEdges.push({ rel: e.rel, target });
    }
    if (pinViolation) {
      plan.quarantined.push({
        candidate: cand,
        reason: `would supersede pinned node ${pinViolation} — pins survive (§5.7)`,
      });
      return;
    }

    if (r.kind === "existing") {
      // Known thing re-mentioned: append provenance + any genuinely new edges.
      const additions: EdgeAddition[] = [
        { nodeId: r.id, rel: "sources", target: ctx.episodeBasename },
        ...resolvedEdges
          .filter((e) => e.target !== r.id)
          .map((e) => ({ nodeId: r.id, rel: e.rel, target: e.target }) as EdgeAddition),
      ];
      for (const a of additions) {
        const key = `${a.nodeId} ${a.rel} ${a.target}`;
        if (!ctx.existingEdgeKeys.has(key)) {
          plan.edgeAdditions.push(a);
          ctx.existingEdgeKeys.add(key);
        }
      }
      for (const e of resolvedEdges) {
        if (e.rel === "supersedes" && ctx.existingIds.has(e.target)) {
          plan.statusChanges.push({ nodeId: e.target, to: "superseded" });
        }
      }
      return;
    }

    // New node.
    const edgeProps: Partial<Record<EdgeRelation, string[]>> = {};
    for (const e of resolvedEdges) {
      const list = edgeProps[e.rel] ?? [];
      if (!list.includes(`[[${e.target}]]`)) list.push(`[[${e.target}]]`);
      edgeProps[e.rel] = list;
    }
    const fm: NodeFrontmatter = {
      id: r.id,
      type: cand.type,
      title: cand.title,
      ...(cand.aliases.length ? { aliases: cand.aliases } : {}),
      ...(cand.tags.length ? { tags: cand.tags } : {}),
      created: ctx.today,
      updated: ctx.today,
      status: "active",
      confidence: cand.confidence,
      provenance: "trusted",
      sources: [`[[${ctx.episodeBasename}]]`],
      summary: cand.summary,
      ...edgeProps,
    };
    plan.newNodes.push({ fm, body: cand.detail ? `## Detail\n\n${cand.detail}` : "" });
    for (const e of resolvedEdges) {
      if (e.rel === "supersedes" && ctx.existingIds.has(e.target)) {
        plan.statusChanges.push({ nodeId: e.target, to: "superseded" });
      }
    }
  });

  // Dedupe status changes deterministically.
  plan.statusChanges = [...new Map(plan.statusChanges.map((s) => [s.nodeId, s])).values()].sort(
    (a, b) => a.nodeId.localeCompare(b.nodeId),
  );
  return plan;
}
