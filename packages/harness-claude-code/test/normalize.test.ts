/**
 * normalizeEpisode (§6.4): Claude Code transcript JSONL → canonical episode
 * envelope. The properties that matter: the envelope validates against the
 * §5.7 guard, ids are deterministic per session, harness noise and secrets
 * (thinking, tool results, command tags, sidechains) never reach episodic
 * storage, and oversized sessions trim from the oldest end (§5.8).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { validateEpisode } from "@brain/contracts";
import {
  claudeCodeHarness,
  episodeIdFor,
  MAX_CONTENT_CHARS,
  normalizeEpisode,
} from "../src/normalize.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

/** Synthetic transcript — identity-clean per §9.4. */
const FIXTURE = [
  line({ type: "summary", summary: "Garden tracker planning", leafUuid: "u9" }),
  "this line is not json {{{",
  line({
    type: "user",
    isSidechain: false,
    timestamp: "2026-08-27T01:00:00.000Z",
    message: { role: "user", content: "let's pick a database for the garden tracker" },
  }),
  line({
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-08-27T01:00:05.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning about options" },
        { type: "text", text: "I'd use SQLite." },
      ],
    },
  }),
  line({
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-08-27T01:00:10.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "notes.md" } },
      ],
    },
  }),
  line({
    type: "user",
    isSidechain: false,
    timestamp: "2026-08-27T01:00:12.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "SECRET FILE CONTENTS" }],
    },
  }),
  line({
    type: "user",
    isSidechain: false,
    timestamp: "2026-08-27T01:00:20.000Z",
    message: {
      role: "user",
      content: "<command-name>/clear</command-name><command-message>clear</command-message>",
    },
  }),
  // entry without a timestamp — skipped, never crashes
  line({ type: "user", message: { role: "user", content: "no timestamp here" } }),
  line({
    type: "user",
    isSidechain: false,
    timestamp: "2026-08-27T01:01:00.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "ok decided: sqlite it is <system-reminder>reminder noise</system-reminder>",
        },
      ],
    },
  }),
  line({
    type: "user",
    isSidechain: true,
    timestamp: "2026-08-27T01:01:02.000Z",
    message: { role: "user", content: "subagent noise from a sidechain" },
  }),
  line({
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-08-27T01:01:05.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Recorded." }] },
  }),
  line({
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-08-27T01:01:06.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_02", name: "files.list", input: {} }],
    },
  }),
].join("\n");

function fixtureEnvelope() {
  return normalizeEpisode({ sessionId: SESSION, transcriptJsonl: FIXTURE });
}

describe("normalizeEpisode", () => {
  test("produces an envelope the §5.7 guard accepts", () => {
    const verdict = validateEpisode(fixtureEnvelope());
    expect(verdict.ok).toBe(true);
  });

  test("is deterministic and keys the episode id to the session", () => {
    const a = fixtureEnvelope();
    const b = fixtureEnvelope();
    expect(a).toEqual(b);
    expect(a.episode_id).toMatch(/^ep_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(episodeIdFor(SESSION)).toBe(a.episode_id);
    expect(episodeIdFor("another-session")).not.toBe(a.episode_id);
  });

  test("carries the Mode A identity: owner, claude-code, high trust", () => {
    const e = fixtureEnvelope();
    expect(e.principal).toBe("owner");
    expect(e.surface).toBe("claude-code");
    expect(e.harness).toBe("claude-code");
    expect(e.trust).toBe("high");
    expect(e.labels).toEqual(["session"]);
    expect(e.started_at).toBe("2026-08-27T01:00:00.000Z");
    expect(e.ended_at).toBe("2026-08-27T01:01:06.000Z");
  });

  test("keeps the conversation, in order, with strictly increasing seq", () => {
    const e = fixtureEnvelope();
    const shapes = e.turns.map((t) => (t.kind === "message" ? `${t.role}` : `tool:${t.urn}`));
    expect(shapes).toEqual([
      "user",
      "assistant",
      "tool:Read",
      "user",
      "assistant",
      "tool:files.list",
    ]);
    e.turns.forEach((t, i) => {
      expect(t.seq).toBe(i);
    });
  });

  test("strips noise: thinking, tool results, command tags, reminders, sidechains", () => {
    const flat = JSON.stringify(fixtureEnvelope());
    expect(flat).not.toContain("secret reasoning");
    expect(flat).not.toContain("SECRET FILE CONTENTS");
    expect(flat).not.toContain("command-name");
    expect(flat).not.toContain("reminder noise");
    expect(flat).not.toContain("subagent noise");
    const decided = fixtureEnvelope().turns[3];
    if (decided?.kind !== "message") throw new Error("expected message turn");
    expect(decided.content).toBe("ok decided: sqlite it is");
  });

  test("tool calls carry a result digest, never the result", () => {
    const e = fixtureEnvelope();
    const read = e.turns[2];
    if (read?.kind !== "tool_call") throw new Error("expected tool_call");
    const expected = `sha256:${createHash("sha256")
      .update(JSON.stringify("SECRET FILE CONTENTS"))
      .digest("hex")}`;
    expect(read.result_digest).toBe(expected);
    expect(read.args).toEqual({ file_path: "notes.md" });
    const noResult = e.turns[5];
    if (noResult?.kind !== "tool_call") throw new Error("expected tool_call");
    expect(noResult.result_digest).toBe(`sha256:${createHash("sha256").update("").digest("hex")}`);
  });

  test("trims oldest turns when content exceeds the §5.8 budget", () => {
    const big = "x".repeat(Math.ceil(MAX_CONTENT_CHARS / 4));
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) {
      const marker = i === 0 ? "FIRST" : i === 5 ? "FINAL" : `mid-${i}`;
      lines.push(
        line({
          type: "user",
          isSidechain: false,
          timestamp: `2026-08-27T02:00:0${i}.000Z`,
          message: { role: "user", content: `${marker} ${big}` },
        }),
      );
    }
    const e = normalizeEpisode({ sessionId: SESSION, transcriptJsonl: lines.join("\n") });
    const flat = e.turns.map((t) => (t.kind === "message" ? t.content.slice(0, 8) : "")).join("|");
    expect(flat).toContain("FINAL");
    expect(flat).not.toContain("FIRST");
    e.turns.forEach((t, i) => {
      expect(t.seq).toBe(i);
    });
    expect(validateEpisode(e).ok).toBe(true);
  });

  test("rejects empty or wrongly shaped input", () => {
    expect(() => normalizeEpisode({ sessionId: SESSION, transcriptJsonl: "" })).toThrow();
    expect(() => normalizeEpisode({ sessionId: "", transcriptJsonl: FIXTURE })).toThrow();
    expect(() => normalizeEpisode("nope")).toThrow();
  });
});

describe("claudeCodeHarness", () => {
  test("implements the §6.4 port with static Mode A install", async () => {
    expect(claudeCodeHarness.id).toBe("claude-code");
    const result = await claudeCodeHarness.install({ gatewayUrl: "http://unused", targetDir: "." });
    expect(result.filesWritten).toEqual([]);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(claudeCodeHarness.normalizeEpisode).toBe(normalizeEpisode);
  });
});
