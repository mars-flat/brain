/**
 * Contract tier (§8.2): every schema validated both ways.
 *
 * Each fixture is checked against BOTH the JSON Schema (via ajv, an
 * independent validator) and the package's hand-written zero-dep guard, and
 * the two must agree:
 *
 *   valid/               → schema accepts, guard accepts
 *   invalid/             → schema rejects, guard rejects
 *   invalid-guard-only/  → schema accepts, guard rejects — the documented
 *                          semantic rules JSON Schema cannot express
 *                          (seq ordering, default-rule position)
 *
 * Drift between schema JSON and TS constants is asserted directly: patterns
 * and enums must be byte-identical.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";

import episodeSchema from "../episode.schema.json";
import nodeSchema from "../node.schema.json";
import policySchema from "../policy.schema.json";
import type { GuardResult } from "../src/index.ts";
import {
  DEFAULT_EDGE_DECAY,
  EDGE_RELATIONS,
  EPISODE_ID_PATTERN,
  NODE_ID_PATTERN,
  NODE_TYPES,
  POLICY_EFFECTS,
  RESULT_DIGEST_PATTERN,
  TIMESTAMP_PATTERN,
  TOOL_KINDS,
  TRUST_TIERS,
  validateEpisode,
  validateNodeFrontmatter,
  validatePolicy,
  WIKILINK_PATTERN,
} from "../src/index.ts";

const ajv = new Ajv2020({ strict: true, allErrors: true });

const CONTRACTS = [
  { name: "node", schema: nodeSchema, guard: validateNodeFrontmatter },
  { name: "episode", schema: episodeSchema, guard: validateEpisode },
  { name: "policy", schema: policySchema, guard: validatePolicy },
] as const;

const FIXTURES = join(import.meta.dir, "fixtures");

function fixturesIn(contract: string, bucket: string): Array<{ file: string; data: unknown }> {
  const dir = join(FIXTURES, contract, bucket);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((file) => ({
    file: `${contract}/${bucket}/${file}`,
    data: JSON.parse(readFileSync(join(dir, file), "utf8")),
  }));
}

describe("schemas compile", () => {
  for (const { name, schema } of CONTRACTS) {
    test(`${name}.schema.json is valid draft 2020-12`, () => {
      expect(() => ajv.compile(schema)).not.toThrow();
    });
  }
});

describe("fixtures validate both ways", () => {
  for (const { name, schema, guard } of CONTRACTS) {
    const validate = ajv.compile(schema);
    const cases = [
      { bucket: "valid", schemaOk: true, guardOk: true },
      { bucket: "invalid", schemaOk: false, guardOk: false },
      { bucket: "invalid-guard-only", schemaOk: true, guardOk: false },
    ] as const;
    for (const { bucket, schemaOk, guardOk } of cases) {
      for (const { file, data } of fixturesIn(name, bucket)) {
        test(file, () => {
          const schemaVerdict = validate(data);
          const guardVerdict = (guard as (v: unknown) => GuardResult<unknown>)(data);
          expect(
            schemaVerdict,
            `schema verdict for ${file}: ${JSON.stringify(validate.errors)}`,
          ).toBe(schemaOk);
          expect(
            guardVerdict.ok,
            `guard verdict for ${file}: ${guardVerdict.ok ? "" : guardVerdict.errors.join("; ")}`,
          ).toBe(guardOk);
          if (!guardVerdict.ok) expect(guardVerdict.errors.length).toBeGreaterThan(0);
        });
      }
    }
  }

  test("every bucket has fixtures where expected", () => {
    for (const { name } of CONTRACTS) {
      expect(fixturesIn(name, "valid").length).toBeGreaterThan(0);
      expect(fixturesIn(name, "invalid").length).toBeGreaterThan(0);
    }
    expect(fixturesIn("episode", "invalid-guard-only").length).toBeGreaterThan(0);
    expect(fixturesIn("policy", "invalid-guard-only").length).toBeGreaterThan(0);
  });
});

describe("schema ↔ TS constants never drift", () => {
  const props = nodeSchema.properties;
  const defs = nodeSchema.$defs;

  test("node id / wikilink / date patterns match", () => {
    expect(props.id.pattern).toBe(NODE_ID_PATTERN.source);
    expect(defs.wikilink.pattern).toBe(WIKILINK_PATTERN.source);
  });

  test("node type enum matches", () => {
    expect(props.type.enum).toEqual([...NODE_TYPES]);
  });

  test("every edge relation is a schema property, and decay covers exactly the vocabulary", () => {
    for (const rel of EDGE_RELATIONS) {
      expect(props[rel]).toBeDefined();
    }
    expect(Object.keys(DEFAULT_EDGE_DECAY).sort()).toEqual([...EDGE_RELATIONS].sort());
    for (const delta of Object.values(DEFAULT_EDGE_DECAY)) {
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThanOrEqual(1);
    }
  });

  test("episode patterns and enums match", () => {
    const e = episodeSchema.properties;
    const d = episodeSchema.$defs;
    expect(e.episode_id.pattern).toBe(EPISODE_ID_PATTERN.source);
    expect(d.timestamp.pattern).toBe(TIMESTAMP_PATTERN.source);
    expect(d.toolCallTurn.properties.result_digest.pattern).toBe(RESULT_DIGEST_PATTERN.source);
    expect(e.trust.enum).toEqual([...TRUST_TIERS]);
  });

  test("policy enums match", () => {
    const d = policySchema.$defs;
    expect(d.effect.enum).toEqual([...POLICY_EFFECTS]);
    expect(d.kind.enum).toEqual([...TOOL_KINDS]);
    expect(d.trust.enum).toEqual([...TRUST_TIERS]);
  });

  test("supersedes and contradicts carry decay 1.0 — the two hard traversal rules (§5.3)", () => {
    expect(DEFAULT_EDGE_DECAY.supersedes).toBe(1.0);
    expect(DEFAULT_EDGE_DECAY.contradicts).toBe(1.0);
  });
});
