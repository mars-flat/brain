#!/usr/bin/env bash
# The §3.1 migration runbook as a TESTED script, not a wiki page:
#   brain backup → untar on a "different host" (fresh dir, Linux container)
#   → docker compose up → brain doctor → authed recall of real memory.
#
#   bash scripts/restore-drill.sh [vault-path]     (default: ./vault)
#
# Uses the dev IdP overlay for auth. The restored vault is read through the
# stack but never written (recall only), and the scratch copy is destroyed
# on exit. P5's done-when drill = this script passing against the vault.
set -euo pipefail

cd "$(dirname "$0")/.."
VAULT="${1:-./vault}"

COMPOSE=(docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.dev.yaml)
SCRATCH="$(mktemp -d)"

cleanup() {
  "${COMPOSE[@]}" exec -T gateway sh -c 'find /data/vault -mindepth 1 -delete' >/dev/null 2>&1 || true
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${SCRATCH}" || true
}
trap cleanup EXIT

echo "1. backup (git push + tarball)"
bun packages/cli/src/main.ts backup --vault "$VAULT" --out "${SCRATCH}/backup.tar.gz"

echo "2. restore on the 'new host'"
tar -xzf "${SCRATCH}/backup.tar.gz" -C "${SCRATCH}"
[ -d "${SCRATCH}/vault" ] || {
  # Vault dirs not literally named "vault" untar under their own basename.
  mv "${SCRATCH}/$(basename "$(cd "$VAULT" && pwd)")" "${SCRATCH}/vault"
}
chmod -R a+rwX "${SCRATCH}/vault"

echo "3. stack up on restored data"
export BRAIN_DATA_DIR="${SCRATCH}"
export GATEWAY_ISSUER="http://keycloak:8081/realms/brain"
export GATEWAY_RESOURCE="http://127.0.0.1:8090/mcp"
"${COMPOSE[@]}" up -d --build --wait

echo "4. doctor"
"${COMPOSE[@]}" exec -T gateway bun /app/packages/cli/src/main.ts doctor --vault /data/vault

echo "5. authed recall serves restored memory"
"${COMPOSE[@]}" exec -T -w /app/packages/gateway gateway bun -e '
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const ISSUER = "http://keycloak:8081/realms/brain";
const res = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "password", client_id: "brain-cli",
    username: "owner", password: "owner", scope: "openid brain:read" }),
});
const bearer = (await res.json()).access_token;
const client = new Client({ name: "drill", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8090/mcp"), {
  requestInit: { headers: { authorization: `Bearer ${bearer}` } },
}));
const recall = await client.callTool({ name: "tools_call",
  arguments: { urn: "brain.recall", args: { query: "decisions", budget_tokens: 800 } } });
const sc = recall.structuredContent;
const nodes = sc?.result?.structuredContent?.nodes ?? [];
console.log(`   recall ok=${sc?.ok} nodes=${nodes.length}`);
await client.close();
process.exit(sc?.ok && nodes.length > 0 ? 0 : 1);
'

echo "restore drill: PASS"
