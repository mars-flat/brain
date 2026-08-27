#!/bin/sh
# _index/brain.db is derived state (§5.11) — a fresh volume or a restored
# backup arrives without it, so rebuild before serving. Never rebuild when
# present: salience lives only in SQLite (§5.2) and a redundant rebuild
# costs startup time for nothing.
set -e

if [ -z "${BRAIN_VAULT_PATH}" ]; then
  echo "entrypoint: BRAIN_VAULT_PATH is required (§9.1)" >&2
  exit 2
fi

if [ ! -f "${BRAIN_VAULT_PATH}/_index/brain.db" ]; then
  echo "entrypoint: no index at ${BRAIN_VAULT_PATH}/_index — rebuilding" >&2
  bun /app/packages/cli/src/main.ts rebuild --vault "${BRAIN_VAULT_PATH}"
fi

exec bun /app/packages/gateway/src/main-http.ts
