/**
 * Lint rules (§5.9), pure. The consolidator/CLI supply graph data and
 * candidate pairs (blocking happens at the storage layer — §5.9: pairwise
 * checks run only within candidate blocks); these functions just decide.
 *
 * P2 implements the mechanical checks. The two model-assisted checks
 * (semantic contradictions, summary drift) wait until running an LLM pass
 * nightly is routine — the proposal-file plumbing is the same.
 */

import type { EdgeRecord } from "@brain/contracts";
import { titleSimilarity } from "./trigram.ts";
import type { GraphSlice } from "./types.ts";

export interface LintFinding {
  check:
    | "broken-link"
    | "orphan"
    | "near-duplicate"
    | "stale"
    | "links-drift"
    | "pin-target-missing";
  severity: "error" | "propose";
  subject: string;
  detail: string;
}

export function findBrokenLinks(
  edges: EdgeRecord[],
  nodeIds: Set<string>,
  episodeIds: Set<string>,
): LintFinding[] {
  return edges
    .filter((e) => !nodeIds.has(e.to) && !episodeIds.has(e.to))
    .map((e) => ({
      check: "broken-link" as const,
      severity: "error" as const,
      subject: e.from,
      detail: `${e.rel} → [[${e.to}]] resolves to nothing — repair or drop`,
    }));
}

export function findOrphans(slice: GraphSlice): LintFinding[] {
  const touched = new Set<string>();
  for (const e of slice.edges) {
    touched.add(e.from);
    touched.add(e.to);
  }
  return [...slice.nodes.keys()]
    .filter((id) => !touched.has(id))
    .sort()
    .map((id) => ({
      check: "orphan" as const,
      severity: "propose" as const,
      subject: id,
      detail: "no edges at all — propose links or merge",
    }));
}

export interface DuplicatePair {
  a: string;
  b: string;
}

/**
 * Given candidate pairs (already blocked by the caller per §5.9), flag
 * near-duplicates; when one side is much newer and the older is still
 * active, propose supersedes instead of merge (the "stale" check).
 */
export function findNearDuplicates(
  slice: GraphSlice,
  pairs: DuplicatePair[],
  threshold = 0.85,
): LintFinding[] {
  const out: LintFinding[] = [];
  const seen = new Set<string>();
  for (const { a, b } of pairs) {
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `${x} ${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const na = slice.nodes.get(x);
    const nb = slice.nodes.get(y);
    if (!na || !nb || na.type !== nb.type) continue;
    const sim = Math.max(
      titleSimilarity(na.title, nb.title),
      titleSimilarity(`${na.title} ${na.summary}`, `${nb.title} ${nb.summary}`),
    );
    if (sim < threshold) continue;
    const [older, newer] = na.created <= nb.created ? [na, nb] : [nb, na];
    const daysApart =
      (Date.parse(`${newer.created}T00:00:00Z`) - Date.parse(`${older.created}T00:00:00Z`)) /
      86_400_000;
    if (older.status === "active" && daysApart > 30) {
      out.push({
        check: "stale",
        severity: "propose",
        subject: older.id,
        detail: `similarity ${sim.toFixed(2)} to newer ${newer.id} — propose [[${newer.id}]] supersedes [[${older.id}]]`,
      });
    } else {
      out.push({
        check: "near-duplicate",
        severity: "propose",
        subject: x,
        detail: `similarity ${sim.toFixed(2)} with ${y} — propose merge`,
      });
    }
  }
  return out;
}

export function findMissingPinTargets(slice: GraphSlice): LintFinding[] {
  return slice.pins
    .filter((p) => !slice.nodes.has(p.nodeId))
    .map((p) => ({
      check: "pin-target-missing" as const,
      severity: "error" as const,
      subject: p.pinId,
      detail: `pin targets unknown node ${p.nodeId}`,
    }));
}

/**
 * Salience decay (§5.9): exponential toward the 1.0 baseline with a 90-day
 * half-life on time since last bump. Returns the new values; the caller
 * writes them.
 */
export function decaySalience(
  salience: Map<string, { value: number; updatedAt: string }>,
  now: Date,
  halfLifeDays = 90,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, s] of salience) {
    const days = Math.max(0, (now.getTime() - Date.parse(s.updatedAt)) / 86_400_000);
    const decayed = 1 + (s.value - 1) * 2 ** (-days / halfLifeDays);
    out.set(id, Math.round(decayed * 1000) / 1000);
  }
  return out;
}

export function formatProposalFile(findings: LintFinding[], now: Date): string {
  const lines = [
    "# Lint proposals",
    "",
    `Generated ${now.toISOString()} by \`brain lint\` (§5.9). Review in Obsidian;`,
    "`brain lint --apply` fixes `links-drift` mechanically and applies salience",
    "decay. `error` rows need a hand edit; `propose` rows are judgment calls —",
    "make the edit yourself or delete the row.",
    "",
  ];
  if (!findings.length) {
    lines.push("Nothing to report — the graph is clean.");
  } else {
    lines.push("| check | severity | node | detail |", "|---|---|---|---|");
    for (const f of findings) {
      lines.push(
        `| ${f.check} | ${f.severity} | ${f.subject} | ${f.detail.replace(/\|/g, "\\|")} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
