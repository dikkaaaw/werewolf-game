#!/usr/bin/env bash
# Run the SQL assertion suites against a freshly migrated LOCAL scratch database.
#
#   npm run db:test:security
#
# Targets the local Postgres only (scripts/db-local.sh defaults to
# /tmp/opencode/wolfpg on 127.0.0.1:55432). It never touches a hosted project:
# PGHOST is pinned to loopback below and refused if overridden to anything else.
#
# Exits non-zero if any assertion fails, so it is CI-usable.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"

export PGHOST="127.0.0.1"
export PGPORT="${PGPORT:-55432}"
export PGUSER="${PGUSER:-postgres}"
export PGDATABASE="${PGDATABASE:-werewolf_test}"
# Socket directory of the same local instance, used by the guard negative
# control. db-local.sh keeps the cluster at /tmp/opencode/wolfpg, and its
# sockets live in that directory (not in the PGDATA/data subdirectory).
export SOCKET_DIR="${SOCKET_DIR:-/tmp/opencode/wolfpg}"

# Hard stop if anything tries to point this at a non-loopback host.
case "$PGHOST" in
  127.0.0.1|localhost|::1) ;;
  *) echo "refusing to run DB suites against non-local host '$PGHOST'" >&2; exit 2 ;;
esac

if ! "$PGBIN/pg_isready" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then
  echo "error: no Postgres at $PGHOST:$PGPORT - see scripts/db-local.sh" >&2
  exit 1
fi

run_suite() {
  local name="$1" file="$2"
  echo "-> resetting $PGDATABASE"
  "$ROOT/scripts/db-local.sh" reset >/dev/null

  echo "-> running $name assertions"
  # NOTE: capture PIPESTATUS[0] (psql) BEFORE any other command runs. An
  # earlier version appended `|| true` to the pipeline, which reset
  # PIPESTATUS and made a failing suite report success. Do not do that.
  set +e
  "$PGBIN/psql" -v ON_ERROR_STOP=1 -q -d "$PGDATABASE" -f "$ROOT/$file" 2>&1 \
    | tee "/tmp/wolf-${name}.log" \
    | grep -E '^(  ok|###|ASSERTION|ERROR|error|psql:.*ERROR)'
  local status=${PIPESTATUS[0]}
  set -e

  if [ "$status" -ne 0 ]; then
    echo "-> $name suite FAILED (psql exit $status)" >&2
    exit "$status"
  fi
  echo "-> $name suite passed"
}

# ---------------------------------------------------------------------------
# Negative controls for the concurrency suite's in-file safety guard.
#
# supabase/tests/concurrency.sql installs `dblink`, which carries PostgreSQL's
# default EXECUTE-to-PUBLIC grant — arbitrary SQL for `authenticated` if it ever
# lands on a shared database. The guard inside the .sql file is the real
# protection; this proves it actually refuses.
#
# Both controls use ONLY the local scratch instance. Nothing here connects to a
# hosted or shared database, and no credentials are printed.
# ---------------------------------------------------------------------------
assert_concurrency_guard() {
  local probe="guard_probe_disallowed"
  local sockdir="${SOCKET_DIR:-}"
  local file="$ROOT/supabase/tests/concurrency.sql"
  local out status

  echo "-> verifying concurrency.sql safety guard (negative controls)"

  dblink_present() {
    "$PGBIN/psql" -tAc \
      "select count(*) from pg_extension where extname = 'dblink'" "$1" | tr -d ' '
  }

  # --- Control 1: loopback host, but a database NOT on the allowlist --------
  "$PGBIN/dropdb" --if-exists "$probe" >/dev/null 2>&1 || true
  "$PGBIN/createdb" "$probe" >/dev/null

  set +e
  out="$("$PGBIN/psql" -v ON_ERROR_STOP=1 -q -d "$probe" -f "$file" 2>&1)"
  status=$?
  set -e

  if [ "$status" -eq 0 ]; then
    echo "GUARD FAILED: concurrency.sql ran against non-allowlisted database '$probe'" >&2
    exit 1
  fi
  if ! grep -q "SAFETY GUARD" <<<"$out"; then
    echo "GUARD FAILED: expected a SAFETY GUARD refusal for '$probe', got:" >&2
    echo "$out" | head -5 >&2
    exit 1
  fi
  if [ "$(dblink_present "$probe")" != "0" ]; then
    echo "GUARD FAILED: dblink was installed in the refused database '$probe'" >&2
    exit 1
  fi
  echo "   ok  refuses a non-allowlisted database, and installs nothing (target: local $probe)"
  "$PGBIN/dropdb" --if-exists "$probe" >/dev/null 2>&1 || true

  # --- Control 2: an allowlisted database reached over a unix socket --------
  # inet_server_addr() is NULL for socket connections, so the guard must fail
  # closed: it cannot prove the connection is local, so it refuses.
  if [ -n "$sockdir" ] && [ -S "$sockdir/.s.PGSQL.$PGPORT" ]; then
    set +e
    out="$("$PGBIN/psql" -v ON_ERROR_STOP=1 -q -h "$sockdir" -p "$PGPORT" \
             -d "$PGDATABASE" -f "$file" 2>&1)"
    status=$?
    set -e

    if [ "$status" -eq 0 ]; then
      echo "GUARD FAILED: concurrency.sql ran over a unix socket" >&2
      exit 1
    fi
    if ! grep -q "could not be established" <<<"$out"; then
      echo "GUARD FAILED: expected a locality-proof refusal over the socket, got:" >&2
      echo "$out" | head -5 >&2
      exit 1
    fi
    echo "   ok  fails closed when the server address cannot be established (local socket)"
  else
    echo "   --  socket control skipped (no local socket found)"
  fi
}

run_suite security supabase/tests/security.sql
run_suite gameplay supabase/tests/gameplay.sql
# Genuine concurrency: each competing call runs on its own dblink backend in
# its own transaction, so this suite takes a few seconds (deliberate sleeps).
assert_concurrency_guard
run_suite concurrency supabase/tests/concurrency.sql

echo "-> all SQL suites passed"