/**
 * brain-mcp over a real MCP client connection: the eight §5.10 tools,
 * exercised against a scratch copy of the example vault (writes included).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkerExtractor } from "@brain/consolidator";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildBrainServer } from "../src/server.ts";

const EXAMPLE = join(import.meta.dir, "..", "..", "..", "examples", "vault-example");
let client: Client;

/** Scratch vaults must be git repos — the consolidator refuses to write
 *  unversioned memory (2026-09-01 incident). Local identity for CI. */
function gitInit(vault: string): void {
  Bun.spawnSync(["git", "init", "-q"], { cwd: vault });
  Bun.spawnSync(["git", "config", "user.email", "test@example.invalid"], { cwd: vault });
  Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: vault });
}

beforeAll(async () => {
  const vault = mkdtempSync(join(tmpdir(), "brain-mcp-"));
  cpSync(EXAMPLE, vault, { recursive: true });
  gitInit(vault);
  const server = buildBrainServer({
    vaultPath: vault,
    clock: () => new Date("2026-08-26T02:00:00Z"),
    extractor: new MarkerExtractor(),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
});

describe("brain over MCP (§5.10)", () => {
  test("advertises the eight tools with read-only annotations on reads", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "expand",
      "ingest",
      "neighbors",
      "note",
      "pin",
      "recall",
      "timeline",
      "trace",
    ]);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const recallAnnotations = (byName.get("recall")?.annotations ?? {}) as {
      readOnlyHint?: boolean;
    };
    expect(recallAnnotations.readOnlyHint).toBe(true);
    expect(byName.get("note")?.annotations ?? {}).not.toHaveProperty("readOnlyHint");
  });

  test("recall serves the supersedes chain; expand promotes a stub", async () => {
    const res = await client.callTool({
      name: "recall",
      arguments: { query: "jquery prototype ui", budget_tokens: 1200 },
    });
    const out = res.structuredContent as { nodes: Array<{ id: string }>; pack: string };
    const ids = out.nodes.map((n) => n.id);
    expect(ids).toContain("jquery-prototype-ui");
    expect(ids).toContain("htmx-server-rendered-ui");

    const expand = await client.callTool({
      name: "expand",
      arguments: { ids: ["rye-starter-boris", "not-a-node"], tier: "summary" },
    });
    const ex = expand.structuredContent as {
      renders: Array<{ id: string; content: string }>;
      missing: string[];
    };
    expect(ex.renders[0]?.content).toContain("Boris");
    expect(ex.missing).toEqual(["not-a-node"]);
  });

  test("neighbors respects rels and depth", async () => {
    const res = await client.callTool({
      name: "neighbors",
      arguments: { id: "caddy-reverse-proxy", rels: ["supersedes"], depth: 1 },
    });
    const out = res.structuredContent as {
      edges: Array<{ from: string; rel: string; to: string }>;
    };
    expect(out.edges).toEqual([
      { from: "caddy-reverse-proxy", rel: "supersedes", to: "nginx-reverse-proxy" },
    ]);
  });

  test("note writes through the consolidator; trace finds provenance", async () => {
    const res = await client.callTool({
      name: "note",
      arguments: {
        text: '@node concept "Gateway smoke fact" id:gateway-smoke-fact summary:"Written through brain-mcp in a test."',
      },
    });
    const out = res.structuredContent as {
      pending_id: string;
      processed: Array<{ newNodes: string[] }>;
    };
    expect(out.pending_id).toMatch(/^ep_/);
    expect(out.processed[0]?.newNodes).toEqual(["gateway-smoke-fact"]);

    const trace = await client.callTool({
      name: "trace",
      arguments: { node_id: "gateway-smoke-fact" },
    });
    const tr = trace.structuredContent as { episodes: Array<{ episode_id: string }> };
    expect(tr.episodes[0]?.episode_id).toBe(out.pending_id);
  });

  test("ingest accepts a §5.7 envelope, consolidates, and is idempotent on redelivery", async () => {
    const iso = "2026-08-26T01:00:00Z";
    const episode = {
      schema_version: 1,
      episode_id: "ep_01J8Z3M4N5P6Q7R8S9T0V1W2X3",
      principal: "owner",
      surface: "cli",
      harness: "claude-code",
      trust: "high",
      started_at: iso,
      ended_at: iso,
      turns: [
        {
          seq: 0,
          kind: "message",
          role: "user",
          content:
            '@node concept "Ingest tool fact" id:ingest-tool-fact summary:"Delivered over MCP by the P5 ingest tool test."',
          ts: iso,
        },
      ],
      labels: ["session"],
    };
    const res = await client.callTool({ name: "ingest", arguments: { episode } });
    const out = res.structuredContent as {
      episode_id: string;
      processed: Array<{ newNodes: string[] }>;
    };
    expect(out.episode_id).toBe(episode.episode_id);
    expect(out.processed[0]?.newNodes).toEqual(["ingest-tool-fact"]);

    // Redelivery (the hook retries, the network flaked, …) must be a no-op.
    const again = await client.callTool({ name: "ingest", arguments: { episode } });
    const out2 = again.structuredContent as { processed: Array<{ newNodes: string[] }> };
    expect((out2.processed ?? []).flatMap((p) => p.newNodes ?? [])).toEqual([]);
  });

  test("ingest refuses an invalid envelope and an untrusted one (§6.5)", async () => {
    const bad = await client.callTool({ name: "ingest", arguments: { episode: { nope: true } } });
    expect(bad.isError).toBe(true);

    const iso = "2026-08-26T01:30:00Z";
    const untrusted = await client.callTool({
      name: "ingest",
      arguments: {
        episode: {
          schema_version: 1,
          episode_id: "ep_01J8Z3M4N5P6Q7R8S9T0V1W2X4",
          principal: "someone",
          surface: "discord",
          harness: "surface-discord",
          trust: "untrusted",
          started_at: iso,
          ended_at: iso,
          turns: [{ seq: 0, kind: "message", role: "user", content: "write this", ts: iso }],
          labels: [],
        },
      },
    });
    expect(untrusted.isError).toBe(true);
  });

  test("pin lands and rides subsequent recalls", async () => {
    await client.callTool({
      name: "pin",
      arguments: {
        node_id: "rye-starter-boris",
        correction: "Boris is fed the night before, never at dawn.",
        reason: "test pin",
      },
    });
    const res = await client.callTool({
      name: "recall",
      arguments: { query: "when did boris get fed" },
    });
    const out = res.structuredContent as { pack: string };
    expect(out.pack).toContain("📌 PIN: Boris is fed the night before");
  });

  test("timeline filters by label", async () => {
    const res = await client.callTool({ name: "timeline", arguments: { query: "note" } });
    const out = res.structuredContent as { episodes: Array<{ labels: string[] }> };
    expect(out.episodes.length).toBeGreaterThan(0);
    expect(out.episodes.every((e) => e.labels.includes("note"))).toBe(true);
  });
});

describe("ingest in queue mode (§5.8 batched cadence)", () => {
  test("stores + enqueues without consolidating inline", async () => {
    const vault = mkdtempSync(join(tmpdir(), "brain-mcp-q-"));
    cpSync(EXAMPLE, vault, { recursive: true });
    gitInit(vault);
    const server = buildBrainServer({
      vaultPath: vault,
      clock: () => new Date("2026-08-27T02:00:00Z"),
      extractor: new MarkerExtractor(),
      ingestMode: "queue",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const qClient = new Client({ name: "test-q", version: "0" });
    await Promise.all([server.connect(st), qClient.connect(ct)]);

    const iso = "2026-08-27T01:00:00Z";
    const res = await qClient.callTool({
      name: "ingest",
      arguments: {
        episode: {
          schema_version: 1,
          episode_id: "ep_01J8Z3M4N5P6Q7R8S9T0V1W2X7",
          principal: "owner",
          surface: "cli",
          harness: "claude-code",
          trust: "high",
          started_at: iso,
          ended_at: iso,
          turns: [
            {
              seq: 0,
              kind: "message",
              role: "user",
              content:
                '@node concept "Queued fact" id:queued-fact summary:"Waits for the batch cadence."',
              ts: iso,
            },
          ],
          labels: ["session"],
        },
      },
    });
    const out = res.structuredContent as { queued?: boolean; processed: unknown[] };
    expect(out.queued).toBe(true);
    expect(out.processed).toEqual([]);
    // Stored (timeline sees it) but NOT consolidated (no node file).
    const timeline = await qClient.callTool({ name: "timeline", arguments: {} });
    const eps = (timeline.structuredContent as { episodes: Array<{ episode_id: string }> })
      .episodes;
    expect(eps.some((e) => e.episode_id === "ep_01J8Z3M4N5P6Q7R8S9T0V1W2X7")).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(vault, "nodes", "concept", "queued-fact.md"))).toBe(false);
    await qClient.close();
  });
});
