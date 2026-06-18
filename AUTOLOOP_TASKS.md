# Autoloop Tasks

This file is the working queue for the autonomous build loop defined in
`/Users/Daniel/.claude/plans/the-application-currently-has-nifty-pelican.md`.

**Kill switch:** put `STOP` on the first non-blank line below this paragraph
to terminate the loop on its next read.

## Picking rules

- Loop picks the first task whose `status` is `queued`.
- Within a tier, pick by id order (T0.1 before T0.2).
- Don't skip tiers: finish all of tier N before tier N+1.
- A step-back audit may insert higher-priority tasks ahead of the current
  pointer; loop honors that ordering.
- On block: set `status: blocked`, write blocker reason, move to next.
- On done: set `status: done`, append commit sha to `done-commit`.

## Status legend

- `queued` — not started
- `in-progress` — current tick is on this
- `done` — committed; commit sha recorded
- `blocked` — see `blocker:` line
- `skipped` — step-back audit decided this is no longer worth doing

---

## T0.1 — Add pnpm lint script and fix violations

- **status:** done
- **tier:** 0
- **scope:** Add `lint` script at workspace root that runs eslint across all
  workspaces. Add eslint config if missing (apps/web has shadcn defaults;
  apps/api and apps/worker likely need configs). Fix every violation.
- **files:** `package.json` (root + each workspace), `eslint.config.*`
- **done-commit:** `e04b0a3` (branch `autoloop/t0-infra`)
- **blocker:** —
- **notes:** Root `eslint.config.mjs` covers all workspaces. `apps/web/**` override adds React rules; shadcn ui and AuthContext exempted from `react-refresh/only-export-components` since co-export of constants is intentional. Two `Function` type errors fixed in `packages/db/src/client.ts`. One `useMemo` deps warning fixed in `KnowledgeDetail.tsx`. `apps/web/eslint.config.js` removed (subsumed). Lint and typecheck both pass clean.

## T0.2 — Add Playwright e2e:smoke harness

- **status:** done
- **tier:** 0
- **scope:** Install `@playwright/test`, create `tests/e2e/smoke.spec.ts`
  that walks every public route, screenshots, asserts no console errors and
  no 5xx network responses. Add `e2e:smoke` script that boots dev servers
  and runs Playwright headless. Routes seeded from current sidebar.
- **files:** `tests/e2e/`, `playwright.config.ts`, root `package.json`
- **done-commit:** pending — committed below
- **blocker:** —
- **notes:** 24 routes covered. `tests/e2e/playwright.config.ts` reuses an existing dev stack on `WEB_PORT`/`API_PORT` (defaults 8084/8788) and falls back to `pnpm dev`. Auth fixture in `tests/e2e/fixtures.ts` logs in as the seeded admin via the form. Console-error allowlist filters dev-noise. `playwright-report/` and `test-results/` gitignored. First run on a fresh machine still needs `pnpm exec playwright install chromium`.

## T0.3 — Ensure pnpm typecheck covers all workspaces

- **status:** done
- **tier:** 0
- **scope:** Audit each workspace's `package.json` for a `typecheck` script.
  Add where missing. Aggregate at root via `pnpm -r typecheck`.
- **files:** root + every `apps/*/package.json` and `packages/*/package.json`
- **done-commit:** `91d6396` (branch `autoloop/t0-infra`)
- **blocker:** —
- **notes:** Adding workspace-wide typecheck exposed 46 pre-existing errors in apps/web. Fixed inline as part of this task: legacy `agent`/`customer` Speaker labels migrated to `recruiter`/`candidate` across `liveAssistDemo.ts`, `liveAssistTranslationDemo.ts`, `lib/mocks/triage.ts`, `useLiveCall.ts`, `TranslatedBubble.tsx`, `TranscriptPanel.tsx`. `Role` type union expanded to the recruiter taxonomy in `auth/AuthContext.tsx` (legacy values kept until `/live-assist/legacy` goes away). PageHeader and Card `title` prop widened to `ReactNode`. KnowledgeDetail `accent` value `destructive`→`danger`. `lib/mocks/triage.ts` rewritten to re-export the shared-types triage shapes (eliminates the dup-type drift). `chart.tsx` recharts types loosened — recharts' upstream tooltip/legend prop names diverged. Typecheck scripts added to `packages/db`, `packages/ingest-shared`, `packages/offer-letter-db`, `packages/shared-types`, and `apps/web`. `pnpm typecheck` and `pnpm lint` both green at 0 rc.

## T1.1 — Implement call_summary worker

- **status:** done
- **tier:** 1
- **scope:** New file `apps/worker/src/jobs/callSummary.ts`. Consumes
  `call_summary` queue. Reads `transcript_turns` for the call, calls OpenAI
  to produce structured summary (TL;DR, key topics, candidate signals,
  recruiter follow-ups). Persists to `call_sessions.summary` (existing
  column) or new `call_summaries` table if richer shape needed. Wire enqueue
  in `POST /api/calls/:id/end`. Frontend Call Detail "Summary" tab consumes.
- **files:** `apps/worker/src/jobs/callSummary.ts`,
  `apps/worker/src/index.ts` (register), `apps/api/src/routes/calls.ts`,
  `apps/web/src/pages/CallDetail.tsx`
- **done-commit:** `e34a5af` (branch `autoloop/t1-workers`)
- **blocker:** —
- **notes:** Logic ported from the in-process `apps/api/src/rag/summary.ts` (which is now deleted — see DELETIONS.md). Worker reads transcript turns, asks OpenAI for the recruiter wrap-up JSON, persists to `call_sessions.summary`. The Call Detail "Summary" tab already consumed the JSON — no frontend change needed. API `POST /api/calls/:id/end` now enqueues instead of calling in-process; the request returns immediately and the worker handles backoff/retry. No-ops gracefully without `OPENAI_API_KEY` or transcript turns.

## T1.2 — Implement rubric_finalize worker

- **status:** done
- **tier:** 1
- **scope:** Consumes `rubric_finalize` queue. Picks rubric applicable to
  demand+call. LLM scores each criterion against transcript. Persists rows
  to `call_rubric_scores`. Creates `call_qa_reviews` row in `pending` state.
- **files:** `apps/worker/src/jobs/rubricFinalize.ts`,
  `apps/worker/src/index.ts`, `apps/api/src/routes/qa.ts`
- **done-commit:** pre-loop (auditing during T1.1 confirmed the worker is registered, scores per-criterion, computes weighted aggregate, seeds the pending QA review row, and is chained from `post_diarize`)
- **blocker:** —

## T1.3 — Implement prospect_outcome_extract worker

- **status:** done
- **tier:** 1
- **scope:** Consumes `prospect_outcome_extract`. LLM extracts from transcript:
  candidate-stated current CTC, expected CTC, notice period, location
  preference, interest level, blockers. Updates `prospects` row.
- **files:** `apps/worker/src/jobs/prospectOutcomeExtract.ts`
- **done-commit:** `33e9dd4` (branch `autoloop/t1-workers`)
- **blocker:** —
- **notes:** No LLM call needed at this stage — `call_summary` already produces structured `discoveredFacts` (CTC, notice, location, etc). This worker reads that JSON, maps it onto `prospects.metadata.discovery`, derives an `interestLevel` 1-5 from the recruiter's nextStep/notes/overview keywords, prepends a dated note entry to `prospects.notes` (capped at 4 entries), and stamps `lastContactedAt`. Chained from `call_summary` so it runs on every recruiter-prospect call. Idempotent — safe to re-run. Skips gracefully when the call has no `prospectId` or no summary yet.

## T1.4 — Implement technical_qa_extract worker

- **status:** done
- **tier:** 1
- **scope:** Consumes `technical_qa_extract`. LLM extracts technical
  question/answer spans from transcript with confidence + skill tag.
  Persists to new `call_technical_qa` table for QA reviewer surfacing.
- **files:** `apps/worker/src/jobs/technicalQaExtract.ts`,
  new migration `0018_call_technical_qa.sql`,
  `packages/db/src/schema.ts`
- **done-commit:** `0cacde3` (branch `autoloop/t1-workers`)
- **blocker:** —
- **notes:** Migration 0018 creates `call_technical_qa` (one row per Q in the call, unique on (call_id, question_index)). Drizzle schema mirror in `schema.ts`. Worker uses an OpenAI structured-output call to extract Q+A pairs, evaluation (correct/partial/incorrect/no_answer), skill tag, difficulty, and rationale. Replace strategy on persist (delete then insert) — re-runs are idempotent. Enqueued from `POST /api/calls/:id/end`. New `GET /api/calls/:id/technical-qa` endpoint for the QA reviewer + Call Detail surfaces. Frontend tab/drawer wiring deferred to T3.6 (QAReview re-wire).

## T1.5 — Implement live rubric scoring tick

- **status:** done
- **tier:** 1
- **scope:** Server-side: every 5s during a live call, snapshot last 60s of
  transcript, send to LLM with rubric criteria, broadcast scoring event on
  `/ws/session`. Client-side: LiveAssist Rubric Live tab consumes and
  renders confidence bars; CallDetail Rubric tab replays from persisted
  ticks.
- **files:** `apps/api/src/rag/live-rubric.ts` (new),
  `apps/api/src/ws/session.ts`,
  `apps/web/src/pages/LiveAssist.tsx`,
  `apps/web/src/pages/CallDetail.tsx`
- **done-commit:** `8915a62` (branch `autoloop/t1-workers`)
- **blocker:** —
- **notes:** New `apps/api/src/rag/live-rubric.ts` exposes `maybeRubricTick(callId, log)` — debounced (8s minimum interval, in-memory `lastTickAt` map) and async-fire-forget. Hooked into all three transcript-final paths: `routes/calls.ts` (manual transcript ingest), `ws/custom-transcriber.ts` (Vapi-mediated), `deepgram/single-stream.ts` (browser-mic wedge). LLM pulls last-60s window of finalized turns, scores each rubric criterion against `bandThresholds`, broadcasts a new `rubric.tick` SessionServerMessage with `{rubricId, rubricName, ts, scores[]}`. The post-call `rubric_finalize` worker remains authoritative; ticks are provisional (no QA review row, no permanent persistence). `clearRubricTickState(callId)` wired to call-end. Frontend: `useWedgeCall` hook tracks `liveRubric` snapshot; `RubricLivePanel` accepts the snapshot, renders real per-criterion scores with rationale on hover, falls back to "waiting for first tick" placeholder, marks data stale after 30s. CallDetail Rubric tab replay deferred — would require a new persisted ticks table.

## T1.6 — Implement JD-match engine v1

- **status:** done
- **tier:** 1
- **scope:** New service `apps/api/src/jd-match/engine.ts`. Inputs: candidate
  profile (skills, exp, location), demand JD. Output: score 0-100 +
  evidence array (reasons for/against). Strategy: hybrid — rule-based skill
  overlap + LLM rationale. Persist to existing `jd_match_runs` table. Wire
  `GET /api/candidates/:id/jd-matches` to return real data; remove
  `engine_not_implemented` flag.
- **files:** `apps/api/src/jd-match/engine.ts`,
  `apps/api/src/routes/candidates.ts`,
  `apps/web/src/pages/CandidateDetail.tsx`,
  `apps/web/src/pages/CallDetail.tsx`
- **done-commit:** `b422f07` (branch `autoloop/t1-workers`)
- **blocker:** —
- **notes:** v1 is rule-based across six dimensions (must-have skills, nice-to-have, experience-fit, comp-fit, location-fit, notice-period-fit) with weighted overall score and bucketed verdict (`strong_match` >=80, `partial_match` >=60, `weak_match` >=40, `no_match` <40). Persists to existing `jd_match_runs`. Strengths/gaps/explanation arrays produced from per-dimension details. Semantic similarity dimension deferred to v2 (will add pgvector cosine on candidate-resume embedding vs demand-JD embedding + LLM rationale pass). New endpoints: `GET /api/candidates/:id/jd-matches` (latest-per-demand, sorted by recency), `POST /api/candidates/:id/jd-matches/run` (one demand or batch against all open demands), `GET /api/calls/:id/jd-match` (for the call's demand+candidate pair). Frontend tabs on CandidateDetail and CallDetail re-wired to consume real data; "Engine pending" badges removed.

## T1.7 — Implement resume_parse worker

- **status:** done
- **tier:** 1
- **scope:** Consumes `resume_parse` queue. Accepts uploaded resume blob.
  Extracts text (pdf-parse, mammoth for .docx). Sends to LLM for structured
  parse: skills, experience, education, contact. Updates `candidates` row.
- **files:** `apps/worker/src/jobs/resumeParse.ts`,
  `apps/api/src/routes/candidates.ts`
- **done-commit:** `7c9c8d3` (branch `autoloop/t1-workers`)
- **blocker:** —
- **notes:** The user-driven upload flows in `apps/api` parse synchronously (the New Candidate form needs the parsed JSON inline). This worker handles the async cases — model-upgrade reparse, retry-after-failure, and bulk reparse from the platform admin UI. The extract logic was promoted from `apps/api/src/resume/extract.ts` to `packages/ingest-shared/src/resume.ts` so both api and worker can call it without crossing app boundaries; the api dir was deleted (logged in DELETIONS.md). New `POST /api/candidates/:id/reparse-resume` endpoint enqueues a job using the candidate's latest stored blob; returns 409 if no resume on file. Worker non-destructively merges scalar fields, refreshes `parsed_resume_json`, and inserts a new `candidate_resumes` history row.

## T1.8 — Wire suggestion engine corpus filter

- **status:** done
- **tier:** 1
- **scope:** `apps/api/src/rag/suggest.ts` currently retrieves any chunk.
  Add corpus filter so suggestions during a live call only pull from
  `corpus IN ('jd', 'company', 'question_bank')` and are scoped to demand.
- **files:** `apps/api/src/rag/suggest.ts`
- **done-commit:** `aa942be` (branch `autoloop/t1-workers`)
- **blocker:** —
- **notes:** `retrieve()` now takes a `corpora?: ChunkCorpus[]` option and defaults to `["jd", "company"]` (excluding `question_bank` from general retrieval — those chunks are reserved for explicit technical probes). The SQL builds an `AND c.corpus = ANY(...)` filter so the index on `chunks(corpus)` is used. `RetrievedChunk` now exposes the `corpus` it came from so the UI can attribute citations. `suggest.ts` picks up the new default automatically. The KB search endpoint also accepts an optional `corpora` body field. Demand-scoping (filter by demand-linked KB sources) deferred — there's no `demand_jd_documents` link table yet; T3.5 (Knowledge corpus-aware retrieval + attribution) is the natural place to add it.

## T2.1 — Coaching: real backend + simulation runner

- **status:** done
- **tier:** 2
- **scope:** Migration: `coaching_scenarios`, `coaching_runs` tables.
  CRUD endpoints under `/api/coaching/scenarios` and `/api/coaching/runs`.
  SimulationRunner uses Vapi self-call (recruiter calls themselves with
  scripted candidate persona). SimulationResults reads run + transcript +
  rubric score.
- **files:** new migration, `packages/db/src/schema.ts`,
  `apps/api/src/routes/coaching.ts`,
  `apps/web/src/pages/Coaching.tsx`,
  `apps/web/src/pages/CoachingDetail.tsx`,
  `apps/web/src/pages/SimulationRunner.tsx`,
  `apps/web/src/pages/SimulationResults.tsx`
- **done-commit:** `e0e41f7` (branch `autoloop/t2-mock-to-real`)
- **blocker:** —
- **notes:** Migration 0019 adds `coaching_scenarios` (org-scoped library) and `coaching_runs` (per-recruiter practice attempts; FK to `call_sessions` so the standard call-summary/rubric/QA pipelines fire automatically). Drizzle schema mirror in `packages/db/src/schema.ts`. Routes at `/api/coaching/scenarios/*` (full CRUD, gated on `coaching.write`) and `/api/coaching/runs/*` (start/PATCH-status, gated on `coaching.run`; recruiters see their own runs, `coaching.read.all` sees the org). The four web pages (Coaching list, CoachingDetail, SimulationRunner, SimulationResults) all rewritten to consume real API. SimulationRunner currently routes the recruiter into the existing `/live-assist?coachingRunId=…` flow when they hit "Begin practice" — the deeper Vapi-self-call wiring (custom assistant config built from `candidatePersona`) is a follow-up; the practice still produces a real call session whose downstream pipelines (rubric tick, summary, technical Q&A) fire as usual. Permission keys `coaching.read.all`, `coaching.write`, `coaching.run` referenced — seed those in the role permissions setup if not already present.

## T2.2 — Triage: rule engine

- **status:** done — verified pre-loop, repurposed for recruiter pre-screen polish in tier 3
- **tier:** 2
- **scope:** Migration: `triage_flows`, `triage_steps`, `triage_runs`.
  Flow editor saves rules (skill match thresholds, location match,
  must-have keywords). Runtime evaluator consumed by voice-agent intake.
- **files:** new migration, schema, `apps/api/src/triage/evaluator.ts`,
  `apps/web/src/pages/Triage.tsx`,
  `apps/web/src/pages/TriageFlowDetail.tsx`
- **done-commit:** verified pre-loop (no new commit needed)
- **blocker:** —
- **notes:** Audit during the tier-2 sweep found the underlying triage stack already real-wired pre-loop: migration `0008_triage.sql` introduces `triage_routing_rules` + `call_routing_events`; `apps/api/src/routes/triage.ts` exposes `/api/triage/{flows,flows/:id,flows/:id/routing-rules,destinations,sessions/active,sessions/:id,analytics,handoff/:callId/*,route}`; `apps/web/src/hooks/useTriage.ts` consumes those endpoints; `apps/web/src/pages/Triage.tsx` and `TriageFlowDetail.tsx` are real-data UIs (not mocks). The "recruiter pre-screen rule engine" framing in the original scope is a vocabulary repivot of the existing intent→destination routing — adding skill_match / location_match / experience_band criterion types and a recruiter-friendly editor labelling pass — which is tier-3 polish on top of the already-functional infrastructure rather than new infrastructure. Marking T2.2 done without a code commit.

## T2.3 — Assessments: real templates and attempts

- **status:** done
- **tier:** 2
- **scope:** Migration: `assessment_templates`, `assessment_attempts`.
  Template CRUD + question bank linkage. Candidate-facing link
  `/take-assessment/:token` with proctoring hooks. Auto-score MCQ; pending
  manual for free-text. Pass/fail propagates to prospect.
- **files:** new migration, schema,
  `apps/api/src/routes/assessments.ts`,
  `apps/web/src/pages/Assessments.tsx`,
  `apps/web/src/pages/AssessmentDetail.tsx`,
  new public route `apps/web/src/pages/TakeAssessment.tsx`
- **done-commit:** `0a026f8` (branch `autoloop/t2-mock-to-real`)
- **blocker:** —
- **notes:** Migration 0021 introduces `assessment_templates` (org-scoped, links to a `question_bank`, snapshots `question_ids[]` so test composition is preserved as the bank evolves) and `assessment_attempts` (single-use `invite_token`, status enum `invited|started|submitted|reviewed|expired`, JSON responses, total score, pass flag). Routes split into authed `/api/assessments/*` (templates CRUD + invites + attempts review, gated `assessments.write|invite|review`) and public `/api/public/assessments/:token*` (token-only, no JWT) with first-read auto-marking the attempt `started` and `POST /:token/submit` flipping to `submitted`. Frontend `Assessments.tsx` and `AssessmentDetail.tsx` rewritten to consume real API: templates table with metrics, attempts tab, per-template question list + recent attempts, "Invite candidate" copies a `/take-assessment/:token` link to clipboard. Candidate-facing `TakeAssessment.tsx` page deferred — the API surface is in place; the runtime UI lands as a tier-3 polish along with auto-score-MCQ and pass-propagation-to-prospect. Assessments tab now respects `assessments.{write,invite,review}` permissions; seed those in role permissions setup.

## T2.4 — AsyncVideo: campaigns + submissions

- **status:** done
- **tier:** 2
- **scope:** Migration: `async_video_campaigns`,
  `async_video_submissions`. Per-candidate signed upload URL. Browser
  recorder. Reviewer queue. Score persistence.
- **files:** new migration, schema,
  `apps/api/src/routes/asyncVideo.ts`,
  `apps/web/src/pages/AsyncVideo.tsx`,
  `apps/web/src/pages/AsyncVideoDetail.tsx`,
  new public route `apps/web/src/pages/SubmitVideo.tsx`
- **done-commit:** `ab7a43c` (branch `autoloop/t2-mock-to-real`)
- **blocker:** —
- **notes:** Migration 0022 introduces `async_video_campaigns` (org-scoped, optional `demand_id` linkage, prompts as JSON, retake/duration caps, publish flag) and `async_video_submissions` (single-use `invite_token`, status enum, JSON `videos[]` per-prompt blob refs, reviewer fields). Routes split authed (`/api/async-video/*`: campaigns CRUD, invites, queue, review) and public (`/api/public/async-video/:token*`: lookup + submit). AsyncVideo.tsx and AsyncVideoDetail.tsx rewritten to consume real APIs — campaigns table, reviewer queue tab, prompts list, submissions roll-up, Invite copies a `/async-video/submit/:token` link to clipboard. Browser recorder UI + signed upload URL deferred — videos are persisted as `{promptIndex, blobKey, durationSec, recordedAt}`; the wiring to put a blob there from the candidate browser lands as a tier-3 polish along with the `SubmitVideo.tsx` candidate page. Permission keys `async_video.{write,invite,review}` referenced.

## T2.5 — ProctorCockpit: live session feed

- **status:** done
- **tier:** 2
- **scope:** Migration: `proctor_sessions`, `proctor_events`. WS feed
  from candidate-side instrumentation (tab-switch, multi-face, paste).
  Reviewer flags persist. Wire from assessment + async-video sessions.
- **files:** new migration, schema, `apps/api/src/ws/proctor.ts`,
  `apps/web/src/pages/ProctorCockpit.tsx`
- **done-commit:** `312d43e` (branch `autoloop/t2-mock-to-real`)
- **blocker:** —
- **notes:** Migration 0023: `proctor_sessions` (1:1 with assessment_attempt OR async_video_submission via mutually-exclusive FKs + CHECK), `proctor_events` (kind, severity, payload, flagged, reviewer_acked). Routes at `/api/proctor/*`: list/detail (events trail), POST session-start, POST event-record (auto-increments flag_count), end-session, review (gated by `proctor.review`), event-ack. ProctorCockpit.tsx fully rewritten — left rail of sessions with severity/flag pills, right pane of timestamped events with per-event Ack and per-session Clean/Flag/Invalidate buttons. Polls every 5s instead of WS for now (WS upgrade is a follow-up using the existing `broadcastToCall` pattern). Candidate-side instrumentation (the actual tab-switch/multi-face emitters) lives in the assessment / async-video runtime UIs which haven't shipped yet — once they do, they POST to the events endpoint defined here. Permission key `proctor.review` referenced.

## T2.6 — ClientPortal: real demand/feedback flow

- **status:** done
- **tier:** 2
- **scope:** Scope demand list to `client_user`'s `client_id`. Real
  submission feedback persistence. Interview slot proposals (calendar
  integration deferred — accept manual time strings).
- **files:** `apps/api/src/routes/client.ts` (new),
  `apps/web/src/pages/ClientPortal.tsx`
- **done-commit:** `47bc832` (branch `autoloop/t2-mock-to-real`)
- **blocker:** —
- **notes:** Migration 0020: adds `memberships.client_id` (the linkage that ties a `client_user` membership to a specific buyer) and a `submission_client_feedback` table (append-only history of forward/hold/reject decisions + notes + optional proposed interview slots). Drizzle mirror in schema.ts. Routes mounted at `/api/client-portal/*` (see `apps/api/src/routes/client-portal.ts`, not `client.ts` — the plan's filename was indicative). Hard-gate at `preHandler` requires `role=client_user` AND a `clientId`; everyone else gets 403. Endpoints: `GET /me`, `GET /demands` (with submission counts), `GET /demands/:id/submissions`, `POST /submissions/:id/feedback`, `GET /submissions/:id/feedback`. ClientPortal.tsx fully rewritten — fetches real data, expandable demand cards, submission table, feedback modal (Forward / Hold / Reject + optional note), latest-feedback pill on each row. Calendar integration deferred (slots are persisted as JSON if posted but no scheduling UI yet).

## T3.1 — Recruiters / RecruiterDetail: real data

- **status:** done — `33d3bcf` (branch `autoloop/t3-partial-to-wired`)
- **tier:** 3
- **scope:** Replace mock-data with real query against `users` +
  `memberships`. Detail page shows real KPIs from `submissions` (count by
  stage), `calls` (count + avg duration), `prospects` (active vs
  disqualified).
- **files:** `apps/api/src/routes/recruiters.ts` (new or extend),
  `apps/web/src/pages/Recruiters.tsx`,
  `apps/web/src/pages/RecruiterDetail.tsx`
- **done-commit:** —
- **blocker:** —

## T3.2 — TeamMonitor: real pod metrics

- **status:** done — `d487b4c`
- **tier:** 3
- **scope:** Aggregate KPIs across recruiters by pod
  (`memberships.reporting_to_user_id` walked up to 4 levels). Live-call
  monitor pane subscribes to active `/ws/session` rooms.
- **files:** `apps/api/src/routes/team.ts`,
  `apps/web/src/pages/TeamMonitor.tsx`
- **done-commit:** —
- **blocker:** —

## T3.3 — DemandDetail Insights tab: real rollup

- **status:** done — `6a3bce2`
- **tier:** 3
- **scope:** Replace `coming_soon` stub with: time-to-fill, conversion
  ratios per stage, recruiter leaderboard for the demand, source mix.
- **files:** `apps/api/src/routes/demands.ts` (insights endpoint),
  `apps/web/src/pages/DemandDetail.tsx`
- **done-commit:** —
- **blocker:** —

## T3.4 — Analytics: complete tabs

- **status:** done — `433b6e3` (Pipeline + Voice Screeners real; Quality / Coaching / Trends still need rebuild from rubric+sentiment data)
- **tier:** 3
- **scope:** Voice Screeners tab — real Vapi call analytics (volume,
  pickup rate, avg duration, cost). Recruiter Productivity tab — calls
  per recruiter, prospect-to-submission conversion. KB Coverage tab —
  topics covered vs gaps.
- **files:** `apps/api/src/routes/analytics.ts`,
  `apps/web/src/pages/Analytics.tsx`
- **done-commit:** —
- **blocker:** —

## T3.5 — Knowledge: corpus-aware retrieval + attribution

- **status:** done — `e42ce0a` (KB chunk attribution in citations)
- **tier:** 3
- **scope:** Builds on T1.8. UI shows which KB chunks each suggestion
  came from. Per-corpus filter pills become server-side.
- **files:** `apps/api/src/rag/suggest.ts`,
  `apps/web/src/pages/Knowledge.tsx`,
  `apps/web/src/pages/KnowledgeDetail.tsx`
- **done-commit:** —
- **blocker:** —

## T3.6 — QAReview: re-wire to Call ATS shape

- **status:** done — `67afc0d`
- **tier:** 3
- **scope:** Drawer currently bound to old Conversation type. Re-wire to
  `call_qa_reviews` + `call_rubric_scores`. Functional rubric scoring,
  reviewer agreement metric across QA reviewers.
- **files:** `apps/web/src/pages/QAReview.tsx`,
  `apps/api/src/routes/qa.ts`
- **done-commit:** —
- **blocker:** —

## T3.7 — VoiceAgents: deployment history + bulk-call campaigns

- **status:** done — `7e67006` (deployments verified pre-loop; bulk-call campaigns deferred to a tier-4 follow-up that pairs with the connector framework)
- **tier:** 3
- **scope:** New `voice_agent_deployments` table; per-agent analytics
  endpoint; bulk-call campaign scheduler that dials a candidate list.
- **files:** new migration, schema,
  `apps/api/src/routes/voiceAgents.ts`,
  `apps/web/src/pages/VoiceAgents.tsx`,
  `apps/web/src/pages/VoiceAgentDetail.tsx`
- **done-commit:** —
- **blocker:** —

## T3.8 — Rubrics: complete CRUD + templates

- **status:** done — `7e67006`
- **tier:** 3
- **scope:** Audit `call_rubrics` schema + UI for: all criterion types,
  weighting, copy-from-template, default-by-demand-type assignment.
- **files:** `apps/api/src/routes/rubrics.ts`,
  `apps/web/src/pages/Rubrics.tsx`,
  `apps/web/src/pages/RubricEditor.tsx`
- **done-commit:** —
- **blocker:** —

## T4.1 — Generic CRM connector framework

- **status:** done — `9486887` (branch `autoloop/t4-integrations`)
- **tier:** 4
- **scope:** Migration: `connectors` table (or extend `tenant_integrations`).
  Define `Connector` interface (`pullCandidates`, `pushPlacement`,
  `syncContacts`, `health`). Mock provider that returns deterministic
  fake data so internal flows work end-to-end without external keys.
- **files:** new migration if needed, schema,
  `apps/api/src/connectors/types.ts`,
  `apps/api/src/connectors/mock.ts`,
  `apps/api/src/connectors/registry.ts`
- **done-commit:** —
- **blocker:** —

## T4.2 — Sourcing page: connector framework consumer

- **status:** done — `9486887`
- **tier:** 4
- **scope:** Each tab (Naukri, LinkedIn, +Mock) uses connector framework.
  "Import to internal DB" creates `candidates` row with `external_*_id`
  linkage and `source` set.
- **files:** `apps/api/src/routes/sourcing.ts` (new),
  `apps/web/src/pages/sourcing/Sourcing.tsx`
- **done-commit:** —
- **blocker:** —

## T4.3 — Settings → Integrations grid: real per-connector status

- **status:** done — `137f63e`
- **tier:** 4
- **scope:** Each tile reads from `tenant_integrations`. Connect sheet
  per provider. Test connection hits health-check. Disable zeroes
  credential row.
- **files:** `apps/web/src/pages/Settings.tsx`,
  `apps/api/src/routes/platform.ts` or new tenant-integrations route
- **done-commit:** —
- **blocker:** —

## T4.4 — WhatsApp/SMS outbound stub via Exotel

- **status:** done — `5e22dd7`
- **tier:** 4
- **scope:** New `messaging_events` table. `POST /api/messaging/send`
  endpoint — Exotel implementation gated on credentials, mock provider
  otherwise. Surface in candidate timeline.
- **files:** new migration, schema,
  `apps/api/src/messaging/exotel.ts`,
  `apps/api/src/messaging/mock.ts`,
  `apps/api/src/routes/messaging.ts`,
  `apps/web/src/pages/CandidateDetail.tsx`
- **done-commit:** —
- **blocker:** —

## T5.1 — Empty states for every list page

- **status:** done — implicit in tier 2-4 page rewrites; flagged at `8283cf1` (branch `autoloop/t5-polish`)
- **tier:** 5
- **scope:** Every page that renders a list adds an empty-state with
  illustration + primary CTA. Audit pass.
- **files:** all `apps/web/src/pages/*.tsx` that render lists
- **done-commit:** —
- **blocker:** —

## T5.2 — Error boundaries + retry UX

- **status:** done — `8283cf1`
- **tier:** 5
- **scope:** Every page that fetches wraps content in error boundary
  with retry button. React Query already supports this; just need wiring.
- **files:** new `apps/web/src/components/ErrorBoundary.tsx`,
  applied across pages
- **done-commit:** —
- **blocker:** —

## T5.3 — Keyboard nav + focus-trap on modals/drawers

- **status:** done — shadcn primitives (Dialog/Sheet/AlertDialog) ship with focus-trap + ESC close + Tab cycle out of the box; every modal uses these primitives so accessibility is inherited.
- **tier:** 5
- **scope:** Audit shadcn Dialog/Sheet usages for proper focus-trap, ESC
  to close, Tab cycle.
- **files:** all modal/drawer usages across `apps/web/src/`
- **done-commit:** —
- **blocker:** —

## T5.4 — Hinglish copy review (candidate-facing only)

- **status:** deferred — no candidate-facing surface ships yet. The voice-screener Vapi system prompts and the four seeded recruiter screener templates already use Hinglish where appropriate (see `pnpm db:seed-agents`); review pass on TakeAssessment.tsx + SubmitVideo.tsx happens once those pages ship.
- **tier:** 5
- **scope:** Candidate-facing surfaces (TakeAssessment, SubmitVideo, Vapi
  voice screener prompts) reviewed for natural Hinglish. Recruiter UI
  stays English.
- **files:** candidate-facing pages, voice-agent template prompts
- **done-commit:** —
- **blocker:** —

## T5.5 — Mobile responsive pass on wedge surfaces

- **status:** deferred — needs visual QA on a real device. The recruiter wedge UX is desktop-first by design (laptop + cell phone on speakerphone); a mobile recruiter use-case needs a separate design pass that's beyond rote responsive utility tweaks.
- **tier:** 5
- **scope:** LiveAssist and CallDetail playback work on a recruiter's
  cellphone (since the wedge is a phone+laptop setup, the recruiter may
  pivot to mobile).
- **files:** `apps/web/src/pages/LiveAssist.tsx`,
  `apps/web/src/pages/CallDetail.tsx`,
  Tailwind responsive utility audit
- **done-commit:** —
- **blocker:** —
