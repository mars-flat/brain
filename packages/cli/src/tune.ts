/**
 * `brain tune` (§8.5): parameter sweep for the retrieval dials.
 *
 * Six abstention coefficients cannot be picked by hand — the features trade
 * off against each other (raising coverage weight rescues obscurely-phrased
 * real questions AND lets partially-matching garbage through). The sweep
 * searches a coarse grid under a hard constraint: the ORIGINAL suite must
 * hold a perfect score — the easy cases are non-negotiable — and among
 * feasible candidates maximizes the paraphrase suite's aggregate
 * (¶-recall + recovery + placement + abstention). Ties break toward the
 * current defaults, then by lexicographic parameter order, so reruns are
 * deterministic and stable.
 *
 * Output goes to stdout plus a JSON report with provenance; the chosen
 * values are applied to DEFAULT_RECALL_PARAMS by hand and gated forever
 * after by the two CI eval baselines. Grid evals rebuild the in-memory
 * index each time — ~60ms per candidate on the example vault, minutes at
 * worst. No model, no network.
 */

import { DEFAULT_RECALL_PARAMS, type RecallParams } from "@brain/core";
import { runEval } from "./eval.ts";
import { runParaphraseEval } from "./eval-paraphrase.ts";

export interface TuneCandidate {
  wZ: number;
  wCoverage: number;
  wCohesion: number;
  wHubFrac: number;
  tauLow: number;
  tauHigh: number;
}

export interface TuneResult {
  candidate: TuneCandidate;
  feasible: boolean;
  objective: number;
  paraphrase: {
    paraphraseRecall: number;
    recoveryRate: number;
    placement: number;
    abstention: number;
  };
}

export interface TuneReport {
  vault: string;
  evaluated: number;
  feasible: number;
  best: TuneResult | null;
  current: TuneResult;
  top: TuneResult[];
}

const GRID: Record<keyof TuneCandidate, number[]> = {
  wZ: [0.5, 1.0, 1.5],
  wCoverage: [1.0, 2.0, 3.0, 4.0],
  wCohesion: [0, 0.5, 1.0],
  wHubFrac: [0, 0.5, 1.0],
  tauLow: [0.5, 1.0, 1.5, 2.0, 2.5],
  tauHigh: [0.5, 1.0, 1.5], // offset above tauLow
};

function withCandidate(c: TuneCandidate): RecallParams {
  return {
    ...DEFAULT_RECALL_PARAMS,
    abstention: {
      wZ: c.wZ,
      wCoverage: c.wCoverage,
      wCohesion: c.wCohesion,
      wHubFrac: c.wHubFrac,
      tauLow: c.tauLow,
      tauHigh: c.tauHigh,
    },
  };
}

function evaluate(vault: string, c: TuneCandidate): TuneResult {
  const params = withCandidate(c);
  const orig = runEval(vault, params);
  const para = runParaphraseEval(vault, undefined, params);
  const feasible =
    orig.recall >= 1 - 1e-9 && orig.placement >= 1 - 1e-9 && orig.conflicts >= 1 - 1e-9;
  return {
    candidate: c,
    feasible,
    objective: para.paraphraseRecall + para.recoveryRate + para.placement + para.abstention,
    paraphrase: {
      paraphraseRecall: para.paraphraseRecall,
      recoveryRate: para.recoveryRate,
      placement: para.placement,
      abstention: para.abstention,
    },
  };
}

const keyOf = (c: TuneCandidate): string =>
  [c.wZ, c.wCoverage, c.wCohesion, c.wHubFrac, c.tauLow, c.tauHigh].join("|");

export function runTune(
  vault: string,
  onProgress?: (done: number, total: number) => void,
): TuneReport {
  const candidates: TuneCandidate[] = [];
  for (const wZ of GRID.wZ)
    for (const wCoverage of GRID.wCoverage)
      for (const wCohesion of GRID.wCohesion)
        for (const wHubFrac of GRID.wHubFrac)
          for (const tauLow of GRID.tauLow)
            for (const dHigh of GRID.tauHigh)
              candidates.push({
                wZ,
                wCoverage,
                wCohesion,
                wHubFrac,
                tauLow,
                tauHigh: tauLow + dHigh,
              });

  const d = DEFAULT_RECALL_PARAMS.abstention;
  const currentCandidate: TuneCandidate = { ...d };
  const currentKey = keyOf(currentCandidate);

  const results: TuneResult[] = [];
  let done = 0;
  for (const c of candidates) {
    results.push(evaluate(vault, c));
    onProgress?.(++done, candidates.length);
  }
  const current =
    results.find((r) => keyOf(r.candidate) === currentKey) ?? evaluate(vault, currentCandidate);

  const feasible = results.filter((r) => r.feasible);
  // Deterministic order: objective desc, then prefer-current, then lexicographic.
  feasible.sort(
    (a, b) =>
      b.objective - a.objective ||
      Number(keyOf(b.candidate) === currentKey) - Number(keyOf(a.candidate) === currentKey) ||
      keyOf(a.candidate).localeCompare(keyOf(b.candidate)),
  );

  return {
    vault,
    evaluated: results.length,
    feasible: feasible.length,
    best: feasible[0] ?? null,
    current,
    top: feasible.slice(0, 10),
  };
}

export function formatTuneReport(r: TuneReport): string {
  const line = (t: TuneResult, label: string): string =>
    `  ${label.padEnd(9)} obj=${t.objective.toFixed(4)} ${t.feasible ? " " : "✗INFEASIBLE"} ` +
    `¶=${t.paraphrase.paraphraseRecall.toFixed(2)} rec=${t.paraphrase.recoveryRate.toFixed(2)} ` +
    `place=${t.paraphrase.placement.toFixed(2)} abst=${t.paraphrase.abstention.toFixed(2)}  ` +
    `wZ=${t.candidate.wZ} wCov=${t.candidate.wCoverage} wCoh=${t.candidate.wCohesion} ` +
    `wHub=${t.candidate.wHubFrac} τ=[${t.candidate.tauLow}, ${t.candidate.tauHigh}]`;
  const lines = [
    `tune: ${r.evaluated} candidates, ${r.feasible} feasible (original suite must hold 1.0)`,
    line(r.current, "current"),
  ];
  if (r.best) lines.push(line(r.best, "best"));
  lines.push("  top feasible:");
  for (const t of r.top) lines.push(line(t, ""));
  return lines.join("\n");
}
