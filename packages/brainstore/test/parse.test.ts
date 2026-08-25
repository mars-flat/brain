/**
 * §8.3 Round-trip: parse(render(node)) == node — property-tested, plus the
 * committed example vault as a fixture corpus.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { EDGE_RELATIONS, type NodeFrontmatter, NODE_TYPES } from "@brain/contracts";
import fc from "fast-check";
import { parseNote, renderNote } from "../src/index.ts";

const arbId = fc
  .stringMatching(/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/)
  .filter((s) => !s.includes("--") || true);

const arbWord = fc.stringMatching(/^[a-zA-Z0-9,.;:()'!?-]{1,12}$/);
const arbText = fc.array(arbWord, { minLength: 1, maxLength: 40 }).map((ws) => ws.join(" "));
const arbDate = fc
  .record({
    y: fc.integer({ min: 2020, max: 2030 }),
    m: fc.integer({ min: 1, max: 12 }),
    d: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  );
// Canonical frontmatter never carries an empty edge list — render drops
// them, so absence is the one canonical spelling (minLength 1 here).
const arbLinks = fc.uniqueArray(arbId.map((id) => `[[${id}]]`), { minLength: 1, maxLength: 3 });

const arbFrontmatter: fc.Arbitrary<NodeFrontmatter> = fc
  .record(
    {
      id: arbId,
      type: fc.constantFrom(...NODE_TYPES),
      title: arbText,
      aliases: fc.option(fc.uniqueArray(arbText, { minLength: 1, maxLength: 3 }), {
        nil: undefined,
      }),
      tags: fc.option(
        fc.uniqueArray(fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,8}[a-z0-9]$/), {
          minLength: 1,
          maxLength: 3,
        }),
        { nil: undefined },
      ),
      created: arbDate,
      updated: arbDate,
      status: fc.constantFrom("active", "superseded"),
      confidence: fc.option(fc.constantFrom("high", "medium", "low"), { nil: undefined }),
      provenance: fc.option(fc.constantFrom("trusted", "untrusted"), { nil: undefined }),
      sources: fc.option(arbLinks, { nil: undefined }),
      summary: arbText,
      supersedes: fc.option(arbLinks, { nil: undefined }),
      contradicts: fc.option(arbLinks, { nil: undefined }),
      about: fc.option(arbLinks, { nil: undefined }),
      mentioned_with: fc.option(arbLinks, { nil: undefined }),
    },
    { requiredKeys: ["id", "type", "title", "created", "updated", "status", "summary"] },
  )
  .map((fm) => {
    // drop undefined-valued keys so equality is structural
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fm)) if (v !== undefined) out[k] = v;
    return out as unknown as NodeFrontmatter;
  });

/** Body lines must not collide with the derived `## Links` mirror heading. */
const arbBody = fc
  .array(fc.oneof(arbText, fc.constant("### Section"), fc.constant("")), { maxLength: 6 })
  .map((lines) => lines.join("\n").replace(/\s+$/, ""));

describe("round-trip (§8.3)", () => {
  test("parse(render(fm, body)) reproduces frontmatter and body exactly", () => {
    fc.assert(
      fc.property(arbFrontmatter, arbBody, (fm, body) => {
        const rendered = renderNote(fm, body);
        const parsed = parseNote(rendered);
        if (!parsed.ok) throw new Error(`parse failed: ${parsed.errors.join("; ")}`);
        expect(parsed.value.frontmatter).toEqual(fm);
        expect(parsed.value.body).toBe(body);
        if (EDGE_RELATIONS.some((rel) => fm[rel]?.length)) {
          expect(parsed.value.linksBlock).toContain("## Links");
        }
        // Render is a fixpoint: render(parse(render(x))) == render(x)
        expect(renderNote(parsed.value.frontmatter, parsed.value.body)).toBe(rendered);
      }),
      { numRuns: 300 },
    );
  });

  test("every committed example-vault node parses, id == basename", () => {
    const root = join(import.meta.dir, "..", "..", "..", "examples", "vault-example", "nodes");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const full = join(dir, e);
        return statSync(full).isDirectory() ? walk(full) : e.endsWith(".md") ? [full] : [];
      });
    const files = walk(root);
    expect(files.length).toBeGreaterThanOrEqual(80);
    for (const file of files) {
      const parsed = parseNote(readFileSync(file, "utf8"));
      if (!parsed.ok) throw new Error(`${file}: ${parsed.errors.join("; ")}`);
      expect(parsed.value.frontmatter.id).toBe(basename(file, ".md"));
    }
  });

  test("rejects notes without frontmatter, with bad YAML, or violating the schema", () => {
    expect(parseNote("just text").ok).toBe(false);
    expect(parseNote("---\n: {[\n---\nbody").ok).toBe(false);
    const salience = ["---", "id: x", "type: concept", 'title: "X"', "created: 2026-01-01", "updated: 2026-01-01", "status: active", "salience: 3", "summary: >", "  s", "---", ""].join("\n");
    const verdict = parseNote(salience);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.errors.join(" ")).toContain("salience");
  });
});
