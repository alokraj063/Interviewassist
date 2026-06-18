# Deploy runbook

Production deployment of RecruitAssist onto the **J2W shared AWS EC2 Dokploy
host**. RecruitAssist runs as one of several apps on that box, behind the host's
Traefik reverse proxy, deployed via the Dokploy UI from
[`docker-compose.dokploy.yml`](docker-compose.dokploy.yml).

For host-level detail (capacity, TLS/CAA caveats, SSH access, Traefik internals)
see **[docs/dokploy-on-this-server.md](../docs/dokploy-on-this-server.md)** — this
file only covers the RecruitAssist-specific steps.

## The host

| | |
|---|---|
| Cloud / region | AWS EC2, `ap-south-1` (Mumbai) |
| Instance | `m5.large` — 2 vCPU, 8 GB RAM |
| Static IP | `13.127.19.121` (Elastic IP) — the A-record target |
| Control plane | Dokploy v0.29.4 on host `:3000` (SSH-tunnel only) |
| Reverse proxy | Traefik (Dokploy-managed) + Let's Encrypt auto-TLS |
| App #1 (don't touch) | `cognition` — slug `cognition`, project name `app` |

`recruitassist.joulestowatts.online` is unaffected by the `j2wofferletter.com`
CAA record that blocks Let's Encrypt, so Traefik can auto-issue its cert.

## Stack (this app)

| Service  | Image                        | Notes                                |
|----------|------------------------------|--------------------------------------|
| web      | nginx (from Dockerfile.web)  | Vite SPA, SPA fallback, port 80      |
| api      | node:20 (Dockerfile.api)     | Fastify + WebSocket + SSE on 8787    |
| worker   | node:20 (Dockerfile.api)     | BullMQ ingest + post-call processing |
| postgres | `pgvector/pgvector:pg16`     | pgvector 1536-dim, DB `recruitassist`|
| redis    | `redis:7-alpine`             | BullMQ queues (appendonly)           |

No reverse proxy in this stack — the host's Traefik handles TLS + routing via
Traefik labels on the `api` and `web` services. The stack joins the host's
external `dokploy-network`; everything else stays on its own `default` network.

## Prerequisites

- **DNS:** `recruitassist.joulestowatts.online` A-record points at `13.127.19.121`.
  Verify before deploying — Let's Encrypt's HTTP-01 challenge runs on first request:
  ```bash
  dig +short recruitassist.joulestowatts.online   # expect 13.127.19.121
  ```
- **SSH access** to the host (for the Dokploy tunnel + post-boot commands). The
  cognition team holds the key (`j2w-cognition.pem`); ask for the PEM or have
  your public key authorized. Then:
  ```bash
  ssh -i j2w-cognition.pem -L 3000:localhost:3000 ec2-user@13.127.19.121
  ```
  With the tunnel up, `http://localhost:3000` hits the Dokploy UI. Get admin
  credentials from the cognition team.
- **Git access for Dokploy:** add an SSH deploy key (generated in this Dokploy
  instance) to the `danielj2w/recruit-assist-ai` GitHub repo (Deploy keys,
  read-only). The repo is private; the SSH-deploy-key path avoids the GitHub App
  (which needs a public callback URL this tunnel-only host can't provide).

## First deploy

1. **Projects → Create Project** → `recruitassist`.
2. **Add Service → Compose**, Provider **Git**:
   - Repo `git@github.com:danielj2w/recruit-assist-ai.git`, branch `main`
   - Compose path `deploy/docker-compose.dokploy.yml`
3. **Environment tab** → paste [`.env.dokploy.template`](.env.dokploy.template)
   and fill in real values. `COMPOSE_PROJECT_NAME=recruitassist-prod`,
   `APP_SLUG=recruitassist`, `APP_HOST=recruitassist.joulestowatts.online`.
   Secrets (`POSTGRES_PASSWORD`, `JWT_SECRET`, `INTEGRATIONS_KEK`, provider keys)
   live only here — never in the repo. **Back up `INTEGRATIONS_KEK` off-host.**
4. **Deploy.** First build is ~5–10 min (pnpm install + Vite build).

## Post-boot (Dokploy Terminal tab, or SSH to the host)

Container names follow `<COMPOSE_PROJECT_NAME>-<service>-1` (e.g.
`recruitassist-prod-api-1`). Dokploy may run compose under its own project slug,
so confirm the real prefix first:

```bash
sudo docker ps --filter "name=recruitassist" --format 'table {{.Names}}\t{{.Status}}'
PFX=recruitassist-prod   # adjust to whatever the line above shows

# Migrations (idempotent SQL runner; safe to re-run)
sudo docker exec ${PFX}-api-1 pnpm --filter @j2w/api exec tsx src/db/migrate.ts

# Fresh DB only — create + promote the first super-admin
sudo docker exec ${PFX}-api-1 pnpm --filter @j2w/api db:bootstrap-admin
sudo docker exec ${PFX}-api-1 pnpm --filter @j2w/api db:promote-platform-admin <email>

# Confirm extensions
sudo docker exec ${PFX}-postgres-1 psql -U recruitassist -d recruitassist -c "\dx"
# Expect: vector, pgcrypto, citext, plpgsql
```

`migrate.ts` is a pure SQL-file runner — it does **not** auto-create the bootstrap
user. On a fresh DB the only path to the first user is `db:bootstrap-admin`
([createBootstrap.ts](../apps/api/src/db/createBootstrap.ts)); public signup is
closed (`POST /api/auth/signup` → 410).

## Verify

```bash
curl -fsS https://recruitassist.joulestowatts.online/health
echo | openssl s_client -connect recruitassist.joulestowatts.online:443 \
       -servername recruitassist.joulestowatts.online 2>/dev/null \
       | openssl x509 -noout -issuer -dates       # issuer: Let's Encrypt, ~90d

# Traefik discovered our routers
sudo docker exec dokploy-traefik wget -qO- http://localhost:8080/api/http/routers \
  | python3 -c 'import json,sys;[print(r["name"],r.get("status")) for r in json.load(sys.stdin) if "recruitassist" in r["name"]]'
```

## Redeploy

This Dokploy is SSH-tunnel-only, so there's **no push-to-`main` autodeploy** by
default (Dokploy repo-polling can be enabled in the service settings if wanted).
To ship a change: push to `main`, open the tunnel, and in the Dokploy UI click
**Deployments → Redeploy**. Named volumes survive —
`recruitassist-prod_{pgdata,redisdata,blobs,audio_dumps}`. Re-run migrations
(above) after a schema-changing release.

## Common operations

```bash
# Logs (or use the Dokploy UI → service → Logs)
sudo docker logs -f ${PFX}-api-1
sudo docker logs -f ${PFX}-worker-1

# Psql
sudo docker exec -it ${PFX}-postgres-1 psql -U recruitassist -d recruitassist

# Backup
sudo docker exec -t ${PFX}-postgres-1 \
  pg_dump -U recruitassist -d recruitassist --format=custom > backup-$(date +%F).dump
```

## Volumes (persistent data)

- `pgdata` — Postgres data
- `redisdata` — Redis AOF + RDB
- `blobs` — `/app/var/blobs` in api + worker
- `audio_dumps` — `/var/audio-dumps` (recorded WAVs, `DUMP_DIR`)

Weekly EBS snapshots are the cognition team's responsibility; per-app `pg_dump`
to off-host storage is ours.

## Gotchas

- **`dokploy-network` is `external: true`.** If Compose ever recreates it as a
  fresh network, Traefik can't see the containers → 404s through the proxy.
- **`COMPOSE_PROJECT_NAME` collisions silently corrupt data** via shared volume
  names. Taken on this host: `app` (cognition). We use `recruitassist-prod`.
- **Web rule is `Host(...)` only** and would catch `/api` and `/ws` — that's why
  the api and ws routers carry explicit `priority=20` / `priority=30`. Don't drop them.
- **SSE:** the api router attaches a Traefik `buffering` middleware (max/mem
  ResponseBodyBytes=0) and the API emits `X-Accel-Buffering: no` on
  `/api/kb/sources/:id/events`. Both keep the ingest heartbeat streaming.
- **Build context is `..`** (the repo root from `deploy/`'s perspective). Compose
  v2 resolves `context:` relative to the **compose file's directory**, so the file
  in `deploy/` must use `context: ..` and `dockerfile: deploy/Dockerfile.api`.
  Same rule lets the `./pg-init.sql` bind mount resolve to `deploy/pg-init.sql`.
- **WebSocket test over curl 404s** if curl negotiated HTTP/2 — re-test with
  `curl --http1.1` or a real WS client (`wscat`).
- **Build args vs runtime env:** the web bundle bakes `VITE_API_BASE_URL` /
  `VITE_WS_BASE_URL` at build time (passed as build args, derived from `APP_HOST`).
  Changing the hostname requires a rebuild, not just an env change.
