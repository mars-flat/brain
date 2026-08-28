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
// The W2 fake Google API — runs in-process here; the g-test upstream the
// smoke overlay wires into servers.yaml reaches it over 127.0.0.1.
import { startFakeGoogle } from "../../mcp-google/test/fake-google.ts";

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

// 6 — the console (§15) is up and gating: healthz open, everything else authed.
const consoleHealth = await fetch("http://console:8091/healthz");
if (!consoleHealth.ok) fail(`console healthz → ${consoleHealth.status}`);
const consoleRoot = await fetch("http://console:8091/", { redirect: "manual" });
if (consoleRoot.status !== 302 || consoleRoot.headers.get("location") !== "/login")
  fail(`console / unauthenticated → ${consoleRoot.status}, wanted 302 to /login`);
console.log("6. console healthy, unauthenticated → login ✓");

// ── W2: the in-house Google server through the full composed stack ──
const fakeGoogle = startFakeGoogle(18860);
const g = new Client({ name: "compose-smoke-google", version: "0" });
await g.connect(
  new StreamableHTTPClientTransport(new URL(`${GW}/mcp`), {
    requestInit: {
      headers: { authorization: `Bearer ${await token("tools:read tools:write")}` },
    },
  }),
);

type CallShape = {
  ok?: boolean;
  needs_confirm?: boolean;
  confirm_token?: string;
  result?: { structuredContent?: Record<string, unknown> };
};
const gcall = async (urn: string, args: Record<string, unknown>) => {
  const first = await g.callTool({ name: "tools_call", arguments: { urn, args } });
  let sc = first.structuredContent as CallShape | undefined;
  if (sc?.needs_confirm === true) {
    const second = await g.callTool({
      name: "tools_call",
      arguments: { urn, args, confirm_token: sc.confirm_token },
    });
    sc = second.structuredContent as CallShape | undefined;
  }
  if (sc?.ok !== true) fail(`${urn}: ${JSON.stringify(first.content).slice(0, 300)}`);
  return sc.result?.structuredContent ?? {};
};

// 7 — search all mail, read a full message body.
const inbox = (await gcall("g-test.mail_search", { query: "engine" })) as {
  results?: Array<{ id: string; subject?: string }>;
};
if (!inbox.results?.length) fail("g-test.mail_search returned nothing");
const msg = (await gcall("g-test.mail_get_message", { id: inbox.results[0]?.id })) as {
  body?: { text?: string };
};
if (!msg.body?.text?.includes("Jacquard")) fail("mail_get_message body not decoded");
console.log(`7. mail search → ${inbox.results.length} hits, full body decoded ✓`);

// 8 — archive is a confirm-gated write: remove INBOX via the token round-trip.
const archived = (await gcall("g-test.mail_modify_labels", {
  message_ids: [inbox.results[0]?.id],
  remove_label_ids: ["INBOX"],
})) as { results?: Array<{ label_ids: string[] }> };
if (archived.results?.[0]?.label_ids.includes("INBOX")) fail("archive left INBOX in place");
console.log("8. archive via confirm round-trip ✓");

// 9 — Drive lifecycle, every mutation confirm-gated: create → rename → trash → untrash.
const created = (await gcall("g-test.drive_create", {
  name: "smoke.txt",
  mime_type: "text/plain",
  content: "compose smoke",
})) as { id?: string };
if (!created.id) fail("drive_create returned no id");
const renamed = (await gcall("g-test.drive_update", {
  id: created.id,
  name: "smoke-final.txt",
})) as { name?: string };
if (renamed.name !== "smoke-final.txt") fail(`rename → ${renamed.name}`);
const trashed = (await gcall("g-test.drive_trash", { id: created.id })) as { trashed?: boolean };
if (trashed.trashed !== true) fail("drive_trash did not trash");
const untrashed = (await gcall("g-test.drive_untrash", { id: created.id })) as {
  trashed?: boolean;
};
if (untrashed.trashed !== false) fail("drive_untrash did not restore");
console.log("9. drive create → rename → trash → untrash ✓");

// 10 — the no-send guarantee, both halves: no send-shaped tool exists on the
// Google server (unknown urn), and a send-shaped tool an upstream DOES
// advertise dies at the policy layer before any upstream call.
const noTool = await g.callTool({
  name: "tools_call",
  arguments: { urn: "g-test.mail_send_message", args: {} },
});
if (!noTool.isError || !JSON.stringify(noTool.content).includes("unknown tool"))
  fail("g-test.mail_send_message should not exist");
const denied = await g.callTool({
  name: "tools_call",
  arguments: { urn: "probe.send_message", args: { to: "x", body: "y" } },
});
if (!denied.isError || !JSON.stringify(denied.content).includes("denied by policy"))
  fail(
    `probe.send_message should be policy-denied: ${JSON.stringify(denied.content).slice(0, 200)}`,
  );
console.log("10. no-send: structurally absent + policy-denied when advertised ✓");

await g.close();
fakeGoogle.stop();

console.log("compose smoke: PASS");
