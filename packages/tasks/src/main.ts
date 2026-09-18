#!/usr/bin/env bun
/**
 * mcp-tasks over stdio: the gateway spawns one per its servers.yaml entry
 * (§16.5). The store path arrives in env and MUST be absolute — upstreams
 * run in a neutral cwd, and a relative path resolving against the OS temp
 * dir is exactly how the 2026-09-01 shadow-vault incident happened (§4.3).
 */

import { isAbsolute } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildTasksServer } from "./server.ts";
import { openTasksDb, TaskStore } from "./store.ts";
import { resolveTz } from "./time.ts";

const path = process.env.TASKS_DB_PATH;
if (!path) {
  console.error("mcp-tasks: TASKS_DB_PATH is required (§16.3)");
  process.exit(2);
}
if (!isAbsolute(path)) {
  console.error(
    `mcp-tasks: TASKS_DB_PATH must be absolute, got "${path}" — nothing relative crosses the spawn boundary (§4.3)`,
  );
  process.exit(2);
}
const tz = resolveTz(process.env.TASKS_TZ);
if (process.env.TASKS_TZ && tz !== process.env.TASKS_TZ.trim())
  console.error(`mcp-tasks: unknown TASKS_TZ "${process.env.TASKS_TZ}", using UTC`);
console.error(`mcp-tasks: store ${path} · tz ${tz}`);

const server = buildTasksServer(new TaskStore(openTasksDb(path)), { tz });
await server.connect(new StdioServerTransport());
