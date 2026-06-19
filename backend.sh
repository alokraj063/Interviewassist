#!/usr/bin/env bash
# ============================================================================
# Run the BACKEND API only — serves every /api/* + /ws/* endpoint on :8787.
# (Frontend not started. Use ./dev.sh to run both.)
#
#   ./backend.sh           start Postgres + Redis (if needed) + migrate + run API
#   ./backend.sh stop      stop the Postgres + Redis containers
#   ./backend.sh seed      force re-run the demo seed, then run the API
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT"

# --- tunables (override via environment) ---
POSTGRES_PORT="${POSTGRES_PORT:-5433}"
REDIS_PORT="${REDIS_PORT:-6380}"
PGUSER="${POSTGRES_USER:-recruitassist}"
PGDB="${POSTGRES_DB:-recruitassist}"
API_PORT="${API_PORT:-8787}"
PG_CONTAINER="recruitassist-postgres"

if [ -t 1 ]; then B="\033[1m"; G="\033[32m"; Y="\033[33m"; R="\033[31m"; X="\033[0m"; else B=""; G=""; Y=""; R=""; X=""; fi
say()  { printf "${B}${G}▶ %s${X}\n" "$*"; }
warn() { printf "${Y}! %s${X}\n" "$*"; }
die()  { printf "${R}✗ %s${X}\n" "$*" >&2; exit 1; }

# --- docker compose + pnpm resolution ---
command -v docker >/dev/null 2>&1 || die "Docker is not installed."
docker info >/dev/null 2>&1 || die "Docker daemon isn't running."
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else die "No docker compose available."; fi
if command -v pnpm >/dev/null 2>&1; then PNPM="pnpm"
elif command -v corepack >/dev/null 2>&1; then PNPM="corepack pnpm"
else die "pnpm not found (install Node >= 18)."; fi

export POSTGRES_PORT REDIS_PORT POSTGRES_USER="$PGUSER" POSTGRES_DB="$PGDB"

CMD="${1:-start}"
if [ "$CMD" = "stop" ]; then say "Stopping containers…"; $DC down; exit 0; fi
FORCE_SEED=0; [ "$CMD" = "seed" ] && FORCE_SEED=1

# --- 1) containers ---
say "Starting Postgres (pgvector) + Redis on ${POSTGRES_PORT}/${REDIS_PORT}…"
$DC up -d
say "Waiting for Postgres…"
for i in $(seq 1 40); do
  docker exec "$PG_CONTAINER" pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1 && break
  [ "$i" = "40" ] && die "Postgres not ready."
  sleep 1
done
docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;" >/dev/null

# --- 2) backend deps + migrate (+ seed when empty / 'seed') ---
if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  say "Installing backend dependencies…"
  ( cd backend && $PNPM install )
fi
say "Applying database migrations…"
( cd backend && $PNPM db:migrate )

CANDIDATE_COUNT="$(docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -tAc "SELECT count(*) FROM candidates" 2>/dev/null || echo 0)"
if [ "$FORCE_SEED" = "1" ] || [ "${CANDIDATE_COUNT:-0}" = "0" ]; then
  say "Seeding demo data…"
  ( cd backend && $PNPM db:seed )
else
  say "Database already has data (${CANDIDATE_COUNT} candidates) — skipping seed."
fi

# --- 3) run the API (foreground; Ctrl+C stops it) ---
printf "\n"
say "Backend API on http://localhost:${API_PORT}  —  all /api/* + /ws/* endpoints."
printf "    health: http://localhost:${API_PORT}/health\n\n"
say "Starting backend… (Ctrl+C to stop; containers keep running — './backend.sh stop' to stop them)"
printf "\n"
cd backend && exec $PNPM dev
