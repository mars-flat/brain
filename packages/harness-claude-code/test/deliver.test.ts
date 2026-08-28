/**
 * Remote delivery plumbing (§6.4 P5): target resolution precedence, the
 * PRM→discovery→client_credentials token flow, and the disk cache that
 * keeps one token per process fleet instead of one per SessionEnd. The
 * full deliver-through-the-gateway path is covered by the compose e2e
 * smoke (§8.2) — here the IdP is a local fake.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clientCredentialsToken,
  issuerFromPrm,
  resolveDeliveryTarget,
  tokenEndpoint,
} from "../src/deliver.ts";

const PORT = 18841;
const BASE = `http://127.0.0.1:${PORT}`;
const GATEWAY = `${BASE}/mcp`;
const ISSUER = `${BASE}/idp`;

let server: ReturnType<typeof Bun.serve>;
let tokenRequests = 0;

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/.well-known/oauth-protected-resource")
        return Response.json({ resource: GATEWAY, authorization_servers: [ISSUER] });
      if (path === "/idp/.well-known/openid-configuration")
        return Response.json({ issuer: ISSUER, token_endpoint: `${ISSUER}/token` });
      if (path === "/idp/token") {
        tokenRequests += 1;
        return Response.json({ access_token: `tok-${tokenRequests}`, expires_in: 120 });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

describe("resolveDeliveryTarget", () => {
  test("null without a gateway URL anywhere", () => {
    expect(resolveDeliveryTarget({}, mkdtempSync(join(tmpdir(), "harness-")))).toBeNull();
  });

  test("env alone is enough", () => {
    const t = resolveDeliveryTarget(
      { TOOL_GATEWAY_URL: GATEWAY, BRAIN_HOOK_CLIENT_ID: "id", BRAIN_HOOK_CLIENT_SECRET: "s" },
      mkdtempSync(join(tmpdir(), "harness-")),
    );
    expect(t).toEqual({
      gatewayUrl: GATEWAY,
      clientId: "id",
      clientSecret: "s",
      audience: undefined,
      tokenCachePath: undefined,
    });
  });

  test("install()-written file supplies the URL; env overrides it; secrets never come from the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-"));
    const claudeDir = join(dir, ".claude");
    Bun.spawnSync(["mkdir", "-p", claudeDir]);
    writeFileSync(
      join(claudeDir, "brain-harness.json"),
      JSON.stringify({ gatewayUrl: "https://file.example/mcp", clientSecret: "leaked?" }),
    );
    expect(resolveDeliveryTarget({}, dir)?.gatewayUrl).toBe("https://file.example/mcp");
    expect(resolveDeliveryTarget({}, dir)?.clientSecret).toBeUndefined();
    expect(resolveDeliveryTarget({ TOOL_GATEWAY_URL: GATEWAY }, dir)?.gatewayUrl).toBe(GATEWAY);
  });
});

describe("token flow (RFC 9728 → OIDC discovery → client_credentials)", () => {
  test("issuer comes from the gateway's PRM, endpoint from discovery", async () => {
    expect(await issuerFromPrm(GATEWAY)).toBe(ISSUER);
    expect(await tokenEndpoint(ISSUER)).toBe(`${ISSUER}/token`);
  });

  test("tokens cache to disk across processes and refresh on expiry", async () => {
    const cachePath = join(mkdtempSync(join(tmpdir(), "harness-")), "token.json");
    const target = {
      gatewayUrl: GATEWAY,
      clientId: "hook",
      clientSecret: "secret",
      tokenCachePath: cachePath,
    };
    const before = tokenRequests;
    let clockMs = 1_000_000_000_000;
    const now = () => clockMs;

    const first = await clientCredentialsToken(target, fetch, now);
    const second = await clientCredentialsToken(target, fetch, now);
    expect(second).toBe(first);
    expect(tokenRequests).toBe(before + 1);
    expect(readFileSync(cachePath, "utf8")).toContain(first);

    clockMs += 121_000; // past expires_in with skew — must refetch
    const third = await clientCredentialsToken(target, fetch, now);
    expect(third).not.toBe(first);
    expect(tokenRequests).toBe(before + 2);
  });

  test("missing credentials fail loudly, pre-acquired token bypasses the flow", async () => {
    expect(clientCredentialsToken({ gatewayUrl: GATEWAY })).rejects.toThrow(/no credentials/);
    expect(await clientCredentialsToken({ gatewayUrl: GATEWAY, token: "presupplied" })).toBe(
      "presupplied",
    );
  });
});
