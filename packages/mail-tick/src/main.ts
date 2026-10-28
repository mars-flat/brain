#!/usr/bin/env bun
/**
 * mail-tick: the twice-daily mail tick, run by a systemd timer on the VM
 * inside the gateway container (`docker compose exec -T gateway bun
 * /app/packages/mail-tick/src/main.ts`), the same shape as the consolidate
 * cadence (§5.8). A gateway client, never an upstream: it authenticates as
 * the `mail-tick` M2M client and every call rides tools_call.
 *
 *   --dry-run        propose nothing, label nothing; print what would happen
 *   --since 3d       the search window (default 2d; use 3d on the first run)
 *   --no-organize    proposals and the seen-marker only; no lanes, no archive
 *   --account g-x    one account only (repeatable)
 *
 * Env: MAIL_TICK_CLIENT_ID / MAIL_TICK_CLIENT_SECRET (Auth0 M2M), GATEWAY_AUDIENCE,
 * MAIL_TICK_GATEWAY_URL (default http://127.0.0.1:8090/mcp), OPENAI_API_KEY,
 * OPENAI_BASE_URL (test override), MAIL_TICK_MODEL (default gpt-5.6-luna),
 * TASKS_TZ, MAIL_TICK_CONFIG (optional JSON: { "accounts": { "g-x": { "lanes": [...], "hint": "..." } } }),
 * MAIL_TICK_TOKEN_CACHE (default /data/tasks/mail-tick-token.json).
 */

import { readFileSync } from "node:fs";
import { clientCredentialsToken } from "@brain/harness-claude-code";
import { OpenAiModelClient } from "@brain/model-openai";
import { GatewayClient } from "./gateway.ts";
import { type AccountConfig, runTick } from "./tick.ts";

function flag(name: string): boolean {
  return process.argv.includes(name);
}
function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function options(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1] as string);
  });
  return out;
}

const env = process.env;
const need = (k: string): string => {
  const v = env[k];
  if (!v) {
    console.error(`mail-tick: ${k} is required`);
    process.exit(2);
  }
  return v;
};

const dryRun = flag("--dry-run");
const window = option("--since") ?? "2d";
if (!/^\d{1,3}[dh]$/.test(window)) {
  console.error(`mail-tick: --since must look like 2d or 36h, got ${window}`);
  process.exit(2);
}
const organize = !flag("--no-organize");
const only = options("--account");
const tz = env.TASKS_TZ?.trim() || "UTC";
const gatewayUrl = env.MAIL_TICK_GATEWAY_URL ?? "http://127.0.0.1:8090/mcp";
const modelName = env.MAIL_TICK_MODEL ?? "gpt-5.6-luna";

let accounts: Record<string, AccountConfig> | undefined;
if (env.MAIL_TICK_CONFIG) {
  try {
    accounts = (
      JSON.parse(readFileSync(env.MAIL_TICK_CONFIG, "utf8")) as { accounts?: typeof accounts }
    ).accounts;
  } catch (err) {
    console.error(`mail-tick: cannot read ${env.MAIL_TICK_CONFIG}: ${String(err)}`);
    process.exit(2);
  }
}

const log = (line: string) => console.log(`mail-tick ${new Date().toISOString()} ${line}`);

const bearer = await clientCredentialsToken({
  gatewayUrl,
  clientId: need("MAIL_TICK_CLIENT_ID"),
  clientSecret: need("MAIL_TICK_CLIENT_SECRET"),
  audience: env.GATEWAY_AUDIENCE,
  scope: "tools:read tools:write",
  tokenCachePath: env.MAIL_TICK_TOKEN_CACHE ?? "/data/tasks/mail-tick-token.json",
});
const gateway = new GatewayClient(gatewayUrl, bearer);
await gateway.connect();
const model = new OpenAiModelClient(need("OPENAI_API_KEY"), env.OPENAI_BASE_URL || undefined);

log(
  `tick start · window ${window} · organize ${organize ? "on" : "off"} · ${dryRun ? "DRY RUN" : "live"} · tz ${tz}`,
);
try {
  const summaries = await runTick({
    gateway,
    model,
    modelName,
    tz,
    window,
    dryRun,
    organize,
    capPerAccount: 20,
    accounts,
    only: only.length ? only : undefined,
    log,
  });
  const stopped = summaries.filter((s) => s.warnings.some((w) => w.startsWith("stopped:")));
  log(`tick end · ${summaries.length} account(s) · ${stopped.length} stopped early`);
  process.exit(stopped.length && stopped.length === summaries.length ? 1 : 0);
} finally {
  await gateway.close();
}
