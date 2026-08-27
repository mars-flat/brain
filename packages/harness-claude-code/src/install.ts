/**
 * install() at P5 (§6.4): with a remote gateway URL in hand, write the
 * harness config Mode A used to keep as committed files. Merge-only: a
 * target dir with its own MCP servers or hooks keeps them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallConfig, InstallResult } from "@brain/contracts";

const HOOK_COMMAND = 'bun "$CLAUDE_PROJECT_DIR/packages/harness-claude-code/hooks/session-end.ts"';

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function install(cfg: InstallConfig): Promise<InstallResult> {
  const filesWritten: string[] = [];
  const notes: string[] = [];

  // 1 — MCP endpoint: Claude Code discovers auth from the 401 challenge
  // (§4.3). With a non-DCR IdP the pre-registered client id rides the
  // `oauth` block; the callback port is fixed because Auth0 native-app
  // loopback redirects are port-agnostic but path-sensitive.
  const mcpPath = join(cfg.targetDir, ".mcp.json");
  const mcp = readJson(mcpPath);
  const servers = (mcp.mcpServers ?? {}) as Record<string, unknown>;
  servers["brain-gateway"] = {
    type: "http",
    url: cfg.gatewayUrl,
    ...(cfg.oauthClientId ? { oauth: { clientId: cfg.oauthClientId, callbackPort: 8484 } } : {}),
  };
  mcp.mcpServers = servers;
  writeJson(mcpPath, mcp);
  filesWritten.push(mcpPath);

  // 2 — SessionEnd hook registration, added once.
  const claudeDir = join(cfg.targetDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");
  const settings = readJson(settingsPath);
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const sessionEnd = (hooks.SessionEnd ?? []) as Array<{
    hooks?: Array<{ command?: string }>;
  }>;
  const registered = sessionEnd.some((g) => g.hooks?.some((h) => h.command === HOOK_COMMAND));
  if (!registered) {
    sessionEnd.push({ hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 300 } as never] });
    hooks.SessionEnd = sessionEnd;
    settings.hooks = hooks;
    writeJson(settingsPath, settings);
    filesWritten.push(settingsPath);
  } else {
    notes.push("SessionEnd hook already registered — left untouched.");
  }

  // 3 — delivery config the hook reads (secrets stay in .env, never here).
  const harnessPath = join(claudeDir, "brain-harness.json");
  writeJson(harnessPath, { gatewayUrl: cfg.gatewayUrl });
  filesWritten.push(harnessPath);

  notes.push(
    "Delivery credentials come from the environment: BRAIN_HOOK_CLIENT_ID / BRAIN_HOOK_CLIENT_SECRET (+ BRAIN_HOOK_AUDIENCE for Auth0).",
    "The hook command assumes the brain repo layout; a packaged harness install is later work.",
  );
  return { filesWritten, notes };
}
