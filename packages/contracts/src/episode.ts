/**
 * The episode envelope (§5.7) — the single integration point for memory.
 * Any harness that can POST this gets the brain; that's the whole contract.
 * Mirrors episode.schema.json, plus one rule the schema cannot express:
 * `seq` must be strictly increasing.
 */

import { Checker, fail, type GuardResult, isRecord } from "./validate.ts";

export const EPISODE_SCHEMA_VERSION = 1;

export const TRUST_TIERS = ["high", "medium", "low", "untrusted"] as const;
/** §6.5 — trust follows the surface, never the conversation. */
export type TrustTier = (typeof TRUST_TIERS)[number];

export const EPISODE_ID_PATTERN = /^ep_[0-9A-HJKMNP-TV-Z]{26}$/;
export const RESULT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const TIMESTAMP_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export interface MessageTurn {
  seq: number;
  kind: "message";
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
}
export const MESSAGE_ROLES = ["user", "assistant", "system"] as const;

export interface ToolCallTurn {
  seq: number;
  kind: "tool_call";
  /** Stable tool URN <server>.<namespace>.<tool> (§4.4). */
  urn: string;
  args: Record<string, unknown>;
  /** Digest of the result, not the result — envelopes stay small, secrets stay out. */
  result_digest: string;
  ts: string;
}

export type Turn = MessageTurn | ToolCallTurn;

export interface EpisodeEnvelope {
  schema_version: typeof EPISODE_SCHEMA_VERSION;
  episode_id: string;
  principal: string;
  surface: string;
  harness: string;
  trust: TrustTier;
  started_at: string;
  ended_at: string;
  /** One ordered array, never parallel message/tool arrays (§5.7). */
  turns: Turn[];
  labels?: string[];
}

const ENVELOPE_KEYS = [
  "schema_version",
  "episode_id",
  "principal",
  "surface",
  "harness",
  "trust",
  "started_at",
  "ended_at",
  "turns",
  "labels",
] as const;

export function validateEpisode(value: unknown): GuardResult<EpisodeEnvelope> {
  if (!isRecord(value)) return fail(["/: expected object"]);
  const c = new Checker();

  if (value.schema_version !== EPISODE_SCHEMA_VERSION) {
    c.fail(
      "/schema_version",
      `expected ${EPISODE_SCHEMA_VERSION}, got ${JSON.stringify(value.schema_version)}`,
    );
  }
  c.string("/episode_id", value.episode_id, {
    pattern: EPISODE_ID_PATTERN,
    patternName: "ep_<26-char Crockford ULID>",
  });
  c.string("/principal", value.principal, { minLength: 1 });
  c.string("/surface", value.surface, { minLength: 1 });
  c.string("/harness", value.harness, { minLength: 1 });
  c.enum("/trust", value.trust, TRUST_TIERS);
  c.string("/started_at", value.started_at, {
    pattern: TIMESTAMP_PATTERN,
    patternName: "ISO 8601 timestamp",
  });
  c.string("/ended_at", value.ended_at, {
    pattern: TIMESTAMP_PATTERN,
    patternName: "ISO 8601 timestamp",
  });

  if (!Array.isArray(value.turns)) {
    c.fail("/turns", "expected array");
  } else if (value.turns.length === 0) {
    c.fail("/turns", "expected at least 1 turn");
  } else {
    let prevSeq = -1;
    value.turns.forEach((turn, i) => {
      const path = `/turns/${i}`;
      if (!isRecord(turn)) {
        c.fail(path, "expected object");
        return;
      }
      if (typeof turn.seq !== "number" || !Number.isInteger(turn.seq) || turn.seq < 0) {
        c.fail(`${path}/seq`, "expected integer ≥ 0");
      } else {
        if (turn.seq <= prevSeq)
          c.fail(`${path}/seq`, `must be strictly increasing (prev ${prevSeq})`);
        prevSeq = turn.seq;
      }
      c.string(`${path}/ts`, turn.ts, {
        pattern: TIMESTAMP_PATTERN,
        patternName: "ISO 8601 timestamp",
      });
      if (turn.kind === "message") {
        c.enum(`${path}/role`, turn.role, MESSAGE_ROLES);
        if (typeof turn.content !== "string") c.fail(`${path}/content`, "expected string");
        c.noExtraKeys(path, turn, ["seq", "kind", "role", "content", "ts"]);
      } else if (turn.kind === "tool_call") {
        c.string(`${path}/urn`, turn.urn, { minLength: 1 });
        if (!isRecord(turn.args)) c.fail(`${path}/args`, "expected object");
        c.string(`${path}/result_digest`, turn.result_digest, {
          pattern: RESULT_DIGEST_PATTERN,
          patternName: "sha256:<64 hex>",
        });
        c.noExtraKeys(path, turn, ["seq", "kind", "urn", "args", "result_digest", "ts"]);
      } else {
        c.fail(
          `${path}/kind`,
          `expected "message" | "tool_call", got ${JSON.stringify(turn.kind)}`,
        );
      }
    });
  }

  if (value.labels !== undefined) c.stringArray("/labels", value.labels, { minLength: 1 });
  c.noExtraKeys("/", value, ENVELOPE_KEYS);

  return c.result(value as unknown as EpisodeEnvelope);
}
