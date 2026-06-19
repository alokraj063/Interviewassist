#!/usr/bin/env bash
# ============================================================================
# Run the BACKEND API only (MongoDB) — serves every /api/* + /ws/* on :8787.
#
#   ./backend.sh         install + seed (if empty) + run the API
#   ./backend.sh seed    force re-seed Mongo, then run the API
#
# Requires MongoDB running locally (default mongodb://localhost:27017).
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT"

MONGO_URL="${MONGO_URL:-mongodb://localhost:27017}"
MONGO_DB="${MONGO_DB:-interview_assist}"
API_PORT="${API_PORT:-8787}"

if [ -t 1 ]; then B="\033[1m"; G="\033[32m"; R="\033[31m"; X="\033[0m"; else B=""; G=""; R=""; X=""; fi
say()  { printf "${B}${G}▶ %s${X}\n" "$*"; }
die()  { printf "${R}✗ %s${X}\n" "$*" >&2; exit 1; }

if command -v pnpm >/dev/null 2>&1; then PNPM="pnpm"
elif command -v corepack >/dev/null 2>&1; then PNPM="corepack pnpm"
else die "pnpm not found (install Node >= 18)."; fi

MSH=""
command -v mongosh >/dev/null 2>&1 && MSH="mongosh"
command -v mongo >/dev/null 2>&1 && [ -z "$MSH" ] && MSH="mongo"

CMD="${1:-start}"
FORCE_SEED=0; [ "$CMD" = "seed" ] && FORCE_SEED=1

say "Checking MongoDB at ${MONGO_URL}…"
if [ -n "$MSH" ]; then
  "$MSH" "$MONGO_URL" --quiet --eval "db.runCommand({ping:1}).ok" >/dev/null 2>&1 || die "Can't reach MongoDB at ${MONGO_URL}."
fi

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  say "Installing backend dependencies…"; ( cd backend && $PNPM install )
fi

USER_COUNT="x"
[ -n "$MSH" ] && USER_COUNT="$("$MSH" "${MONGO_URL}/${MONGO_DB}" --quiet --eval "db.users.countDocuments()" 2>/dev/null || echo 0)"
if [ "$FORCE_SEED" = "1" ] || [ "${USER_COUNT:-0}" = "0" ]; then
  say "Seeding MongoDB demo data…"; ( cd backend && $PNPM db:seed )
else
  say "MongoDB already has data (${USER_COUNT} users) — skipping seed."
fi

printf "\n"
say "Backend API on http://localhost:${API_PORT}  —  all /api/* + /ws/* endpoints."
printf "    health: http://localhost:${API_PORT}/health\n\n"
say "Starting backend… (Ctrl+C to stop)"
printf "\n"
cd backend && exec $PNPM dev
