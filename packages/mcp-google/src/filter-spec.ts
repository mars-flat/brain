/**
 * A declarative Gmail filter spec (2026-09-18): one YAML file per account
 * in the private vault (`config/gmail-filters/<account>.yaml` — the real
 * one carries the owner's institutional addresses, so it never lives in
 * this repo; `examples/vault-example` has the synthetic shape). Rules are
 * deterministic Gmail searches with a label and/or archive action, and
 * `scripts/gmail-filters.ts` reconciles them against the account: labels
 * created if missing, filters created if no identical one exists, an
 * optional backfill relabelling existing matches. Everything here is pure
 * so the reconciliation is testable without an API.
 *
 * Why `query` rather than `from:`: mail auto-forwarded by an Outlook rule
 * arrives *from the forwarding mailbox*; the original sender survives only
 * as quoted text in the body ("From: someone@…"). Gmail's `query` criterion
 * searches the body, so a rule can key on that text — the one deterministic
 * signal such a message carries.
 */

import type { FilterAction, FilterCriteria, Label, MailFilter } from "./gmail.ts";

export interface FilterRule {
  /** Human name, unique within the spec; used in plans and logs only. */
  name: string;
  /** Gmail search syntax — exactly what the filter's `criteria.query` will be. */
  query: string;
  /** Label to add (nested with `/`); created if missing. */
  label?: string;
  /** Remove INBOX on match. */
  archive?: boolean;
  /** Remove UNREAD on match. */
  mark_read?: boolean;
}

export interface FilterSpec {
  account: string;
  rules: FilterRule[];
}

export class SpecError extends Error {}

/** Validate a parsed YAML document into a spec, failing on the first defect. */
export function parseFilterSpec(doc: unknown): FilterSpec {
  if (!doc || typeof doc !== "object") throw new SpecError("spec must be a mapping");
  const d = doc as Record<string, unknown>;
  if (typeof d.account !== "string" || !d.account.trim())
    throw new SpecError("spec.account is required");
  if (!Array.isArray(d.rules) || d.rules.length === 0)
    throw new SpecError("spec.rules must be a non-empty list");
  const names = new Set<string>();
  const rules: FilterRule[] = d.rules.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new SpecError(`rules[${i}] must be a mapping`);
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) throw new SpecError(`rules[${i}].name is required`);
    if (names.has(name)) throw new SpecError(`duplicate rule name "${name}"`);
    names.add(name);
    const query = typeof r.query === "string" ? r.query.trim() : "";
    if (!query) throw new SpecError(`rule "${name}": query is required`);
    const label = typeof r.label === "string" ? r.label.trim() : undefined;
    if (label !== undefined && !label) throw new SpecError(`rule "${name}": label is empty`);
    if (label && /^(INBOX|UNREAD|SPAM|TRASH|STARRED|IMPORTANT|SENT|DRAFT)$/i.test(label))
      throw new SpecError(`rule "${name}": "${label}" is a system label`);
    const archive = r.archive === true;
    const markRead = r.mark_read === true;
    if (!label && !archive && !markRead)
      throw new SpecError(`rule "${name}": needs a label, archive: true, or mark_read: true`);
    for (const k of Object.keys(r))
      if (!["name", "query", "label", "archive", "mark_read"].includes(k))
        throw new SpecError(`rule "${name}": unknown key "${k}"`);
    return {
      name,
      query,
      ...(label ? { label } : {}),
      ...(archive ? { archive } : {}),
      ...(markRead ? { mark_read: markRead } : {}),
    };
  });
  return { account: d.account.trim(), rules };
}

/** Every label the spec needs, in first-use order (parents before children is not required by Gmail). */
export function specLabels(spec: FilterSpec): string[] {
  const out: string[] = [];
  for (const r of spec.rules) if (r.label && !out.includes(r.label)) out.push(r.label);
  return out;
}

export interface PlannedFilter {
  rule: FilterRule;
  criteria: FilterCriteria;
  action: FilterAction;
  /** Id of an identical existing filter, when one exists. */
  existing?: string;
}

export interface FilterPlan {
  /** Label names to create before any filter that needs them. */
  createLabels: string[];
  filters: PlannedFilter[];
  /** Existing filters no rule accounts for — reported, never deleted. */
  unmanaged: MailFilter[];
}

const sorted = (xs: string[] | undefined) => [...(xs ?? [])].sort();
const sameAction = (a: FilterAction, b: FilterAction) =>
  sorted(a.add_label_ids).join(",") === sorted(b.add_label_ids).join(",") &&
  sorted(a.remove_label_ids).join(",") === sorted(b.remove_label_ids).join(",");
const sameCriteria = (a: FilterCriteria, b: FilterCriteria) =>
  (a.query ?? "") === (b.query ?? "") &&
  !a.from &&
  !b.from &&
  !a.to &&
  !b.to &&
  !a.subject &&
  !b.subject &&
  !a.negated_query &&
  !b.negated_query;

/**
 * Reconcile: which labels are missing, which rules already have an
 * identical filter, which existing filters nothing in the spec explains.
 * Label ids for not-yet-created labels are left as the label NAME prefixed
 * with `name:` — the applier swaps them once the labels exist.
 */
export function planFilters(
  spec: FilterSpec,
  existingLabels: Label[],
  existingFilters: MailFilter[],
): FilterPlan {
  const byName = new Map(existingLabels.map((l) => [l.name, l.id]));
  const createLabels = specLabels(spec).filter((n) => !byName.has(n));
  const labelId = (name: string) => byName.get(name) ?? `name:${name}`;
  const claimed = new Set<string>();
  const filters: PlannedFilter[] = spec.rules.map((rule) => {
    const criteria: FilterCriteria = { query: rule.query };
    const action: FilterAction = {
      ...(rule.label ? { add_label_ids: [labelId(rule.label)] } : {}),
      ...(rule.archive || rule.mark_read
        ? {
            remove_label_ids: [
              ...(rule.archive ? ["INBOX"] : []),
              ...(rule.mark_read ? ["UNREAD"] : []),
            ],
          }
        : {}),
    };
    const match = existingFilters.find(
      (f) =>
        !claimed.has(f.id) && sameCriteria(f.criteria, criteria) && sameAction(f.action, action),
    );
    if (match) claimed.add(match.id);
    return { rule, criteria, action, ...(match ? { existing: match.id } : {}) };
  });
  return {
    createLabels,
    filters,
    unmanaged: existingFilters.filter((f) => !claimed.has(f.id)),
  };
}

/** After labels exist: replace `name:<label>` placeholders with real ids. */
export function resolveLabelIds(plan: FilterPlan, labels: Label[]): FilterPlan {
  const byName = new Map(labels.map((l) => [l.name, l.id]));
  const swap = (ids: string[] | undefined) =>
    ids?.map((id) => {
      if (!id.startsWith("name:")) return id;
      const real = byName.get(id.slice(5));
      if (!real) throw new SpecError(`label "${id.slice(5)}" still missing after creation`);
      return real;
    });
  return {
    ...plan,
    filters: plan.filters.map((f) => ({
      ...f,
      action: {
        ...(f.action.add_label_ids ? { add_label_ids: swap(f.action.add_label_ids) } : {}),
        ...(f.action.remove_label_ids ? { remove_label_ids: swap(f.action.remove_label_ids) } : {}),
      },
    })),
  };
}

/** The backfill search for a rule: its query, windowed so old, already-sorted mail is untouched. */
export function backfillQuery(rule: FilterRule, since: string): string {
  return `${rule.query} newer_than:${since}`;
}
