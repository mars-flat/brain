#!/usr/bin/env bun
/**
 * One-shot installer for the daily reminder (§16.6): writes the launchd
 * agent plist and the reminder's config file, then loads the agent into
 * the GUI session. Per machine, outside the deploy pipeline — the reminder
 * is a local artifact. Secrets never land in the plist or the config: the
 * client secret lives in the repo's .env, which bun auto-loads because the
 * agent's WorkingDirectory is the repo.
 *
 *   bun packages/tasks-reminder/src/install.ts \
 *     --gateway-url https://brain.example/mcp --console-url https://brain.example \
 *     --client-id <tasks-reminder client id> [--audience <api audience>]
 *   bun packages/tasks-reminder/src/install.ts --uninstall
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { reminderPaths } from "./reminder.ts";

export const LABEL = "com.brain.tasks-reminder";

export interface InstallOptions {
  home: string;
  repoRoot: string;
  bunPath: string;
  gatewayUrl: string;
  consoleUrl: string;
  clientId: string;
  audience?: string;
  earliestHour?: number;
}

export function plistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * 09:00 daily + every 30 minutes + at login. The script itself enforces
 * "not before 9, once a day" (reminder.ts), so the extra ticks cost a
 * silent exit and buy retries when the first attempt found no tailnet.
 */
export function renderPlist(o: InstallOptions): string {
  const script = join(o.repoRoot, "packages", "tasks-reminder", "src", "reminder.ts");
  const log = reminderPaths(o.home).log;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(o.bunPath)}</string>
    <string>${xml(script)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(o.repoRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${o.earliestHour ?? 9}</integer><key>Minute</key><integer>0</integer></dict>
  <key>StartInterval</key><integer>1800</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin</string></dict>
</dict>
</plist>
`;
}

export interface InstallResult {
  filesWritten: string[];
  notes: string[];
}

type Launchctl = (args: string[]) => { exitCode: number; stderr: string };

export function writeInstall(o: InstallOptions, launchctl: Launchctl): InstallResult {
  const paths = reminderPaths(o.home);
  const plist = plistPath(o.home);
  const filesWritten: string[] = [];
  const notes: string[] = [];

  mkdirSync(dirname(paths.config), { recursive: true });
  writeFileSync(
    paths.config,
    `${JSON.stringify(
      {
        gatewayUrl: o.gatewayUrl,
        consoleUrl: o.consoleUrl,
        clientId: o.clientId,
        ...(o.audience ? { audience: o.audience } : {}),
        earliestHour: o.earliestHour ?? 9,
        horizonDays: 3,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  filesWritten.push(paths.config);

  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, renderPlist(o));
  filesWritten.push(plist);

  const domain = `gui/${process.getuid?.() ?? 501}`;
  launchctl(["bootout", domain, plist]); // ignore: not loaded yet on first install
  const loaded = launchctl(["bootstrap", domain, plist]);
  if (loaded.exitCode !== 0)
    notes.push(
      `launchctl bootstrap failed: ${loaded.stderr.trim()} — load it by hand: launchctl bootstrap ${domain} ${plist}`,
    );
  else
    notes.push(
      `agent loaded (${domain}); first run happens now, then daily at ${o.earliestHour ?? 9}:00`,
    );

  notes.push(
    `TASKS_REMINDER_CLIENT_SECRET must be in ${join(o.repoRoot, ".env")} — the agent's working directory is the repo so bun loads it.`,
    "Try it: bun packages/tasks-reminder/src/reminder.ts --dry-run",
  );
  return { filesWritten, notes };
}

export function uninstall(home: string, launchctl: Launchctl): string[] {
  const plist = plistPath(home);
  const removed: string[] = [];
  launchctl(["bootout", `gui/${process.getuid?.() ?? 501}`, plist]);
  if (existsSync(plist)) {
    rmSync(plist);
    removed.push(plist);
  }
  return removed;
}

function realLaunchctl(args: string[]) {
  const run = Bun.spawnSync(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: run.exitCode, stderr: run.stderr.toString() };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "gateway-url": { type: "string" },
      "console-url": { type: "string" },
      "client-id": { type: "string" },
      audience: { type: "string" },
      hour: { type: "string" },
      uninstall: { type: "boolean" },
    },
  });
  const home = homedir();
  if (values.uninstall) {
    const removed = uninstall(home, realLaunchctl);
    console.log(removed.length ? `removed ${removed.join(", ")}` : "nothing was installed");
    process.exit(0);
  }
  const repoRoot = resolve(import.meta.dir, "..", "..", "..");
  // Defaults from the SessionEnd hook's config: the gateway URL and audience
  // are the same tailnet-only values (§9.2 — hand-placed, never committed).
  let harness: { gatewayUrl?: string; audience?: string } = {};
  try {
    harness = JSON.parse(readFileSync(join(repoRoot, ".claude", "brain-harness.json"), "utf8"));
  } catch {
    // fine — flags may carry everything
  }
  const gatewayUrl = values["gateway-url"] ?? harness.gatewayUrl;
  const consoleUrl = values["console-url"] ?? gatewayUrl?.replace(/\/mcp\/?$/, "");
  const clientId = values["client-id"] ?? process.env.TASKS_REMINDER_CLIENT_ID;
  if (!gatewayUrl || !consoleUrl || !clientId) {
    console.error(
      "usage: install.ts --gateway-url <…/mcp> --console-url <https://…> --client-id <id> [--audience <aud>] [--hour 9] | --uninstall",
    );
    process.exit(2);
  }
  const result = writeInstall(
    {
      home,
      repoRoot,
      bunPath: process.execPath,
      gatewayUrl,
      consoleUrl,
      clientId,
      audience: values.audience ?? harness.audience ?? process.env.TASKS_REMINDER_AUDIENCE,
      earliestHour: values.hour ? Number(values.hour) : undefined,
    },
    realLaunchctl,
  );
  for (const f of result.filesWritten) console.log(`wrote ${f}`);
  for (const n of result.notes) console.log(`note: ${n}`);
}
