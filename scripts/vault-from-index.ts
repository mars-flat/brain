/**
 * Disaster recovery (§5.11): reconstruct canonical vault markdown from a
 * brain.db index. The index is normally a pure cache — but when the markdown
 * is lost and the index survives (the 2026-09-01 shadow-vault incident:
 * notes written to a tmpdir vault whose .md files the OS purged), it holds
 * everything a node needs: frontmatter columns, body, and the edge table.
 *
 * Usage: bun scripts/vault-from-index.ts <brain.db> <target-vault>
 *
 * Writes only nodes whose id does NOT already exist in the target vault
 * (basename-uniqueness is sacred, §5.2), validates every reconstruction
 * against @brain/contracts before writing, and prints a report. It does NOT
 * rebuild, commit, or touch the target's index — review, then `brain
 * rebuild` and commit in the vault repo yourself.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadVault, renderNote } from "@brain/brainstore";
import {
  EDGE_RELATIONS,
  type EdgeRelation,
  type NodeFrontmatter,
  validateNodeFrontmatter,
  wikilinkTarget,
} from "@brain/contracts";

const [dbPath, targetVault] = process.argv.slice(2);
if (!dbPath || !targetVault) {
  console.error("usage: bun scripts/vault-from-index.ts <brain.db> <target-vault>");
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true });
const existing = new Set(loadVault(targetVault).nodes.map((n) => n.fm.id));

interface Row {
  id: string;
  type: string;
  title: string;
  created: string;
  updated: string;
  status: string;
  confidence: string;
  provenance: string;
  summary: string;
  body: string;
  aliases_json: string;
  tags_json: string;
  sources_json: string;
}

const rows = db.query("SELECT * FROM nodes ORDER BY id").all() as Row[];
const edges = db
  .query("SELECT from_id, rel, to_id FROM edges ORDER BY from_id, rel, to_id")
  .all() as Array<{ from_id: string; rel: string; to_id: string }>;

const written: string[] = [];
const skipped: string[] = [];
const failed: string[] = [];

for (const r of rows) {
  if (existing.has(r.id)) {
    skipped.push(r.id);
    continue;
  }
  const sources = JSON.parse(r.sources_json) as string[];
  const sourceTargets = new Set(sources.map((s) => wikilinkTarget(s)).filter(Boolean));
  const fm: NodeFrontmatter = {
    id: r.id,
    type: r.type as NodeFrontmatter["type"],
    title: r.title,
    created: r.created,
    updated: r.updated,
    status: r.status as NodeFrontmatter["status"],
    confidence: r.confidence as NodeFrontmatter["confidence"],
    provenance: r.provenance as NodeFrontmatter["provenance"],
    summary: r.summary,
  };
  const aliases = JSON.parse(r.aliases_json) as string[];
  const tags = JSON.parse(r.tags_json) as string[];
  if (aliases.length) fm.aliases = aliases;
  if (tags.length) fm.tags = tags;
  if (sources.length) fm.sources = sources;
  for (const rel of EDGE_RELATIONS as readonly EdgeRelation[]) {
    const targets = edges
      .filter((e) => e.from_id === r.id && e.rel === rel)
      // rebuild re-materializes sources as derived_from — don't double them
      .filter((e) => !(rel === "derived_from" && sourceTargets.has(e.to_id)))
      .map((e) => `[[${e.to_id}]]`);
    if (targets.length) fm[rel] = targets;
  }

  const guard = validateNodeFrontmatter(fm);
  if (!guard.ok) {
    failed.push(`${r.id}: ${guard.errors.join("; ")}`);
    continue;
  }
  const file = join(targetVault, "nodes", r.type, `${r.id}.md`);
  if (existsSync(file)) {
    skipped.push(r.id);
    continue;
  }
  mkdirSync(join(targetVault, "nodes", r.type), { recursive: true });
  writeFileSync(file, renderNote(fm, r.body));
  written.push(r.id);
}

console.log(`recovered ${written.length} node(s) into ${targetVault}:`);
for (const id of written) console.log(`  + ${id}`);
if (skipped.length) console.log(`skipped ${skipped.length} already present: ${skipped.join(", ")}`);
if (failed.length) {
  console.error(`FAILED validation (${failed.length}):`);
  for (const f of failed) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("next: review, then `brain rebuild` and git commit inside the vault repo");
