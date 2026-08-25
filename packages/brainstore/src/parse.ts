/**
 * Note parsing (§5.2): frontmatter YAML → validated NodeFrontmatter, body
 * with the derived `## Links` mirror stripped. Inverse of render.ts.
 */

import { type GuardResult, type NodeFrontmatter, validateNodeFrontmatter } from "@brain/contracts";

export interface ParsedNote {
  frontmatter: NodeFrontmatter;
  /** Body markdown without the derived `## Links` mirror. */
  body: string;
  /** The raw links mirror, if present — lint compares it against frontmatter. */
  linksBlock: string | null;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export function parseNote(markdown: string): GuardResult<ParsedNote> {
  const m = FRONTMATTER.exec(markdown);
  if (!m) return { ok: false, errors: ["/: missing frontmatter block"] };

  let raw: unknown;
  try {
    raw = Bun.YAML.parse(m[1] as string);
  } catch (e) {
    return { ok: false, errors: [`/: frontmatter is not valid YAML — ${(e as Error).message}`] };
  }

  // YAML folded scalars carry a trailing newline; the contract's summary is
  // the logical text.
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.summary === "string") rec.summary = rec.summary.trim();
  }

  const verdict = validateNodeFrontmatter(raw);
  if (!verdict.ok) return verdict;

  const rest = markdown.slice(m[0].length);
  const { body, linksBlock } = splitLinksBlock(rest);
  return { ok: true, value: { frontmatter: verdict.value, body, linksBlock } };
}

function splitLinksBlock(raw: string): { body: string; linksBlock: string | null } {
  // The canonical render puts exactly one blank separator line after the
  // frontmatter; it is structure, not body.
  const rest = raw.replace(/^\n/, "");
  const lines = rest.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## Links");
  if (start === -1) return { body: rest.replace(/\s+$/, ""), linksBlock: null };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6} /.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  const body = [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\s+$/, "");
  const linksBlock = lines.slice(start, end).join("\n").replace(/\s+$/, "");
  return { body, linksBlock };
}

/** Frontmatter of an episode file — loose by design; the strict contract is the envelope (§5.7). */
export interface EpisodeFileMeta {
  episode_id?: string;
  started_at?: string;
  ended_at?: string;
  surface?: string;
  harness?: string;
  trust?: string;
  labels?: string[];
}

export function parseEpisodeFile(markdown: string): { meta: EpisodeFileMeta; body: string } | null {
  const m = FRONTMATTER.exec(markdown);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(m[1] as string);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    meta: {
      episode_id: str(rec.episode_id),
      started_at: str(rec.started_at),
      ended_at: str(rec.ended_at),
      surface: str(rec.surface),
      harness: str(rec.harness),
      trust: str(rec.trust),
      labels: Array.isArray(rec.labels) ? rec.labels.filter((l) => typeof l === "string") : [],
    },
    body: markdown.slice(m[0].length),
  };
}

/** A pin file under pins/ — format fixed at P1, formalized with the write path at P2. */
export interface PinFileMeta {
  pin_id: string;
  node_id: string;
  created: string;
  reason: string;
}

export function parsePinFile(markdown: string): { meta: PinFileMeta; correction: string } | null {
  const m = FRONTMATTER.exec(markdown);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(m[1] as string);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (
    typeof rec.pin_id !== "string" ||
    typeof rec.node_id !== "string" ||
    typeof rec.created !== "string" ||
    typeof rec.reason !== "string"
  )
    return null;
  return {
    meta: {
      pin_id: rec.pin_id,
      node_id: rec.node_id,
      created: rec.created,
      reason: rec.reason,
    },
    correction: markdown.slice(m[0].length).trim(),
  };
}
