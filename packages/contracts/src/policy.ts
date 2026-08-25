/**
 * The policy document (§4.5): an ordered rule list, first match wins,
 * default is `confirm` not `deny`. Mirrors policy.schema.json, plus two
 * rules the schema can't fully express: exactly one default rule (the
 * schema does enforce this via contains) and the default must be LAST —
 * anything after it is dead under first-match-wins.
 *
 * Precedence with OAuth scopes (§4.3): scopes are checked first at the
 * protocol layer; policy is evaluated second and can only narrow, never
 * widen.
 */

import { TRUST_TIERS, type TrustTier } from "./episode.ts";
import { Checker, fail, type GuardResult, isRecord } from "./validate.ts";

export const POLICY_EFFECTS = ["allow", "confirm", "deny"] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

export const TOOL_KINDS = ["read", "write", "admin"] as const;
/** Risk class of a tool: read-only, mutating, or destructive/shell (§4.3 scope tiers). */
export type ToolKind = (typeof TOOL_KINDS)[number];

export interface PolicyMatch {
  /** URN glob(s): "brain.*", "*.delete_*". */
  tool?: string | string[];
  kind?: ToolKind | ToolKind[];
  surface?: string | string[];
  principal?: string | string[];
  trust?: TrustTier | TrustTier[];
}

export interface MatchRule {
  match: PolicyMatch;
  effect: PolicyEffect;
  reason?: string;
}

export interface DefaultRule {
  default: PolicyEffect;
}

export type PolicyRule = MatchRule | DefaultRule;
export type PolicyDocument = PolicyRule[];

export function isDefaultRule(rule: PolicyRule): rule is DefaultRule {
  return "default" in rule;
}

const MATCH_KEYS = ["tool", "kind", "surface", "principal", "trust"] as const;

export function validatePolicy(value: unknown): GuardResult<PolicyDocument> {
  if (!Array.isArray(value)) return fail(["/: expected array of rules"]);
  if (value.length === 0) return fail(["/: expected at least one rule"]);
  const c = new Checker();

  let defaultCount = 0;
  value.forEach((rule, i) => {
    const path = `/${i}`;
    if (!isRecord(rule)) {
      c.fail(path, "expected object");
      return;
    }
    if ("default" in rule) {
      defaultCount++;
      c.enum(`${path}/default`, rule.default, POLICY_EFFECTS);
      c.noExtraKeys(path, rule, ["default"]);
      if (i !== value.length - 1)
        c.fail(path, "default rule must be last — rules after it are dead (first match wins)");
      return;
    }
    if (!isRecord(rule.match)) {
      c.fail(`${path}/match`, "expected object");
    } else {
      const m = rule.match;
      if (Object.keys(m).length === 0) c.fail(`${path}/match`, "must constrain at least one field");
      if (m.tool !== undefined) checkStringOrList(c, `${path}/match/tool`, m.tool);
      if (m.kind !== undefined) checkEnumOrList(c, `${path}/match/kind`, m.kind, TOOL_KINDS);
      if (m.surface !== undefined) checkStringOrList(c, `${path}/match/surface`, m.surface);
      if (m.principal !== undefined) checkStringOrList(c, `${path}/match/principal`, m.principal);
      if (m.trust !== undefined) checkEnumOrList(c, `${path}/match/trust`, m.trust, TRUST_TIERS);
      c.noExtraKeys(`${path}/match`, m, MATCH_KEYS);
    }
    c.enum(`${path}/effect`, rule.effect, POLICY_EFFECTS);
    if (rule.reason !== undefined && typeof rule.reason !== "string")
      c.fail(`${path}/reason`, "expected string");
    c.noExtraKeys(path, rule, ["match", "effect", "reason"]);
  });

  if (defaultCount === 0)
    c.fail("/", "missing default rule — every policy needs an explicit fallthrough");
  if (defaultCount > 1) c.fail("/", `expected exactly one default rule, found ${defaultCount}`);

  return c.result(value as PolicyDocument);
}

function checkStringOrList(c: Checker, path: string, v: unknown): void {
  if (typeof v === "string") {
    c.string(path, v, { minLength: 1 });
  } else {
    c.stringArray(path, v, { minLength: 1, minItems: 1, unique: false });
  }
}

function checkEnumOrList<const T extends readonly string[]>(
  c: Checker,
  path: string,
  v: unknown,
  allowed: T,
): void {
  if (typeof v === "string") {
    c.enum(path, v, allowed);
  } else if (Array.isArray(v)) {
    if (v.length === 0) c.fail(path, "expected at least 1 item");
    v.forEach((item, i) => {
      c.enum(`${path}/${i}`, item, allowed);
    });
  } else {
    c.fail(path, "expected value or array");
  }
}
