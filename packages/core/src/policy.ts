/**
 * Policy evaluation (§4.5), pure. First match wins; the default rule is
 * guaranteed last by validatePolicy. Two layers compose in the gateway:
 *
 *   1. The §6.5 trust matrix — what this SURFACE TIER may ever do — as a
 *      built-in baseline.
 *   2. The user's policy.yaml — what this CALL may do right now.
 *
 * The composed effect is the STRICTER of the two (deny > confirm > allow):
 * policy can narrow the matrix, never widen it — the same one-way rule
 * scopes get in §4.3.
 */

import type {
  PolicyDocument,
  PolicyEffect,
  PolicyMatch,
  ToolKind,
  TrustTier,
} from "@brain/contracts";

export interface PolicyRequest {
  urn: string;
  kind: ToolKind;
  surface: string;
  principal: string;
  trust: TrustTier;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  /** Index of the deciding rule in the document; the default rule for fallthrough. */
  ruleIndex: number;
  isDefault: boolean;
  reason?: string;
}

/** `brain.*` / `*.delete_*` style globs — `*` is the only metacharacter (§4.4 URNs). */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function asList<T>(v: T | T[] | undefined): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function matches(match: PolicyMatch, req: PolicyRequest): boolean {
  const tool = asList(match.tool);
  if (tool && !tool.some((g) => globToRegExp(g).test(req.urn))) return false;
  const kind = asList(match.kind);
  if (kind && !kind.includes(req.kind)) return false;
  const surface = asList(match.surface);
  if (surface && !surface.includes(req.surface)) return false;
  const principal = asList(match.principal);
  if (principal && !principal.includes(req.principal)) return false;
  const trust = asList(match.trust);
  if (trust && !trust.includes(req.trust)) return false;
  return true;
}

export function evaluatePolicy(doc: PolicyDocument, req: PolicyRequest): PolicyDecision {
  for (let i = 0; i < doc.length; i++) {
    const rule = doc[i];
    if (!rule) continue;
    if ("default" in rule) {
      return { effect: rule.default, ruleIndex: i, isDefault: true };
    }
    if (matches(rule.match, req)) {
      return { effect: rule.effect, ruleIndex: i, isDefault: false, reason: rule.reason };
    }
  }
  // validatePolicy guarantees a default rule; this is the defensive floor.
  return { effect: "confirm", ruleIndex: -1, isDefault: true, reason: "implicit confirm" };
}

const EFFECT_STRICTNESS: Record<PolicyEffect, number> = { allow: 0, confirm: 1, deny: 2 };

/** deny > confirm > allow — the composition can only narrow (§4.3). */
export function stricterEffect(a: PolicyEffect, b: PolicyEffect): PolicyEffect {
  return EFFECT_STRICTNESS[a] >= EFFECT_STRICTNESS[b] ? a : b;
}

/**
 * The §6.5 trust matrix as effects. "Memory writes → quarantine" is the
 * consolidator's concern (§5.7); at the tool layer medium/low mean
 * confirm-writes and deny-admin. Untrusted never reaches evaluation — the
 * router drops it — but the matrix says deny anyway.
 */
export function trustMatrixEffect(trust: TrustTier, kind: ToolKind): PolicyEffect {
  switch (trust) {
    case "high":
      return "allow";
    case "medium":
    case "low":
      return kind === "read" ? "allow" : kind === "write" ? "confirm" : "deny";
    case "untrusted":
      return "deny";
  }
}

export interface ComposedDecision extends PolicyDecision {
  matrixEffect: PolicyEffect;
  policyEffect: PolicyEffect;
}

export function decide(doc: PolicyDocument, req: PolicyRequest): ComposedDecision {
  const policy = evaluatePolicy(doc, req);
  const matrix = trustMatrixEffect(req.trust, req.kind);
  return {
    ...policy,
    matrixEffect: matrix,
    policyEffect: policy.effect,
    effect: stricterEffect(matrix, policy.effect),
  };
}
