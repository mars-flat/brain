/**
 * `brain eval` (§8.5): run queries.yaml against a fresh in-memory index and
 * score recall, tier placement, and conflict surfacing. Deterministic by
 * construction — the clock is pinned in queries.yaml and the index is
 * rebuilt from markdown each run, so a committed baseline stays comparable
 * forever. CI runs `--check` and fails on regression.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BrainStore, loadVault, openDb, rebuild } from "@brain/brainstore";
import type { RenderTier } from "@brain/contracts";
import { DEFAULT_RECALL_PARAMS, type RecallParams, recall } from "@brain/core";

const TIER_RANK: Record<RenderTier, number> = { stub: 0, summary: 1, full: 2 };

interface QuerySpec {
  name: string;
  query: string;
  budget_tokens?: number;
  hops?: number;
  expect: Array<{ id: string; min_tier: RenderTier }>;
  expect_conflicts?: Array<[string, string]>;
}

interface EvalFile {
  defaults: { budget_tokens: number; hops: number; now?: string; recall_target?: number };
  queries: QuerySpec[];
}

export interface QueryResult {
  name: string;
  hits: number;
  expected: number;
  placed: number;
  conflictsOk: boolean;
  emptyOk: boolean | null;
  tokens: number;
  missing: string[];
  misplaced: string[];
}

export interface EvalReport {
  recall: number;
  placement: number;
  conflicts: number;
  queries: QueryResult[];
  now: string;
  recallTarget: number;
}

/** Pinned eval clock — recency must not drift with the wall calendar. */
const DEFAULT_EVAL_NOW = "2026-09-01T00:00:00Z";

export function runEval(vaultPath: string, params: RecallParams = DEFAULT_RECALL_PARAMS): EvalReport {
  const file = Bun.YAML.parse(
    readFileSync(join(vaultPath, "queries.yaml"), "utf8"),
  ) as unknown as EvalFile;
  const now = new Date(file.defaults.now ?? DEFAULT_EVAL_NOW);
  const recallTarget = file.defaults.recall_target ?? 0.9;

  const db = openDb(":memory:");
  rebuild(db, loadVault(vaultPath));
  const store = new BrainStore(db);

  const queries: QueryResult[] = [];
  for (const q of file.queries) {
    const out = recall(
      store,
      {
        query: q.query,
        budget_tokens: q.budget_tokens ?? file.defaults.budget_tokens,
        hops: q.hops ?? file.defaults.hops,
      },
      now,
      params,
    );
    const tiers = new Map(out.result.nodes.map((n) => [n.id, n.tier]));
    const expected = q.expect ?? [];

    if (expected.length === 0) {
      queries.push({
        name: q.name,
        hits: 0,
        expected: 0,
        placed: 0,
        conflictsOk: true,
        emptyOk: out.result.nodes.length === 0,
        tokens: out.result.pack.length,
        missing: [],
        misplaced: out.result.nodes.length ? out.result.nodes.map((n) => n.id) : [],
      });
      continue;
    }

    const missing: string[] = [];
    const misplaced: string[] = [];
    let hits = 0;
    let placed = 0;
    for (const e of expected) {
      const tier = tiers.get(e.id);
      if (tier === undefined) {
        missing.push(e.id);
        continue;
      }
      hits++;
      if (TIER_RANK[tier] >= TIER_RANK[e.min_tier]) placed++;
      else misplaced.push(`${e.id} (${tier} < ${e.min_tier})`);
    }
    const conflictKeys = new Set(out.result.conflicts.map((c) => `${c.a} ${c.b}`));
    const conflictsOk = (q.expect_conflicts ?? []).every(([x, y]) => {
      const [a, b] = x < y ? [x, y] : [y, x];
      return conflictKeys.has(`${a} ${b}`);
    });
    queries.push({
      name: q.name,
      hits,
      expected: expected.length,
      placed,
      conflictsOk,
      emptyOk: null,
      tokens: out.result.pack.length,
      missing,
      misplaced,
    });
  }

  const scored = queries.filter((q) => q.expected > 0);
  const emptyChecks = queries.filter((q) => q.emptyOk !== null);
  const recallNum =
    scored.reduce((s, q) => s + q.hits / q.expected, 0) +
    emptyChecks.reduce((s, q) => s + (q.emptyOk ? 1 : 0), 0);
  const recallDen = scored.length + emptyChecks.length;
  const placement = scored.length
    ? scored.reduce((s, q) => s + (q.hits ? q.placed / q.expected : 0), 0) / scored.length
    : 1;
  const conflicts = queries.filter((q) => q.conflictsOk).length / Math.max(1, queries.length);

  return {
    recall: recallDen ? recallNum / recallDen : 1,
    placement,
    conflicts,
    queries,
    now: now.toISOString(),
    recallTarget,
  };
}

export function formatReport(r: EvalReport): string {
  const lines: string[] = [];
  for (const q of r.queries) {
    const status =
      q.emptyOk !== null
        ? q.emptyOk
          ? "✓ empty"
          : "✗ NOT EMPTY"
        : q.missing.length === 0 && q.misplaced.length === 0 && q.conflictsOk
          ? "✓"
          : "✗";
    const detail = [
      q.expected ? `${q.hits}/${q.expected} found, ${q.placed} placed` : "",
      q.missing.length ? `missing: ${q.missing.join(", ")}` : "",
      q.misplaced.length ? `misplaced: ${q.misplaced.join(", ")}` : "",
      q.conflictsOk ? "" : "conflicts NOT surfaced",
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`  ${status.padEnd(12)} ${q.name.padEnd(28)} ${detail}`);
  }
  lines.push("");
  lines.push(
    `  recall ${r.recall.toFixed(4)} (target ${r.recallTarget}) · tier placement ${r.placement.toFixed(4)} · conflicts ${r.conflicts.toFixed(4)} · eval clock ${r.now}`,
  );
  return lines.join("\n");
}

export interface Baseline {
  recall: number;
  placement: number;
  conflicts: number;
  perQuery: Record<string, { hits: number; expected: number; placed: number }>;
}

export function toBaseline(r: EvalReport): Baseline {
  const perQuery: Baseline["perQuery"] = {};
  for (const q of r.queries)
    perQuery[q.name] = { hits: q.hits, expected: q.expected, placed: q.placed };
  return { recall: r.recall, placement: r.placement, conflicts: r.conflicts, perQuery };
}

/** Regression = any aggregate metric or any per-query hit/placement count dropping. */
export function regressions(baseline: Baseline, current: EvalReport): string[] {
  const out: string[] = [];
  const cur = toBaseline(current);
  const EPS = 1e-9;
  for (const key of ["recall", "placement", "conflicts"] as const) {
    if (cur[key] < baseline[key] - EPS)
      out.push(`${key} regressed: ${baseline[key].toFixed(4)} → ${cur[key].toFixed(4)}`);
  }
  for (const [name, b] of Object.entries(baseline.perQuery)) {
    const c = cur.perQuery[name];
    if (!c) {
      out.push(`query removed from eval set: ${name}`);
      continue;
    }
    if (c.hits < b.hits) out.push(`${name}: hits ${b.hits} → ${c.hits}`);
    if (c.placed < b.placed) out.push(`${name}: placement ${b.placed} → ${c.placed}`);
  }
  return out;
}
