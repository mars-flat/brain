#!/usr/bin/env bun
/**
 * brain-mcp over stdio. BRAIN_VAULT_PATH required, no default (§9.1).
 */

import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildBrainServer } from "./server.ts";

const vault = process.env.BRAIN_VAULT_PATH;
if (!vault) {
  console.error("brain-mcp: BRAIN_VAULT_PATH is required (§9.1)");
  process.exit(2);
}

const server = buildBrainServer({
  vaultPath: resolve(vault),
  // The VM sets BRAIN_INGEST_MODE=queue (via the gateway's servers.yaml env)
  // so ingest returns fast and the batch cadence does the extraction (§5.8).
  ingestMode: process.env.BRAIN_INGEST_MODE === "queue" ? "queue" : "sync",
});
await server.connect(new StdioServerTransport());
