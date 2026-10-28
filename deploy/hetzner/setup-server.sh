#!/usr/bin/env bash
# Prepares a fresh Ubuntu/Debian server (run as root, usually via deploy.sh): Docker, firewall, rsync, the secrets file and a
# nightly backup. Safe to run again: it never overwrites an existing /opt/clearline/.env.
#   bash setup-server.sh [domain]            this stack owns ports 80/443 (bundled Caddy)
#   HOST_PROXY=1 bash setup-server.sh domain  shared server: an existing proxy owns 80/443; firewall and other services are left alone
set -euo pipefail
DOMAIN="${1:-}"
HOST_PROXY="${HOST_PROXY:-0}"
[ "$(id -u)" = 0 ] || { echo "run as root (or via sudo)"; exit 1; }

export DEBIAN_FRONTEND=noninteractive
command -v docker >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq curl ca-certificates; curl -fsSL https://get.docker.com | sh; }
apt-get install -y -qq rsync ufw >/dev/null
docker compose version >/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin

# Firewall: SSH and web only. PostgreSQL is not published at all (it is only on the compose network).
# On a shared server (HOST_PROXY=1) the existing firewall and proxy are not ours to change.
if [ "$HOST_PROXY" != 1 ]; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

mkdir -p /opt/clearline/src /opt/clearline/backups
ENV=/opt/clearline/.env
if [ ! -f "$ENV" ]; then
  rnd() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }     # hex only: safe inside URLs and SQL
  if [ -n "$DOMAIN" ]; then SITE="$DOMAIN"; URL="https://$DOMAIN"; else SITE=":80"; URL="http://$(curl -fsS https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"; fi
  umask 077
  cat > "$ENV" <<ENVEOF
# Secrets and settings for the production stack. Never commit this file. Edit, then: docker compose --env-file /opt/clearline/.env up -d
POSTGRES_PASSWORD=$(rnd)
APP_DB_PASSWORD=$(rnd)
QUERY_DB_PASSWORD=$(rnd)
SITE_ADDRESS=$SITE
PUBLIC_URL=$URL
API_PORT=8090
$( [ "$HOST_PROXY" = 1 ] && echo "# Shared server: the proxy that already owns 80/443 forwards to 127.0.0.1:\$API_PORT; the bundled Caddy is not started." || echo "COMPOSE_PROFILES=own-caddy" )
# Optional: model-written assistant answers and natural-language SQL (get a key from Anthropic), then set NL_SQL_PROVIDER=anthropic.
ANTHROPIC_API_KEY=
NL_SQL_PROVIDER=deterministic
# Optional: protects /metrics if you ever expose it. Anonymous assistant data answers stay off unless you name a synthetic demo tenant.
METRICS_TOKEN=
ASSISTANT_PUBLIC_DATA_TENANT=
ENVEOF
  echo "created $ENV"
elif [ -n "$DOMAIN" ] && ! grep -q "^SITE_ADDRESS=$DOMAIN$" "$ENV"; then
  sed -i "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$DOMAIN|; s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" "$ENV"; echo "updated domain in $ENV"
fi

# Nightly logical backup (see backup.sh); keeps 14 days.
cat > /etc/cron.d/clearline-backup <<'CRON'
17 3 * * * root /opt/clearline/src/deploy/hetzner/backup.sh >> /var/log/clearline-backup.log 2>&1
CRON
echo "server ready"
