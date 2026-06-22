# J2W AI Interview Assist

A real-time AI co-pilot for technical interviews at **JoulestoWatts Business Solutions**. It captures live mic audio, transcribes it via Deepgram (with Sarvam / Shunya fallbacks), and feeds the rolling transcript to an OpenAI co-pilot loop that suggests the next question, verifies the candidate's answer, and produces a final evaluation. Sessions and transcripts are stored in the same MongoDB cluster as **J2W OfferLetter 2026** so interviews link straight back to the JD and recruiter.

---

## Tech Stack

| Layer          | Technology                                                          |
| -------------- | ------------------------------------------------------------------- |
| Frontend       | Next.js 16, React 19 (lives inside J2W OfferLetter `frontend/`)     |
| Backend        | Node.js, Fastify 4, TypeScript, MongoDB driver, pino logging        |
| Real-time      | `@fastify/websocket` + `ws` (binary PCM16 / 16 kHz frames)          |
| Transcription  | Deepgram (primary), Sarvam, Shunya                                  |
| LLM            | OpenAI (gpt-5.4-nano with gpt-4o-mini fallback)                     |
| Auth           | Shared J2W OfferLetter cookie (`authToken` HS256 JWT)               |
| Storage        | Local blob root (`./var/blobs`) for resumes, AWS Rekognition (opt.) |
| OL data source | MySQL (production OfferLetter) + MongoDB Atlas (shared cluster)     |

---

## Project Structure

```
recruit-assist-ai/
├── backend/                       # Fastify API + WS server
│   ├── src/
│   │   ├── index.ts               # Server entry point
│   │   ├── server.ts              # Fastify app setup
│   │   ├── env.ts                 # Env loader & validation
│   │   ├── mongo.ts               # MongoDB connection (shared OL cluster)
│   │   ├── bus.ts                 # Internal event bus
│   │   ├── auth/
│   │   │   └── olAuth.ts          # OL authToken cookie verifier
│   │   ├── routes/                # REST endpoints
│   │   │   ├── assist.ts          # plan / next / verify / detect-question / final
│   │   │   ├── calls.ts           # Interview lifecycle
│   │   │   ├── candidates.ts      # Ephemeral resume parse
│   │   │   ├── demands.ts         # Recruiter-scoped JD list
│   │   │   └── health.ts          # Liveness probe
│   │   ├── ws/                    # WebSocket handlers
│   │   │   ├── ingest-call.ts     # Mic audio → Deepgram
│   │   │   ├── session.ts         # Live transcript fan-out
│   │   │   ├── custom-transcriber.ts
│   │   │   └── wav-dump.ts        # Recording capture
│   │   ├── transcription/         # Provider abstractions
│   │   │   ├── mixed-turn.ts      # Turn segmentation
│   │   │   ├── provider.ts        # Provider switch
│   │   │   ├── sarvam.ts          # Sarvam STT
│   │   │   ├── shunya.ts          # Shunya STT
│   │   │   ├── single-bridge.ts   # Bridge audio stream → STT
│   │   │   └── speaker-map.ts     # Diarization labels
│   │   ├── deepgram/
│   │   │   └── single-stream.ts   # Deepgram live STT
│   │   ├── rag/                   # In-call AI helpers
│   │   │   ├── live-rubric.ts     # Scorecard against rubric
│   │   │   ├── sentiment.ts       # Candidate sentiment
│   │   │   └── suggest.ts         # Next-question suggestion
│   │   ├── integrations/
│   │   │   ├── encryption.ts      # Cookie encryption helpers
│   │   │   └── resolver.ts        # OL → IA entity resolution
│   │   ├── lib/keyset.ts          # JWT keyset utilities
│   │   ├── dev/mockCallIds.ts     # Local-dev fixtures
│   │   └── usage/                 # Per-call usage telemetry
│   ├── packages/
│   │   ├── ingest-shared/         # Audio frame types shared with frontend
│   │   └── shared-types/          # API contract types
│   ├── fixtures/                  # Sample resumes / JDs for local tests
│   ├── var/                       # Local blob root + audio dumps
│   ├── package.json
│   └── tsconfig.json
│
└── frontend/                      # UI lives inside J2W_OfferLetter_2026/frontend
                                   # under src/sections/interviewAssist/
```

---

## Prerequisites

- **Node.js** >= 18
- **pnpm** (workspace package manager — `corepack enable && corepack prepare pnpm@latest`)
- **MongoDB** Atlas access (uses the same cluster as J2W OfferLetter)
- **Redis** (optional — used by job/queue paths in dev)
- A running **J2W OfferLetter 2026** frontend on `localhost:3000` to log in and source the `authToken` cookie
- **API keys** for at least one of: Deepgram, Sarvam, Shunya (transcription); OpenAI (LLM)

---

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/J2W-Developer/recruit-assist-ai.git
cd recruit-assist-ai
```

### 2. Backend setup

```bash
cd backend
pnpm install
```

Create a `.env` file in the repo root (one level above `backend/`):

```env
# API
API_HOST=0.0.0.0
API_PORT=8787
API_PUBLIC_URL=http://localhost:8787

# MongoDB — share the J2W OfferLetter staging cluster
STAGING_MONGOURI_LOCAL=mongodb+srv://<user>:<pass>@j2wofferletter.acjnjw8.mongodb.net/j2wOfferletter-staging-2026
MONGO_DB=j2wOfferletter-staging-2026

# Shared JWT secret — must match J2W OfferLetter backend JWT_KEY
OL_JWT_KEY=your-shared-jwt-secret-here

# OL MySQL (used by the resolver for recruiter / JD metadata)
OFFER_LETTER_MYSQL_HOST=j2wofferletter-prod.ca8kj4bjkq5a.ap-south-1.rds.amazonaws.com
OFFER_LETTER_MYSQL_PORT=3306
OFFER_LETTER_MYSQL_USER=mis_operations
OFFER_LETTER_MYSQL_PASSWORD=
OFFER_LETTER_MYSQL_DATABASE=offerletter
OFFER_LETTER_MYSQL_TLS=true

# Redis (optional)
REDIS_URL=redis://localhost:6379

# Transcription
DEEPGRAM_API_KEY=
SARVAM_API_SUBSCRIPTION_KEY=
SHUNYA_API_KEY=

# OpenAI
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-nano
OPENAI_MODEL_FALLBACK=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# Blob storage
BLOB_ROOT=./var/blobs
DUMP_DIR=./var/audio-dumps
RECORDING_RETENTION_DAYS=90

# Frontend origin (CORS)
APP_BASE_URL=http://localhost:3000
```

Start the backend:

```bash
pnpm dev          # Development (tsx watch on src/index.ts)
pnpm start        # Production
pnpm typecheck    # Type-check only
pnpm test         # Vitest
```

### 3. Frontend setup

The Interview Assist UI lives inside the **J2W OfferLetter 2026** project under `frontend/src/sections/interviewAssist/`. Run that frontend as documented in [J2W OfferLetter README](https://github.com/J2W-Developer/J2W_OfferLetter_2026/blob/master/README.md) and add the following two variables to its `.env`:

```env
NEXT_PUBLIC_INTERVIEW_API_URL=http://localhost:8787
NEXT_PUBLIC_INTERVIEW_WS_URL=ws://localhost:8787
```

Then log in to OfferLetter at `http://localhost:3000` — the AI Interview Assist button in the top bar opens `/<role>/interview_assist` and reuses the same `authToken` cookie.

---

## API Routes

### Auth
| Method | Endpoint            | Description                                  |
| ------ | ------------------- | -------------------------------------------- |
| —      | (cookie-based)      | Verifies the J2W OfferLetter `authToken` cookie via shared HS256 secret. No standalone login endpoint. |

### Health
| Method | Endpoint     | Description           |
| ------ | ------------ | --------------------- |
| GET    | `/health`    | Liveness + version    |

### Demands (job postings)
| Method | Endpoint          | Description                                                |
| ------ | ----------------- | ---------------------------------------------------------- |
| GET    | `/api/demands`    | List JDs assigned to the logged-in recruiter (via OL `jobAssignMappings`) |

### Candidates
| Method | Endpoint                                       | Description                                              |
| ------ | ---------------------------------------------- | -------------------------------------------------------- |
| POST   | `/api/candidates/parse-resume-preview`         | Multipart resume upload → parsed JSON. Ephemeral — nothing is persisted; the snapshot is later inlined into the interview when the call starts. |

### Calls (interview lifecycle)
| Method | Endpoint                                       | Description                                              |
| ------ | ---------------------------------------------- | -------------------------------------------------------- |
| POST   | `/api/calls`                                    | Create an interview with an inline candidate snapshot   |
| GET    | `/api/calls`                                    | List past interviews for the recruiter                  |
| GET    | `/api/calls/:callId`                            | Detail (transcript + summary + verdict)                 |
| GET    | `/api/calls/:callId/transcripts`                | Raw transcript lines for replay                         |
| POST   | `/api/calls/:callId/end`                        | End the call + trigger final evaluation                 |

### Assist (live AI co-pilot)
| Method | Endpoint                              | Description                                                |
| ------ | ------------------------------------- | ---------------------------------------------------------- |
| POST   | `/api/assist/plan`                    | Generate the question bank for a call (English-only)       |
| POST   | `/api/assist/next`                    | Pick the next question given history + transcript          |
| POST   | `/api/assist/verify`                  | Score an answer for the current question                   |
| POST   | `/api/assist/detect-question`         | Detect whether the candidate has been asked the question   |
| POST   | `/api/assist/final`                   | Produce the final candidate evaluation                     |

### WebSockets
| Path                    | Direction                         | Description                                                              |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `/ws/ingest-call`       | Browser → Backend (binary frames) | PCM16 / 16 kHz / 20 ms audio frames forwarded to Deepgram                |
| `/ws/session`           | Backend → Browser (JSON events)   | `transcript.partial` / `transcript.final` / `suggestion.end` / `relabel` |

---

## Key Features

- **Single OL session** — Verifies the J2W OfferLetter `authToken` cookie via shared HS256 secret. No second login.
- **Live mic capture** — AudioWorklet downsamples to PCM16/16 kHz/20 ms frames, transferred over `arraybuffer` WebSocket. Bytes-per-frame metrics surface on the UI.
- **Real-time transcription** — Deepgram (linear16, diarize: true, 16 kHz) with Sarvam/Shunya fallbacks; partial + final transcripts streamed back to the browser.
- **AI co-pilot loop** — `plan → next → verify → detect-question → final`. Question bank is generated up-front before the call begins; subsequent endpoints follow the rolling transcript.
- **English-only output** — All prompts enforce English in the response JSON schema so co-pilot suggestions stay readable regardless of candidate language.
- **Ephemeral candidates** — Resume parsed at interview time; nothing is persisted in a candidates table. The parsed snapshot is inlined into the interview document.
- **Single `ia_interviews` collection** — One document per interview holds transcript + summary + verdict + parties (recruiter, panel, candidate snapshot).
- **JD scoping** — Demands list is filtered through OL `jobAssignMappings` so a recruiter only sees their own assigned JDs.
- **Recording capture (optional)** — `/ws/wav-dump` writes audio to `./var/audio-dumps` with configurable retention.

---

## Authentication & Authorization

- **Cookie-based, single-session with OL.** Every REST + WS request must carry the J2W OfferLetter `authToken` cookie. The backend verifies it with `OL_JWT_KEY` (the same HS256 secret OfferLetter uses) and looks up the active session via `sessions.jti` to honour OL revocation.
- **No second login surface.** There is no `signIn` endpoint here — auth flows entirely through OfferLetter.
- **Role gating.** The frontend Interview Assist button is visible only to `super_admin`, `business_head`, `account_manager`, `lead`, `recruiter`. Server-side, route handlers re-verify the cookie on each request via `app.authenticate`.

---

## Background Workers

| Worker            | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `ingest-call ws`  | Forwards browser PCM16 audio into the Deepgram live socket    |
| `final evaluator` | Triggered on `POST /api/calls/:id/end` — runs the final LLM prompt against the full transcript and writes the verdict back to the interview document |
| `wav-dump ws`     | Optional — persists audio frames to disk under `var/audio-dumps` for replay / QA |

---

## Git Branching

- `master` — Production branch
- `development` — Active development branch
- `feature/*` — Feature branches merged into development

---

## License

Proprietary - JoulestoWatts Business Solutions Pvt. Ltd.
