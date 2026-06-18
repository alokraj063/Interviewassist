# RecruitAssist — Build Report

## Phase 12 — Live Assist provider wiring + STT bridge fixes (2026-06-01)

Plan: `/Users/Daniel/.claude/plans/i-d-like-you-to-graceful-dusk.md`

Goal: make live transcription + AI assistance work on `/live-assist` with the
**default (Deepgram)**, **Sarvam**, and **Shunya** providers, verified end-to-end
with real keys. An audit found nothing fundamentally broken, but four issues
blocked it. All fixed and verified live (real speech streamed through
`/ws/ingest-call` for all three providers → transcripts + Hinglish suggestions +
rubric ticks + sentiment all fire):

- **The wedge is no longer Deepgram-only.** The provider switcher now actually
  drives the live recruiter call. Added `call_sessions.transcriber_{provider,
  model,language}` (migration `0026_call_transcriber.sql` + schema mirror);
  `POST /api/calls` accepts a `transcription` block, validates the provider's
  credentials eagerly (503 `<provider>_api_key_missing`), and persists it;
  `useWedgeCall.create()` sends `readTranscriptionSettings()`; `/ws/ingest-call`
  branches on the persisted provider. Sarvam/Shunya run through a new
  `transcription/single-bridge.ts` (reuses the existing bridges, fed the
  browser mic) and the shared `transcription/mixed-turn.ts` so behavior is
  identical to Deepgram single-stream (speaker='unknown', suggestion on every
  final). Deepgram single-stream now honors the selected model/language.
- **Sarvam + Shunya streaming bridges corrected to the live APIs** (they were
  written from docs and never actually worked):
  - Sarvam: `audio` must be an object `{data, sample_rate, encoding}` (not a
    base64 string); results arrive as `{type:"data", data:{transcript}}` (not
    `{type:"transcript", text}`).
  - Shunya: requires a JSON **config** message first (`{api_key, model:
    "zero-indic", language, sample_rate, dtype:"int16", ...}`) before audio;
    end-of-audio is `{type:"end"}`. Result parsing was already correct.
- **`OPENAI_MODEL` was `gpt-5.4-nano`** (an invalid model) with no fallback in
  `suggest.ts` → suggestions and live-rubric ticks would fail even with a valid
  key. Fixed the env default to `gpt-4o-mini` and routed both call sites through
  a new `chatModel()` helper (`env.OPENAI_MODEL || env.OPENAI_MODEL_FALLBACK`).
- **Vapi test-call persona** changed from the legacy "HP Pavilion support
  customer" to a Hinglish **candidate being screened** (`live-assist.ts`); the
  human in the browser is the recruiter.
- Minor: fixed `acoustic:${callId}` → `acoustic-${callId}` jobId (BullMQ rejects
  `:`); added a live-rubric tick to the desktop dual-channel path for parity;
  `closeSingleStream` now clears rubric-tick debounce state.

Notes / follow-ups:
- Stale CLAUDE.md/BUILD_REPORT notes corrected: live-rubric and the suggestion
  corpus filter (`['jd','company']`) are **already implemented**.
- Shunya's zero-indic model renders Hindi in Devanagari (English transliterated)
  when `language=hi`; the bridge maps `multi→hi`. If recruiters prefer Latin
  script, map `multi→en` — a one-line tuning change, left as a product decision.
- The Vapi **screener** path (`/live-assist/legacy` → Sarvam/Shunya) additionally
  needs `CUSTOM_TRANSCRIBER_PUBLIC_URL` (public `wss://`) + `CUSTOM_TRANSCRIBER_SECRET`
  so Vapi Cloud can reach the bridge; the browser-mic wedge needs neither.

## Phase 11 — Autonomous Build Loop (production wire-up)

Plan: `/Users/Daniel/.claude/plans/the-application-currently-has-nifty-pelican.md`
Task ledger: `AUTOLOOP_TASKS.md`

Status: **complete** through tiers 0–5 + a final-polish (tier 6) pass. Approximately 38 commits across six stacked branches:

- `autoloop/t0-infra` — workspace lint, Playwright e2e smoke, workspace typecheck (4 commits)
- `autoloop/t1-workers` — 8 workers/engines: call_summary worker, rubric_finalize verified, prospect_outcome_extract, technical_qa_extract, live rubric tick on `/ws/session`, JD-match v1 (rule-based, 6 dimensions), resume_parse async reparse, KB corpus filter
- `autoloop/t2-mock-to-real` — 6 mock-to-real conversions: Coaching scenarios+runs, ClientPortal, Assessments, AsyncVideo, ProctorCockpit, Triage audit
- `autoloop/t3-partial-to-wired` — 8 PARTIAL→WIRED: Recruiters/RecruiterDetail, TeamMonitor, DemandDetail Insights, Analytics tabs, KB attribution, QAReview, VoiceAgents deployments verified, Rubrics CRUD
- `autoloop/t4-integrations` — generic CRM connector framework + Sourcing connector consumer + Settings → Integrations grid + WhatsApp/SMS messaging stub
- `autoloop/t5-polish` — empty states + global ErrorBoundary
- `autoloop/t6-final-polish` — TakeAssessment + SubmitVideo (candidate-facing public token-gated runtimes), bulk-call campaigns infra for voice agents, Analytics Quality/Coaching/Trends rebuilt with real data, auto-create proctor session on assessment/video start, candidate timeline tab with messaging composer

### What's in the loop's product surface

- 8 new migrations (0018–0025): `call_technical_qa`, `coaching_{scenarios,runs}`, `submission_client_feedback` + `memberships.client_id`, `assessment_{templates,attempts}`, `async_video_{campaigns,submissions}`, `proctor_{sessions,events}`, `messaging_events`, `voice_agent_{campaigns,call_targets}`
- 13 new API route modules: `coaching`, `client-portal`, `assessments` + public, `async-video` + public + upload, `proctor`, `recruiters`, `team-monitor`, `analytics`, `rubrics`, `sourcing`, `messaging`, `voice-agent-campaigns`
- New `apps/api/src/connectors/` framework — `Connector` interface + mock provider that returns deterministic seeded fake candidates for every source key, registry that real provider modules (Naukri/LinkedIn/Greenhouse/Workday/WhatsApp/Exotel) plug into behind credential checks
- `apps/api/src/jd-match/engine.ts` — rule-based engine producing structured strengths/gaps/explanation arrays
- `apps/api/src/rag/live-rubric.ts` — debounced 8s LLM tick on every transcript-final, broadcasts `rubric.tick` on `/ws/session`
- `apps/worker/src/jobs/{callSummary,prospectOutcomeExtract,technicalQaExtract,resumeParse}.ts` — full post-call pipeline
- Two public token-gated candidate runtimes (`/take-assessment/:token`, `/async-video/submit/:token`) with browser MediaRecorder upload, draft persistence, countdown timers, auto-proctor session creation
- ErrorBoundary at the App tree root
- The Citation type now carries `corpus`, surfaced as a JD/COMPANY/Q-bank pill on every chunk-grounded suggestion

### Permission keys to seed in role config

The new gated routes reference (must be added to existing role permissions):
- `coaching.{read.all,write,run}`
- `assessments.{write,invite,review}`
- `async_video.{write,invite,review}`
- `proctor.review`
- `rubrics.write`
- `messaging.send`
- `voice_agents.write` (already exists, used by bulk-call campaigns)

### What's still genuinely external-blocked

These need API keys / external accounts / visual QA — not loop-completable:
- Real provider modules behind the connector framework (Naukri search API, LinkedIn Recruiter, Greenhouse, Workday, WhatsApp Business, Exotel SIP). Each plugs in at `apps/api/src/connectors/registry.ts` once the relevant `tenant_integrations` row is set.
- Bulk-call campaign dialer worker — schema + REST surface in place; the actual scheduled-Vapi-dialer worker activates once VAPI credentials are configured per-tenant.
- T5.5 mobile responsive QA on LiveAssist + CallDetail — needs visual QA on a real device.
- Hinglish copy review on the candidate runtime pages (already Hinglish-flavored, but a native-speaker copy pass adds polish).

---

## Phase 10 — Demo IA Buildout (UI/IA, no backend engines)

Built per the plan at `/Users/Daniel/.claude/plans/i-ve-attached-the-original-recursive-thompson.md` to make every sidebar entry render believable content for a self-contained recruiter demo. Scope deliberately excludes new backend engines (post-call workers, JD-match, live rubric LLM tick, Sarvam TTS, real Naukri/LinkedIn) — those remain Phase 11+ candidates.

### What landed

**Information architecture**
- `/conversations` and `/conversations/:id` retired (legacy contact-flow leftover); 301-redirect from `/conversations` → `/calls` and `/conversations/:id` → `/calls/:id`.
- URL renames: `/agents` → `/recruiters`, `/supervisor-monitor` → `/team-monitor`, `/scorecards` → `/rubrics`. Legacy URLs redirect for one cycle.
- Component-file renames in `apps/web/src/pages/`: `Agents.tsx` → `Recruiters.tsx`, `AgentDetail.tsx` → `RecruiterDetail.tsx`, `SupervisorMonitor.tsx` → `TeamMonitor.tsx`, `Scorecards.tsx` → `Rubrics.tsx`, `ScorecardEditor.tsx` → `RubricEditor.tsx`.
- Sidebar restructured into 6 sections: **Pipeline / Live Work / Sourcing & Assessment / People & Clients / Config / Admin**. Admin section is gated to `role === "admin"` and surfaces Offer Letter Sync.

**New pages (web)**
- `/sourcing/{naukri,linkedin,internal-db}` — tabbed sourcing surface ([apps/web/src/pages/sourcing/Sourcing.tsx](apps/web/src/pages/sourcing/Sourcing.tsx)). Naukri / LinkedIn render mock results with a "Not connected" banner. Internal DB queries the real `/api/candidates` endpoint with extended filter UI.
- `/assessments` and `/assessments/:id` — assessment template library with mock attempts.
- `/async-video` and `/async-video/:id` — async video interview campaigns with mock submissions.
- `/proctor` — multi-tile cockpit for AI-proctored assessments with live flag feed (mock).
- `/client-portal` — collapsible per-demand submission list with feedback modal (placeholder, role-gated to `client_user` and `admin`).
- `/question-banks` and `/question-banks/:id` — full CRUD against existing `question_banks` / `question_bank_questions` tables. Real API.
- `/admin/offer-letter-sync` — admin-only page reading the existing `offer_letter_sync_heartbeats` table and the `external_offer_letter_*_id` columns. Manual-trigger buttons enqueue jobs into the existing BullMQ queues.

**New API routes**
- `/api/question-banks/*` — full CRUD ([apps/api/src/routes/question-banks.ts](apps/api/src/routes/question-banks.ts)).
- `/api/admin/offer-letter-sync/*` — status / heartbeats / mappings / manual triggers ([apps/api/src/routes/admin/offer-letter-sync.ts](apps/api/src/routes/admin/offer-letter-sync.ts)). Read-only against existing tables; no schema changes.

**Page rewrites and content fills**
- `Home.tsx` rewritten as recruiter dashboard: real-data KPIs from `/api/calls`, `/api/prospects`, `/api/submissions`; assigned-demands tile; suggested-next-actions panel auto-derived from prospect `lastContactedAt`; 14-day call volume chart; recent-calls table.
- `LiveAssist.tsx` right-panel: replaced the small Topics + Compliance cards with a tabbed panel containing **Question Bank / Rubric Live / Coverage / Notes / Topics**. Four new components under [apps/web/src/components/live-assist/](apps/web/src/components/live-assist/). Question Bank pulls from real `/api/question-banks`. Notes auto-saves to localStorage keyed by `callId`.
- `CallDetail.tsx`: filled the JD-Match and Compliance tabs with substantive placeholder UI (component-by-component bars with "Engine pending" badges, ✓/✗/— flags with rationales). Summary and Rubric tabs already had loading-state placeholders from prior phases.
- `Analytics.tsx`: added **Pipeline** tab as the new default — funnel chart (Internal review → Client screen → L1/L2/L3 → Offer pending → Onboarded) wired to real `/api/submissions` data, plus disqualification reasons rollup. Tab labels softened: "Voice Agents" → "Voice Screeners".
- `Knowledge.tsx`: added corpus filter pills (All / JD corpus / Company knowledge / Question bank) with client-side filtering keyed off source name patterns; Add-Source dialog has a corpus picker. Schema is in place (`chunks.corpus`); the API will read/write `metadata.corpus` in Phase 2.
- `Settings.tsx`: added **Rubrics** and **Question Banks** subsections that link to the dedicated routes. Removed legacy "Scorecards" section.
- `Recruiters.tsx` / `RecruiterDetail.tsx` / `TeamMonitor.tsx` / `Rubrics.tsx` / `RubricEditor.tsx`: header copy and column labels updated to recruiter context (Recruiter / Pod / Avg rubric / Candidate / etc).

**Voice Screener templates**
- [apps/api/src/db/seedAgents.ts](apps/api/src/db/seedAgents.ts) replaced HP Anika with **four recruiter screener templates** matching brief §7.4: General Screen — Hinglish, Technical Screen — Java, Interest Gauge — Re-engagement, Notice Period & Comp Check. Each has a full system prompt with shared language rules (Hinglish-first, Indian English fallback) and PII rules.
- [apps/web/src/pages/VoiceAgentCreate.tsx](apps/web/src/pages/VoiceAgentCreate.tsx) template picker copy updated to match.

**Mock data layer**
- [apps/web/src/data/store.ts](apps/web/src/data/store.ts) rewritten with recruiter content while preserving export names so existing consumers keep working: AGENTS now hosts Indian recruiter personas, TEAMS uses J2W-style pod names ("GCC Hiring Pod 1", "Tech Sourcing — North"), SCORECARDS reframed as recruiter rubrics (JD positioning, salary handling, notice probing, technical depth), CONVERSATIONS contains recruiter-candidate Hinglish dialog, COACHING / TRAINING modules retitled to recruiter scenarios, VOICE_AGENTS reflects screener templates.
- New mock arrays added: `RECRUITERS` (alias of AGENTS for new code), `ASSESSMENTS`, `ASSESSMENT_ATTEMPTS`, `ASYNC_VIDEO_CAMPAIGNS`, `ASYNC_VIDEO_SUBMISSIONS`, `PROCTOR_SESSIONS`, `PROCTOR_FLAGS`, `CLIENT_PORTAL_DEMANDS`, `CLIENT_PORTAL_SUBMISSIONS`, `SOURCING_NAUKRI`, `SOURCING_LINKEDIN`.

### What was deliberately deferred to Phase 11+

- Post-call worker handlers (`call_summary`, `rubric_finalize`, `prospect_outcome_extract`, `technical_qa_extract`, `jd_match_update`, `post_diarize`).
- Live rubric scoring LLM tick (`/ws/session` `rubric.update` events every 5s).
- JD-match engine (the `/api/jd-match/*` routes still don't exist; the Call Detail tab and Candidate Detail tab show structured placeholders).
- Question-bank embedding into the suggestion engine's third corpus.
- Sarvam TTS provider wiring for voice screeners.
- Real Naukri / LinkedIn / WhatsApp / Exotel connector implementations.
- QA Review rewire from mock CONVERSATIONS to real `/api/calls` (recruiter-flavored mock data is sufficient for demo since store.ts was overhauled; the QAReviewDetail drawer is heavily tied to the `Conversation` shape and that refactor is its own Phase 11 chunk).
- Separate shell for `client_user` role — Client Portal renders inside AppShell for now.

### Verification

- `pnpm --filter @j2w/api typecheck` — clean.
- Web `npx tsc --noEmit` — clean.
- `pnpm db:migrate` no-ops (zero new migrations).
- `pnpm db:seed` still idempotent.
- The Offer Letter MySQL integration (`@j2w/offer-letter-db` package, `external_offer_letter_*_id` columns, sync workers, candidate-dedup logic) is **untouched**. The new admin page only reads existing tables and enqueues into the existing queues.

### Critical files modified

Web: [App.tsx](apps/web/src/App.tsx), [AppShell.tsx](apps/web/src/layouts/AppShell.tsx), [Home.tsx](apps/web/src/pages/Home.tsx), [LiveAssist.tsx](apps/web/src/pages/LiveAssist.tsx), [CallDetail.tsx](apps/web/src/pages/CallDetail.tsx), [Analytics.tsx](apps/web/src/pages/Analytics.tsx), [Knowledge.tsx](apps/web/src/pages/Knowledge.tsx), [Settings.tsx](apps/web/src/pages/Settings.tsx), [VoiceAgentCreate.tsx](apps/web/src/pages/VoiceAgentCreate.tsx), [store.ts](apps/web/src/data/store.ts).

API: [server.ts](apps/api/src/server.ts), [seedAgents.ts](apps/api/src/db/seedAgents.ts), and the two new route files above.

---

# RecruitAssist Foundation + Live-Assist Wedge — Build Report

Built per the plan at `/Users/Daniel/.claude/plans/please-review-the-attached-swift-beacon.md`.
Covers steps 1–9 of the original brief; the remaining steps (voice-screener
templates, JD-match engine, question-bank UIs, knowledge corpus split,
analytics, recruiter home, manager views, all placeholder modules, deploy
refresh, docs sweep) are deferred to subsequent plans.

---

## Phase status

| Phase | Title | Status |
|-------|-------|--------|
| 1 | Brand sweep + workspace metadata | ✅ Done |
| 2 | Schema migration (`0010_recruitassist_foundation.sql` + Drizzle mirror) | ✅ Done |
| 3 | Seed data (J2W demo environment) | ✅ Done |
| 4 | Auth + role taxonomy + code rewiring | ✅ Done |
| 5 | Demands API + UI | ✅ Done |
| 6 | Candidates API + UI (with dedup) | ✅ Done |
| 7 | Prospects API + UI (Kanban actions on Demand detail) | ✅ Done |
| 8 | Live-assist wedge: mixed-mono ingest + Calls API + Setup page | ⚠️ Partial — see below |
| 9 | Calls list + detail UI | ✅ Done |

---

## Verification

- `pnpm typecheck` clean across `@j2w/api`, `@j2w/worker`, `@j2w/desktop`, `@j2w/db`, `@j2w/web`
- `pnpm db:migrate` applies all 11 migrations to a fresh `recruitassist` Postgres DB cleanly
- `pnpm db:seed` is idempotent (re-running wipes and recreates demo rows; verified twice)
- API boots, `/health` returns 200, login as `recruiter1@recruitassist.local / Recruiter#2026` returns the new role taxonomy permissions
- End-to-end smoke (live curl, see `BUILD_REPORT` history): `/api/demands?assignedToMe=true` returns the recruiter's three demands; `/api/candidates/dedup-check` correctly finds existing candidates
- Browser app at `pnpm --filter @j2w/web dev` mounts (compiles); the Demands → Candidates → Live-assist navigation is wired

---

## Decisions locked in (vs. brief)

1. **Schema strategy: in-place mutation**, not parallel new tables. Existing `qa_reviews` renamed to `call_qa_reviews`; `transcript_turns.speaker` enum mutated from `(agent, customer)` to `(recruiter, candidate, unknown, mixed)`; `call_sessions.agent_id` renamed to `recruiter_user_id` and `customer_ref` to `candidate_ref_or_phone`. (Backwards-compat re-export `qaReviews = callQaReviews` left in `@j2w/db` for any straggler imports.)
2. **Workspace package scope stays `@j2w/*`.** Saves ~150 import rewrites; only public-facing branding is RecruitAssist.
3. **Wedge ingest path is a NEW WS** (`/ws/ingest-call`), parallel to the existing `/ws/ingest` (legacy desktop two-channel path) and `/ws/custom-transcriber` (Vapi-facing). Single Deepgram session per call, no live diarization, frames written as `speaker='unknown'`.
4. **`/live-assist` route now points at the new `LiveAssistSetup` page** (the wedge entry). The Vapi-mediated test-call UI is preserved at `/live-assist/legacy`.
5. **`/calls` route added as the canonical recruiter-call list** (the legacy `/conversations` mock-data page is still wired for completeness; the sidebar nav now points "Calls" at `/calls`).
6. **No tables deleted from the original schema.** The brief listed `inductions`, `employee_details`, `genesys_*` — none existed. Genesys was a frontend-only config page (`apps/web/src/pages/integrations/GenesysCloudConfig.tsx`) plus a stub provider; both deleted. The contact-center-only inbound webhook (`apps/api/src/routes/telephony.ts`) was deleted.
7. **`scorecards` is green-field** (`call_rubrics` is a new table, not a rename — no scorecards table existed despite the UI/routes).
8. **Sarvam preserved as-is** at `apps/api/src/transcription/sarvam.ts` — it was already a working transcription provider; the brief incorrectly assumed it needed adding.

---

## What was built

### Schema (Phase 2)

`apps/api/src/db/migrations/0010_recruitassist_foundation.sql` — single migration adding 27 new tables and mutating 5 existing ones. Drizzle mirror in `packages/db/src/schema.ts`. Highlights:

- **Role taxonomy:** `recruiter / delivery_lead / account_manager / business_head / qa_reviewer / admin / client_user / proctor`. Self-FK `memberships.reporting_to_user_id`. Default permission matrix re-seeded for the new roles.
- **Speaker enum:** `(agent, customer) → (recruiter, candidate, unknown, mixed)` on `transcript_turns`, `transcript_acoustic_windows`, `call_translations`.
- **call_sessions:** renamed `agent_id → recruiter_user_id`, `customer_ref → candidate_ref_or_phone`. Added `mode` (browser_mixed / desktop_dual_channel / vapi_outbound / vapi_inbound / bridge), `demand_id`, `prospect_id`, `candidate_id`. Extended `origin` enum to include `bridge`.
- **chunks.corpus discriminator** (`jd | company | question_bank`) for the suggestion engine's per-corpus retrieval.
- **`qa_reviews` → `call_qa_reviews`** (rename + add `ai_score` column).
- **27 new ATS tables:** clients, client_recruiters, demands, demand_skills, demand_locations, demand_assignments, candidates, candidate_skills, candidate_experiences, candidate_qualifications, prospects, prospect_calls, submissions, submission_stage_transitions, interviews, selections, offers, jd_match_runs, call_rubrics, call_rubric_scores, question_banks, question_bank_questions, question_bank_demand_links, transcript_speaker_brackets, industries, functional_areas, role_categories, job_roles, skills, locations, disqualification_reasons.
- **`STAGE_METADATA` map** exported from `@j2w/db` — source of truth for submission stage transition validity (isTerminal / requiresReason / progressOrder / bucket / mapsToOfferLetterStep). The DB CHECK constraint only enforces "value is in the universe."

### Seed (Phase 3)

`apps/api/src/db/seed.ts`. Idempotent (TRUNCATE … CASCADE, re-insert).

- 1 org (default workspace), 72 users (5 BHs, 8 AMs, 12 DLs, 40 recruiters, 3 QAs, 2 admins, 1 client_user, 1 proctor) with `Recruiter#2026` password
- 10 J2W-shaped clients with realistic GCC names; 8 recruiters per client via `client_recruiters`
- 30 demands across clients, varied skills/locations/salary ranges, 4 recruiters per demand
- 50 candidates with skills + 1–3 experiences + 1 qualification each, randomized but deterministic via Mulberry32-seeded RNG
- 100 prospects (deduped to ~95 unique by the (demand, candidate, recruiter) UNIQUE)
- 25 submissions across mixed stages, each with an audit-trail entry
- 3 default rubrics (general, technical, senior technical) + 12 question-bank questions across 2 banks
- Taxonomy: 30 skills, 15 cities, 12 industries, 9 functional areas, 10 role categories, 19 job roles, 9 disqualification reasons

### API routes (Phases 5–9)

| Path | Purpose |
|------|---------|
| `GET /api/demands` | List with filters (status, client, isVip, assignedToMe, q) |
| `GET /api/demands/:id` | Detail with skills, locations, assignments, taxonomy |
| `POST /api/demands` | Create (admin/AM) |
| `PATCH /api/demands/:id` | Update |
| `POST /api/demands/:id/assignments` | Assign recruiters |
| `DELETE /api/demands/:id/assignments/:recruiterId` | Release recruiter |
| `GET /api/demands/:id/prospects` | Prospects on the demand |
| `GET /api/demands/:id/submissions` | Submissions on the demand |
| `GET /api/demands/:id/insights` | Placeholder (`{status: "coming_soon"}`) |
| `GET /api/candidates` | Search (q, source, skill) |
| `GET /api/candidates/:id` | Full profile + skills + experiences + submissions + prospects |
| `POST /api/candidates/dedup-check` | Email/phone normalize → org-scoped lookup |
| `POST /api/candidates` | Create (409 on duplicate, `confirmDuplicate: true` to bypass) |
| `PATCH /api/candidates/:id` | Update |
| `POST /api/candidates/:id/parse-resume` | 202 stub (worker not wired) |
| `GET /api/candidates/:id/jd-matches` | Empty array + `engine_not_implemented` flag |
| `GET /api/prospects` | Filtered list (recruiter-scoped by default) |
| `POST /api/prospects` | Create (recruiter starts working a candidate) |
| `PATCH /api/prospects/:id` | Update status / notes / interest |
| `POST /api/prospects/:id/promote-to-submission` | Atomic transaction (insert submission + audit + flip prospect) |
| `POST /api/prospects/:id/disqualify` | With reason enum |
| `GET /api/prospects/:id/calls` | Call history |
| `GET /api/submissions` | Filtered list with joins |
| `GET /api/submissions/:id` | Detail + transitions + STAGE_METADATA |
| `POST /api/submissions/:id/transition` | Validates against STAGE_METADATA |
| `POST /api/submissions/:id/withdraw` | Terminal convenience |
| `POST /api/calls` | Wedge-aware (demandId/prospectId/candidateId/mode), returns wsIngestUrl |
| `POST /api/calls/:id/manual-speaker-bracket` | Persists "I'm/Candidate speaking" markers |
| `GET /api/calls/:id` | Now includes transcript turns + recruiter |
| `WS /ws/ingest-call` | Browser-mic mixed-mono ingest path (NEW) |

### Worker

- `acousticSentiment.ts` rewired: speaker enum changed, sibling-channel filenames updated to `recruiter`/`candidate`.
- New post-call worker queues (`post_diarize`, `call_summary`, `rubric_finalize`, `prospect_outcome_extract`, `technical_qa_extract`, `jd_match_update`, `resume_parse`) **NOT yet wired** — the Phase 8 plan called these out as scaffolding hooks; the actual handlers are deferred to the next plan. The acoustic-sentiment queue is already enqueued from `/ws/ingest-call` on close.

### Web (Phases 5, 6, 7, 8, 9)

New pages:
- `/demands` — list with filters, VIP/openings metrics
- `/demands/:id` — detail with Overview / JD / Prospects / Submissions / Activity / Insights tabs; the Prospects tab is a 6-column Kanban with Promote and Disqualify actions
- `/candidates` — list with search + source filter
- `/candidates/:id` — Profile / Experience / Qualifications / Submissions / Prospects / JD-matches tabs
- `/candidates/new` — dedup-aware create form (auto-checks on email/phone blur)
- `/live-assist` — NEW wedge entry (LiveAssistSetup): pick demand → pick prospect/candidate → start browser-mic call with live transcript, manual speaker brackets, and end button
- `/live-assist/legacy` — preserved Vapi-mediated test-call UI
- `/calls` — list of recorded calls with status pills
- `/calls/:id` — Replay (audio player synced to transcript) / Transcript / Summary / Rubric / JD-Match / Compliance tabs

Sidebar nav rewired: Demands and Candidates added at top; Conversations renamed to Calls and pointed at `/calls`; Agents renamed to Recruiters; Voice Agents renamed to Voice Screeners; Scorecards renamed to Rubrics; Supervisor Monitor renamed to Team Monitor.

### Brand sweep (Phase 1)

- `package.json` root name → `recruitassist`
- `CLAUDE.md` rewritten with RecruitAssist context (preserves all gotchas, adds wedge-specific ones)
- `README.md` rewritten as RecruitAssist intro
- `apps/web/index.html` titles + meta updates
- `apps/desktop/package.json` appId + productName + mic permission strings
- `deploy/Caddyfile`, `deploy/docker-compose.yml`, `deploy/Dockerfile.api/web`, `deploy/pg-init.sql`, `deploy/README.md` — all renamed to recruitassist
- `apps/api/src/email/send.ts` email templates use RecruitAssist branding
- Root `docker-compose.yml` (dev) and `.env.example` updated
- `TELEPHONY_WEBHOOK_SECRET` env var deleted alongside the agent-routing webhook

### Deletions

- `apps/web/src/pages/integrations/GenesysCloudConfig.tsx` and `apps/web/src/pages/integrations/` directory
- `apps/api/src/telephony/genesysProvider.ts` (TelephonyProviderId union now `"vapi"` only; triage.ts simplified)
- `apps/api/src/routes/telephony.ts` and its registration in `server.ts`
- Settings → Integrations grid: Salesforce/ServiceNow/Genesys/etc. mock entries replaced with recruiter-flavored placeholders (Naukri / LinkedIn / WhatsApp / Exotel / Offer Letter / Workday / Greenhouse / M365 Calendar)

---

## ⚠️ Phase 8 — partial scope

The wedge is **functionally usable end-to-end** (browser captures mic, server transcribes via Deepgram, transcript streams over WS, API stores turns and persists recording on close), but the following pieces called out in the plan are **deferred** because they multiply the scope:

1. **AudioWorklet (instead of ScriptProcessorNode).** The current `useWedgeCall` uses `ScriptProcessorNode` — deprecated but universally supported. AudioWorklet would be lower latency but requires a separate worklet module file. Acceptable for the demo; revisit when latency budget becomes binding.
2. **Live rubric scoring (`apps/api/src/rubric/live-tick.ts`).** The plan calls for a 5-second / Nth-turn LLM tick that updates per-criterion bars over `/ws/session`. Not built. The rubric tab on the Call detail surfaces a "coming soon" message.
3. **Post-call worker handlers.** The acoustic-sentiment queue is enqueued from `/ws/ingest-call` on close, but the new queues (`post_diarize`, `call_summary`, `rubric_finalize`, `prospect_outcome_extract`, `technical_qa_extract`, `jd_match_update`, `resume_parse`) have no `apps/worker/src/jobs/*.ts` handlers yet. The Calls Detail "Summary" tab polls and shows a loading state until something writes to `call_sessions.summary`.
4. **Suggestion engine retrieval filter** — the suggestion engine still retrieves across all KB chunks. The plan calls for filtering by `chunks.corpus IN ('jd', 'company')` and pulling top-K=4 from `question_bank_questions` joined to `demand_skills`. The schema is in place (corpus column added); the retrieval call needs updating.
5. **Question-bank embedding pipeline.** Question banks exist as schema + raw rows, but the suggestion engine doesn't yet pull them at inference time.

These are **all 1–3 hour tasks each** but accumulating them would push this plan past its scope. They should be prioritized in the next plan.

---

## NOT_IMPLEMENTED placeholders (intentional)

| File | What's stubbed |
|------|----------------|
| `POST /api/candidates/:id/parse-resume` | 202 + `resume_parse:<id>` jobId. Worker not wired. |
| `GET /api/candidates/:id/jd-matches` | Returns `{matches: [], status: "engine_not_implemented"}`. Engine deferred. |
| `GET /api/demands/:id/insights` | Returns `{status: "coming_soon"}`. |
| Call detail tabs: JD-Match, Compliance | "Coming soon" copy. |
| Settings → Integrations | Tile grid is purely visual. None of Naukri/LinkedIn/WhatsApp/Exotel/Offer-Letter/Workday/Greenhouse/M365 are wired. |
| Rubric tab on Call detail | "Coming soon" copy until rubric_finalize lands. |
| Coaching, Supervisor Monitor, Triage, Voice Screeners | All routes still mounted (preserved from contact-flow); they read from mock data store; rewiring to ATS context is deferred. |

---

## New technical debt introduced

1. **Workspace `@j2w/*` scope mismatch with product brand.** Cosmetic but jarring. Renaming would touch ~150 import lines across the repo and the deploy compose/Dockerfile commands. Acceptable for now since we're internal-J2W-first.
2. **Backwards-compat re-export `qaReviews = callQaReviews`** in `packages/db/src/schema.ts`. Should be removed once we're confident no consumer still imports the old name. Phase 4 grep found zero remaining import sites of the old name, so this can probably be dropped in the next plan.
3. **Mock-data store still drives `/conversations`, `/agents`, `/coaching`, `/supervisor-monitor`, `/scorecards` pages.** These read from `apps/web/src/data/store.ts` which has not been updated to recruiter context. Each is a candidate for a focused rewrite or deletion.
4. **`apps/api/src/db/seedAgents.ts`** still seeds the HP-laptop voice-agent test scenario. The brief calls for replacing this with the Aarti Sharma recruiter-screening persona — deferred to the next plan along with voice-screener template overhaul.
5. **`recordingUrl` is a `file://` URL in dev.** The Call detail Replay tab `<audio>` element won't open it (browsers block file URLs from JS). Works in prod where it's an HTTPS S3 URL. For local testing, copy the file to a place the dev server can serve, or implement a `/api/calls/:id/recording` proxy.

---

## Recommended next 5–10 tasks (priority order)

1. **(Wedge polish) Wire the post-call worker handlers.** Add `apps/worker/src/jobs/{post_diarize,call_summary,rubric_finalize,prospect_outcome_extract}.ts`. `call_summary` is the most user-visible — without it the Call Detail Summary tab spins forever. The existing `apps/api/src/rag/summary.ts` already does the LLM call; the worker just needs to invoke it and persist back to `call_sessions.summary`.
2. **(Wedge polish) Live rubric scoring.** Build `apps/api/src/rubric/live-tick.ts` per the plan: every 5s or every 4 final turns, GPT-4o-mini call updates per-criterion score, broadcasts `rubric.update` on `/ws/session`. The Call Detail Rubric tab and the LiveAssistSetup right panel both consume.
3. **(Foundation gap) Voice-screener template overhaul** (brief §7.4). Replace the HP-laptop test scenario in `apps/api/src/db/seedAgents.ts` with the Aarti Sharma recruiter-screening persona. Rewire the test-call drawer in `apps/web/src/pages/VoiceAgentDetail.tsx`.
4. **(Foundation gap) JD-match engine implementation** (brief §8). Schema is in place (`jd_match_runs`); engine needs writing. ~6 hours of work covering the hybrid pipeline (hard filters + dense embeddings + skill-graph + LLM reasoning + cached run keying).
5. **(Foundation gap) Question-bank embedding pipeline + suggestion-engine corpus filter.** Embed `question_bank_questions` into the third corpus; update `apps/api/src/rag/suggest.ts` to filter retrieval by `chunks.corpus IN ('jd', 'company')` and pull top-K=4 from `question_bank` corpus filtered to demand's must-have skills.
6. **(Polish) Real Offer Letter MySQL connection wiring** in `apps/api/src/integrations/offer-letter/` (placeholders not yet created — would need scaffolding too). Schema-side hooks (`external_offer_letter_*_id` columns) are already in every table.
7. **(Polish) Sarvam ASR/TTS integration completion.** Sarvam is wired as an STT provider for Vapi via the custom-transcriber bridge. The brief asks for it to also be selectable as a TTS provider for voice agents — quick win.
8. **(Polish) Knowledge corpus split UI** — `chunks.corpus` defaults to `company`; need an admin UI on `/knowledge` to reclassify sources between `jd` and `company`.
9. **(Polish) Recruiter Home dashboard** (brief §4.2) — KPI tiles for daily/weekly counts, suggested next actions panel.
10. **(Cleanup) Rip out the legacy mock-data pages** (`Conversations`, `Coaching`, `SupervisorMonitor`, `Scorecards`) once the recruiter-flavored equivalents are stable. Currently they're dead-weight that confuses the IA.

---

## Smoke test (verified end-to-end)

```bash
# 1. Fresh DB + seed
docker exec j2w-postgres psql -U j2w -d postgres -c \
  "DROP DATABASE IF EXISTS recruitassist; CREATE DATABASE recruitassist OWNER recruitassist"
docker exec j2w-postgres psql -U recruitassist -d recruitassist -c \
  "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;"
pnpm db:migrate
pnpm db:seed

# 2. Boot API
pnpm --filter @j2w/api dev

# 3. Login + walk a demand
curl -X POST http://localhost:8787/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"recruiter1@recruitassist.local","password":"Recruiter#2026"}'

# 4. Boot web (separate terminal)
pnpm --filter @j2w/web dev
# Visit http://localhost:8080
# Sign in as recruiter1 → Demands → click any → Prospects tab Kanban
# → start a Live Assist call → grant mic permission → speak → end
# → see /calls/:id with the transcript persisted
```

Verified working as of build completion. Recording playback in the Replay tab requires either a prod S3 URL or a local proxy (see "New technical debt #5" above).

---

**Stop conditions hit:** all 9 plan phases complete or partial-with-explicit-scope-cut. End-to-end smoke test passes the wedge happy path. Ready for the next plan to land voice screeners, JD-match, post-call workers, and the deferred placeholders.
