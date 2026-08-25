/**
 * Extraction (§5.7): episode → candidate facts, decisions, entities,
 * preferences. Two implementations behind one interface:
 *
 *  - LlmExtractor — the real one, via the ModelClient port with structured
 *    outputs (§5.8: effort `medium`; the stable prompt prefix comes first
 *    so provider prompt caching applies, volatile episode content last).
 *  - MarkerExtractor — deterministic, no model: parses explicit `@node`
 *    marker lines. Powers tests, offline use, and precise hand captures.
 *
 * The extraction threshold loosens on thin graphs (§5.6): below 200 nodes
 * the prompt asks for aggressive capture; lint merges duplicates later.
 */

import {
  CONFIDENCES,
  type Confidence,
  EDGE_RELATIONS,
  type EdgeRelation,
  type EpisodeEnvelope,
  type ModelClient,
  NODE_TYPES,
  type NodeType,
} from "@brain/contracts";
import { type ExtractedCandidate, slugify } from "@brain/core";

export interface Extractor {
  extract(episode: EpisodeEnvelope, ctx: ExtractionContext): Promise<ExtractedCandidate[]>;
}

export interface ExtractionContext {
  /** Current graph size — drives the §5.6 cold-start looseness. */
  nodeCount: number;
  /** Existing node ids, so the model links instead of duplicating. */
  existingIds: string[];
}

export function renderTranscript(episode: EpisodeEnvelope): string {
  return episode.turns
    .map((t) =>
      t.kind === "message"
        ? `**${t.role}** — ${t.content}`
        : `\`tool\` ${t.urn} args=${JSON.stringify(t.args)} → ${t.result_digest.slice(0, 23)}…`,
    )
    .join("\n\n");
}

// ── Marker extractor ───────────────────────────────────────────────────────
//
// Grammar, one candidate per line anywhere in message content:
//   @node <type> "<title>" summary:"..." [id:<kebab>] [aliases:"a","b"]
//         [tags:x,y] [confidence:high|medium|low] [detail:"..."]
//         [edge:<rel>=<target>]...

const MARKER = /^@node\s+(\S+)\s+"([^"]+)"\s*(.*)$/;

export class MarkerExtractor implements Extractor {
  extract(episode: EpisodeEnvelope): Promise<ExtractedCandidate[]> {
    const out: ExtractedCandidate[] = [];
    for (const turn of episode.turns) {
      if (turn.kind !== "message") continue;
      for (const line of turn.content.split("\n")) {
        const m = MARKER.exec(line.trim());
        if (!m) continue;
        const [, typeRaw, title, rest] = m as unknown as [string, string, string, string];
        if (!NODE_TYPES.includes(typeRaw as NodeType)) continue;
        const get = (key: string) => new RegExp(`${key}:"([^"]*)"`).exec(rest)?.[1] ?? undefined;
        const getBare = (key: string) =>
          new RegExp(`${key}:([a-z0-9,-]+)`).exec(rest)?.[1] ?? undefined;
        const edges: Array<{ rel: EdgeRelation; target: string }> = [];
        for (const em of rest.matchAll(/edge:([a-z_]+)=([a-z0-9-]+)/g)) {
          if (EDGE_RELATIONS.includes(em[1] as EdgeRelation))
            edges.push({ rel: em[1] as EdgeRelation, target: em[2] as string });
        }
        const confidence = (getBare("confidence") ?? "high") as Confidence;
        out.push({
          type: typeRaw as NodeType,
          title,
          id_hint: getBare("id") ?? slugify(title),
          aliases: [...rest.matchAll(/aliases:((?:"[^"]*",?)+)/g)]
            .flatMap((am) =>
              [...(am[1] as string).matchAll(/"([^"]*)"/g)].map((x) => x[1] as string),
            )
            .filter(Boolean),
          tags: (getBare("tags") ?? "").split(",").filter(Boolean),
          summary: get("summary") ?? title,
          detail: get("detail") ?? "",
          confidence: CONFIDENCES.includes(confidence) ? confidence : "high",
          edges,
        });
      }
    }
    return Promise.resolve(out);
  }
}

// ── LLM extractor ──────────────────────────────────────────────────────────

export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { enum: [...NODE_TYPES] },
          title: { type: "string" },
          id_hint: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$" },
          aliases: { type: "array", items: { type: "string" } },
          tags: { type: "array", items: { type: "string", pattern: "^[a-z0-9/-]+$" } },
          summary: { type: "string" },
          detail: { type: "string" },
          confidence: { enum: [...CONFIDENCES] },
          edges: {
            type: "array",
            items: {
              type: "object",
              properties: {
                rel: { enum: [...EDGE_RELATIONS] },
                target: { type: "string" },
              },
              required: ["rel", "target"],
              additionalProperties: false,
            },
          },
        },
        required: [
          "type",
          "title",
          "id_hint",
          "aliases",
          "tags",
          "summary",
          "detail",
          "confidence",
          "edges",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

/** Stable prefix — identical every call so provider prompt caching applies (§5.8). */
const SYSTEM_PROMPT = `You extract durable memory from one conversation episode into graph nodes.

Node types: ${NODE_TYPES.join(" · ")}.
Relations (edges FROM the new node): ${EDGE_RELATIONS.join(" · ")}.
- supersedes: this new decision/fact replaces the target.
- contradicts: both stand, but they conflict.
- caused_by / depends_on / part_of / about / example_of / authored_by: as named.
- mentioned_with: weak co-occurrence only.

Extract only what is durable: decisions with their reasons, stable facts,
people, preferences, constraints, real events. Skip pleasantries, transient
task chatter, and anything the transcript merely quotes from elsewhere.

Each candidate needs: a title a stranger would recognize; a summary of
100–150 tokens that stands alone; kebab-case id_hint; aliases someone might
search; edges with target = an existing node id (list provided) or another
candidate's id_hint. confidence: high = stated outright, medium = clearly
implied, low = a guess (low-confidence extractions are quarantined for
review, so use low rather than omitting when unsure).

Return {"candidates": []} when nothing durable happened.`;

export class LlmExtractor implements Extractor {
  constructor(
    private readonly model: ModelClient,
    private readonly modelName = "gpt-5.6-luna",
  ) {}

  async extract(episode: EpisodeEnvelope, ctx: ExtractionContext): Promise<ExtractedCandidate[]> {
    const aggressiveness =
      ctx.nodeCount < 200
        ? "The graph is young — capture aggressively; near-duplicates get merged by lint later (§5.6)."
        : "The graph is established — extract selectively; prefer linking to existing nodes over creating new ones.";
    const result = await this.model.complete({
      model: this.modelName,
      effort: "medium",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `${aggressiveness}\n\nExisting node ids (link to these where relevant):\n${ctx.existingIds.join(", ") || "(none yet)"}\n\n--- EPISODE (surface=${episode.surface}, ${episode.started_at}) ---\n\n${renderTranscript(episode)}`,
        },
      ],
      responseSchema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
    });
    const parsed = result.parsed as { candidates?: ExtractedCandidate[] } | undefined;
    return parsed?.candidates ?? [];
  }
}
