#!/usr/bin/env bash
# ============================================================================
# Run the BACKEND API only — serves every /api/* + /ws/* on :8787.
#
#   ./backend.sh         install deps + run the API
#
# MongoDB connection comes from backend/.env (MONGO_URL) — this points at the
# OfferLetter Atlas cluster. The script does NOT seed and does NOT touch any
# local database.
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT"

API_PORT="${API_PORT:-8787}"

if [ -t 1 ]; then B="\033[1m"; G="\033[32m"; R="\033[31m"; X="\033[0m"; else B=""; G=""; R=""; X=""; fi
say()  { printf "${B}${G}▶ %s${X}\n" "$*"; }
die()  { printf "${R}✗ %s${X}\n" "$*" >&2; exit 1; }

if command -v pnpm >/dev/null 2>&1; then PNPM="pnpm"
elif command -v corepack >/dev/null 2>&1; then PNPM="corepack pnpm"
else die "pnpm not found (install Node >= 18)."; fi

[ -f backend/.env ] || say "Warning: backend/.env not found — set MONGO_URL and provider keys before the API can serve."

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  say "Installing backend dependencies…"; ( cd backend && $PNPM install )
fi

printf "\n"
say "Backend API on http://localhost:${API_PORT}  —  all /api/* + /ws/* endpoints."
printf "    health: http://localhost:${API_PORT}/health\n\n"
say "Starting backend… (Ctrl+C to stop)"
printf "\n"
cd backend && exec $PNPM start
