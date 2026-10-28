#!/usr/bin/env bash
# Deploy from your machine to the server over SSH: prepare the server (first time), copy the code, build and start the stack.
#   deploy/hetzner/deploy.sh root@SERVER_IP [domain]                 this stack owns ports 80/443 (bundled Caddy)
#   deploy/hetzner/deploy.sh root@SERVER_IP domain --host-proxy      shared server: add a site to the Caddy already on 80/443; firewall untouched
# Re-run it for every release. Requires ssh access (key-based) and, for HTTPS, a DNS A record for the domain pointing at the server.
set -euo pipefail
TARGET="${1:?usage: deploy.sh user@host [domain] [--host-proxy]}"; DOMAIN="${2:-}"; MODE="${3:-}"
HOST_PROXY=0; [ "$MODE" = "--host-proxy" ] && { HOST_PROXY=1; [ -n "$DOMAIN" ] || { echo "--host-proxy needs a domain"; exit 1; }; }
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
SSH="ssh -o StrictHostKeyChecking=accept-new"

echo "== preparing the server"
$SSH "$TARGET" "HOST_PROXY=$HOST_PROXY bash -s -- $DOMAIN" < "$HERE/setup-server.sh"

echo "== copying the code"
rsync -az --delete -e "$SSH" \
  --exclude '.git' --exclude 'node_modules' --exclude '**/node_modules' --exclude 'native' --exclude 'dist' --exclude 'web/dist' \
  --exclude 'test-results' --exclude '.env*' --exclude 'var' --exclude '*.log' \
  "$ROOT/" "$TARGET:/opt/clearline/src/"

echo "== building and starting (the first build downloads the embedding model and compiles pgvector; allow several minutes)"
$SSH "$TARGET" "cd /opt/clearline/src/deploy/hetzner && docker compose --env-file /opt/clearline/.env up -d --build --remove-orphans"

if [ "$HOST_PROXY" = 1 ]; then echo "== adding the site to the existing Caddy"; $SSH "$TARGET" "bash -s -- $DOMAIN 8090" < "$HERE/host-caddy.sh"; fi

echo "== waiting for readiness"
for i in $(seq 1 60); do
  if $SSH "$TARGET" "cd /opt/clearline/src/deploy/hetzner && docker compose --env-file /opt/clearline/.env exec -T api node -e \"fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" 2>/dev/null; then echo "ready"; break; fi
  [ "$i" = 60 ] && { echo "not ready after 5 minutes: ssh $TARGET 'cd /opt/clearline/src/deploy/hetzner && docker compose --env-file /opt/clearline/.env logs --tail 80'"; exit 1; }
  sleep 5
done
$SSH "$TARGET" "cd /opt/clearline/src/deploy/hetzner && docker compose --env-file /opt/clearline/.env ps --format 'table {{.Service}}\t{{.Status}}'"
echo "Done. First time only: create the platform-admin token with"
echo "  ssh $TARGET 'cd /opt/clearline/src/deploy/hetzner && docker compose --env-file /opt/clearline/.env exec -T api node dist/src/cli.js platform-admin'"
