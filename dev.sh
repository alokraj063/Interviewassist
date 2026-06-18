#!/usr/bin/env bash
# ============================================================================
# RecruitAssist — one-shot dev launcher (macOS + Linux)
#
#   ./dev.sh            start everything (containers + backend + frontend)
#   ./dev.sh stop       stop the Postgres + Redis containers
#   ./dev.sh reset      stop + DELETE the db/redis volumes (fresh start)
#   ./dev.sh seed       re-run the (destructive) demo seed, then start
#
# It is idempotent — safe to run again. Postgres(pgvector) + Redis run in
# Docker on ports 5433 / 6380 (so they don't clash with anything on the
# default 5432 / 6379). Backend = :8787, Frontend = :8084.
# ============================================================================
set -euo pipefail

# --- resolve repo root (this script's directory) ---------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT"

# --- tunables (override via environment) -----------------------------------
POSTGRES_PORT="${POSTGRES_PORT:-5433}"
REDIS_PORT="${REDIS_PORT:-6380}"
PGUSER="${POSTGRES_USER:-recruitassist}"
PGDB="${POSTGRES_DB:-recruitassist}"
PGPASS="${POSTGRES_PASSWORD:-recruitassist_dev}"
API_PORT="${API_PORT:-8787}"
WEB_PORT="${WEB_PORT:-8084}"
PG_CONTAINER="recruitassist-postgres"
REDIS_CONTAINER="recruitassist-redis"

# --- pretty output ---------------------------------------------------------
if [ -t 1 ]; then B="\033[1m"; G="\033[32m"; Y="\033[33m"; R="\033[31m"; X="\033[0m"; else B=""; G=""; Y=""; R=""; X=""; fi
say()  { printf "${B}${G}▶ %s${X}\n" "$*"; }
warn() { printf "${Y}! %s${X}\n" "$*"; }
die()  { printf "${R}✗ %s${X}\n" "$*" >&2; exit 1; }

# --- pick a docker compose command (v2 plugin or legacy v1) ----------------
command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop (mac) or docker engine (linux)."
docker info >/dev/null 2>&1 || die "Docker daemon isn't running. Start Docker Desktop / the docker service and retry."
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else die "Neither 'docker compose' nor 'docker-compose' is available."; fi

# --- resolve pnpm (direct, or via corepack which ships with Node >=16) -----
if command -v pnpm >/dev/null 2>&1; then PNPM="pnpm"
elif command -v corepack >/dev/null 2>&1; then PNPM="corepack pnpm"
else die "pnpm not found. Install Node.js >= 18 (which bundles corepack) or 'npm i -g pnpm'."; fi

export POSTGRES_PORT REDIS_PORT POSTGRES_USER="$PGUSER" POSTGRES_DB="$PGDB" POSTGRES_PASSWORD="$PGPASS"

# ---------------------------------------------------------------------------
# sub-commands
# ---------------------------------------------------------------------------
CMD="${1:-start}"

if [ "$CMD" = "stop" ]; then
  say "Stopping containers…"
  $DC down
  exit 0
fi

if [ "$CMD" = "reset" ]; then
  warn "This DELETES the Postgres + Redis volumes (all local data)."
  $DC down -v
  say "Volumes removed. Run ./dev.sh to start fresh."
  exit 0
fi

FORCE_SEED=0
[ "$CMD" = "seed" ] && FORCE_SEED=1

# ---------------------------------------------------------------------------
# 1) .env — create a sane default if missing (keeps your keys if it exists)
# ---------------------------------------------------------------------------
if [ ! -f .env ]; then
  say "No .env found — creating one (ports ${POSTGRES_PORT}/${REDIS_PORT})…"
  if command -v openssl >/dev/null 2>&1; then JWT="$(openssl rand -hex 32)"; else JWT="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"; fi
  cat > .env <<EOF
# --- Database (pgvector container) ---
POSTGRES_USER=${PGUSER}
POSTGRES_PASSWORD=${PGPASS}
POSTGRES_DB=${PGDB}
POSTGRES_PORT=${POSTGRES_PORT}
DATABASE_URL=postgres://${PGUSER}:${PGPASS}@localhost:${POSTGRES_PORT}/${PGDB}

# --- Redis / BullMQ ---
REDIS_PORT=${REDIS_PORT}
REDIS_URL=redis://localhost:${REDIS_PORT}

# --- API + web ---
API_HOST=0.0.0.0
API_PORT=${API_PORT}
API_PUBLIC_URL=http://localhost:${API_PORT}
APP_BASE_URL=http://localhost:${WEB_PORT}
JWT_SECRET=${JWT}
VITE_API_BASE_URL=http://localhost:${API_PORT}
VITE_WS_BASE_URL=ws://localhost:${API_PORT}
WEB_PORT=${WEB_PORT}

# --- Live Assist providers (REQUIRED for transcription + AI) ---
DEEPGRAM_API_KEY=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# --- First admin (created on fresh DB) ---
BOOTSTRAP_ADMIN_EMAIL=admin@recruitassist.local
BOOTSTRAP_ADMIN_PASSWORD=Recruiter#2026

# --- Recordings ---
DUMP_DIR=./var/audio-dumps
EOF
  warn "Add your DEEPGRAM_API_KEY and OPENAI_API_KEY to .env for live transcription + the AI co-pilot."
fi

# ---------------------------------------------------------------------------
# 2) containers
# ---------------------------------------------------------------------------
say "Starting Postgres (pgvector) + Redis on ${POSTGRES_PORT}/${REDIS_PORT}…"
$DC up -d

say "Waiting for Postgres to be ready…"
for i in $(seq 1 40); do
  if docker exec "$PG_CONTAINER" pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1; then break; fi
  [ "$i" = "40" ] && die "Postgres did not become ready in time."
  sleep 1
done

say "Ensuring Postgres extensions (vector, pgcrypto, citext)…"
docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;" >/dev/null

# ---------------------------------------------------------------------------
# 3) dependencies
# ---------------------------------------------------------------------------
if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  say "Installing dependencies (pnpm install)…"
  $PNPM install
fi

# ---------------------------------------------------------------------------
# 4) migrate (idempotent) + seed (only when empty, or 'seed' command)
# ---------------------------------------------------------------------------
say "Applying database migrations…"
$PNPM db:migrate

CANDIDATE_COUNT="$(docker exec "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -tAc "SELECT count(*) FROM candidates" 2>/dev/null || echo 0)"
if [ "$FORCE_SEED" = "1" ] || [ "${CANDIDATE_COUNT:-0}" = "0" ]; then
  say "Seeding demo data (users, demands, candidates)…"
  $PNPM db:seed
else
  say "Database already has data (${CANDIDATE_COUNT} candidates) — skipping seed. Use ./dev.sh seed to reseed."
fi

# ---------------------------------------------------------------------------
# 5) run backend + frontend (foreground; Ctrl+C stops them)
# ---------------------------------------------------------------------------
printf "\n"
say "Everything is up. Open the app:"
printf "    ${B}Frontend:${X} http://localhost:${WEB_PORT}\n"
printf "    ${B}Backend :${X} http://localhost:${API_PORT}\n"
printf "    ${B}Login   :${X} recruiter1@recruitassist.local  /  Recruiter#2026  (admin@recruitassist.local for Settings → Jobs)\n\n"
say "Starting backend + frontend… (Ctrl+C to stop; containers keep running — './dev.sh stop' to stop them)"
printf "\n"

exec $PNPM --parallel --filter @j2w/api --filter @j2w/web dev
