/**
 * `brain eval --paraphrase` (§8.5): the adversarial paraphrase suite.
 *
 * Where the main eval asks "does retrieval work when the query shares words
 * with the answer?", this suite asks the question that decides the embedding
 * debate: "what happens when it doesn't?" It scores the seed stage and the
 * final pack separately — the gap between them is the recovery rate, the
 * direct measurement of the §1 bet that traversal over typed edges does the
 * semantic work BM25 can't.
 *
 * Expectations may carry `paraphrase: true`, which mechanically enforces
 * zero content-word overlap between the query and that node's indexed text
 * (title+aliases+tags+summary). The FTS index's own porter tokenizer is the
 * authority: a single-term MATCH restricted to the target row either hits or
 * it doesn't. A flagged node can therefore never be a seed — any pack
 * appearance is traversal recovery. Enforcement violations fail the run:
 * a suite whose queries secretly reach their targets measures nothing.
 *
 * Abstention queries (`expect: []`) probe calibration with vault-adjacent
 * vocabulary on foreign topics; correct behavior is an empty answer, never
 * a confident wrong pack.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BrainStore, loadVault, openDb, rebuild } from "@brain/brainstore";
import type { RenderTier } from "@brain/contracts";
import { contentTerms, DEFAULT_RECALL_PARAMS, type RecallParams, recall } from "@brain/core";

const TIER_RANK: Record<RenderTier, number> = { stub: 0, summary: 1, full: 2 };

interface ExpectSpec {
  id: string;
  min_tier: RenderTier;
  paraphrase?: boolean;
}

interface QuerySpec {
  name: string;
  query: string;
  budget_tokens?: number;
  hops?: number;
  expect: ExpectSpec[];
}

interface EvalFile {
  defaults: { budget_tokens: number; hops: number; now?: string };
  queries: QuerySpec[];
}

export interface ParaExpectResult {
  id: string;
  paraphrase: boolean;
  seeded: boolean;
  packed: boolean;
  tier: RenderTier | null;
  tierOk: boolean;
  /** Content terms that lexically reach this paraphrase target — must be empty. */
  overlapViolations: string[];
}

export interface ParaQueryResult {
  name: string;
  abstention: boolean;
  abstentionOk: boolean | null;
  /** Recall's graded confidence for this query (null on legacy packs). */
  confidence: "high" | "low" | "none" | null;
  /** Top raw -bm25 among in-graph seed hits, before thresholding. */
  bestSeedRaw: number;
  seedIds: string[];
  packIds: string[];
  expects: ParaExpectResult[];
}

export interface ParaReport {
  seedRecall: number;
  packRecall: number;
  paraphraseRecall: number;
  recoveryRate: number;
  placement: number;
  abstention: number;
  violations: Array<{ query: string; id: string; terms: string[] }>;
  queries: ParaQueryResult[];
  now: string;
  nodeCount: number;
}

const DEFAULT_EVAL_NOW = "2026-09-01T00:00:00Z";

export function runParaphraseEval(
  vaultPath: string,
  queriesFile?: string,
  params: RecallParams = DEFAULT_RECALL_PARAMS,
): ParaReport {
  const path = queriesFile ?? join(vaultPath, "queries-paraphrase.yaml");
  const file = Bun.YAML.parse(readFileSync(path, "utf8")) as unknown as EvalFile;
  const now = new Date(file.defaults.now ?? DEFAULT_EVAL_NOW);

  const db = openDb(":memory:");
  rebuild(db, loadVault(vaultPath));
  const store = new BrainStore(db);
  const nodeCount = (db.query("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;

  const reaches = db.query("SELECT 1 AS hit FROM nodes_fts WHERE nodes_fts MATCH ? AND id = ?");
  const termReaches = (term: string, id: string): boolean => reaches.get(term, id) !== null;

  const queries: ParaQueryResult[] = [];
  for (const q of file.queries) {
    // seed-recall measures lexical reachability@k — the raw top-k, before
    // any gating, so the metric is stable across abstention-policy changes.
    const hits = store.seedSearch(q.query, params.traversal.seedK);
    const bestSeedRaw = hits[0]?.raw ?? 0;
    const seedIds = hits.map((h) => h.id);

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

    const expects: ParaExpectResult[] = expected.map((e) => {
      const tier = tiers.get(e.id) ?? null;
      return {
        id: e.id,
        paraphrase: e.paraphrase ?? false,
        seeded: seedIds.includes(e.id),
        packed: tier !== null,
        tier,
        tierOk: tier !== null && TIER_RANK[tier] >= TIER_RANK[e.min_tier],
        overlapViolations: e.paraphrase
          ? contentTerms(q.query).filter((t) => termReaches(t, e.id))
          : [],
      };
    });

    // A garbage probe fails only when answered CONFIDENTLY — a hedged pack
    // (flattened, bannered) is the designed degradation, and an empty one
    // is the ideal. The measured harm was fabricated authority (§5.5).
    const abstentionOk =
      expected.length === 0
        ? out.result.confidence
          ? out.result.confidence !== "high"
          : out.result.nodes.length === 0
        : null;
    queries.push({
      name: q.name,
      abstention: expected.length === 0,
      abstentionOk,
      confidence: out.result.confidence ?? null,
      bestSeedRaw,
      seedIds,
      packIds: out.result.nodes.map((n) => n.id),
      expects,
    });
  }

  const allExpects = queries.flatMap((r) => r.expects);
  const flagged = allExpects.filter((e) => e.paraphrase);
  const unseeded = allExpects.filter((e) => !e.seeded);
  const abstentions = queries.filter((r) => r.abstention);
  const ratio = (num: number, den: number) => (den ? num / den : 1);

  return {
    seedRecall: ratio(allExpects.filter((e) => e.seeded).length, allExpects.length),
    packRecall: ratio(allExpects.filter((e) => e.packed).length, allExpects.length),
    paraphraseRecall: ratio(flagged.filter((e) => e.packed).length, flagged.length),
    recoveryRate: ratio(unseeded.filter((e) => e.packed).length, unseeded.length),
    placement: ratio(allExpects.filter((e) => e.tierOk).length, allExpects.length),
    abstention: ratio(abstentions.filter((r) => r.abstentionOk).length, abstentions.length),
    violations: queries.flatMap((r) =>
      r.expects
        .filter((e) => e.overlapViolations.length)
        .map((e) => ({ query: r.name, id: e.id, terms: e.overlapViolations })),
    ),
    queries,
    now: now.toISOString(),
    nodeCount,
  };
}

export function formatParaReport(r: ParaReport): string {
  const lines: string[] = [];
  for (const q of r.queries) {
    if (q.abstention) {
      const mark = q.abstentionOk
        ? q.confidence === "low"
          ? "✓ hedged"
          : "✓ abstained"
        : "✗ CONFIDENT";
      const spill = q.abstentionOk
        ? ""
        : ` → pack: ${q.packIds.slice(0, 4).join(", ")}${q.packIds.length > 4 ? " …" : ""}`;
      lines.push(
        `  ${mark.padEnd(13)} ${q.name.padEnd(28)} bestSeed=${q.bestSeedRaw.toFixed(2)}${spill}`,
      );
      continue;
    }
    const ok = q.expects.every((e) => e.packed && e.tierOk && !e.overlapViolations.length);
    lines.push(
      `  ${(ok ? "✓" : "✗").padEnd(13)} ${q.name.padEnd(28)} bestSeed=${q.bestSeedRaw.toFixed(2)}`,
    );
    for (const e of q.expects) {
      const bits = [
        e.paraphrase ? "¶" : " ",
        e.seeded ? "seeded" : "unseeded",
        e.packed ? `packed:${e.tier}${e.tierOk ? "" : " (below min_tier)"}` : "MISSING",
        e.overlapViolations.length ? `OVERLAP[${e.overlapViolations.join(",")}]` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(`        ${e.id.padEnd(36)} ${bits}`);
    }
  }
  lines.push("");
  lines.push(
    `  seed-recall ${r.seedRecall.toFixed(4)} · pack-recall ${r.packRecall.toFixed(4)} · ` +
      `¶-recall ${r.paraphraseRecall.toFixed(4)} · recovery ${r.recoveryRate.toFixed(4)} · ` +
      `placement ${r.placement.toFixed(4)} · abstention ${r.abstention.toFixed(4)}`,
  );
  lines.push(`  ${r.nodeCount} nodes · eval clock ${r.now}`);
  if (r.violations.length) {
    lines.push("");
    lines.push(
      `  ⚠ enforcement: ${r.violations.length} paraphrase target(s) lexically reachable — fix the queries:`,
    );
    for (const v of r.violations) lines.push(`      ${v.query} → ${v.id}: [${v.terms.join(", ")}]`);
  }
  return lines.join("\n");
}

export interface ParaBaseline {
  seedRecall: number;
  packRecall: number;
  paraphraseRecall: number;
  recoveryRate: number;
  placement: number;
  abstention: number;
  perQuery: Record<string, { packed: number; placed: number; abstentionOk: boolean | null }>;
}

export function toParaBaseline(r: ParaReport): ParaBaseline {
  const perQuery: ParaBaseline["perQuery"] = {};
  for (const q of r.queries) {
    perQuery[q.name] = {
      packed: q.expects.filter((e) => e.packed).length,
      placed: q.expects.filter((e) => e.tierOk).length,
      abstentionOk: q.abstentionOk,
    };
  }
  return {
    seedRecall: r.seedRecall,
    packRecall: r.packRecall,
    paraphraseRecall: r.paraphraseRecall,
    recoveryRate: r.recoveryRate,
    placement: r.placement,
    abstention: r.abstention,
    perQuery,
  };
}

/** Regression = any aggregate dropping, any per-query count dropping, or a correct abstention breaking. */
export function paraRegressions(baseline: ParaBaseline, current: ParaReport): string[] {
  const out: string[] = [];
  const cur = toParaBaseline(current);
  const EPS = 1e-9;
  for (const key of [
    "seedRecall",
    "packRecall",
    "paraphraseRecall",
    "recoveryRate",
    "placement",
    "abstention",
  ] as const) {
    if (cur[key] < baseline[key] - EPS)
      out.push(`${key} regressed: ${baseline[key].toFixed(4)} → ${cur[key].toFixed(4)}`);
  }
  for (const [name, b] of Object.entries(baseline.perQuery)) {
    const c = cur.perQuery[name];
    if (!c) {
      out.push(`query removed from paraphrase suite: ${name}`);
      continue;
    }
    if (c.packed < b.packed) out.push(`${name}: packed ${b.packed} → ${c.packed}`);
    if (c.placed < b.placed) out.push(`${name}: placed ${b.placed} → ${c.placed}`);
    if (b.abstentionOk === true && c.abstentionOk === false) out.push(`${name}: abstention broke`);
  }
  return out;
}
