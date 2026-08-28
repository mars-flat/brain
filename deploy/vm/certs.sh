#!/usr/bin/env bash
# Obtain or renew the edge certificate via lego (DNS-01 against the zone's
# DNS API — Vercel today; swap LEGO_DNS if the DNS host ever changes) into
# the compose certs volume, then reload Caddy. Idempotent: `run` first
# time, `renew` after (lego renews only within 30 days of expiry).
# Run ON THE VM as root. Wired to a monthly systemd timer by provision.sh.
set -euo pipefail
export HOME="${HOME:-/root}"

cd /opt/brain/deploy/compose
DOMAIN="$(grep '^CONSOLE_DOMAIN=' .env | cut -d= -f2-)"
EMAIL="$(grep '^CONSOLE_ACME_EMAIL=' .env | cut -d= -f2-)"
TOKEN="$(grep '^VERCEL_API_TOKEN=' .env | cut -d= -f2-)"
TEAM="$(grep '^VERCEL_TEAM_ID=' .env | cut -d= -f2- || true)"
[ -n "$DOMAIN" ] && [ -n "$EMAIL" ] && [ -n "$TOKEN" ] || {
  echo "certs.sh: CONSOLE_DOMAIN, CONSOLE_ACME_EMAIL, VERCEL_API_TOKEN required in .env" >&2
  exit 2
}

VOLUME="brain_certs"
docker volume create "$VOLUME" >/dev/null

mode=run
docker run --rm -v "$VOLUME":/certs goacme/lego@sha256:7cddf252ccf0ec00b71cbd4dcd548fdbc780006b05ae630e5fa4a981353c5728 \
  list --path /certs 2>/dev/null | grep -q "$DOMAIN" && mode=renew

docker run --rm -v "$VOLUME":/certs \
  -e VERCEL_API_TOKEN="$TOKEN" -e VERCEL_TEAM_ID="$TEAM" \
  goacme/lego@sha256:7cddf252ccf0ec00b71cbd4dcd548fdbc780006b05ae630e5fa4a981353c5728 \
  --accept-tos --path /certs --email "$EMAIL" --dns vercel -d "$DOMAIN" "$mode"

# Caddy reads certs at start; reload picks up renewals without downtime.
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null ||
  docker compose restart caddy >/dev/null 2>&1 || true
echo "CERTS-OK $DOMAIN ($mode)"
