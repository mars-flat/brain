/**
 * Claude Code transcript (JSONL) → canonical episode envelope (§5.7, §6.4).
 *
 * Mode A: Claude Code is both surface and harness (§6.0) on the owner's
 * machine — trust "high" (§6.5). Only message text and tool-call digests
 * enter episodic storage: thinking blocks, tool results, command tags,
 * system reminders, and sidechain (subagent) lines are stripped here, so
 * they never reach the vault or the extractor.
 */
import { createHash } from "node:crypto";
import type { EpisodeEnvelope, HarnessAdapter, InstallResult, Turn } from "@brain/contracts";
import { validateEpisode } from "@brain/contracts";

export interface ClaudeCodeTranscript {
  sessionId: string;
  /** Contents of the session's transcript .jsonl file. */
  transcriptJsonl: string;
}

/** ≈150k tokens at chars/4 — safely under the 200k ingest guard (§5.8). */
export const MAX_CONTENT_CHARS = 600_000;

/** Crockford base32, the ULID alphabet the episode id pattern requires. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Deterministic episode id per session: SessionEnd can fire again for the
 * same session (and a crashed hook can rerun) — same id in, consolidator
 * ledger idempotency out.
 */
export function episodeIdFor(sessionId: string): string {
  const digest = createHash("sha256").update(`claude-code:${sessionId}`).digest();
  let acc = 0;
  let bits = 0;
  let out = "";
  for (const byte of digest) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      bits -= 5;
      out += CROCKFORD[(acc >> bits) & 31];
    }
    if (out.length === 26) break;
  }
  return `ep_${out}`;
}

const NOISE = [
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
];

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

interface RawEntry {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

function sha256(s: string): string {
  return `sha256:${createHash("sha256").update(s).digest("hex")}`;
}

function stripNoise(text: string): string {
  let out = text;
  for (const re of NOISE) out = out.replace(re, "");
  return out.trim();
}

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

function turnChars(t: Turn): number {
  return t.kind === "message" ? t.content.length : JSON.stringify(t.args).length + 64;
}

export function normalizeEpisode(raw: unknown): EpisodeEnvelope {
  const { sessionId, transcriptJsonl } = (raw ?? {}) as Partial<ClaudeCodeTranscript>;
  if (!sessionId || typeof sessionId !== "string" || typeof transcriptJsonl !== "string")
    throw new Error("normalizeEpisode expects { sessionId, transcriptJsonl }");

  const entries: RawEntry[] = [];
  for (const lineText of transcriptJsonl.split("\n")) {
    if (!lineText.trim()) continue;
    try {
      entries.push(JSON.parse(lineText) as RawEntry);
    } catch {
      // transcripts are harness-internal; unparseable lines are not our bug
    }
  }

  // Pass 1 — tool results by tool_use_id, digested and then discarded.
  const resultDigests = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "user") continue;
    for (const block of blocksOf(entry.message?.content)) {
      if (block.type === "tool_result" && block.tool_use_id)
        resultDigests.set(block.tool_use_id, sha256(JSON.stringify(block.content ?? "")));
    }
  }

  // Pass 2 — ordered turns.
  const turns: Turn[] = [];
  for (const entry of entries) {
    if (entry.isSidechain) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const ts = entry.timestamp;
    if (!ts || !TS.test(ts)) continue;
    const content = entry.message?.content;

    if (entry.type === "assistant") {
      const texts: string[] = [];
      for (const block of blocksOf(content)) {
        if (block.type === "text" && block.text) texts.push(block.text);
        if (block.type === "tool_use" && block.name) {
          const args =
            block.input && typeof block.input === "object" && !Array.isArray(block.input)
              ? (block.input as Record<string, unknown>)
              : {};
          turns.push({
            seq: turns.length,
            kind: "tool_call",
            urn: block.name,
            args,
            result_digest: resultDigests.get(block.id ?? "") ?? sha256(""),
            ts,
          });
        }
      }
      const text = stripNoise(texts.join("\n\n"));
      if (text)
        turns.push({ seq: turns.length, kind: "message", role: "assistant", content: text, ts });
      continue;
    }

    const pieces =
      typeof content === "string"
        ? [content]
        : blocksOf(content)
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text as string);
    const text = stripNoise(pieces.join("\n\n"));
    if (text) turns.push({ seq: turns.length, kind: "message", role: "user", content: text, ts });
  }

  if (turns.length === 0) throw new Error("transcript yielded no turns");

  // §5.8 guard: trim the oldest turns first — recent context extracts best.
  let total = turns.reduce((n, t) => n + turnChars(t), 0);
  while (total > MAX_CONTENT_CHARS && turns.length > 1) {
    const dropped = turns.shift() as Turn;
    total -= turnChars(dropped);
  }
  turns.forEach((t, i) => {
    t.seq = i;
  });

  const first = turns[0] as Turn;
  const last = turns[turns.length - 1] as Turn;
  const envelope: EpisodeEnvelope = {
    schema_version: 1,
    episode_id: episodeIdFor(sessionId),
    principal: "owner",
    surface: "claude-code",
    harness: "claude-code",
    trust: "high",
    started_at: first.ts,
    ended_at: last.ts,
    turns,
    labels: ["session"],
  };

  const verdict = validateEpisode(envelope);
  if (!verdict.ok)
    throw new Error(`normalized envelope invalid:\n  ${verdict.errors.join("\n  ")}`);
  return verdict.value;
}

/**
 * §6.4 port. install() is deliberately static for Mode A on this machine:
 * the config it would write is committed to the repo instead. It starts
 * writing real config at P5, when a remote harness needs a gateway URL.
 */
export const claudeCodeHarness: HarnessAdapter = {
  id: "claude-code",
  async install(): Promise<InstallResult> {
    return {
      filesWritten: [],
      notes: [
        "Mode A config is committed, not installed (§6.4): .mcp.json registers the gateway, .claude/settings.json registers the SessionEnd hook, .claude/skills/brain-memory/ carries the protocol.",
        "install() writes real harness config at P5, when there is an HTTP gateway URL to point at.",
      ],
    };
  },
  normalizeEpisode,
};
