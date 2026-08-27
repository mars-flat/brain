/**
 * P5 e2e smoke — the container half. Runs INSIDE the gateway container
 * (scripts/compose-smoke.sh drives it via `docker compose exec`), so
 * http://keycloak:8081 resolves and the token's `iss` matches the
 * gateway's configured issuer exactly.
 *
 * Unlike auth-smoke.ts this starts nothing: the stack under test is the
 * real composed one — container image, entrypoint rebuild, volume mount.
 */

import type { EpisodeEnvelope } from "@brain/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
// Relative on purpose: the harness package resolves its own deps under the
// container's isolated install layout; the gateway package never depends on it.
import { deliverEpisode } from "../../harness-claude-code/src/deliver.ts";

const GW = "http://127.0.0.1:8090";
const ISSUER = process.env.GATEWAY_ISSUER ?? "http://keycloak:8081/realms/brain";

function fail(msg: string): never {
  console.error(`compose smoke: FAIL — ${msg}`);
  process.exit(1);
}

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
  if (!res.ok) fail(`token request (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

// 1 — unauthenticated → 401 + PRM challenge.
const anon = await fetch(`${GW}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
});
if (anon.status !== 401) fail(`unauth request → ${anon.status}, wanted 401`);
console.log("1. unauth → 401 ✓");

// 2 — PRM names the composed IdP.
const prm = (await (await fetch(`${GW}/.well-known/oauth-protected-resource`)).json()) as {
  authorization_servers?: string[];
};
if (prm.authorization_servers?.[0] !== ISSUER)
  fail(`PRM issuer ${JSON.stringify(prm.authorization_servers)} ≠ ${ISSUER}`);
console.log("2. PRM issuer ✓");

// 3 — authed recall serves a real pack from the mounted example vault.
const client = new Client({ name: "compose-smoke", version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${GW}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${await token("brain:read")}` } },
  }),
);
const recall = await client.callTool({
  name: "tools_call",
  // A query from the example vault's committed eval set — known to hit.
  arguments: {
    urn: "brain.recall",
    args: { query: "what frontend does the garden tracker use", budget_tokens: 800 },
  },
});
const sc = recall.structuredContent as
  | { ok?: boolean; result?: { structuredContent?: { nodes?: unknown[] } } }
  | undefined;
const nodes = sc?.result?.structuredContent?.nodes;
if (!sc?.ok) fail(`recall not ok: ${JSON.stringify(recall.content).slice(0, 200)}`);
if (!Array.isArray(nodes) || nodes.length === 0)
  fail(`recall returned no nodes: ${JSON.stringify(recall.content).slice(0, 200)}`);
console.log(`3. authed recall → ${nodes.length} nodes ✓`);
await client.close();

// 4 — step-up boundary holds in the container: write scope missing → 403.
const stepUp = await fetch(`${GW}/mcp`, {
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
if (stepUp.status !== 403) fail(`write without scope → ${stepUp.status}, wanted 403`);
console.log("4. step-up 403 ✓");

// 5 — the SessionEnd delivery path (§6.4 P5): harness deliverEpisode →
// tools_call → brain.ingest, policy-allowed headlessly, idempotent redelivery.
const iso = "2026-08-27T00:00:00Z";
const episode: EpisodeEnvelope = {
  schema_version: 1,
  episode_id: "ep_01J8Z3M4N5P6Q7R8S9T0V1W2X5",
  principal: "owner",
  surface: "cli",
  harness: "claude-code",
  trust: "high",
  started_at: iso,
  ended_at: iso,
  turns: [
    {
      seq: 0,
      kind: "message",
      role: "user",
      content:
        '@node concept "Compose smoke ingest" id:compose-smoke-ingest summary:"Delivered by the e2e smoke through brain.ingest."',
      ts: iso,
    },
  ],
  labels: ["session"],
};
const target = { gatewayUrl: `${GW}/mcp`, token: await token("brain:write") };
const first = await deliverEpisode(target, episode);
if (first.new_nodes < 1) fail(`ingest delivered but consolidated ${first.new_nodes} nodes`);
const redelivered = await deliverEpisode(target, episode);
if (redelivered.new_nodes !== 0)
  fail(`redelivery consolidated ${redelivered.new_nodes} nodes — not idempotent`);
console.log(`5. SessionEnd delivery → +${first.new_nodes} node, redelivery no-op ✓`);

console.log("compose smoke: PASS");
