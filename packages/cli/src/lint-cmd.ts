/**
 * `brain lint` (§5.9): mechanical checks over the vault, output as a
 * proposal file — never a silent mutation. `--apply` performs only the
 * mechanical fixes: canonical re-render for links-drift, dropping broken
 * edge links, salience decay. Judgment calls (merges, supersedes, orphan
 * linking) stay proposals for a human in Obsidian.
 *
 * Blocking (§5.9): pairwise checks run only within candidate blocks —
 * same type + shared tag, or top FTS matches for the node's own title.
 * The touched-since-last-run watermark waits until vault size demands it;
 * at O(10^2–10^3) nodes the full pass is milliseconds.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrainStore, loadVault, openDb, parseNote, rebuild, renderNote } from "@brain/brainstore";
import { EDGE_RELATIONS, type NodeFrontmatter } from "@brain/contracts";
import {
  type DuplicatePair,
  decaySalience,
  findBrokenLinks,
  findMissingPinTargets,
  findNearDuplicates,
  findOrphans,
  formatProposalFile,
  type LintFinding,
} from "@brain/core";

export interface LintOutcome {
  findings: LintFinding[];
  proposalPath: string;
  applied: string[];
}

export function runLint(vaultPath: string, apply: boolean, now: Date): LintOutcome {
  const vault = loadVault(vaultPath);
  if (vault.errors.length) {
    throw new Error(
      `vault has hard errors — fix before linting:\n${vault.errors
        .map((e) => `  ${e.filePath}: ${e.message}`)
        .join("\n")}`,
    );
  }
  const db = openDb(join(vaultPath, "_index", "brain.db"));
  rebuild(db, vault);
  const store = new BrainStore(db);
  const slice = store.loadGraph();
  const nodeIds = new Set(slice.nodes.keys());
  const episodeIds = new Set(vault.episodes.map((e) => e.basename));

  const findings: LintFinding[] = [
    ...findBrokenLinks(slice.edges, nodeIds, episodeIds),
    ...findOrphans(slice),
    ...findMissingPinTargets(slice),
  ];

  // Candidate blocks for the pairwise sweep (§5.9).
  const pairs: DuplicatePair[] = [];
  const byTypeTag = new Map<string, string[]>();
  for (const n of vault.nodes) {
    for (const tag of n.fm.tags ?? []) {
      const key = `${n.fm.type}:${tag}`;
      byTypeTag.set(key, [...(byTypeTag.get(key) ?? []), n.fm.id]);
    }
  }
  for (const ids of byTypeTag.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        pairs.push({ a: ids[i] as string, b: ids[j] as string });
      }
    }
  }
  for (const n of vault.nodes) {
    for (const hit of store.seedSearch(n.fm.title, 5, [n.fm.type])) {
      if (hit.id !== n.fm.id) pairs.push({ a: n.fm.id, b: hit.id });
    }
  }
  findings.push(...findNearDuplicates(slice, pairs));

  // Links-block drift (§5.2: the body mirror is lint-maintained).
  const driftIds: string[] = [];
  for (const n of vault.nodes) {
    const canonical = renderNote(n.fm, n.body);
    const expected = extractLinksBlock(canonical);
    if (normalize(n.linksBlock) !== normalize(expected)) {
      driftIds.push(n.fm.id);
      findings.push({
        check: "links-drift",
        severity: "propose",
        subject: n.fm.id,
        detail: "## Links body mirror disagrees with frontmatter — regenerated on apply",
      });
    }
  }

  const sorted = findings.sort(
    (a, b) => a.check.localeCompare(b.check) || a.subject.localeCompare(b.subject),
  );
  const proposalPath = join(vaultPath, "lint-proposals.md");
  writeFileSync(proposalPath, formatProposalFile(sorted, now));

  const applied: string[] = [];
  if (apply) {
    // 1 — regenerate drifted files in canonical form.
    for (const id of driftIds) {
      const rel = store.nodeFile(id);
      if (!rel) continue;
      const parsed = parseNote(readFileSync(join(vaultPath, rel), "utf8"));
      if (parsed.ok) {
        writeFileSync(
          join(vaultPath, rel),
          renderNote(parsed.value.frontmatter, parsed.value.body),
        );
        applied.push(`links-drift: regenerated ${id}`);
      }
    }
    // 2 — drop broken edge links.
    for (const f of sorted.filter((x) => x.check === "broken-link")) {
      const rel = store.nodeFile(f.subject);
      if (!rel) continue;
      const parsed = parseNote(readFileSync(join(vaultPath, rel), "utf8"));
      if (!parsed.ok) continue;
      const fm = dropBrokenLinks(parsed.value.frontmatter, nodeIds, episodeIds);
      writeFileSync(join(vaultPath, rel), renderNote(fm, parsed.value.body));
      applied.push(`broken-link: cleaned ${f.subject}`);
    }
    // 3 — salience decay (§5.9).
    const rows = db.query("SELECT node_id, value, updated_at FROM salience").all() as Array<{
      node_id: string;
      value: number;
      updated_at: string;
    }>;
    const decayed = decaySalience(
      new Map(rows.map((r) => [r.node_id, { value: r.value, updatedAt: r.updated_at }])),
      now,
    );
    const upd = db.query("UPDATE salience SET value = ?, updated_at = ? WHERE node_id = ?");
    const tx = db.transaction(() => {
      for (const [id, value] of decayed) upd.run(value, now.toISOString(), id);
    });
    tx();
    applied.push(`salience: decayed ${decayed.size} nodes`);

    rebuild(db, loadVault(vaultPath));
  }

  return { findings: sorted, proposalPath, applied };
}

function extractLinksBlock(rendered: string): string | null {
  const parsed = parseNote(rendered);
  return parsed.ok ? parsed.value.linksBlock : null;
}

function normalize(block: string | null): string {
  return (block ?? "").trim();
}

function dropBrokenLinks(
  fm: NodeFrontmatter,
  nodeIds: Set<string>,
  episodeIds: Set<string>,
): NodeFrontmatter {
  const next = { ...fm };
  const keep = (link: string) => {
    const target = link.slice(2, -2);
    return nodeIds.has(target) || episodeIds.has(target);
  };
  for (const rel of EDGE_RELATIONS) {
    const list = next[rel];
    if (!list) continue;
    const kept = list.filter(keep);
    if (kept.length) next[rel] = kept;
    else delete next[rel];
  }
  if (next.sources) {
    const kept = next.sources.filter(keep);
    if (kept.length) next.sources = kept;
    else delete next.sources;
  }
  return next;
}
