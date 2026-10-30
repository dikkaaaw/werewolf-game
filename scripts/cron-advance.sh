#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/cron-advance.sh — 5-second external scheduler for staging.
#
# Calls POST /api/cron/advance in a loop. This is the only way to get a
# 5-second cadence, since Vercel Cron and pg_cron are minute-level and Vercel
# Cron uses GET. Run it on any always-on host (a small VM, a container, etc.).
#
#   STAGING_URL=https://your-app.vercel.app \
#   SCHEDULER_SECRET=... \
#   ./scripts/cron-advance.sh
#
# Env:
#   STAGING_URL       base URL of the deployed app (required)
#   SCHEDULER_SECRET  same secret configured on the server (required)
#   INTERVAL_SECONDS  loop interval, default 5
# ---------------------------------------------------------------------------
set -euo pipefail

: "${STAGING_URL:?set STAGING_URL to the deployed app base URL}"
: "${SCHEDULER_SECRET:?set SCHEDULER_SECRET to the scheduler secret}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-5}"

endpoint="${STAGING_URL%/}/api/cron/advance"

echo "→ advancing phases every ${INTERVAL_SECONDS}s at ${endpoint}"

while true; do
  # --max-time keeps a hung request from delaying the next tick.
  # -sS: quiet, but still print errors. --fail: non-2xx is an error.
  if ! curl -sS --max-time 10 --fail \
      -X POST \
      -H "Authorization: Bearer ${SCHEDULER_SECRET}" \
      -H "Content-Type: application/json" \
      -d '{}' \
      "${endpoint}"; then
    echo "!! advance request failed at $(date -u +%FT%TZ)" >&2
  fi
  echo
  sleep "${INTERVAL_SECONDS}"
done
