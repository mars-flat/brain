#!/usr/bin/env bun
/**
 * tool-gateway over stdio (P3 transport; Streamable HTTP + OAuth arrive
 * with P4). BRAIN_VAULT_PATH required, no default (§9.1).
 */

import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildGateway } from "./server.ts";

const vault = process.env.BRAIN_VAULT_PATH;
if (!vault) {
  console.error("tool-gateway: BRAIN_VAULT_PATH is required (§9.1)");
  process.exit(2);
}

const gateway = await buildGateway({ vaultPath: resolve(vault), cwd: process.cwd() });
await gateway.server.connect(new StdioServerTransport());
