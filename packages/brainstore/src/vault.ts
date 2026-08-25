/**
 * Vault loading (§5.11): walk nodes/, episodes/, pins/ under the vault root,
 * parse and validate everything, enforce the cross-file invariants the
 * schema can't see — basename == id, basename uniqueness (§5.2).
 * quarantine/ is deliberately not loaded: quarantined content never serves
 * (§5.7).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Confidence, NodeFrontmatter, Provenance } from "@brain/contracts";
import {
  type EpisodeFileMeta,
  type PinFileMeta,
  parseEpisodeFile,
  parseNote,
  parsePinFile,
} from "./parse.ts";

export interface VaultNode {
  fm: NodeFrontmatter;
  /** fm.confidence with the documented default applied (§5.2). */
  confidence: Confidence;
  /** fm.provenance with the documented default applied (§5.2). */
  provenance: Provenance;
  body: string;
  linksBlock: string | null;
  /** Relative to the vault root. */
  filePath: string;
}

export interface VaultEpisode {
  basename: string;
  meta: EpisodeFileMeta;
  filePath: string;
}

export interface VaultPin {
  meta: PinFileMeta;
  correction: string;
  filePath: string;
}

export interface VaultProblem {
  filePath: string;
  message: string;
}

export interface LoadedVault {
  root: string;
  nodes: VaultNode[];
  episodes: VaultEpisode[];
  pins: VaultPin[];
  /** Hard problems — a rebuild refuses when any exist. */
  errors: VaultProblem[];
  /** Soft problems — recorded, indexed anyway (lint's inbox). */
  warnings: VaultProblem[];
}

function mdFilesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) files.push(...mdFilesUnder(full));
    else if (entry.endsWith(".md")) files.push(full);
  }
  return files;
}

export function loadVault(root: string): LoadedVault {
  const nodes: VaultNode[] = [];
  const episodes: VaultEpisode[] = [];
  const pins: VaultPin[] = [];
  const errors: VaultProblem[] = [];
  const warnings: VaultProblem[] = [];

  const seen = new Map<string, string>(); // basename -> filePath

  for (const file of mdFilesUnder(join(root, "nodes"))) {
    const rel = relative(root, file);
    const name = basename(file, ".md");
    const parsed = parseNote(readFileSync(file, "utf8"));
    if (!parsed.ok) {
      errors.push({ filePath: rel, message: parsed.errors.join("; ") });
      continue;
    }
    const { frontmatter: fm, body, linksBlock } = parsed.value;
    if (fm.id !== name) {
      errors.push({ filePath: rel, message: `id "${fm.id}" != basename "${name}" (§5.2)` });
      continue;
    }
    const prior = seen.get(name);
    if (prior) {
      errors.push({
        filePath: rel,
        message: `basename collision with ${prior} — ids are globally unique basenames (§5.2)`,
      });
      continue;
    }
    seen.set(name, rel);
    nodes.push({
      fm,
      confidence: fm.confidence ?? "medium",
      provenance: fm.provenance ?? "trusted",
      body,
      linksBlock,
      filePath: rel,
    });
  }

  for (const file of mdFilesUnder(join(root, "episodes"))) {
    const rel = relative(root, file);
    const name = basename(file, ".md");
    const prior = seen.get(name);
    if (prior) {
      errors.push({ filePath: rel, message: `basename collision with ${prior}` });
      continue;
    }
    seen.set(name, rel);
    const parsed = parseEpisodeFile(readFileSync(file, "utf8"));
    if (!parsed) {
      warnings.push({ filePath: rel, message: "episode file has no parseable frontmatter" });
      episodes.push({ basename: name, meta: {}, filePath: rel });
      continue;
    }
    episodes.push({ basename: name, meta: parsed.meta, filePath: rel });
  }

  for (const file of mdFilesUnder(join(root, "pins"))) {
    const rel = relative(root, file);
    const parsed = parsePinFile(readFileSync(file, "utf8"));
    if (!parsed) {
      warnings.push({ filePath: rel, message: "pin file missing pin_id/node_id/created/reason" });
      continue;
    }
    pins.push({ meta: parsed.meta, correction: parsed.correction, filePath: rel });
  }

  return { root, nodes, episodes, pins, errors, warnings };
}

/**
 * Resolve a link target exactly as Obsidian does (§5.2): basename first,
 * then alias (case-insensitive). Ambiguous aliases resolve to the lowest id
 * for determinism; lint flags them.
 */
export class Resolver {
  private readonly byId = new Map<string, string>();
  private readonly byAlias = new Map<string, string[]>();

  constructor(nodes: Iterable<Pick<VaultNode, "fm">>) {
    for (const n of nodes) {
      this.byId.set(n.fm.id, n.fm.id);
      for (const alias of n.fm.aliases ?? []) {
        const key = alias.toLowerCase();
        const list = this.byAlias.get(key) ?? [];
        list.push(n.fm.id);
        this.byAlias.set(key, list);
      }
    }
    for (const list of this.byAlias.values()) list.sort();
  }

  resolve(ref: string): string | null {
    const direct = this.byId.get(ref);
    if (direct) return direct;
    const viaAlias = this.byAlias.get(ref.toLowerCase());
    return viaAlias?.[0] ?? null;
  }

  ambiguousAliases(): Array<{ alias: string; ids: string[] }> {
    return [...this.byAlias.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([alias, ids]) => ({ alias, ids }));
  }
}
