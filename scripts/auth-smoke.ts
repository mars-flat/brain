/**
 * P4 end-to-end auth smoke against LIVE Keycloak (§4.3 done-when).
 * Prereq: docker compose -f deploy/keycloak/compose.yaml up -d
 *
 *   bun scripts/auth-smoke.ts
 *
 * Gets a real token from Keycloak via the resource-owner password grant
 * (dev convenience — the browser+PKCE flow is what Claude Code does), starts
 * the HTTP gateway as a resource server against the same realm, and drives:
 * unauth 401 → PRM discovery → authed recall → step-up (403 then success).
 */

import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpGateway } from "../packages/gateway/src/http.ts";

const ISSUER = process.env.GATEWAY_ISSUER ?? "http://localhost:8081/realms/brain";
const GW_PORT = 18899;
const repoRoot = join(import.meta.dir, "..");

async function token(scope: string): Promise<string> {
  const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "brain-cli",
      username: "owner",
      password: "owner",
      scope: `openid ${scope}`,
    }),
  });
  if (!res.ok) throw new Error(`token request failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

// The brain upstream reads ${BRAIN_VAULT_PATH} from the gateway's env, and
// spawned children need bun on PATH.
process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH ?? ""}`;
process.env.BRAIN_VAULT_PATH = join(repoRoot, "vault");

const gw = await startHttpGateway({
  vaultPath: join(repoRoot, "vault"),
  cwd: repoRoot,
  port: GW_PORT,
  auth: { issuer: ISSUER, audience: "brain-gateway", resource: `http://127.0.0.1:${GW_PORT}/mcp` },
});

try {
  // 1 — no token → 401 + challenge.
  const anon = await fetch(gw.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  console.log(
    `1. unauth → ${anon.status} ${anon.status === 401 ? "✓" : "✗"} (${anon.headers.get("www-authenticate")?.slice(0, 60)}…)`,
  );

  // 2 — PRM discovery.
  const prm = await (
    await fetch(`http://127.0.0.1:${GW_PORT}/.well-known/oauth-protected-resource`)
  ).json();
  console.log(
    `2. PRM authorization_servers = ${JSON.stringify((prm as { authorization_servers: string[] }).authorization_servers)} ✓`,
  );

  // 3 — authed recall (brain:read).
  const readClient = new Client({ name: "auth-smoke", version: "0" });
  await readClient.connect(
    new StreamableHTTPClientTransport(new URL(gw.url), {
      requestInit: { headers: { authorization: `Bearer ${await token("brain:read")}` } },
    }),
  );
  const recall = await readClient.callTool({
    name: "tools_call",
    arguments: { urn: "brain.recall", args: { query: "keycloak auth", budget_tokens: 600 } },
  });
  const sc = recall.structuredContent as { ok?: boolean } | undefined;
  console.log(
    `3. authed brain.recall ${sc?.ok ? "ok=true ✓" : `→ ${JSON.stringify(recall.content).slice(0, 120)}`}`,
  );
  await readClient.close();

  // 4 — step-up: a write without tools:write is refused, then allowed.
  const stepUp = await fetch(gw.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${await token("tools:read")}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "tools_call", arguments: { urn: "brain.note", args: { text: "x" } } },
    }),
  });
  console.log(
    `4. brain:write w/o scope → ${stepUp.status} ${stepUp.status === 403 ? "✓" : "✗"} scope=${stepUp.headers.get("www-authenticate")?.match(/scope="([^"]+)"/)?.[1] ?? "-"}`,
  );

  console.log("auth smoke: PASS");
} finally {
  await gw.stop();
}
