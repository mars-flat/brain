/**
 * brain-mcp over a real MCP client connection: the seven §5.10 tools,
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

beforeAll(async () => {
  const vault = mkdtempSync(join(tmpdir(), "brain-mcp-"));
  cpSync(EXAMPLE, vault, { recursive: true });
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
  test("advertises the seven tools with read-only annotations on reads", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "expand",
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
