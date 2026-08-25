/**
 * Quarantine, not silent acceptance (§5.7): low-confidence extractions,
 * ambiguous resolutions, pin conflicts, and everything from non-high-trust
 * episodes land as schema-valid notes under quarantine/ — a folder in the
 * Obsidian vault, so review is reading notes and dragging them out.
 * quarantine/ is never indexed (§ loadVault), so nothing here serves.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderNote } from "@brain/brainstore";
import type { NodeFrontmatter, TrustTier } from "@brain/contracts";
import type { QuarantinedCandidate } from "@brain/core";

export function writeQuarantinedCandidate(
  vaultPath: string,
  q: QuarantinedCandidate,
  episodeBasename: string,
  today: string,
  trust: TrustTier,
): string {
  const dir = join(vaultPath, "quarantine");
  mkdirSync(dir, { recursive: true });

  let id = q.candidate.id_hint;
  for (let n = 2; existsSync(join(dir, `${id}.md`)); n++) id = `${q.candidate.id_hint}-${n}`;

  const fm: NodeFrontmatter = {
    id,
    type: q.candidate.type,
    title: q.candidate.title,
    ...(q.candidate.aliases.length ? { aliases: q.candidate.aliases } : {}),
    ...(q.candidate.tags.length ? { tags: q.candidate.tags } : {}),
    created: today,
    updated: today,
    status: "active",
    confidence: q.candidate.confidence,
    provenance: trust === "high" ? "trusted" : "untrusted",
    sources: [`[[${episodeBasename}]]`],
    summary: q.candidate.summary,
  };
  const body = [
    `> **Quarantined:** ${q.reason}`,
    "> Review, fix links/ids as needed, then move this file into nodes/<type>/ and run `brain rebuild`.",
    ...(q.candidate.detail ? ["", "## Detail", "", q.candidate.detail] : []),
    ...(q.candidate.edges.length
      ? [
          "",
          "## Proposed edges (not applied)",
          ...q.candidate.edges.map((e) => `- ${e.rel} → [[${e.target}]]`),
        ]
      : []),
  ].join("\n");

  writeFileSync(join(dir, `${id}.md`), renderNote(fm, body));
  return id;
}
