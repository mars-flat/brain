#!/usr/bin/env bash
# P5 e2e smoke (§8.2 top tier): build the production image, compose the full
# stack with the dev IdP overlay, and drive unauth → PRM → recall → step-up
# from inside the network against a synthetic vault. Local and CI.
#
#   bash scripts/compose-smoke.sh
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.dev.yaml)

# A writable scratch copy of the synthetic vault: the entrypoint rebuilds the
# index into it, and the container's uid (1000) differs from CI's runner uid.
SCRATCH="$(mktemp -d)"
cp -R examples/vault-example "${SCRATCH}/vault"

# W2 leg: a mcp-google instance against the fake Google API the inner script
# starts on 127.0.0.1:18860 (same network namespace as the gateway's spawned
# upstreams), plus the send-probe fixture that proves the policy deny fires
# on an advertised send-shaped tool. Synthetic values only — never real.
cat >> "${SCRATCH}/vault/config/servers.yaml" <<'YAML'

  - name: g-test
    command: bun
    args: [packages/mcp-google/src/main.ts]
    env:
      GOOGLE_OAUTH_CLIENT_ID: test-client
      GOOGLE_OAUTH_CLIENT_SECRET: test-secret
      GOOGLE_REFRESH_TOKEN: fake-refresh-token
      GOOGLE_ACCOUNT_LABEL: g-test
      GOOGLE_TOKEN_URL: http://127.0.0.1:18860/token
      GOOGLE_GMAIL_BASE: http://127.0.0.1:18860/gmail/v1
      GOOGLE_DRIVE_BASE: http://127.0.0.1:18860/drive/v3
      GOOGLE_UPLOAD_BASE: http://127.0.0.1:18860/upload/drive/v3

  - name: probe
    command: bun
    args: [packages/gateway/test/fake-upstream.ts]
YAML

chmod -R a+rwX "${SCRATCH}"

export BRAIN_DATA_DIR="${SCRATCH}"
# Interpolated by the base compose file; the dev overlay overrides both for
# the gateway service. Never a real value here.
export GATEWAY_ISSUER="http://keycloak:8081/realms/brain"
export GATEWAY_RESOURCE="http://127.0.0.1:8090/mcp"
# Console interpolation (§15) — the dev overlay overrides these per-service,
# but the base file's ${VAR:?} guards evaluate regardless.
export CONSOLE_BASE_URL="http://127.0.0.1:8091"
export CONSOLE_CLIENT_ID="brain-cli"
export CONSOLE_SESSION_SECRET="dev-only-session-secret"

cleanup() {
  "${COMPOSE[@]}" logs --no-color gateway 2>/dev/null | tail -20 || true
  # The container (uid 1000) owns whatever it wrote into the mounted scratch
  # vault (_index/, ingested episodes/, consolidated nodes/); the host user
  # (CI: uid 1001) cannot delete inside those dirs — empty the vault from
  # inside while the stack is still up. Every step is best-effort: cleanup
  # must never turn a passing smoke into a failing job.
  "${COMPOSE[@]}" exec -T gateway sh -c 'find /data/vault -mindepth 1 -delete' >/dev/null 2>&1 || true
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${SCRATCH}" || true
}
trap cleanup EXIT

"${COMPOSE[@]}" up -d --build --wait

# The scratch vault must be a real git repo with an identity, exactly as VM
# provisioning does for /data/vault (deploy/vm/provision.sh) — the
# consolidator refuses unversioned memory writes (2026-09-01 incident).
# Init INSIDE the container so .git ownership matches the writing uid.
"${COMPOSE[@]}" exec -T gateway sh -c '
  git config --global --add safe.directory /data/vault
  git -C /data/vault init -q
  git -C /data/vault config user.name "brain-consolidator"
  git -C /data/vault config user.email "consolidator@compose-smoke.invalid"
'

# Lives in the gateway package so the MCP SDK resolves as its production
# dependency under bun's isolated install layout.
"${COMPOSE[@]}" exec -T gateway bun /app/packages/gateway/scripts/compose-smoke-inner.ts
