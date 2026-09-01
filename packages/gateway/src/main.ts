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
// Absolutize BEFORE ${VAR} expansion into upstream children: they run in a
// neutral cwd (tmpdir, §4.2), so a relative path would silently resolve to
// a shadow vault there — the 2026-09-01 incident. Children must inherit the
// absolute form.
process.env.BRAIN_VAULT_PATH = resolve(vault);
console.error(`tool-gateway: vault = ${process.env.BRAIN_VAULT_PATH}`);

const gateway = await buildGateway({ vaultPath: resolve(vault), cwd: process.cwd() });
await gateway.server.connect(new StdioServerTransport());
