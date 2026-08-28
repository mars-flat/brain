#!/usr/bin/env bash
# One-shot VM provisioning (§3.1), idempotent — safe to re-run. Executed as
# root on brain-vm by `az vm run-command` after cloning this repo, with
# secrets injected via environment (never in this file, §9.2):
#
#   OPENAI_API_KEY        model key for the compose .env
#   VAULT_DEPLOY_KEY_B64  base64 ed25519 key with write access to brain-vault
#   GATEWAY_ISSUER        Auth0 issuer URL (placeholder until §12 Q6 wiring)
#   GATEWAY_RESOURCE      tailnet /mcp URL (placeholder until tailscale up)
#
# Tailscale is installed but NOT brought up — `tailscale up` needs the
# owner's auth (or TAILSCALE_AUTHKEY, see QUESTIONS-FOR-OWNER P5-3).
set -euo pipefail

# run-command executes as root with no HOME; git hard-fails without it.
export HOME="${HOME:-/root}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq docker.io docker-compose-v2 docker-buildx git curl

# ── data disk at /data (lun0 = the 32 GiB disk from `az vm create`) ──────
if ! mountpoint -q /data; then
  DEV=/dev/disk/azure/scsi1/lun0
  blkid "$DEV" >/dev/null 2>&1 || mkfs.ext4 -q -L braindata "$DEV"
  mkdir -p /data
  grep -q 'LABEL=braindata' /etc/fstab ||
    echo 'LABEL=braindata /data ext4 defaults,nofail 0 2' >>/etc/fstab
  mount /data
fi

# ── code repo (public) ───────────────────────────────────────────────────
[ -d /opt/brain/.git ] || git clone -q https://github.com/mars-flat/brain.git /opt/brain

# ── vault repo (private, via deploy key) ─────────────────────────────────
mkdir -p /root/.ssh && chmod 700 /root/.ssh
if [ -n "${VAULT_DEPLOY_KEY_B64:-}" ] && [ ! -f /root/.ssh/vault-deploy ]; then
  echo "$VAULT_DEPLOY_KEY_B64" | base64 -d >/root/.ssh/vault-deploy
  chmod 600 /root/.ssh/vault-deploy
fi
ssh-keyscan -t ed25519 github.com 2>/dev/null >/root/.ssh/known_hosts
cat >/root/.ssh/config <<'EOF'
Host github.com
  IdentityFile /root/.ssh/vault-deploy
  IdentitiesOnly yes
EOF
if [ ! -d /data/vault/.git ]; then
  git clone -q git@github.com:mars-flat/brain-vault.git /data/vault
  # The consolidator commits inside the container (§5.7) — it needs an
  # identity in the repo config, and it is not the owner's personal one (§9.4).
  git -C /data/vault config user.name "brain-consolidator"
  git -C /data/vault config user.email "consolidator@brain-vm.invalid"
fi
# Container user is uid 1000; root keeps operating the repo for push/backup.
chown -R 1000:1000 /data/vault
git config --global --add safe.directory /data/vault

# ── compose environment (0600, never committed — §9.2) ───────────────────
ENVF=/opt/brain/deploy/compose/.env
if [ ! -f "$ENVF" ]; then
  cat >"$ENVF" <<EOF
TAG=latest
BRAIN_DATA_DIR=/data
BRAIN_INGEST_MODE=queue
GATEWAY_ISSUER=${GATEWAY_ISSUER:-https://pending-auth0.invalid/}
GATEWAY_AUDIENCE=brain-gateway
GATEWAY_RESOURCE=${GATEWAY_RESOURCE:-https://pending-tailnet.invalid/mcp}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
EOF
  chmod 600 "$ENVF"
fi

# ── tailscale: installed now, authenticated by the owner later (§3.1) ────
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh

# ── batch consolidation cadence (§5.8): one cycle every 15 minutes ───────
cat >/etc/systemd/system/brain-consolidate.service <<'EOF'
[Unit]
Description=brain batched consolidation cycle (§5.8)
[Service]
Type=oneshot
# systemd units run without HOME; git (and anything reading ~/.gitconfig,
# e.g. root's safe.directory for the uid-1000-owned vault) needs it.
Environment=HOME=/root
WorkingDirectory=/opt/brain/deploy/compose
ExecStart=/usr/bin/docker compose exec -T gateway bun /app/packages/cli/src/main.ts consolidate --batch --vault /data/vault
EOF
cat >/etc/systemd/system/brain-consolidate.timer <<'EOF'
[Unit]
Description=brain consolidation cadence
[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
EOF

# ── monthly edge-cert renewal (§15.1; deploy/vm/certs.sh is lego DNS-01) ─
cat >/etc/systemd/system/brain-certs.service <<'EOF'
[Unit]
Description=obtain/renew the edge TLS certificate (lego DNS-01)
[Service]
Type=oneshot
Environment=HOME=/root
ExecStart=/usr/bin/bash /opt/brain/deploy/vm/certs.sh
EOF
cat >/etc/systemd/system/brain-certs.timer <<'EOF'
[Unit]
Description=monthly edge cert renewal
[Timer]
OnCalendar=monthly
Persistent=true
RandomizedDelaySec=1h
[Install]
WantedBy=timers.target
EOF

# ── nightly vault push: the private remote is the backup (§12 Q1) ────────
cat >/etc/systemd/system/brain-vault-push.service <<'EOF'
[Unit]
Description=push the vault to its private remote
[Service]
Type=oneshot
Environment=HOME=/root
ExecStart=/usr/bin/git -C /data/vault push -q origin main
EOF
cat >/etc/systemd/system/brain-vault-push.timer <<'EOF'
[Unit]
Description=nightly vault backup push
[Timer]
OnCalendar=*-*-* 09:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable -q --now brain-consolidate.timer brain-vault-push.timer
systemctl enable -q brain-certs.timer 2>/dev/null || true # armed once the edge env exists

# ── first bring-up: build locally (the GHCR package may still be private;
#    subsequent deploys pull by tag via deploy.sh) ───────────────────────
cd /opt/brain/deploy/compose
docker compose build -q gateway
docker compose up -d --no-build --wait gateway
docker compose exec -T gateway bun /app/packages/cli/src/main.ts doctor --vault /data/vault
echo "PROVISION-OK"
