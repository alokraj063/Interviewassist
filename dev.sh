#!/usr/bin/env bash
# ============================================================================
# Interview Assist — one-shot dev launcher (macOS + Linux). MongoDB backed.
#
#   ./dev.sh            install + seed (if empty) + run backend + frontend
#   ./dev.sh seed       force re-seed Mongo, then run
#
# Requires MongoDB running locally (default mongodb://localhost:27017).
# Backend = :8787, Frontend = :8084.
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT"

MONGO_URL="${MONGO_URL:-mongodb://localhost:27017}"
MONGO_DB="${MONGO_DB:-interview_assist}"
API_PORT="${API_PORT:-8787}"
WEB_PORT="${WEB_PORT:-8084}"

if [ -t 1 ]; then B="\033[1m"; G="\033[32m"; Y="\033[33m"; R="\033[31m"; X="\033[0m"; else B=""; G=""; Y=""; R=""; X=""; fi
say()  { printf "${B}${G}▶ %s${X}\n" "$*"; }
die()  { printf "${R}✗ %s${X}\n" "$*" >&2; exit 1; }

# pnpm (direct or via corepack)
if command -v pnpm >/dev/null 2>&1; then PNPM="pnpm"
elif command -v corepack >/dev/null 2>&1; then PNPM="corepack pnpm"
else die "pnpm not found. Install Node.js >= 18 (bundles corepack)."; fi

# mongosh helper
MSH=""
command -v mongosh >/dev/null 2>&1 && MSH="mongosh"
command -v mongo >/dev/null 2>&1 && [ -z "$MSH" ] && MSH="mongo"

CMD="${1:-start}"
FORCE_SEED=0; [ "$CMD" = "seed" ] && FORCE_SEED=1

# 1) Check MongoDB is reachable.
say "Checking MongoDB at ${MONGO_URL}…"
if [ -n "$MSH" ]; then
  "$MSH" "$MONGO_URL" --quiet --eval "db.runCommand({ping:1}).ok" >/dev/null 2>&1 || die "Can't reach MongoDB at ${MONGO_URL}. Start mongod and retry."
else
  printf "" >/dev/null  # no client; assume reachable (backend will fail fast if not)
fi

# 2) Dependencies.
if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  say "Installing backend dependencies…";  ( cd backend  && $PNPM install )
  say "Installing frontend dependencies…"; ( cd frontend && $PNPM install )
fi

# 3) Seed (only when empty, or 'seed').
USER_COUNT="x"
if [ -n "$MSH" ]; then
  USER_COUNT="$("$MSH" "${MONGO_URL}/${MONGO_DB}" --quiet --eval "db.users.countDocuments()" 2>/dev/null || echo 0)"
fi
if [ "$FORCE_SEED" = "1" ] || [ "${USER_COUNT:-0}" = "0" ]; then
  say "Seeding MongoDB demo data…"
  ( cd backend && $PNPM db:seed )
else
  say "MongoDB already has data (${USER_COUNT} users) — skipping seed. Use ./dev.sh seed to reseed."
fi

# 4) Run backend + frontend (Ctrl+C stops both).
printf "\n"
say "Everything is up. Open the app:"
printf "    ${B}Frontend:${X} http://localhost:${WEB_PORT}\n"
printf "    ${B}Backend :${X} http://localhost:${API_PORT}\n"
printf "    ${B}Login   :${X} recruiter1@recruitassist.local  /  Recruiter#2026  (admin@recruitassist.local for the JD & Résumé tab)\n\n"
say "Starting backend + frontend… (Ctrl+C to stop)"
printf "\n"

( cd backend && exec $PNPM dev ) &
BACKEND_PID=$!
trap 'kill "$BACKEND_PID" 2>/dev/null' INT TERM EXIT
cd frontend && exec $PNPM dev
