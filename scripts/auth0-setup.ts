/**
 * Auth0 tenant configuration as code (§4.3, §12 Q6) — idempotent; re-run
 * freely. Creates everything the P5 gateway needs on a fresh tenant:
 *
 *   - resource server (API) `brain-gateway` with the §4.3 scopes
 *   - `brain-cli`      native + PKCE (loopback callbacks, port-agnostic)
 *   - `brain-hook`     M2M, granted brain:write only  (SessionEnd delivery)
 *   - `agent-runtime`  M2M, granted read+write scopes (P6)
 *
 * Needs a Management API credential in the environment (owner creates one
 * M2M app authorized for the Management API — see QUESTIONS P5-1):
 *
 *   AUTH0_DOMAIN=dev-xxxx.us.auth0.com
 *   AUTH0_MGMT_CLIENT_ID=...
 *   AUTH0_MGMT_CLIENT_SECRET=...
 *
 *   bun scripts/auth0-setup.ts
 *
 * Prints the .env lines to copy at the end. Never writes secrets anywhere.
 */

const DOMAIN = process.env.AUTH0_DOMAIN;
const MGMT_ID = process.env.AUTH0_MGMT_CLIENT_ID;
const MGMT_SECRET = process.env.AUTH0_MGMT_CLIENT_SECRET;
if (!DOMAIN || !MGMT_ID || !MGMT_SECRET) {
  console.error(
    "need AUTH0_DOMAIN, AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET in the env (§13)",
  );
  process.exit(2);
}

const BASE = `https://${DOMAIN}/api/v2`;
const AUDIENCE = "brain-gateway";
const SCOPES = [
  { value: "brain:read", description: "read memory: recall, expand, neighbors, timeline, trace" },
  { value: "brain:write", description: "write memory: note, pin, ingest" },
  { value: "tools:read", description: "read-kind tools through the gateway" },
  { value: "tools:write", description: "write-kind tools through the gateway" },
  { value: "tools:admin", description: "admin/destructive tools — step-up only" },
];

async function mgmtToken(): Promise<string> {
  const res = await fetch(`https://${DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: MGMT_ID,
      client_secret: MGMT_SECRET,
      audience: `https://${DOMAIN}/api/v2/`,
    }),
  });
  if (!res.ok) throw new Error(`management token failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

const token = await mgmtToken();

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// ── resource server ────────────────────────────────────────────────────────
interface ResourceServer {
  id: string;
  identifier: string;
}
const servers = await api<ResourceServer[]>("GET", "/resource-servers?per_page=50");
let rs = servers.find((s) => s.identifier === AUDIENCE);
if (rs) {
  console.log(`✓ API ${AUDIENCE} exists`);
} else {
  rs = await api<ResourceServer>("POST", "/resource-servers", {
    name: "brain-gateway",
    identifier: AUDIENCE,
    signing_alg: "RS256",
    scopes: SCOPES,
    skip_consent_for_verifiable_first_party_clients: true,
    token_lifetime: 86400,
  });
  console.log(`+ API ${AUDIENCE} created`);
}

// ── clients ────────────────────────────────────────────────────────────────
interface Client {
  client_id: string;
  name: string;
  client_secret?: string;
}
const clients = await api<Client[]>(
  "GET",
  "/clients?per_page=100&fields=client_id,name,client_secret",
);
async function ensureClient(name: string, body: Record<string, unknown>): Promise<Client> {
  const existing = clients.find((c) => c.name === name);
  if (existing) {
    console.log(`✓ client ${name} exists (${existing.client_id})`);
    return existing;
  }
  const created = await api<Client>("POST", "/clients", { name, ...body });
  console.log(`+ client ${name} created (${created.client_id})`);
  return created;
}

const cli = await ensureClient("brain-cli", {
  app_type: "native",
  token_endpoint_auth_method: "none",
  oidc_conformant: true,
  grant_types: ["authorization_code", "refresh_token"],
  // RFC 8252 loopback redirects: Auth0 ignores the port for native apps.
  callbacks: ["http://127.0.0.1/callback", "http://localhost/callback"],
});

const hook = await ensureClient("brain-hook", {
  app_type: "non_interactive",
  grant_types: ["client_credentials"],
});

const runtime = await ensureClient("agent-runtime", {
  app_type: "non_interactive",
  grant_types: ["client_credentials"],
});

// ── client grants (M2M → the API, least privilege each) ───────────────────
interface Grant {
  id: string;
  client_id: string;
  audience: string;
}
const grants = await api<Grant[]>("GET", `/client-grants?audience=${AUDIENCE}&per_page=50`);
async function ensureGrant(client: Client, scope: string[]): Promise<void> {
  if (grants.find((g) => g.client_id === client.client_id)) {
    console.log(`✓ grant ${client.name} → ${AUDIENCE} exists`);
    return;
  }
  await api("POST", "/client-grants", { client_id: client.client_id, audience: AUDIENCE, scope });
  console.log(`+ grant ${client.name} → ${AUDIENCE} [${scope.join(" ")}]`);
}
await ensureGrant(hook, ["brain:write"]);
await ensureGrant(runtime, ["brain:read", "brain:write", "tools:read", "tools:write"]);

// ── what goes where ────────────────────────────────────────────────────────
console.log(`
Done. Copy into the LAPTOP .env (SessionEnd delivery, §6.4):
  BRAIN_HOOK_CLIENT_ID=${hook.client_id}
  BRAIN_HOOK_CLIENT_SECRET=<Applications → brain-hook → Settings → Client Secret>
  BRAIN_HOOK_AUDIENCE=${AUDIENCE}

And into the VM's deploy/compose/.env:
  GATEWAY_ISSUER=https://${DOMAIN}/
  GATEWAY_AUDIENCE=${AUDIENCE}

brain-cli (${cli.client_id}) is public+PKCE — Claude Code discovers it via
the OAuth flow; no secret exists for it.`);
