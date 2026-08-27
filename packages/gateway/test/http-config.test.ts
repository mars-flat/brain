/**
 * P5 (§3.1): the gateway runs in a container behind Tailscale, so the bind
 * host and the advertised PRM resource can no longer be hardcoded loopback.
 * Contract: `host` controls the listen interface (default stays 127.0.0.1);
 * `auth.resource` is advertised verbatim in the PRM document even when it
 * differs from the local bind address (the tailnet URL is what clients see).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningHttpGateway, startHttpGateway } from "../src/http.ts";
import { type MockAS, startMockAS } from "./mock-as.ts";

const FIXTURE = join(import.meta.dir, "fake-upstream.ts");
const AS_PORT = 18831;
const GW_PORT = 18832;
const RESOURCE = `http://brain-vm.tailnet.example:${GW_PORT}/mcp`;

let mockAs: MockAS;
let gw: RunningHttpGateway;

beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "brain-httpcfg-"));
  mockAs = await startMockAS(AS_PORT);
  gw = await startHttpGateway({
    vaultPath: tmp,
    cwd: join(import.meta.dir, "..", "..", ".."),
    port: GW_PORT,
    host: "0.0.0.0",
    auth: {
      issuer: mockAs.issuer,
      audience: "brain-gateway",
      resource: RESOURCE,
    },
    dbPath: ":memory:",
    auditPath: join(tmp, "audit.jsonl"),
    config: {
      servers: [{ name: "fake", command: process.execPath, args: [FIXTURE], enabled: true }],
      policy: [{ match: { kind: "read" }, effect: "allow" }, { default: "confirm" }],
      identity: { principal: "static", surface: "cli", trust: "high" },
      rateLimitPerMin: 500,
    },
  });
});

afterAll(async () => {
  await gw.stop();
  await mockAs.stop();
});

test("PRM advertises the configured resource, not the bind address", async () => {
  const res = await fetch(`http://127.0.0.1:${GW_PORT}/.well-known/oauth-protected-resource`);
  expect(res.status).toBe(200);
  const prm = (await res.json()) as Record<string, unknown>;
  expect(prm.resource).toBe(RESOURCE);
});

test("host: 0.0.0.0 listens on non-loopback interfaces", async () => {
  const { networkInterfaces } = await import("node:os");
  const external = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal);
  if (!external) return; // no external interface on this machine — bind still verified via loopback
  const res = await fetch(
    `http://${external.address}:${GW_PORT}/.well-known/oauth-protected-resource`,
  );
  expect(res.status).toBe(200);
});

test("401 challenge points clients at the advertised resource's PRM URL", async () => {
  const res = await fetch(`http://127.0.0.1:${GW_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toContain(
    `http://brain-vm.tailnet.example:${GW_PORT}/.well-known/oauth-protected-resource`,
  );
});
