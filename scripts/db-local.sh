#!/usr/bin/env bash
# Apply migrations + test harness to a scratch database.
#
#   ./scripts/db-local.sh reset          # drop, recreate, harness, migrate
#   ./scripts/db-local.sh migrate        # migrate an existing database
#   ./scripts/db-local.sh psql           # open a shell
#
# Defaults target the local scratch instance in /tmp/opencode/wolfpg.
# Override with PGHOST / PGPORT / PGUSER / PGDATABASE.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"

export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-55432}"
export PGUSER="${PGUSER:-postgres}"
export PGDATABASE="${PGDATABASE:-werewolf_test}"

psql_cmd() { "$PGBIN/psql" -v ON_ERROR_STOP=1 -q "$@"; }

apply_migrations() {
  local applied
  applied="$(psql_cmd -d "$PGDATABASE" -tAc \
    "select count(*) from pg_tables where schemaname='public' and tablename='rooms'")"
  if [[ "$applied" == "1" ]]; then
    echo "→ migrations already applied; run 'reset' to start over"
    return 0
  fi

  echo "→ applying harness"
  psql_cmd -f "$ROOT/supabase/tests/harness.sql"

  local file
  for file in "$ROOT"/supabase/migrations/*.sql; do
    echo "→ applying $(basename "$file")"
    psql_cmd -f "$file"
  done
  echo "→ all migrations applied"
}

case "${1:-reset}" in
  reset)
    "$PGBIN/dropdb" --if-exists "$PGDATABASE" >/dev/null
    "$PGBIN/createdb" "$PGDATABASE"
    apply_migrations
    ;;
  migrate)
    apply_migrations
    ;;
  psql)
    "$PGBIN/psql" -d "$PGDATABASE"
    ;;
  *)
    echo "usage: $0 {reset|migrate|psql}" >&2
    exit 1
    ;;
esac
