#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/supastack-local.sh — ISOLATED LOCAL Supabase-compatible stack (CI/dev)
#
# Brings up a real Postgres + GoTrue (auth) + PostgREST so that
# tests/integration/game-loop.test.ts can run WITHOUT touching any hosted
# project. Docker and the Supabase CLI are NOT required: the two services are
# plain static binaries talking to a local Postgres.
#
#   ./scripts/supastack-local.sh install   # download binaries (once)
#   ./scripts/supastack-local.sh up        # create db, migrate, start services
#   ./scripts/supastack-local.sh status    # health check
#   ./scripts/supastack-local.sh env       # print the env vars for `npm test`
#   ./scripts/supastack-local.sh down      # stop services (drops nothing)
#
# SAFETY: every service binds to 127.0.0.1 only. The JWT secret is generated
# locally into $STATE/jwt_secret and is never printed or committed. There is no
# code path here that reads .env / .env.local, so the hosted project cannot be
# contacted by accident.
#
# CREDENTIALS: no database credential is written into this script. The
# PostgREST login role and password come from SUPASTACK_PGRST_DB_USER /
# SUPASTACK_PGRST_DB_PASSWORD, or from a git-ignored `.supastack.env` at the
# repo root if one is present. Under the local cluster's trust auth Postgres
# ignores the password entirely; it is still part of the connection URI, so it
# is supplied from outside rather than baked in here.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${SUPASTACK_STATE:-/tmp/opencode/supastack}"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"

# Optional local overrides. Git-ignored, never committed, read only if it
# exists. Sourced before the defaults below so any value it sets wins.
if [[ -f "$ROOT/.supastack.env" ]]; then
  # shellcheck disable=SC1090,SC1091
  source "$ROOT/.supastack.env"
fi

# Loopback-only. Guarded rather than assumed.
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-55432}"
export PGUSER="${PGUSER:-postgres}"

# The role PostgREST logs in as, then switches to `anon`. It must already
# exist in the target database — this script does not create roles.
PGRST_DB_USER="${SUPASTACK_PGRST_DB_USER:-authenticator}"
PGRST_DB_PASSWORD="${SUPASTACK_PGRST_DB_PASSWORD:-}"

DB_NAME="${SUPASTACK_DB:-werewolf_e2e}"
AUTH_PORT="${SUPASTACK_AUTH_PORT:-9999}"
PGRST_PORT="${SUPASTACK_PGRST_PORT:-3001}"
# Single front-door port, mirroring hosted Supabase's Kong: this is what
# NEXT_PUBLIC_SUPABASE_URL must point at, because supabase-js derives the auth
# base URL from it too.
PROXY_PORT="${SUPASTACK_PROXY_PORT:-54321}"

PGRST_VERSION="v16.4"
AUTH_VERSION="v2.197.0"

BIN="$STATE/bin"
mkdir -p "$BIN"

log() { printf '→ %s\n' "$*"; }

# `setsid` may fork, so $! is not necessarily the daemon's pid. Resolve the real
# listener by port instead, otherwise `down` leaves orphans holding the port and
# the next `up` dies with "Address in use".
# Every listener on the port, not just the first. Accumulated orphans holding
# a stale port are a nasty failure mode: the newly started daemon cannot bind,
# exits silently, and requests keep being served by the OLD process — with its
# OLD configuration — while the health check happily reports UP.
pids_on_port() {
  ss -lptnH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
}

kill_port() {
  local port="$1" p
  for p in $(pids_on_port "$port"); do
    kill "$p" 2>/dev/null || true
  done
  # Give them a moment, then be certain.
  sleep 1
  for p in $(pids_on_port "$port"); do
    kill -9 "$p" 2>/dev/null || true
  done
}

require_free_port() {
  local port="$1" name="$2" p
  for p in $(pids_on_port "$port"); do
    die "port $port is still held by pid $p ($name); run '$0 down' and retry"
  done
}
die() { printf '!! %s\n' "$*" >&2; exit 1; }

# --- install ---------------------------------------------------------------
install_bins() {
  if [[ ! -x "$BIN/postgrest" ]]; then
    log "downloading PostgREST $PGRST_VERSION"
    # NB: upstream spells the linux asset `x86-64`; a wrong guess 404s with a
    # 9-byte "Not Found" body, so derive the name from the API listing.
    local asset
    asset="$(curl -fsSL "https://api.github.com/repos/PostgREST/postgrest/releases/latest" \
      | python3 -c "import sys,json;print([a['name'] for a in json.load(sys.stdin)['assets'] if 'linux-static' in a['name'] and 'x86-64' in a['name']][0])")"
    curl -fsSL -o "$STATE/pgrst.tar.xz" \
      "https://github.com/PostgREST/postgrest/releases/download/$PGRST_VERSION/$asset"
    tar -xf "$STATE/pgrst.tar.xz" -C "$STATE"
    install -m 0755 "$STATE/postgrest" "$BIN/postgrest"
  fi
  if [[ ! -x "$BIN/auth" ]]; then
    log "downloading GoTrue $AUTH_VERSION"
    curl -fsSL -o "$STATE/auth.tar.gz" \
      "https://github.com/supabase/auth/releases/download/$AUTH_VERSION/auth-$AUTH_VERSION-x86.tar.gz"
    mkdir -p "$STATE/authx"
    tar -xf "$STATE/auth.tar.gz" -C "$STATE/authx"
    install -m 0755 "$STATE/authx/auth" "$BIN/auth"
  fi
  log "postgrest=$($BIN/postgrest --version)  gotrue=$($BIN/auth version)"
}

secret() { cat "$STATE/jwt_secret"; }

# GoTrue reads the same env for `migrate` and `serve`, so keep it in one place.
# GOTRUE_JWT_ADMIN_ROLES is what lets the integration suite call
# auth.admin.createUser with the service_role key.
auth_env() {
  export GOTRUE_DB_DRIVER=postgres
  # search_path=auth is required: GoTrue queries its tables unqualified
  # (e.g. "identities"), and hosted Supabase supplies this on the connection
  # string. Without it admin user creation fails with
  # `relation "identities" does not exist` (SQLSTATE 42P01).
  export GOTRUE_DB_DATABASE_URL="postgres://$PGUSER@$PGHOST:$PGPORT/$DB_NAME?search_path=auth"
  export GOTRUE_SITE_URL="http://127.0.0.1:3000"
  export API_EXTERNAL_URL="http://127.0.0.1:$AUTH_PORT"
  export GOTRUE_JWT_SECRET="$(secret)"
  export GOTRUE_JWT_EXP=3600
  export GOTRUE_JWT_AUD=authenticated
  export GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
  export GOTRUE_JWT_ADMIN_ROLES=service_role
  export GOTRUE_EXTERNAL_EMAIL_ENABLED=true
  export GOTRUE_MAILER_AUTOCONFIRM=true
  export GOTRUE_DISABLE_SIGNUP=false
}

# --- up --------------------------------------------------------------------
up() {
  [[ -x "$BIN/postgrest" && -x "$BIN/auth" ]] || install_bins
  [[ -s "$STATE/jwt_secret" ]] || { openssl rand -hex 32 > "$STATE/jwt_secret"; chmod 600 "$STATE/jwt_secret"; }

  # Stop first: a live PostgREST/GoTrue holds open connections, which makes
  # dropdb fail with "database is being accessed by other users" and then
  # createdb fail with "already exists".
  down >/dev/null 2>&1 || true
  # Now verify: a surviving listener here means `down` did not work and the new
  # daemons below would fail to bind while health checks pass against the old.
  require_free_port "$AUTH_PORT"  gotrue
  require_free_port "$PGRST_PORT" postgrest
  require_free_port "$PROXY_PORT" proxy

  log "recreating isolated database $DB_NAME on $PGHOST:$PGPORT"
  # Terminate leftovers rather than trusting the pidfiles alone.
  psql -d postgres -tAc \
    "select pg_terminate_backend(pid) from pg_stat_activity
      where datname = '$DB_NAME' and pid <> pg_backend_pid()" >/dev/null
  "$PGBIN/dropdb" --if-exists "$DB_NAME" >/dev/null
  "$PGBIN/createdb" "$DB_NAME"

  # GoTrue assumes Supabase has already created the schema; bare Postgres has
  # not, and its first migration fails with SQLSTATE 3F000 without this.
  "$PGBIN/psql" -v ON_ERROR_STOP=1 -q -d "$DB_NAME" -c 'create schema if not exists auth;'

  # GoTrue owns the `auth` schema, so it migrates FIRST. The test harness then
  # adds only what GoTrue does not provide (auth.uid(), anon/authenticated/
  # service_role, extensions schema, realtime publication).
  log "running GoTrue migrations (auth schema)"
  ( auth_env && "$BIN/auth" migrate ) >"$STATE/auth-migrate.log" 2>&1 \
    || { tail -20 "$STATE/auth-migrate.log"; die "GoTrue migration failed"; }

  log "applying test harness + game migrations"
  "$PGBIN/psql" -v ON_ERROR_STOP=1 -q -d "$DB_NAME" -f "$ROOT/supabase/tests/harness.sql"
  local f
  for f in "$ROOT"/supabase/migrations/*.sql; do
    "$PGBIN/psql" -v ON_ERROR_STOP=1 -q -d "$DB_NAME" -f "$f"
  done

  log "starting GoTrue on 127.0.0.1:$AUTH_PORT"
  ( cd "$STATE" && auth_env && \
    export GOTRUE_API_HOST=127.0.0.1 GOTRUE_API_PORT="$AUTH_PORT" GOTRUE_LOG_LEVEL=warn && \
    setsid nohup "$BIN/auth" serve </dev/null >"$STATE/auth.log" 2>&1 & )

  log "starting PostgREST on 127.0.0.1:$PGRST_PORT"
  ( cd "$STATE" && \
    PGRST_DB_URI="postgres://${PGRST_DB_USER}:${PGRST_DB_PASSWORD}@$PGHOST:$PGPORT/$DB_NAME" \
    PGRST_DB_SCHEMAS=public \
    PGRST_DB_ANON_ROLE=anon \
    PGRST_JWT_SECRET="$(secret)" \
    PGRST_SERVER_HOST=127.0.0.1 \
    PGRST_SERVER_PORT="$PGRST_PORT" \
    PGRST_DB_USE_LEGACY_GUCS=false \
    PGRST_DB_PRE_REQUEST="" \
    PGRST_LOG_LEVEL=error \
    setsid nohup "$BIN/postgrest" </dev/null >"$STATE/pgrst.log" 2>&1 & )

  log "starting gateway proxy on 127.0.0.1:$PROXY_PORT"
  ( cd "$ROOT" && \
    SUPASTACK_PROXY_PORT="$PROXY_PORT" SUPASTACK_PGRST_PORT="$PGRST_PORT" SUPASTACK_AUTH_PORT="$AUTH_PORT" \
    setsid nohup node scripts/supastack-proxy.mjs </dev/null >"$STATE/proxy.log" 2>&1 & )

  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$PGRST_PORT/" >/dev/null 2>&1 \
       && curl -fsS "http://127.0.0.1:$AUTH_PORT/health" >/dev/null 2>&1 \
       && curl -fsS -o /dev/null "http://127.0.0.1:$PROXY_PORT/rest/v1/" 2>/dev/null; then
      log "stack is up"; status; return 0
    fi
    sleep 0.5
  done
  tail -20 "$STATE/pgrst.log" "$STATE/auth.log" 2>/dev/null
  die "services did not become healthy"
}

status() {
  # PostgREST >= 13 has no /health route; the OpenAPI root is the liveness probe.
  printf 'postgrest : http://127.0.0.1:%s  %s\n' "$PGRST_PORT" \
    "$(curl -fsS "http://127.0.0.1:$PGRST_PORT/" >/dev/null 2>&1 && echo UP || echo DOWN)"
  printf 'gotrue    : http://127.0.0.1:%s  %s\n' "$AUTH_PORT" \
    "$(curl -fsS "http://127.0.0.1:$AUTH_PORT/health" >/dev/null 2>&1 && echo UP || echo DOWN)"
  printf 'gateway   : http://127.0.0.1:%s  %s  <- point NEXT_PUBLIC_SUPABASE_URL here\n' "$PROXY_PORT" \
    "$(curl -fsS -o /dev/null "http://127.0.0.1:$PROXY_PORT/rest/v1/" 2>/dev/null && echo UP || echo DOWN)"
  printf 'postgres  : %s:%s/%s\n' "$PGHOST" "$PGPORT" "$DB_NAME"
}

# --- env -------------------------------------------------------------------
# Emits a service_role JWT signed with the local secret. Contains no hosted
# credentials; it only ever authenticates against the loopback PostgREST.
env() {
  local tok
  tok="$(python3 "$STATE/mkservice.py" "$(secret)")"
  cat <<EOF
export DATABASE_URL="postgres://$PGUSER@$PGHOST:$PGPORT/$DB_NAME"
# src/lib/env.ts accepts only https:// or http://localhost, so the app-facing
# URL must use the hostname even though the listener binds to 127.0.0.1.
# (No backticks in these comments: this block is inside a heredoc that would
# otherwise try to command-substitute them.)
export NEXT_PUBLIC_SUPABASE_URL="http://localhost:$PROXY_PORT"
# A real anon-role JWT, so the session client runs as the anon role and RLS
# applies exactly as it does in production.
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$(python3 "$STATE/mkservice.py" "$(secret)" anon)"
# serverEnvSchema demands >= 32 chars. Local-only value; never used remotely.
export SCHEDULER_SECRET="$(openssl rand -hex 32)"
export SUPABASE_SERVICE_ROLE_KEY="$tok"
EOF
}

down() {
  # Kill whatever actually owns the ports, not just the recorded pids.
  kill_port "$AUTH_PORT"
  kill_port "$PGRST_PORT"
  kill_port "$PROXY_PORT"
  log "services stopped (database left intact)"
}

case "${1:-up}" in
  install) install_bins ;;
  up)      up ;;
  down)    down ;;
  status)  status ;;
  env)     env ;;
  *) echo "usage: $0 {install|up|down|status|env}" >&2; exit 1 ;;
esac