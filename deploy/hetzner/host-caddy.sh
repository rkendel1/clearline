#!/usr/bin/env bash
# Shared server: add (or update) a Clearline site block in the Caddy that already owns ports 80/443, safely:
# backs up the Caddyfile, validates the new config, reloads gracefully (no dropped connections), and rolls back if validation fails.
#   bash host-caddy.sh clearline.example.com [upstream-port]
set -euo pipefail
DOMAIN="${1:?usage: host-caddy.sh domain [port]}"; PORT="${2:-8090}"; FILE="${CADDYFILE:-/etc/caddy/Caddyfile}"; RELOAD="${RELOAD_CMD:-systemctl reload caddy}"
[ -f "$FILE" ] || { echo "no $FILE: configure your proxy by hand to forward $DOMAIN to 127.0.0.1:$PORT"; exit 1; }
# Validation provisions the TLS modules, which need the environment the Caddy service itself runs with (for example a DNS-challenge token).
# Load it from the systemd unit for this process only; it is never printed.
ENVLINE=$(systemctl show caddy -p Environment --value 2>/dev/null || true)
EFILE=$(systemctl show caddy -p EnvironmentFiles --value 2>/dev/null | awk '{print $1}' || true)
[ -n "${EFILE:-}" ] && [ -f "$EFILE" ] && { set -a; . "$EFILE"; set +a; }
[ -n "$ENVLINE" ] && export $ENVLINE
BLOCK="# BEGIN clearline (managed by deploy/hetzner/host-caddy.sh)
$DOMAIN {
	encode zstd gzip
	# Prometheus metrics expose tenant ids and source names: not for the public internet.
	@metrics path /metrics
	respond @metrics 404
	reverse_proxy 127.0.0.1:$PORT {
		header_down Strict-Transport-Security \"max-age=31536000\"
	}
}
# END clearline"
TMP=$(mktemp)
# Drop a previous managed block (idempotent), then append the current one.
awk '/^# BEGIN clearline/{skip=1} !skip{print} /^# END clearline/{skip=0}' "$FILE" > "$TMP"
printf '\n%s\n' "$BLOCK" >> "$TMP"
if caddy validate --config "$TMP" --adapter caddyfile >/dev/null 2>"$TMP.err"; then
  cp -a "$FILE" "$FILE.bak.$(date -u +%Y%m%dT%H%M%SZ)"; cat "$TMP" > "$FILE"; $RELOAD; echo "Caddy reloaded: https://$DOMAIN -> 127.0.0.1:$PORT"
else
  echo "new Caddy config did not validate; nothing changed:"; cat "$TMP.err"; exit 1
fi
rm -f "$TMP" "$TMP.err"
