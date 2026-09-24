#!/usr/bin/env bun
/**
 * The daily Mac reminder (§16.6). Read-only by construction: it asks the
 * gateway's `tasks.due` (a tools:read call with a headless client-
 * credentials token, the same plane the SessionEnd hook uses) and shows a
 * System Events dialog — Later / Open — that links to the console for any
 * actual change. It never writes the store.
 *
 * "max(9am, first computer open)" is a guard, not a scheduler: launchd runs
 * this at 09:00, at login, and every half hour; the script exits silently
 * before 9am local or once it has shown today's dialog (a date stamp in
 * ~/.brain). A dark wake — the lid closed, the Mac up for a few seconds to
 * service keepalives — is not "the computer open" and is skipped outright.
 * A failed gateway call retries inside the tick (the network needs a few
 * seconds after a real wake) and then leaves the stamp alone so the next
 * tick tries again.
 *
 * Every failure path exits 0: a launchd agent that "fails" just gets
 * re-run and logged, and a reminder must never become a nag of errors.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { clientCredentialsToken, type DeliveryTarget } from "@brain/harness-claude-code";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface ReminderConfig {
  /** The gateway MCP endpoint, e.g. https://brain.example/mcp */
  gatewayUrl: string;
  /** Where "Open" lands: the console's tasks tab. */
  consoleUrl: string;
  clientId: string;
  /** Auth0 needs an audience on client_credentials; Keycloak ignores it. */
  audience?: string;
  /** Local hour before which the reminder stays silent. Default 9. */
  earliestHour: number;
  horizonDays: number;
  tokenCachePath?: string;
}

export interface DueItem {
  id: string;
  title: string;
  due: string | null;
  due_human: string | null;
}

export interface DueSummary {
  needs_attention: number;
  overdue: DueItem[];
  today: DueItem[];
  upcoming: DueItem[];
}

export function reminderPaths(home = homedir()) {
  const dir = join(home, ".brain");
  return {
    config: join(dir, "tasks-reminder.json"),
    stamp: join(dir, "tasks-reminder-last"),
    log: join(dir, "tasks-reminder.log"),
    tokenCache: join(dir, "tasks-reminder-token.json"),
  };
}

/** Env wins over the install()-written file — same rule as the hook (§6.4). */
export function loadReminderConfig(
  env: Record<string, string | undefined>,
  home = homedir(),
): ReminderConfig | null {
  let file: Partial<ReminderConfig> = {};
  try {
    file = JSON.parse(readFileSync(reminderPaths(home).config, "utf8")) as Partial<ReminderConfig>;
  } catch {
    // no file — env may still carry everything
  }
  const gatewayUrl = env.TOOL_GATEWAY_URL ?? file.gatewayUrl;
  const consoleUrl = env.TASKS_CONSOLE_URL ?? file.consoleUrl;
  const clientId = env.TASKS_REMINDER_CLIENT_ID ?? file.clientId;
  if (!gatewayUrl || !consoleUrl || !clientId) return null;
  return {
    gatewayUrl,
    consoleUrl,
    clientId,
    audience: env.TASKS_REMINDER_AUDIENCE ?? file.audience,
    earliestHour: Number(env.TASKS_REMINDER_EARLIEST_HOUR ?? file.earliestHour ?? 9),
    horizonDays: Number(file.horizonDays ?? 3),
    tokenCachePath: file.tokenCachePath ?? reminderPaths(home).tokenCache,
  };
}

/** Local calendar date — the Mac's zone, which is where the human is. */
export function localToday(now = new Date()): string {
  return now.toLocaleDateString("en-CA");
}

export function shouldFire(
  now: Date,
  lastShown: string | null,
  earliestHour: number,
): { fire: boolean; reason: string } {
  if (now.getHours() < earliestHour) return { fire: false, reason: `before ${earliestHour}:00` };
  if (lastShown === localToday(now)) return { fire: false, reason: "already shown today" };
  return { fire: true, reason: "first run after the hour" };
}

export function readStamp(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function writeStamp(path: string, day: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${day}\n`);
}

/**
 * A dark wake is not "the computer open". A closed MacBook wakes for a few
 * seconds every quarter hour to service TCP keepalives, launchd fires any
 * missed ticks inside those windows, and the network is only half up —
 * every failure in the first week of logs ran that way (2026-09-22..24),
 * and so did the 09:00 "successes". `pmset -g systemstate` lists the
 * current capabilities: a full wake has `Graphics`, a dark wake does not.
 */
export function isDarkWake(systemState: string): boolean {
  const m = /Current System Capabilities are:(.*)/i.exec(systemState);
  if (!m) return false; // unrecognised output: never block the reminder on it
  return !/\bGraphics\b/.test(m[1] ?? "");
}

export function readSystemState(): string {
  if (process.platform !== "darwin") return "";
  try {
    const run = Bun.spawnSync(["pmset", "-g", "systemstate"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    return run.stdout.toString();
  } catch {
    return "";
  }
}

/** Connect, DNS and timeout failures — the network still coming up after a wake. */
export function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Unable to connect|fetch failed|ECONN|ENOTFOUND|ETIMEOUT|ETIMEDOUT|EAI_AGAIN|getaddrinfo|Request timed out|-32001/i.test(
    msg,
  );
}

export interface RetryOptions {
  attempts: number;
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Wi-Fi and the tailnet need a few seconds after a real wake. Retrying
 * inside the tick beats waiting for launchd's next one, which can be hours
 * away if the lid closes again. Anything that is not a network error
 * (a 403, a refused tool) is thrown at once.
 */
export async function withNetworkRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.attempts || !isTransientNetworkError(err)) throw err;
      opts.onRetry?.(attempt, err);
      await sleep(opts.delayMs);
    }
  }
}

/** One `tasks.due` call through the gateway. */
export async function fetchDue(cfg: ReminderConfig, clientSecret: string): Promise<DueSummary> {
  const target: DeliveryTarget = {
    gatewayUrl: cfg.gatewayUrl,
    clientId: cfg.clientId,
    clientSecret,
    audience: cfg.audience,
    tokenCachePath: cfg.tokenCachePath,
    scope: "tools:read",
  };
  const bearer = await clientCredentialsToken(target);
  const client = new Client({ name: "tasks-reminder", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(cfg.gatewayUrl), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    }),
  );
  try {
    const res = await client.callTool({
      name: "tools_call",
      arguments: { urn: "tasks.due", args: { horizon_days: cfg.horizonDays } },
    });
    const sc = res.structuredContent as
      | {
          ok?: boolean;
          result?: {
            isError?: boolean;
            structuredContent?: DueSummary;
            content?: Array<{ text?: string }>;
          };
        }
      | undefined;
    if (!sc?.ok || sc.result?.isError || !sc.result?.structuredContent)
      throw new Error(
        `gateway refused tasks.due: ${sc?.result?.content?.[0]?.text ?? JSON.stringify(res.content).slice(0, 200)}`,
      );
    return sc.result.structuredContent;
  } finally {
    await client.close().catch(() => {});
  }
}

/** The dialog body, or null when nothing needs attention (stay silent). */
export function dialogText(due: DueSummary, maxLines = 6): string | null {
  const items = [...due.overdue, ...due.today];
  if (items.length === 0) return null;
  const head =
    items.length === 1 ? "1 task needs attention" : `${items.length} tasks need attention`;
  const lines = items.slice(0, maxLines).map((t) => `• ${t.title} — ${t.due ?? ""}`.trimEnd());
  if (items.length > maxLines) lines.push(`…and ${items.length - maxLines} more`);
  const soon =
    due.upcoming.length > 0
      ? `\n\n${due.upcoming.length} more coming up in the next few days.`
      : "";
  return `${head}\n\n${lines.join("\n")}${soon}`;
}

function appleScriptString(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

/** A real modal via System Events — no notification permission needed (verified 2026-09-17). */
export function showDialog(text: string): "open" | "later" {
  const script = `tell application "System Events" to display dialog ${appleScriptString(text)} with title "tasks" buttons {"Later", "Open"} default button "Open" with icon note`;
  const run = Bun.spawnSync(["osascript", "-e", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return run.stdout.toString().includes("Open") ? "open" : "later";
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const force = args.has("--force");
  const paths = reminderPaths();
  const log = (msg: string) => console.error(`tasks-reminder ${new Date().toISOString()}: ${msg}`);

  const cfg = loadReminderConfig(process.env);
  if (!cfg) {
    log("not configured — run the installer (packages/tasks-reminder/src/install.ts)");
    return;
  }
  const secret = process.env.TASKS_REMINDER_CLIENT_SECRET;
  if (!secret) {
    log("TASKS_REMINDER_CLIENT_SECRET is not set (the repo .env, loaded via WorkingDirectory)");
    return;
  }

  const gate = shouldFire(new Date(), readStamp(paths.stamp), cfg.earliestHour);
  if (!gate.fire && !force && !dryRun) return; // silent by design
  if (!gate.fire) log(`${gate.reason} — continuing because of --force/--dry-run`);

  if (isDarkWake(readSystemState())) {
    if (!force && !dryRun) return; // lid closed: not "the computer open" — stamp untouched
    log("dark wake (no display) — continuing because of --force/--dry-run");
  }

  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  let due: DueSummary;
  try {
    due = await withNetworkRetry(() => fetchDue(cfg, secret), {
      attempts: 3,
      delayMs: 20_000,
      onRetry: (attempt, err) =>
        log(`gateway unreachable (${errText(err)}) — retry ${attempt} of 2 in 20s`),
    });
  } catch (err) {
    log(`gateway call failed (${errText(err)}) — will retry next tick`);
    return;
  }

  const text = dialogText(due);
  if (dryRun) {
    console.log(text ?? "(nothing needs attention — no dialog)");
    return;
  }
  const today = localToday();
  if (!text) {
    writeStamp(paths.stamp, today);
    log("nothing due — silent");
    return;
  }
  if (process.platform !== "darwin") {
    console.log(text);
    writeStamp(paths.stamp, today);
    return;
  }
  const choice = showDialog(text);
  writeStamp(paths.stamp, today);
  log(`shown (${due.needs_attention} need attention) → ${choice}`);
  if (choice === "open") {
    const url = `${cfg.consoleUrl.replace(/\/$/, "")}/tasks`;
    Bun.spawnSync(["open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`tasks-reminder: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  });
}
