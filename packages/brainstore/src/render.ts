/**
 * Canonical note rendering (§5.2). The single source of truth for how a node
 * becomes markdown — the example-vault generator and (from P2) the
 * consolidator both use it, and §8.3's round-trip invariant holds against it:
 * parseNote(renderNote(fm, body)) reproduces fm and body exactly.
 *
 * The `## Links` section is the lint-maintained body mirror of frontmatter
 * edges (§5.2) — regenerated on every render, stripped on parse, never part
 * of the round-tripped body.
 */

import { EDGE_RELATIONS, type NodeFrontmatter } from "@brain/contracts";

function yamlScalar(s: string): string {
  return JSON.stringify(s);
}

/**
 * Ids and tags are kebab [a-z0-9-], which YAML re-parses as strings — except
 * all-digit forms ("2026" → number, "1e2" → 100) and the YAML keywords. Quote
 * exactly those, keep everything else pretty.
 */
function yamlKebab(s: string): string {
  return /^\d/.test(s) || s === "null" || s === "true" || s === "false" ? yamlScalar(s) : s;
}

function yamlList(items: string[]): string {
  return `[${items.map(yamlScalar).join(", ")}]`;
}

export function foldSummary(summary: string): string {
  const words = summary.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && `${line} ${w}`.length > 76) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => `  ${l}`).join("\n");
}

export function renderNote(fm: NodeFrontmatter, body: string): string {
  const out: string[] = ["---"];
  out.push(`id: ${yamlKebab(fm.id)}`);
  out.push(`type: ${fm.type}`);
  out.push(`title: ${yamlScalar(fm.title)}`);
  if (fm.aliases?.length) out.push(`aliases: ${yamlList(fm.aliases)}`);
  if (fm.tags?.length) out.push(`tags: [${fm.tags.map(yamlKebab).join(", ")}]`);
  out.push(`created: ${fm.created}`);
  out.push(`updated: ${fm.updated}`);
  out.push(`status: ${fm.status}`);
  if (fm.confidence) out.push(`confidence: ${fm.confidence}`);
  if (fm.provenance) out.push(`provenance: ${fm.provenance}`);
  if (fm.sources?.length) out.push(`sources: ${yamlList(fm.sources)}`);

  const edgeLines: string[] = [];
  for (const rel of EDGE_RELATIONS) {
    const targets = fm[rel];
    if (targets?.length) edgeLines.push(`${rel}: ${yamlList(targets)}`);
  }
  if (edgeLines.length) {
    out.push("");
    out.push(...edgeLines);
  }

  out.push("");
  out.push("summary: >");
  out.push(foldSummary(fm.summary));
  out.push("---");
  out.push("");

  const trimmedBody = body.replace(/\s+$/, "");
  if (trimmedBody) {
    out.push(trimmedBody);
    out.push("");
  }

  const linkLines = EDGE_RELATIONS.filter((rel) => fm[rel]?.length).map(
    (rel) => `- ${rel} → ${(fm[rel] as string[]).join(", ")}`,
  );
  if (linkLines.length) {
    out.push("## Links");
    out.push(...linkLines);
    out.push("");
  }

  return out.join("\n");
}
