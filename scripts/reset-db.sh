#!/usr/bin/env bash
# Drop and recreate a local database (development/test only). Usage: scripts/reset-db.sh <dbname>
set -euo pipefail
DB=${1:?database name}
ADMIN_URL=${PG_ADMIN_URL:-postgres://postgres@localhost:5432/postgres}
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB OWNER clearline"
psql "$ADMIN_URL" -q -tA -c "SELECT rolname FROM pg_roles WHERE rolname LIKE 'clearline_rpt_%'" | while read -r r; do
  psql "$ADMIN_URL" -q -c "DROP ROLE IF EXISTS \"$r\"" 2>/dev/null || true
done
