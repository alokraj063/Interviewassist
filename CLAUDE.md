# RecruitAssist

pnpm monorepo. AI-native applicant tracking system and recruiter productivity
platform for staffing firms and in-house TA teams. Hinglish (Hindi + English)
is the primary voice/UX language for candidate-facing flows; recruiter UI is
in English.

**Forked from `j2w-contact-flow` on 2026-04-29.** The contact-center foundation
(multi-tenant auth, KB with pgvector, Vapi voice agents, live-assist
transcription pipeline, BullMQ workers, per-tenant credential resolver) is
preserved and rewired around the recruiter domain. Internal workspace package
names remain `@j2w/*` for migration cost reasons; public-facing branding
(domain, UI, emails, deploy stack) is RecruitAssist.

The wedge feature is **recruiter live-assist during candidate phone calls**:
the recruiter holds a personal cell phone on speakerphone with the candidate
audible through the speaker, and the laptop browser captures a single mixed
audio stream over `/ws/ingest-call`. Live diarization on a mixed mono source
is unreliable, so the live UI does not show speaker labels by default; a
post-call diarization worker retroactively labels turns where confidence is
high.

## Layout

- [apps/web](apps/web) — Vite SPA, shadcn/ui, Tailwind, React Query, React Router
- [apps/api](apps/api) — Fastify (HTTP + WebSocket + SSE) on :8787
- [apps/worker](apps/worker) — BullMQ worker (`kb-ingest`, `acoustic-sentiment`, plus recruiter-call post-processing queues added in the wedge phase)
- [apps/desktop](apps/desktop) — Electron audio companion (client-distributed, not deployed; `desktop_dual_channel` capture path is a future-state mode for recruiters with softphones)
- [packages/db](packages/db), [packages/ingest-shared](packages/ingest-shared), [packages/shared-types](packages/shared-types) — workspace libs that export TypeScript source directly (no build step)
- [deploy/](deploy/) — production single-VM stack (see below)

Runtime deps: Postgres with **pgvector** (1536-dim, OpenAI `text-embedding-3-small`) and Redis (BullMQ).

## Dev quick-start

```bash
pnpm install
docker compose --env-file .env up -d       # postgres (pgvector) + redis
# First boot: create the recruitassist DB + extensions inside the container
docker exec recruitassist-postgres psql -U recruitassist -d recruitassist \
  -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext"
cp .env.example .env                       # edit BOOTSTRAP_ADMIN_* + add real provider keys as needed
pnpm db:migrate                            # applies all 12 migrations
pnpm db:seed                               # idempotent — 72 users, 30 demands, 50 candidates, 100 prospects, 25 submissions
pnpm dev                                   # web (8080) + api (8787) + worker in parallel
```

**Local ports default to 5433/6380** (Postgres / Redis), not the usual 5432/6379. This is so RecruitAssist can run side-by-side with the legacy `j2w-contact-flow` containers (which still use 5432/6379) on a single dev machine. If you don't have the legacy stack, you can flip `POSTGRES_PORT=5432` / `REDIS_PORT=6379` in `.env` and shorten `DATABASE_URL` / `REDIS_URL` accordingly. The dedicated containers are named `recruitassist-postgres` and `recruitassist-redis`.

Sign in as any seeded user with password `Recruiter#2026`. Useful personas:

- `admin@recruitassist.local` — full perms, every nav entry visible
- `recruiter1@recruitassist.local` — typical recruiter, has 3+ assigned demands
- `am1@recruitassist.local` — account manager, can create/assign demands
- `dl1@recruitassist.local` — delivery lead, sees their team's pipeline
- `qa1@recruitassist.local` — QA reviewer, sees the review queue

The seed script is **destructive** — it `TRUNCATE … CASCADE`s every ATS-domain
table (clients/demands/candidates/prospects/submissions/rubrics/question_banks/
taxonomy) and re-inserts. Auth tables (organizations / users with non-seeded
emails / role_permissions) survive. Run it any time to reset to a known good
state. Seed users are anything with `@recruitassist.local` or
`@example-gcc.local`; leave platform admins alone if you have any.

## Domain model — recruiter ATS

Core tables (see [packages/db/src/schema.ts](packages/db/src/schema.ts) and the `0010_recruitassist_foundation.sql` migration):

- **`clients`** — buyer of recruiting services (a GCC client of J2W)
- **`demands`** — a specific role to fill at a client (maps to J2W Offer Letter's `job_postings`)
- **`demand_assignments`** — recruiters sourcing for a demand (multi-recruiter normal)
- **`candidates`** — a person we might submit; org-scoped uniqueness with email/phone dedup
- **`prospects`** — pre-submission workspace: a candidate the recruiter is evaluating but hasn't pushed yet (this is the missing-piece concept; J2W's existing system has no analog)
- **`submissions`** — pipeline row created when a recruiter promotes a prospect (maps to `applied_jobs`)
- **`submission_stage_transitions`** — full audit trail of stage changes
- **`interviews`**, **`selections`**, **`offers`** — downstream stages
- **`call_sessions`** + **`transcript_turns`** + **`prospect_calls`** — recorded recruiter-candidate calls
- **`call_rubrics`** + **`call_qa_reviews`** — scoring + reviewer queue (rubrics replace the old contact-center scorecards concept)
- **`jd_match_runs`** — JD-vs-candidate match scores with explainable evidence (engine impl deferred)
- **`question_banks`** — curated technical questions tagged by skill/level (used by live-assist suggestion engine and post-call technical Q&A extraction)

Recruiter role taxonomy: `recruiter`, `delivery_lead`, `account_manager`, `business_head`, `qa_reviewer`, `admin`, `client_user` (placeholder), `proctor` (placeholder). `memberships.reporting_to_user_id` walks the org chart up to 4 levels.

**Submission stage transitions:** the canonical state machine is the
`STAGE_METADATA` map in [packages/db/src/schema.ts](packages/db/src/schema.ts)
— it carries `{isTerminal, requiresReason, progressOrder, bucket,
mapsToOfferLetterStep}` per stage. The DB CHECK constraint on
`submissions.current_stage` only enforces "value is in the universe"; it
does NOT enforce transition validity. The transition validator
([apps/api/src/routes/prospects.ts](apps/api/src/routes/prospects.ts) →
`validateStageTransition`) consults `STAGE_METADATA` instead. When adding
or renaming a stage, update both the SQL CHECK and the TS map together —
they don't auto-stay-in-sync.

## Live-assist data flow (the wedge)

Three WS endpoints exist and they do **different** things — easy to confuse:

- **`/ws/ingest-call`** ([ws/ingest-call.ts](apps/api/src/ws/ingest-call.ts)) — the recruiter wedge. Browser sends mixed-mono PCM16 16kHz frames; server runs them through a single Deepgram session ([deepgram/single-stream.ts](apps/api/src/deepgram/single-stream.ts)) with `diarize=false`; persisted turns get `speaker='unknown'`; transcripts broadcast on `/ws/session`; suggestions fire on every final.
- **`/ws/ingest`** ([ws/ingest.ts](apps/api/src/ws/ingest.ts)) — the legacy desktop_dual_channel path. Frame format is byte-tagged stereo (channel 0 = recruiter, channel 1 = candidate), routed to two parallel Deepgram sessions ([deepgram/stream.ts](apps/api/src/deepgram/stream.ts)). Used by [apps/desktop](apps/desktop). Speaker label is definitive.
- **`/ws/custom-transcriber`** ([ws/custom-transcriber.ts](apps/api/src/ws/custom-transcriber.ts)) — Vapi-facing. Vapi opens this when the autonomous voice screener uses a non-Deepgram transcriber (Sarvam/Shunya). Bridge relays to the upstream vendor and writes `transcriber-response` JSON back to Vapi.

Two parallel React hooks drive these:

- **`useWedgeCall`** ([apps/web/src/hooks/useWedgeCall.ts](apps/web/src/hooks/useWedgeCall.ts)) — the wedge. `getUserMedia` → AudioContext → ScriptProcessorNode → downsample to 16kHz → send raw PCM over `/ws/ingest-call`. Drives `LiveAssistSetup`.
- **`useLiveCall`** ([apps/web/src/hooks/useLiveCall.ts](apps/web/src/hooks/useLiveCall.ts)) — the legacy Vapi-mediated test-call UI (preserved at `/live-assist/legacy`). Uses `@vapi-ai/web` SDK; audio never touches our API.

`/live-assist` now mounts `LiveAssistSetup` (the wedge entry). Anyone touching live-assist code should be clear which hook they're in.

The **recruiter Live Call surface** is `/live-call/:callId` ([apps/web/src/pages/LiveAssist.tsx](apps/web/src/pages/LiveAssist.tsx) — same file, but rebuilt as the recruiter UI: candidate+demand context replaces the CRM context card, the compliance card is relabeled "Discovery checklist", and the suggestion engine ([apps/api/src/rag/suggest.ts](apps/api/src/rag/suggest.ts)) injects demand+candidate context per call). When a `?callId=` is present the demo seed is suppressed and the page subscribes to the real `/ws/session`. The legacy contact-center demo lives at `/live-assist/legacy`.

**Post-call worker chain** — kicks off when `POST /api/calls/:id/end` fires (and `/ws/ingest-call` close also enqueues acoustic-sentiment with the recording's relative path):

```
recording-finalize? → post-diarize → rubric-finalize → QA queue row
                                  ↘ acoustic-sentiment (parallel)
call-summary runs in-process (rag/summary.ts) — not a worker yet
```

Each step no-ops gracefully when its dependency is missing (no recording, no rubric, no `OPENAI_API_KEY`). All four post-call workers are wired in [apps/worker/src/jobs/](apps/worker/src/jobs/).

## Production deploy — Dokploy on the J2W shared AWS host

Serves **https://recruitassist.joulestowatts.online**.

RecruitAssist runs as one app on the J2W shared **AWS EC2** Dokploy host
(`m5.large`, `ap-south-1`, Elastic IP `13.127.19.121`) behind the host's
Dokploy v0.29.4 + Traefik stack. App #1 on the box is `cognition`
(`cognition.j2wofferletter.com`). The compose at
[deploy/docker-compose.dokploy.yml](deploy/docker-compose.dokploy.yml) is a
self-contained stack (postgres+redis+api+worker+web) that joins the host's
external `dokploy-network` for TLS + routing. Full host-level runbook (SSH,
capacity, TLS/CAA caveats): [docs/dokploy-on-this-server.md](docs/dokploy-on-this-server.md);
app-specific steps: [deploy/README.md](deploy/README.md).

| Field | Value |
|---|---|
| Host | AWS EC2 `m5.large`, `ap-south-1`, IP `13.127.19.121` |
| Dokploy project / slug | `recruitassist` / `recruitassist` (`cognition` + project `app` are taken) |
| `COMPOSE_PROJECT_NAME` | `recruitassist-prod` |
| Compose path in repo | `deploy/docker-compose.dokploy.yml` |
| Git source | `git@github.com:danielj2w/recruit-assist-ai.git`, branch `main`, SSH deploy key |
| Container name pattern | `recruitassist-prod-{api,web,worker,postgres,redis}-1` |

DNS: `recruitassist.joulestowatts.online` A-record → `13.127.19.121`. That apex
has no blocking CAA, so Traefik auto-issues the Let's Encrypt cert (unlike
`*.j2wofferletter.com`, whose CAA forbids LE).

### Redeploying

This Dokploy is SSH-tunnel-only, so there is **no push-to-`main` autodeploy**
by default (repo-polling can be enabled in the service settings if wanted). To
ship: push to `main`, open the tunnel, and in the Dokploy UI click
**Deployments → Redeploy**.

```bash
# Open the SSH tunnel to the Dokploy UI (key held by the cognition team)
ssh -i j2w-cognition.pem -L 3000:localhost:3000 ec2-user@13.127.19.121
# → browse http://localhost:3000 → service → Deployments → Redeploy
```

Env-var changes are made in the Dokploy UI → service → Environment tab, then
redeploy.

### Post-deploy commands (Dokploy Terminal tab, or SSH to the host)

After a fresh deploy or schema-changing release. Confirm the real container
prefix first — Dokploy may run compose under its own slug:

```bash
ssh -i j2w-cognition.pem ec2-user@13.127.19.121
sudo docker ps --filter "name=recruitassist" --format 'table {{.Names}}\t{{.Status}}'
PFX=recruitassist-prod   # adjust to whatever the line above shows

# Migrations (idempotent SQL runner; safe to re-run)
sudo docker exec ${PFX}-api-1 pnpm --filter @j2w/api exec tsx src/db/migrate.ts

# Fresh DB only — create + promote the first super-admin
sudo docker exec ${PFX}-api-1 pnpm --filter @j2w/api db:bootstrap-admin
sudo docker exec ${PFX}-api-1 pnpm --filter @j2w/api db:promote-platform-admin <email>

# Confirm Postgres extensions
sudo docker exec ${PFX}-postgres-1 psql -U recruitassist -d recruitassist -c "\dx"
# Expect: vector, pgcrypto, citext, plpgsql
```

**Why a separate `db:bootstrap-admin` script?** [migrate.ts](apps/api/src/db/migrate.ts)
is a pure SQL-file runner — it does NOT auto-create a bootstrap user from
`BOOTSTRAP_ADMIN_EMAIL`/`PASSWORD` env vars (despite older comments in this
file suggesting it does). Public signup is also closed (`POST /api/auth/signup`
→ 410). So on a fresh DB the only path to land the first user is
[createBootstrap.ts](apps/api/src/db/createBootstrap.ts).

### Dokploy operational gotchas

- **Container prefix may not match `name:`.** Our compose declares
  `name: ${COMPOSE_PROJECT_NAME}` (= `recruitassist-prod`), but Dokploy runs
  `docker compose -p <slug>` and may override it. Always look up the actual
  prefix via `sudo docker ps --filter "name=recruitassist"` before exec'ing.
- **Build context is `..` not `.`** in [deploy/docker-compose.dokploy.yml](deploy/docker-compose.dokploy.yml).
  Compose v2 resolves `context:` relative to the **compose file's directory**,
  not the directory where `docker compose` was launched. `context: .` would
  resolve to `deploy/` and `dockerfile: deploy/Dockerfile.api` would become
  `deploy/deploy/Dockerfile.api` (broken).
- **GitHub auth is via SSH deploy key**, not the Dokploy GitHub App. The App
  flow requires Dokploy to be reachable on a public URL for the OAuth
  callback + webhook; ours is SSH-tunneled to localhost only. Generic Git
  provider + SSH key avoids that.
- **Secrets live only in Dokploy's encrypted env store**, not in repo.
  `INTEGRATIONS_KEK`, `JWT_SECRET`, `POSTGRES_PASSWORD`, `BOOTSTRAP_ADMIN_*`,
  `OFFER_LETTER_MYSQL_PASSWORD`, and any provider API keys are pasted into
  Dokploy UI → service → Environment. The `BOOTSTRAP_ADMIN_*` pair is needed
  by `db:bootstrap-admin` at first deploy and can be removed afterwards
  (the user record persists; the env vars are no longer consulted).
- **`COMPOSE_PROJECT_NAME` collisions on the shared host corrupt volumes
  silently.** Taken on this host: `app` (cognition). We use `recruitassist-prod`.
- **Postgres tuning is reduced for the shared host.** `shared_buffers=256MB`.
  Don't raise without checking host RAM — the box is `m5.large` (8 GB) with
  ~5 GB free across apps.
- **SSE buffering** is disabled on the api router via a Traefik `buffering`
  middleware in the compose, belt-and-braces with the API's `X-Accel-Buffering: no`
  header on `/api/kb/sources/:id/events`. Don't strip either.

### Migrating between hosts

The compose is host-agnostic (parameterized by `COMPOSE_PROJECT_NAME` /
`APP_SLUG` / `APP_HOST` + external `dokploy-network`), so moving to another
Dokploy host is DNS + a fresh Dokploy app + env paste. **Carry over data with
`pg_dump`/restore and reuse the same `INTEGRATIONS_KEK`** — a new host starts
with an empty Postgres volume, and a mismatched KEK makes every tenant's stored
integration credentials unrecoverable.

## Gotchas

- **Always tar with `COPYFILE_DISABLE=1` on macOS.** Without it, tar adds `._*` AppleDouble sidecars that get baked into the image and confuse directory iteration (the DB migration runner tried to apply `._0000_init.sql` and crashed). This is why it's in the upgrade command.
- **`apps/api` start script uses deprecated `node --loader tsx`** which errors on Node 20.6+. The docker-compose command is overridden to run `tsx src/index.ts` directly — same approach as the worker. If you fix the repo script, drop the compose override.
- **Workspace packages (`@j2w/db`, `@j2w/ingest-shared`, `@j2w/shared-types`) export `.ts` source directly.** Api + worker resolve them via `tsx` at runtime — don't strip source or run with plain node.
- **`getWsBase()` in [apps/web/src/lib/api.ts](apps/web/src/lib/api.ts) calls `new URL(API_BASE)` which throws on empty string.** When building the web image, always pass absolute `VITE_API_BASE_URL` and `VITE_WS_BASE_URL` as build args (the deploy Dockerfile does this).
- **SSE on `/api/kb/sources/*/ingest` must not be proxy-buffered** or the 15s heartbeat batches up. The API emits `X-Accel-Buffering: no`, and the prod compose ([deploy/docker-compose.dokploy.yml](deploy/docker-compose.dokploy.yml)) also attaches a Traefik `buffering` middleware (max/mem `ResponseBodyBytes=0`) to the api router. Keep both.
- **Postgres needs the `vector` extension before migrations run.** [deploy/pg-init.sql](deploy/pg-init.sql) creates it; compose's `depends_on: postgres: condition: service_healthy` enforces ordering.
- **`apps/desktop` is Electron and client-distributed** — not deployed, but its `package.json` must be present for pnpm workspace resolution when building api/web images.
- **`CUSTOM_TRANSCRIBER_PUBLIC_URL` must be set in prod** to `wss://recruitassist.joulestowatts.online` (or whatever the public hostname is). It's the URL Vapi dials when a non-Deepgram STT provider is selected. In dev it can be blank — the live-assist route falls back to `API_PUBLIC_URL` upgraded to `wss://`. If it points at `localhost` in prod, Vapi Cloud can't reach the bridge and Sarvam/Shunya test calls hang silently.
- **Public signup is disabled.** `POST /api/auth/signup` returns 410. Tenants are provisioned by a platform admin via `POST /api/platform/orgs`, which sends the first admin a normal `/accept-invite` email. Bootstrapping the first super-admin: invite/sign up the user via the legacy flow, then `pnpm --filter @j2w/api db:promote-platform-admin <email>`.
- **`INTEGRATIONS_KEK` must be set in prod and backed up.** 32-byte base64 master key (`node -e "console.log(crypto.randomBytes(32).toString('base64'))"`) used for AES-256-GCM at-rest encryption of `tenant_integrations.ciphertext`. Lose it and every tenant's stored credentials are unrecoverable. Without it the resolver falls back to env vars (single-tenant behavior) — fine for dev, broken for true multi-tenant.
- **Any new Vapi callsite must run inside `withVapiContext`.** [apps/api/src/vapi/client.ts](apps/api/src/vapi/client.ts) reads `apiKey` from an `AsyncLocalStorage` ([context.ts](apps/api/src/vapi/context.ts)); outside a context it falls back to `env.VAPI_API_KEY`. New routes that call Vapi must `getProviderCredentials(orgId, "vapi")` first and wrap the work in `withVapiContext({ apiKey, publicKey, webhookSecret, orgId }, () => ...)`. Same applies to webhook-secret-aware code in [transform.ts](apps/api/src/vapi/transform.ts).
- **Vapi `serverUrl` is tagged with `?orgId=`** in [transform.ts](apps/api/src/vapi/transform.ts). The inbound webhook handler reads it back to look up the right tenant's `webhookSecret` for HMAC verification. Don't strip the query param when adjusting the URL pattern.
- **Browser-mic ingest is mixed-mono, not stereo.** The recruiter wedge captures a single mixed audio stream over `/ws/ingest-call` (new, not the same as `/ws/ingest` which is for KB ingest progress events). `transcript_turns.speaker` defaults to `unknown` for browser_mixed mode; the `post_diarize` worker retroactively flips to `recruiter`/`candidate` where Deepgram's diarization confidence is high. Live UI must not show speaker labels by default — over-claiming on speaker attribution from a mixed source erodes trust.
- **Echo cancellation must be OFF in `getUserMedia`** for the browser-mic path. The candidate's voice reaches the laptop mic via the recruiter's phone speaker; standard echo cancellation would suppress it. Use `{ echoCancellation: false, noiseSuppression: true, autoGainControl: true }`.
- **`call_sessions.recording_url` is a relative path under `DUMP_DIR`** (e.g. `2026-04-29/<callId>-recruiter.wav`), not a `file://` URI. Resolved at read time by `GET /api/calls/:id/recording` ([calls.ts](apps/api/src/routes/calls.ts)) — auth-checked, range-supporting WAV stream with a `path.startsWith(dumpDir)` traversal guard. The Call Detail audio player calls this endpoint with the access token in the `?token=` query (since `<audio>` can't set headers). Migration `0011` rewrites legacy `file://` rows. Future GCS migration just adds a branch in the playback endpoint that returns a signed URL.
- **`app.authenticate` accepts `?token=<jwt>`** as a fallback when the `Authorization` header is absent — needed for `<audio>` / `<img>` / direct-link contexts. The fallback runs in [server.ts](apps/api/src/server.ts) before `request.jwtVerify()`. Don't strip query params in proxies for endpoints that rely on this.
- **BullMQ rejects `:` in `jobId` and `repeat.key`.** Error is `Custom Id cannot contain :`. Use `-` as the separator in repeat keys and explicit job IDs (`demand-sync-${orgId}` not `demand-sync:${orgId}`). Several pre-existing `acoustic:${callId}` jobIds in the codebase will trip this when their code paths actually fire — fix when you touch them.
- **`qaReviews` in `@j2w/db` is a backwards-compat re-export** of `callQaReviews`. The 0010 migration renamed the table; the alias is there so any straggler imports keep building. A `rg "\\bqaReviews\\b" apps/api/src` should return zero hits — drop the alias once we're confident.
- **Three call-related FK columns on `call_sessions` are nullable on purpose** (`demand_id`, `prospect_id`, `candidate_id`). A recruiter can dial a candidate without first creating a prospect (manual outbound), or a Vapi screener call may pre-date a candidate row. Don't tighten to NOT NULL without auditing the create paths.
- **Submission stage transition `requiresReason` is enforced application-side, not by Postgres.** The TS-side `STAGE_METADATA` map is the source of truth (see "Domain model" above). DB CHECK only validates the value is in the universe of legal stages. New stages need both updates.
- **Workspace package scope stays `@j2w/*` even though product brand is RecruitAssist.** Renaming would touch ~150 import lines + every `pnpm --filter` invocation in deploy scripts. Acceptable for the J2W-internal-first lifecycle. If we externalize the product, plan a coordinated rename PR (deploy compose commands, Dockerfile cmds, docs all need updating in lockstep).
- **The seeded `BOOTSTRAP_ADMIN_*` env vars** in `.env.example` are required as non-empty even when you don't want a bootstrap admin — Zod's `.optional()` rejects empty strings. Either fill them or delete the lines from `.env`.

## Voice stack direction

Primary candidate-facing language is Hinglish — default to providers with proven code-mix
support: **Deepgram Nova-3 `multi`**, **Sarvam**, **ElevenLabs**, **Vapi**.
Don't build telephony logic in the React app; that's the API + provider
side. Account for Hindi/English mixing in any candidate-facing copy or prompt.
Recruiter UI copy is in English (recruiters are bilingual professionals on
desktops; candidates speak Hinglish on calls).

## Transcription (STT) providers — Live Assist

Three providers selectable per call:

- **Deepgram** — for browser-mic mixed-mono ingest (`/ws/ingest-call`) AND for native Vapi integration (`transcriber: { provider: "deepgram", model: "nova-3", language: "multi" }`). Lowest-latency path.
- **Sarvam** and **Shunya** — wired through Vapi's `custom-transcriber` provider for autonomous voice screener calls. Vapi opens a WebSocket to our API at [`/ws/custom-transcriber`](apps/api/src/ws/custom-transcriber.ts); the bridge opens the upstream vendor WS, relays PCM16 frames, and sends transcripts back to Vapi as `transcriber-response` JSON while also broadcasting them to `/ws/session` so the Live Assist UI renders identically across providers.

Key locations:
- Provider catalog + localStorage shape: [apps/web/src/lib/transcriptionConfig.ts](apps/web/src/lib/transcriptionConfig.ts) (key `liveAssist.transcriptionSettings.v1`)
- Quick switcher in the CallBar (`STT · <provider>` dropdown) + full page at `/settings/transcription`
- Backend picks the `transcriber` block per request in [apps/api/src/routes/live-assist.ts](apps/api/src/routes/live-assist.ts) based on the POST body from [apps/web/src/hooks/useLiveCall.ts](apps/web/src/hooks/useLiveCall.ts)
- Provider bridges: [apps/api/src/transcription/sarvam.ts](apps/api/src/transcription/sarvam.ts), [apps/api/src/transcription/shunya.ts](apps/api/src/transcription/shunya.ts) (both implement `TranscriptionBridge` from [provider.ts](apps/api/src/transcription/provider.ts))

Env vars: `SARVAM_API_SUBSCRIPTION_KEY`, `SHUNYA_API_KEY`, `CUSTOM_TRANSCRIBER_PUBLIC_URL`, optional `CUSTOM_TRANSCRIBER_SECRET`. These are the **fallback** values; per-tenant overrides live in `tenant_integrations` and take precedence (see Multi-tenancy below). The live-assist route 503s with `{error:"sarvam_api_key_missing"}` (etc.) if neither a tenant row nor the env var is set for the caller's org.

To add a fourth provider: implement `TranscriptionBridge` in a new file under [apps/api/src/transcription/](apps/api/src/transcription/), add a `createBridge` branch in [custom-transcriber.ts](apps/api/src/ws/custom-transcriber.ts), and extend the `TranscriptionProvider` union in [transcriptionConfig.ts](apps/web/src/lib/transcriptionConfig.ts).

## Multi-tenancy — per-tenant credentials & platform admin

The deployment is multi-tenant: one Postgres serves many orgs (J2W is the first; external customers come later), each with its own Vapi/Deepgram/Sarvam/Shunya credentials. **Public signup is closed**; tenants are provisioned by platform admins (super-admins) via `POST /api/platform/orgs`, which emails the first admin a normal invitation.

Design rules:
- One email = one tenant. A user belongs to exactly one org. There's no tenant switcher and no multi-membership.
- Platform admins (`users.is_platform_admin = true`) have *no* membership. `loadAuthUser` returns a sentinel `AuthUser` with `orgId = PLATFORM_ORG_ID` so any tenant-scoped query they leak into returns nothing. Real access goes through `app.requirePlatformAdmin` on `/api/platform/*`.
- Tenant credentials are stored encrypted in `tenant_integrations` (AES-256-GCM keyed by `INTEGRATIONS_KEK`). The resolver order is: tenant row → env fallback → 503. Env fallback exists so single-tenant dev keeps working without per-tenant rows.

Key locations:
- Schema: [`tenant_integrations`](apps/api/src/db/migrations/0009_platform_admin_and_integrations.sql), `users.is_platform_admin`. Drizzle mirror in [packages/db/src/schema.ts](packages/db/src/schema.ts).
- Encryption + provider secret types: [apps/api/src/integrations/encryption.ts](apps/api/src/integrations/encryption.ts).
- Resolver (use this for any new tenant-scoped credential read): [apps/api/src/integrations/resolver.ts](apps/api/src/integrations/resolver.ts) (`getProviderCredentials(orgId, provider)`).
- Platform routes: [apps/api/src/routes/platform.ts](apps/api/src/routes/platform.ts) — list/create/inspect tenants, set/rotate/disable integration credentials.
- Bootstrap script: `pnpm --filter @j2w/api db:promote-platform-admin <email>` ([promotePlatformAdmin.ts](apps/api/src/db/promotePlatformAdmin.ts)). The user must already exist in `users`.
- Frontend split: tenant users see [AppShell](apps/web/src/layouts/AppShell.tsx); platform admins see [PlatformShell](apps/web/src/layouts/PlatformShell.tsx). `RequirePlatformAdmin` and `RedirectPlatformAdmin` in [AuthContext.tsx](apps/web/src/auth/AuthContext.tsx) gate the routes.

To add a fifth integration provider:
1. Add the provider key to the `provider` CHECK in a new migration *and* to `TENANT_INTEGRATION_PROVIDERS` in [packages/db/src/schema.ts](packages/db/src/schema.ts).
2. Add a typed secret shape + `envFallback` branch in [encryption.ts](apps/api/src/integrations/encryption.ts) and [resolver.ts](apps/api/src/integrations/resolver.ts).
3. Add a body-validation branch + `buildSecret` case in [routes/platform.ts](apps/api/src/routes/platform.ts).
4. Update the per-provider editor in [TenantDetail.tsx](apps/web/src/pages/platform/TenantDetail.tsx).
5. At the consumer (the route or worker that calls the provider): `getProviderCredentials(orgId, "<provider>")` → 503 on null → use the returned secret. For Vapi-flavored consumers, prefer wrapping the call site in `withVapiContext` instead of threading apiKey through every function.

## Offer Letter MySQL integration

The recruiter ATS sources demands, recruiter assignments, candidate dedup
pool, and downstream funnel state from the J2W Offer Letter production
MySQL DB (`offerletter`, `mis_operations` user, read-only, RDS in
`ap-south-1`). Full reference: **[docs/offer-letter-db.md](docs/offer-letter-db.md)** — schema map,
join rules, role hierarchy, lifecycle queries, and operational caveats.

All MySQL access goes through the **`@j2w/offer-letter-db`** workspace
package — never import `mysql2` directly elsewhere. The package enforces a
read-only guard regex, prepared statements, and the standard exclusion
filters (`clients.id NOT IN (1,2)`, `users.id <> 887485`).

Connection is env-based, not per-tenant (one external system shared
across all J2W deployments): `OFFER_LETTER_MYSQL_HOST`, `_PORT`, `_USER`,
`_PASSWORD`, `_DATABASE`, `_TLS`. Routes that depend on it return 503
`{error:"offer_letter_not_configured"}` when unset.

Sync architecture is **hybrid**: small-and-bounded tables (clients,
demands, demand_assignments, taxonomies) sync periodically into Postgres
for snappy UI; candidates resolve lazily on dedup-check (mirroring
matched MySQL rows into our `candidates` table with
`external_offer_letter_user_id` populated); active submissions are polled
every 2 minutes for funnel updates. See `apps/worker/src/jobs/offerLetter*.ts`.

**`job_assignments` is the assignment list, not noise.** Per
[docs/demand-recruiter-attribution.md](docs/demand-recruiter-attribution.md),
the table covers 93% of open demands and 97% of demands < 30 days old;
multi-thousand returns for senior recruiters (Sandipta P,
`sandipta.p@joulestowatts.com`, ~2494 active assignments) are real, not
artifacts. `getDemandsForRecruiter` in
[packages/offer-letter-db/src/queries.ts](packages/offer-letter-db/src/queries.ts)
returns the full list filtered by `jp.status IN (0, 1)`, `u.role_id=3`,
`u.locked=0`, and `clients.id NOT IN (1,2)`. **The reference doc says
only `status=1` (active) counts as open, but the J2W workflow has
recruiters sourcing on draft postings (`status=0`) before client
activation — so we include both.** Closed (2) and on-hold (3) stay
excluded. The recruiter home view (`GET /api/demands?assignedToMe=true`)
sorts by `demand_assignments.active_candidates_count DESC` — populated
each sync run from `applied_jobs` (current_step not in 11 terminal
states, last 365 days) — so the demands the recruiter is actually
working on surface above the long tail of cold assignments. Pass
`?activeOnly=true` to filter to assignments with live pipeline only.
There is no recency cap on the assignment list itself; the status
filter trims closed/on-hold postings naturally.

Submission write-back to MySQL `applied_jobs` is **deferred** pending
INSERT grants from J2W ops. Phase 1 stages submissions locally and
enqueues an `offer_letter_outbox` row; the drain worker is unimplemented
until grants land.

**Critical gotchas at a glance** (full list in the reference doc):
1. `clients.user_id` is the FK to the client admin user, not a back-ref.
   Right join: `clients.user_id = job_postings.client_id`.
2. `validation_screens` has no `user_id` — recover the recruiter via
   `applied_jobs` 1:1 join on `(job_posting_id, user_id=applied_candidate_id)`.
3. `applied_jobs.current_step` is `varchar(255)` — always quote.
4. Standard exclusions: `clients.id NOT IN (1,2)` and `users.id <> 887485`.

## Build state — what's wired vs. deferred

[BUILD_REPORT.md](BUILD_REPORT.md) at the repo root has the canonical
status of which phases of the RecruitAssist transformation are done,
what's deliberately stubbed, and the priority queue for the next plan.
Read it before assuming a feature works end-to-end.

Quick orientation for what's NOT yet wired (to spare a future session
chasing it):

- **Post-call worker handlers** for `post_diarize`, `call_summary`, `rubric_finalize`, `prospect_outcome_extract`, `technical_qa_extract`, `jd_match_update`, `resume_parse` — queue names referenced in code; handler files (`apps/worker/src/jobs/*.ts`) don't exist yet. The Call Detail "Summary" tab spins indefinitely until `call_summary` lands. Acoustic-sentiment IS wired (existing queue).
- **Live rubric scoring** (every-5s LLM tick on `/ws/session`) — the Live Assist right-panel "Rubric live" tab and Call Detail Rubric tab render the rubric structure with placeholder bars. Real LLM tick is Phase 2.
- **Suggestion engine corpus filter** — schema added (`chunks.corpus`) but `apps/api/src/rag/suggest.ts` doesn't yet filter by `corpus IN ('jd', 'company')` or pull from the `question_bank` corpus.
- **JD-match engine** — schema (`jd_match_runs`) is in; engine implementation deferred. `GET /api/candidates/:id/jd-matches` returns `{matches: [], status: "engine_not_implemented"}`. Call Detail "JD-Match" tab renders structured placeholders with "Engine pending" badges.
- **Resume parser worker** — `POST /api/candidates/:id/parse-resume` returns 202 + jobId but no worker consumes the job.
- **Sourcing connectors** — Naukri / LinkedIn / WhatsApp / Exotel are visual-only on `/sourcing` and Settings → Integrations. Internal DB tab on `/sourcing/internal-db` is real (queries `/api/candidates`).
- **Offer Letter MySQL adapter** — see the dedicated "Offer Letter MySQL integration" section above. Read-only sync + dedup + funnel poll are wired through `@j2w/offer-letter-db`; submission write-back is deferred pending INSERT grants. The new admin UI at `/admin/offer-letter-sync` reads `offer_letter_sync_heartbeats` and the `external_offer_letter_*_id` columns; manual-trigger buttons enqueue into the existing queues.

What IS wired as of Phase 10 (demo IA buildout):

- All 23+ sidebar entries resolve to populated pages (Pipeline / Live Work / Sourcing & Assessment / People & Clients / Config / Admin sections).
- Recruiter Home reads real data from `/api/calls`, `/api/prospects`, `/api/submissions`.
- Live Assist right-panel exposes Question Bank (real API), Rubric Live (placeholder), Coverage checklist, Notes (localStorage), Topics — as a tabbed panel.
- Call Detail has six tabs all rendering content: Replay, Transcript, Summary, Rubric, JD-Match (placeholder), Compliance (placeholder).
- Question Banks at `/question-banks` is a real CRUD surface against existing schema. New `/api/question-banks` endpoint.
- Voice screener templates seeded as four recruiter-flavored personas (General Screen / Technical Screen / Interest Gauge / Notice Period & Comp Check) via `pnpm --filter @j2w/api db:seed-agents`. The HP Anika contact-center scenario was retired.
- Sidebar URL renames: `/agents` → `/recruiters`, `/supervisor-monitor` → `/team-monitor`, `/scorecards` → `/rubrics`. Legacy URLs 301-redirect for one cycle. `/conversations*` was deleted entirely.
- Mock-data layer in `apps/web/src/data/store.ts` overhauled with recruiter content (Indian recruiter personas, J2W-style pod names, Hinglish recruiter-candidate dialog, recruiter rubrics) — kept under existing export names so consumers didn't break.

When picking up a deferred item, update BUILD_REPORT.md to reflect the new state.
