# RecruitAssist

AI-native applicant tracking system and recruiter productivity platform for
staffing firms and in-house TA teams. Hinglish-first (Hindi + English) for
Indian recruiting workflows.

Forked from `j2w-contact-flow` on 2026-04-29. The contact-center foundation
(multi-tenant auth, KB with pgvector, Vapi voice agents, live-assist
transcription pipeline, BullMQ workers) carries over; the domain has been
rewired around recruiters, candidates, demands, prospects, and submissions.

See [CLAUDE.md](CLAUDE.md) for architecture, deploy, and gotchas.

## Quick start

```bash
pnpm install
docker compose up -d            # postgres + redis
pnpm db:migrate
pnpm --filter @j2w/api db:seed
pnpm dev                        # web + api + worker in parallel
```

Web at http://localhost:8080, API at http://localhost:8787.

## Layout

- [apps/web](apps/web) — Vite SPA (React + Tailwind + shadcn/ui + React Query)
- [apps/api](apps/api) — Fastify (HTTP + WebSocket + SSE) on :8787
- [apps/worker](apps/worker) — BullMQ workers
- [apps/desktop](apps/desktop) — Electron audio companion (client-distributed)
- [packages/db](packages/db), [packages/ingest-shared](packages/ingest-shared), [packages/shared-types](packages/shared-types) — workspace libs
- [deploy/](deploy/) — Dokploy/Traefik docker-compose stack (nginx + api + worker + postgres-pgvector + redis); see [deploy/README.md](deploy/README.md)

The workspace package scope stays `@j2w/*` (saves ~150 import-rewrites and
matches the J2W-internal-first product lifecycle); only public-facing
branding becomes RecruitAssist.
