/**
 * install() at P5 (§6.4): writes the three config files into a target dir,
 * merges instead of clobbering, and is idempotent.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeHarness } from "../src/index.ts";

const URL_A = "https://vm.tailnet.example/mcp";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("claudeCodeHarness.install (§6.4 P5)", () => {
  test("fresh dir gets .mcp.json, hook registration, and harness config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "install-"));
    const res = await claudeCodeHarness.install({
      gatewayUrl: URL_A,
      targetDir: dir,
      oauthClientId: "client-abc",
    });
    expect(res.filesWritten.length).toBe(3);

    const mcp = readJson(join(dir, ".mcp.json")) as {
      mcpServers: Record<
        string,
        { type: string; url: string; oauth?: { clientId: string; callbackPort: number } }
      >;
    };
    expect(mcp.mcpServers["tool-gateway"]).toEqual({
      type: "http",
      url: URL_A,
      oauth: { clientId: "client-abc", callbackPort: 8484 },
    });

    const settings = readJson(join(dir, ".claude", "settings.json")) as {
      hooks: { SessionEnd: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.SessionEnd[0]?.hooks[0]?.command).toContain("session-end.ts");

    const harness = readJson(join(dir, ".claude", "brain-harness.json"));
    expect(harness).toEqual({ gatewayUrl: URL_A });
  });

  test("merges into existing config and re-runs idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "install-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "bunx", args: ["something"] } } }),
    );
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ statusLine: { x: 1 } }));

    await claudeCodeHarness.install({ gatewayUrl: URL_A, targetDir: dir });
    const second = await claudeCodeHarness.install({ gatewayUrl: URL_A, targetDir: dir });

    const mcp = readJson(join(dir, ".mcp.json")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["other", "tool-gateway"]);

    const settings = readJson(join(dir, ".claude", "settings.json")) as {
      statusLine: unknown;
      hooks: { SessionEnd: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.statusLine).toEqual({ x: 1 });
    expect(settings.hooks.SessionEnd.length).toBe(1); // not duplicated
    expect(second.notes.join(" ")).toContain("already registered");
  });
});
