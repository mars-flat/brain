#!/usr/bin/env bash
# Runs ON THE VM, invoked by deploy.yml via `az vm run-command` (§8.6) after
# a `git reset --hard origin/main` of /opt/brain — so this file is always the
# version being deployed. $1 = image tag (the commit SHA).
#
# run-command does not propagate exit codes as failures, so the workflow
# greps for the DEPLOY-OK / ROLLED-BACK / ROLLBACK-FAILED markers below.
set -uo pipefail

# run-command executes as root with no HOME; git (and compose) want one.
export HOME="${HOME:-/root}"
TAG="${1:?usage: deploy.sh <image-tag>}"
cd "$(dirname "$0")/../compose"

# deploy/compose/.env on the VM carries GATEWAY_* and BRAIN_DATA_DIR; TAG is
# ours to manage. The previous tag is the rollback target.
touch .env
PREV="$(grep '^TAG=' .env | cut -d= -f2- || true)"
PREV="${PREV:-latest}"

set_tag() {
  if grep -q '^TAG=' .env; then
    sed -i "s|^TAG=.*|TAG=$1|" .env
  else
    echo "TAG=$1" >>.env
  fi
}

deploy_tag() {
  # Pull from GHCR (falls back to building the identical image from the
  # checked-out commit if the registry is unreachable). ALL services ride
  # the tag — the console shares the image (§15). Rebuild the index before
  # the doctor gate: vault git pulls land content the VM never indexed,
  # and a deploy must verify the system can be made consistent, not fail
  # because someone pushed notes (rebuild is salience-preserving, §5.2).
  set_tag "$1" &&
    { docker compose pull -q || docker compose build -q; } &&
    docker compose up -d --no-build --wait &&
    docker compose exec -T gateway bun /app/packages/cli/src/main.ts rebuild --vault /data/vault &&
    docker compose exec -T gateway bun /app/packages/cli/src/main.ts doctor --vault /data/vault
}

if deploy_tag "$TAG"; then
  echo "DEPLOY-OK $TAG"
  exit 0
fi

echo "doctor failed on $TAG — rolling back to $PREV" >&2
if deploy_tag "$PREV"; then
  echo "ROLLED-BACK $PREV"
else
  echo "ROLLBACK-FAILED $PREV"
fi
exit 1
