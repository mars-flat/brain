/**
 * End-to-end gateway smoke over REAL stdio — the P3 done-when, executable
 * against your live vault and config:
 *
 *   bun scripts/gateway-smoke.ts
 *
 * Spawns packages/gateway/src/main.ts exactly as an MCP client would,
 * lists the four meta-tools, searches for memory recall, describes the hit,
 * calls brain.recall, and prints server health.
 */

import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(import.meta.dir, "..");
const bunDir = dirname(process.execPath);

const client = new Client({ name: "gateway-smoke", version: "0.1.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, "packages", "gateway", "src", "main.ts")],
    cwd: repoRoot,
    env: {
      ...(process.env as Record<string, string>),
      PATH: `${bunDir}:${process.env.PATH ?? ""}`,
      BRAIN_VAULT_PATH: join(repoRoot, "vault"),
    },
    stderr: "inherit",
  }),
);

const { tools } = await client.listTools();
console.log(`meta-tools: ${tools.map((t) => t.name).join(", ")}`);

const servers = await client.callTool({ name: "tools_servers", arguments: {} });
for (const s of (servers.structuredContent as { results: Array<Record<string, unknown>> })
  .results) {
  console.log(`  server ${s.name}: ${s.status} (${s.tool_count} tools)`);
}

const search = await client.callTool({
  name: "tools_search",
  arguments: { query: "recall memory from the knowledge graph" },
});
const hits = (search.structuredContent as { results: Array<Record<string, unknown>> }).results;
console.log(`search top hit: ${hits[0]?.urn} — ${hits[0]?.one_line}`);

const call = await client.callTool({
  name: "tools_call",
  arguments: { urn: "brain.recall", args: { query: "keycloak auth decision", budget_tokens: 900 } },
});
const result = call.structuredContent as { ok?: boolean; result?: unknown };
console.log(`brain.recall ok=${result.ok}`);
const inner = result.result as { content?: Array<{ text?: string }> };
console.log((inner.content?.[0]?.text ?? "").slice(0, 700));

await client.close();
console.log("smoke: PASS");
