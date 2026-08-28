/**
 * P3 done-when, executable: an MCP client connects to the gateway, base
 * context is < 1k tokens, tools_search finds the right tool, and the
 * policy/confirm/audit machinery holds (§4.4, §4.5, §8.4).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyDocument, ToolsCallResult } from "@brain/contracts";
import { estimateTokens } from "@brain/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuditLog } from "../src/audit.ts";
import { expandEnv } from "../src/config.ts";
import { classifyKind } from "../src/kinds.ts";
import { buildGateway, META_TOOLS, type RunningGateway } from "../src/server.ts";

const FIXTURE = join(import.meta.dir, "fake-upstream.ts");

const TEST_POLICY: PolicyDocument = [
  { match: { tool: "*.purge_*" }, effect: "deny", reason: "destructive" },
  // The owner's permanent no-send rule (§4.5) — mirrors the real vault policy.
  {
    match: { tool: ["*.send_*", "*.send", "*send_message*", "*send_email*", "*send_draft*"] },
    effect: "deny",
    reason: "email sending is disabled at the gateway, permanently, by owner rule",
  },
  { match: { kind: "read" }, effect: "allow" },
  { default: "confirm" },
];

let clockMs = Date.parse("2026-08-26T02:00:00Z");
const clock = () => new Date(clockMs);

let gw: RunningGateway;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "brain-gateway-"));
  gw = await buildGateway({
    vaultPath: tmp,
    cwd: join(import.meta.dir, "..", "..", ".."),
    clock,
    dbPath: ":memory:",
    auditPath: join(tmp, "audit.jsonl"),
    config: {
      servers: [
        { name: "fake", command: process.execPath, args: [FIXTURE], enabled: true },
        {
          name: "ghost",
          command: process.execPath,
          args: ["/nonexistent-server.ts"],
          enabled: true,
        },
      ],
      policy: TEST_POLICY,
      identity: { principal: "owner", surface: "cli", trust: "high" },
      rateLimitPerMin: 50,
    },
  });
});

afterAll(async () => {
  await gw.stop();
});

describe("classification (§4.3 risk tiers)", () => {
  test("annotations, heuristics, and overrides in authority order", () => {
    expect(classifyKind({ name: "x", annotations: { readOnlyHint: true } })).toBe("read");
    expect(classifyKind({ name: "x", annotations: { destructiveHint: true } })).toBe("admin");
    expect(classifyKind({ name: "list_files" })).toBe("read");
    expect(classifyKind({ name: "delete_repo" })).toBe("admin");
    expect(classifyKind({ name: "create_issue" })).toBe("write");
    expect(classifyKind({ name: "delete_repo" }, [{ pattern: "delete_*", kind: "write" }])).toBe(
      "write",
    );
  });

  test("env expansion in server config", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: expandEnv's own placeholder syntax
    expect(expandEnv("${HOME}/x", { HOME: "/h" })).toBe("/h/x");
    expect(expandEnv("plain", {})).toBe("plain");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: expandEnv's own placeholder syntax
    expect(expandEnv("${MISSING}", {})).toBe("");
  });
});

describe("gateway over a real MCP client connection", () => {
  let client: Client;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-harness", version: "0.0.1" });
    await Promise.all([gw.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  test("advertises exactly four meta-tools, base context < 1k tokens (§4.4)", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "tools_call",
      "tools_describe",
      "tools_search",
      "tools_servers",
    ]);
    const baseContext = estimateTokens(JSON.stringify(META_TOOLS));
    expect(baseContext).toBeLessThan(1000);
  });

  test("catalog and URNs: up server indexed, down server reported (§4.2)", async () => {
    const res = await client.callTool({ name: "tools_servers", arguments: {} });
    const servers = (res.structuredContent as { results: Array<Record<string, unknown>> }).results;
    const fake = servers.find((s) => s.name === "fake");
    const ghost = servers.find((s) => s.name === "ghost");
    expect(fake?.status).toBe("up");
    expect(fake?.tool_count).toBe(5);
    expect(ghost?.status).toBe("down");
  });

  test("tools_search finds the right tool and filters denied ones (§4.4, §4.5)", async () => {
    const res = await client.callTool({
      name: "tools_search",
      arguments: { query: "read a note" },
    });
    const hits = (res.structuredContent as { results: Array<Record<string, unknown>> }).results;
    expect(hits[0]?.urn).toBe("fake.read_note");
    expect(hits.every((h) => h.urn !== "fake.purge_notes")).toBe(true);

    const purge = await client.callTool({
      name: "tools_search",
      arguments: { query: "destroy purge notes" },
    });
    const purgeHits = (purge.structuredContent as { results: Array<Record<string, unknown>> })
      .results;
    expect(purgeHits.every((h) => h.urn !== "fake.purge_notes")).toBe(true);
  });

  test("tools_describe returns schema + risk", async () => {
    const res = await client.callTool({
      name: "tools_describe",
      arguments: { urns: ["fake.append_note", "fake.read_note", "nope.nope"] },
    });
    const described = (res.structuredContent as { results: Array<Record<string, unknown>> })
      .results;
    expect(described.length).toBe(2);
    const first = described[0] as Record<string, unknown>;
    expect(first.risk).toBe("write");
    expect((first.input_schema as Record<string, unknown>).type).toBe("object");
  });

  test("read call: allowed, executed, wrapped untrusted (§4.6)", async () => {
    const res = await client.callTool({
      name: "tools_call",
      arguments: { urn: "fake.read_note", args: { title: "hello" } },
    });
    const out = res.structuredContent as Extract<ToolsCallResult, { ok: true }>;
    expect(out.ok).toBe(true);
    expect(out.untrusted_content).toBe(true);
    expect(JSON.stringify(out.result)).toContain("fake:read_note");
  });

  test("write call: needs_confirm → token round-trip → executes (§4.4)", async () => {
    const args = { urn: "fake.append_note", args: { title: "t", line: "l" } };
    const first = await client.callTool({ name: "tools_call", arguments: args });
    const confirm = first.structuredContent as Extract<ToolsCallResult, { needs_confirm: true }>;
    expect(confirm.needs_confirm).toBe(true);
    expect(confirm.risk).toBe("write");
    expect(confirm.preview).toContain("fake.append_note");

    // Wrong args with a valid token: refused (a fresh confirm comes back).
    const tampered = await client.callTool({
      name: "tools_call",
      arguments: {
        urn: "fake.append_note",
        args: { title: "t", line: "SOMETHING ELSE" },
        confirm_token: confirm.confirm_token,
      },
    });
    expect((tampered.structuredContent as Record<string, unknown>).needs_confirm).toBe(true);

    const second = await client.callTool({
      name: "tools_call",
      arguments: { ...args, confirm_token: confirm.confirm_token },
    });
    const done = second.structuredContent as Extract<ToolsCallResult, { ok: true }>;
    expect(done.ok).toBe(true);

    // Token is single-use.
    const replay = await client.callTool({
      name: "tools_call",
      arguments: { ...args, confirm_token: confirm.confirm_token },
    });
    expect((replay.structuredContent as Record<string, unknown>).needs_confirm).toBe(true);
  });

  test("expired confirm token is refused", async () => {
    const args = { urn: "fake.append_note", args: { title: "x", line: "y" } };
    const first = await client.callTool({ name: "tools_call", arguments: args });
    const confirm = first.structuredContent as Extract<ToolsCallResult, { needs_confirm: true }>;
    clockMs += 6 * 60_000; // past the 5-minute TTL
    const late = await client.callTool({
      name: "tools_call",
      arguments: { ...args, confirm_token: confirm.confirm_token },
    });
    expect((late.structuredContent as Record<string, unknown>).needs_confirm).toBe(true);
  });

  test("deny: refused with the rule, upstream never called (§4.5)", async () => {
    const res = await client.callTool({
      name: "tools_call",
      arguments: { urn: "fake.purge_notes", args: {} },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("denied by policy rule #0");
  });

  test("send-shaped tools die at the policy layer even when an upstream advertises one (W2)", async () => {
    const res = await client.callTool({
      name: "tools_call",
      arguments: { urn: "fake.send_message", args: { to: "x", body: "y" } },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("denied by policy rule #1");
    expect(JSON.stringify(res.content)).toContain("sending is disabled");
  });

  test("unknown urn errors cleanly", async () => {
    const res = await client.callTool({
      name: "tools_call",
      arguments: { urn: "nope.nothing", args: {} },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("unknown tool urn");
  });

  test("rate limit trips and is audited (§7 runaway agent)", async () => {
    gw.deps.rateWindow.length = 0;
    gw.deps.rateLimitPerMin = 3;
    for (let i = 0; i < 3; i++) {
      await client.callTool({
        name: "tools_call",
        arguments: { urn: "fake.read_note", args: { title: `r${i}` } },
      });
    }
    const fourth = await client.callTool({
      name: "tools_call",
      arguments: { urn: "fake.read_note", args: { title: "r3" } },
    });
    expect(fourth.isError).toBe(true);
    expect(JSON.stringify(fourth.content)).toContain("rate limit");
    gw.deps.rateLimitPerMin = 50;
  });
});

describe("audit chain (§4.2)", () => {
  test("executed calls carry a numeric duration (W1.7 analytics)", async () => {
    const raw = await Bun.file(join(tmp, "audit.jsonl")).text();
    const calls = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: { type: string; ms?: number } })
      .filter((l) => l.event.type === "call");
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(typeof c.event.ms).toBe("number");
  });

  test("hash chain verifies; args appear only as digests; tampering detected", async () => {
    const path = join(tmp, "audit.jsonl");
    const verdict = AuditLog.verify(path);
    expect(verdict.ok).toBe(true);
    expect(verdict.entries).toBeGreaterThan(5);

    const raw = await Bun.file(path).text();
    expect(raw).not.toContain("SOMETHING ELSE"); // arg VALUES never logged
    expect(raw).toContain("argsDigest");

    const lines = raw.trim().split("\n");
    const tampered = lines
      .map((l, i) => (i === 2 ? l.replace('"owner"', '"mallory"') : l))
      .join("\n");
    const tamperedPath = join(tmp, "tampered.jsonl");
    await Bun.write(tamperedPath, `${tampered}\n`);
    const broken = AuditLog.verify(tamperedPath);
    expect(broken.ok).toBe(false);
    expect(broken.breakAt).toBe(3);
  });
});
