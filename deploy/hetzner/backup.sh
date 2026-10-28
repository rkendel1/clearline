#!/usr/bin/env bash
# Logical backup of the application database and the roles (roles live outside a database dump). Keeps 14 days.
# Restore: see README.md. Copy /opt/clearline/backups off the server too; a backup on the same disk is not a backup.
set -euo pipefail
cd "$(dirname "$0")"
OUT=/opt/clearline/backups; STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DC="docker compose --env-file /opt/clearline/.env"
$DC exec -T db pg_dumpall -U postgres --roles-only | gzip > "$OUT/roles-$STAMP.sql.gz"
$DC exec -T db pg_dump -U postgres --format=custom clearline > "$OUT/clearline-$STAMP.dump"
find "$OUT" -type f -mtime +14 -delete
echo "$STAMP backup ok: $(ls -1 "$OUT" | wc -l) files, $(du -sh "$OUT" | cut -f1)"
