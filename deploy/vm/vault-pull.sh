#!/usr/bin/env bash
# Ad-hoc vault pull, the safe way. Runs as root on brain-vm (run-command
# or Tailscale SSH + sudo). A bare root `git pull` in /data/vault strands
# root-owned files that the uid-1000 consolidator later EACCESes on, so
# ownership is handed back and the index rebuilt (§5.2: whoever changes
# the vault must reindex) in the same step.
set -euo pipefail

# run-command and sudo shells may lack HOME; git dies without it.
export HOME="${HOME:-/root}"

git -C /data/vault pull --ff-only -q origin main
find /data/vault -not -user 1000 -exec chown 1000:1000 {} +
cd /opt/brain/deploy/compose
docker compose exec -T gateway bun /app/packages/cli/src/main.ts rebuild --vault /data/vault
echo "VAULT-PULL-OK $(git -C /data/vault rev-parse --short HEAD)"
