# Interview Assist — Live Call Co-pilot

A recruiter co-pilot for live candidate interviews: it transcribes the call,
auto-generates a JD + résumé-based question bank, drives the interview one
question at a time (detecting when you go off-script), scores each answer, and
saves a final rubric + summary per call. Token + Deepgram audio cost is tracked
per call.

## Structure

Two self-contained folders:

```
backend/    Fastify API (HTTP + WebSocket) on :8787
  src/                   routes, ws audio pipeline, interview-flow engine, usage tracking
  packages/              @j2w/db (pgvector + drizzle), ingest-shared, shared-types, offer-letter-db
frontend/   Vite + React SPA on :8084
  src/                   the Live Assist UI (call surface, JD & Résumé, Usage & Cost)
  packages/shared-types  shared transcript/session types
docker-compose.yml       Postgres (pgvector) + Redis
.env                     single shared env file (root)
dev.sh                   one-command launcher (macOS + Linux)
```

Each folder is its own pnpm workspace and installs independently.

## Quick start

```bash
./dev.sh           # containers + migrate + seed + backend + frontend
```

Then open **http://localhost:8084** and sign in:

- `recruiter1@recruitassist.local` / `Recruiter#2026` — recruiter
- `admin@recruitassist.local` / `Recruiter#2026` — admin

Other commands:

```bash
./dev.sh stop      # stop the Postgres + Redis containers
./dev.sh reset     # stop + delete the db/redis volumes (fresh start)
./dev.sh seed      # force re-run the demo seed, then start
```

## Manual (without dev.sh)

```bash
docker compose up -d                          # postgres + redis
cd backend  && pnpm install && pnpm db:migrate && pnpm db:seed && pnpm dev
cd frontend && pnpm install && pnpm dev
```

## Env

Add your keys to the root `.env` (both folders read it):

```
DEEPGRAM_API_KEY=...   # live speech-to-text
OPENAI_API_KEY=...     # the interview co-pilot (plan / questions / scoring)
```

`DATABASE_URL`, `REDIS_URL`, and `JWT_SECRET` are also required (the defaults in
`.env` point at the docker containers on ports 5433 / 6380).
