/**
 * The node contract (§5.2, §5.3): a node is an Obsidian note whose frontmatter
 * carries identity, lifecycle, and typed edges. Mirrors node.schema.json —
 * the contract tests assert the two never drift.
 */

import { Checker, fail, type GuardResult, isRecord } from "./validate.ts";

export const NODE_TYPES = [
  "project",
  "decision",
  "concept",
  "entity",
  "person",
  "preference",
  "constraint",
  "artifact",
  "event",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/**
 * Closed edge vocabulary (§5.3). Closed so traversal can weight by relation
 * type — weight is a property of the relation, not the individual edge.
 */
export const EDGE_RELATIONS = [
  "supersedes",
  "contradicts",
  "caused_by",
  "depends_on",
  "part_of",
  "about",
  "example_of",
  "authored_by",
  "derived_from",
  "mentioned_with",
] as const;
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

/**
 * Default traversal decay δ per relation (§5.3). Starting values, tuned
 * against the eval set (§8.5); a vault's BRAIN.md may override them.
 * `supersedes` and `contradicts` are 1.0 AND carry hard rules the packer
 * enforces regardless of decay: supersedes chains are followed to the
 * terminal node ignoring the budget, and contradiction counterparts are
 * always pulled in and labeled.
 */
export const DEFAULT_EDGE_DECAY: Readonly<Record<EdgeRelation, number>> = {
  supersedes: 1.0,
  contradicts: 1.0,
  caused_by: 0.85,
  depends_on: 0.8,
  part_of: 0.75,
  about: 0.6,
  example_of: 0.6,
  authored_by: 0.5,
  derived_from: 0.4,
  mentioned_with: 0.3,
};

export type NodeStatus = "active" | "superseded";
export const NODE_STATUSES = ["active", "superseded"] as const;
export type Confidence = "high" | "medium" | "low";
export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Provenance = "trusted" | "untrusted";
export const PROVENANCES = ["trusted", "untrusted"] as const;

/** A quoted wikilink to a bare basename: "[[gateway-runs-on-ec2]]" (§5.2). */
export type Wikilink = string;

/** Node ids are bare basenames — kebab, globally unique across the vault (§5.2). */
export const NODE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const WIKILINK_PATTERN = /^\[\[[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\]\]$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const TAG_PATTERN = /^[a-z0-9](?:[a-z0-9/-]*[a-z0-9])?$/;

export type NodeEdges = Partial<Record<EdgeRelation, Wikilink[]>>;

/**
 * `salience` is intentionally NOT here — it lives only in SQLite (§5.2).
 * The guard (and the schema's additionalProperties:false) reject it.
 */
export interface NodeFrontmatter extends NodeEdges {
  id: string;
  type: NodeType;
  title: string;
  aliases?: string[];
  tags?: string[];
  created: string;
  updated: string;
  status: NodeStatus;
  /** Defaults applied by the parser, not the guard: medium. */
  confidence?: Confidence;
  /** Defaults applied by the parser, not the guard: trusted. */
  provenance?: Provenance;
  /** Wikilinks to source episodes. */
  sources?: Wikilink[];
  /** The middle render tier; must stand alone at ~100–150 tokens (§5.2). */
  summary: string;
}

/** Strip the brackets: "[[foo]]" → "foo". Returns null if not a valid wikilink. */
export function wikilinkTarget(link: string): string | null {
  const m = WIKILINK_PATTERN.exec(link);
  return m ? link.slice(2, -2) : null;
}

const NODE_KEYS = [
  "id",
  "type",
  "title",
  "aliases",
  "tags",
  "created",
  "updated",
  "status",
  "confidence",
  "provenance",
  "sources",
  "summary",
  ...EDGE_RELATIONS,
] as const;

export function validateNodeFrontmatter(value: unknown): GuardResult<NodeFrontmatter> {
  if (!isRecord(value)) return fail(["/: expected object"]);
  const c = new Checker();

  c.string("/id", value.id, {
    pattern: NODE_ID_PATTERN,
    patternName: "kebab-case basename",
    maxLength: 120,
  });
  c.enum("/type", value.type, NODE_TYPES);
  c.string("/title", value.title, { minLength: 1, maxLength: 300 });
  if (value.aliases !== undefined) c.stringArray("/aliases", value.aliases, { minLength: 1 });
  if (value.tags !== undefined)
    c.stringArray("/tags", value.tags, { pattern: TAG_PATTERN, patternName: "kebab-case tag" });
  c.string("/created", value.created, { pattern: DATE_PATTERN, patternName: "YYYY-MM-DD" });
  c.string("/updated", value.updated, { pattern: DATE_PATTERN, patternName: "YYYY-MM-DD" });
  c.enum("/status", value.status, NODE_STATUSES);
  if (value.confidence !== undefined) c.enum("/confidence", value.confidence, CONFIDENCES);
  if (value.provenance !== undefined) c.enum("/provenance", value.provenance, PROVENANCES);
  if (value.sources !== undefined)
    c.stringArray("/sources", value.sources, {
      pattern: WIKILINK_PATTERN,
      patternName: 'quoted wikilink "[[bare-basename]]"',
    });
  c.string("/summary", value.summary, { minLength: 1 });
  for (const rel of EDGE_RELATIONS) {
    if (value[rel] !== undefined)
      c.stringArray(`/${rel}`, value[rel], {
        pattern: WIKILINK_PATTERN,
        patternName: 'quoted wikilink "[[bare-basename]]"',
      });
  }
  c.noExtraKeys("/", value, NODE_KEYS);

  return c.result(value as unknown as NodeFrontmatter);
}
