# Backend ↔ Frontend — how they connect, and the full API

The app is two self-contained folders:

| Folder | What it is | Dev URL |
|---|---|---|
| `backend/` | Fastify API (HTTP + WebSocket) | `http://localhost:8787` |
| `frontend/` | Vite + React SPA | `http://localhost:8084` |

They talk over **HTTP (REST/JSON)** and **WebSockets**. The backend owns all data + AI; the frontend is a pure client.

---

## 1. The connection layer

### Base URLs (frontend → backend)
The frontend reads two env vars (from the shared root `.env`, loaded by Vite via `envDir: ".."`):

```
VITE_API_BASE_URL=http://localhost:8787     # REST base
VITE_WS_BASE_URL=ws://localhost:8787        # WebSocket base
```

Defined in `frontend/src/lib/api.ts`:
- `API_BASE` ← `VITE_API_BASE_URL` (defaults to `http://localhost:8787`).
- `getWsBase()` ← `VITE_WS_BASE_URL`, else derived from `API_BASE` (http→ws).

### Every REST call goes through `apiFetch()`
`frontend/src/lib/api.ts` → `apiFetch(path, { method, json })`:
1. Prefixes `API_BASE` (`fetch(\`${API_BASE}${path}\`)`).
2. Adds `Authorization: Bearer <accessToken>` (the access token lives in memory, not localStorage).
3. On `401`, silently calls `POST /api/auth/refresh` (httpOnly refresh cookie) **once** and retries; if that fails, it bubbles the error (the UI redirects to sign-in).
4. Returns parsed JSON or throws an `ApiError` carrying the response body.

React Query wraps `apiFetch` for caching (`useQuery`/`useMutation`).

### Auth flow
```
POST /api/auth/login  ─→  { accessToken, user }   (+ httpOnly refresh cookie)
        access token kept in memory ──► sent as Bearer on every apiFetch
        on 401 ──► POST /api/auth/refresh (cookie) ──► new access token ──► retry
```
The backend verifies the JWT in a Fastify `authenticate` hook, then hydrates `req.authUser` (org + permissions). Routes gate with `requirePermission("...")`.

### WebSockets (the live audio pipeline)
`<audio>`/WS can't set headers, so the JWT is passed as `?token=<jwt>` (the backend's `authenticate` promotes `?token` to a Bearer header).

- **`/ws/ingest-call`** — browser mic → PCM16 16kHz frames → backend → Deepgram. The recorder hook `useWedgeCall` opens it with the `wsIngestUrl` the API returned from `POST /api/calls`.
- **`/ws/session`** — backend → browser: live transcript turns, speaker relabels, sentiment, suggestions. Opened with `wsSessionUrl`.

`POST /api/calls` returns both URLs (`wsIngestUrl`, `wsSessionUrl`) so the client never hard-codes them.

---

## 2. The interview-call sequence (how the feature uses the APIs)

```
1. Setup     GET  /api/demands                 → pick a JD
             GET  /api/candidates              → pick a candidate
             GET  /api/question-banks?demandId → JD-linked question bank
2. Start     POST /api/calls                   → { callId, wsIngestUrl, wsSessionUrl }
             POST /api/assist/plan {callId}     → fit read + 20 Easy/Medium/Hard questions
             POST /api/assist/next  {callId,history,transcript} → first question
3. Live      WS   /ws/ingest-call  (mic frames out)
             WS   /ws/session       (transcript + speaker labels + sentiment in)
             POST /api/assist/detect-question   → catch recruiter's off-script question
             POST /api/assist/verify {question,answer} → "did they answer?" → advance
             POST /api/assist/next               → next in-context question
4. End       POST /api/calls/:id/end             (closes recording, audio-cost recorded)
             POST /api/assist/final {callId,history} → verdict + rubric scores + summary (saved)
5. Cost      GET  /api/assist/usage              → tokens + Deepgram audio cost, per call
```

Resume/JD ingestion (the **JD & Résumé** tab):
```
POST /api/demands/parse-jd          (multipart)  → extract JD text
POST /api/demands                                 → create the JD
POST /api/question-banks/:id/link-demand          → tie a bank to the JD
POST /api/candidates/parse-resume-preview (multipart) → parse résumé
POST /api/candidates                              → create the candidate
```

---

## 3. Full API reference

Base path shown per group. ✅ = used by the Live Assist feature today.

### Health
| Method | Path | |
|---|---|---|
| GET | `/health` | ✅ liveness |
| GET | `/health/db` | DB ping |

### Auth — `/api/auth`
| Method | Path | |
|---|---|---|
| POST | `/api/auth/login` | ✅ → `{accessToken, user}` |
| POST | `/api/auth/refresh` | ✅ silent token refresh (cookie) |
| POST | `/api/auth/logout` | ✅ |
| GET | `/api/auth/me` | ✅ current user + permissions |
| POST | `/api/auth/signup` | 410 (signup closed) |
| POST | `/api/auth/verify-email` · `/reset-password` | account recovery |
| GET/POST | `/api/auth/invitations/:token` · `/invitations/accept` | invite acceptance |

### Interview co-pilot — `/api/assist` (the heart of the feature)
| Method | Path | |
|---|---|---|
| POST | `/api/assist/plan` | ✅ fit read + 20 graded questions from JD + résumé |
| POST | `/api/assist/next` | ✅ next question (uses last ~10 transcript turns) |
| POST | `/api/assist/verify` | ✅ did the candidate answer? (Strong/Adequate/Weak…) |
| POST | `/api/assist/detect-question` | ✅ catch recruiter's off-script question (content-based) |
| POST | `/api/assist/final` | ✅ final verdict + rubric scores + summary (saved to call) |
| GET | `/api/assist/:callId/evaluation` | ✅ re-read a saved evaluation |
| GET | `/api/assist/usage` | ✅ token + Deepgram audio cost (totals, by op, by model, per call) |

### Calls — `/api/calls`
| Method | Path | |
|---|---|---|
| POST | `/api/calls` | ✅ create a call → `{callId, wsIngestUrl, wsSessionUrl}` |
| POST | `/api/calls/:id/end` | ✅ end call (closes recording, records audio cost) |
| GET | `/api/calls` · `/api/calls/:id` | list / detail |
| GET | `/api/calls/:id/recording` | auth WAV stream (range) |
| GET | `/api/calls/:id/context` | candidate + demand context card |
| POST | `/api/calls/:id/manual-speaker-bracket` | manual "I'm/candidate speaking" |
| POST | `/api/calls/:id/transcripts` | transcript ingest (bridge) |
| GET | `/api/calls/:id/rubric · /jd-match · /technical-qa` | post-call tabs (placeholder) |
| POST/GET | `/api/calls/:id/translation*` | live translation toggles |

### Candidates — `/api/candidates`
| Method | Path | |
|---|---|---|
| GET | `/api/candidates` | ✅ list / search (setup picker) |
| POST | `/api/candidates` | ✅ create candidate |
| POST | `/api/candidates/parse-resume-preview` | ✅ upload + AI-parse résumé (multipart) |
| POST | `/api/candidates/dedup-check` | email/phone dedup |
| GET/PATCH | `/api/candidates/:id` | detail / update |
| POST/GET | `/api/candidates/:id/resume · /resumes/:rid/file` | attach / fetch résumé |

### Demands (JDs) — `/api/demands`
| Method | Path | |
|---|---|---|
| GET | `/api/demands` | ✅ list (setup picker) |
| POST | `/api/demands` | ✅ create JD (needs `demands.write`) |
| POST | `/api/demands/parse-jd` | ✅ upload + extract JD text (multipart) |
| GET | `/api/demands/:id` · `/:id/prospects` · `/:id/submissions` · `/:id/insights` | detail |
| POST/PATCH | `/api/demands/:id` · `/:id/assignments` | update / assign |

### Question banks — `/api/question-banks`
| Method | Path | |
|---|---|---|
| GET | `/api/question-banks?demandId=` | ✅ JD-linked bank(s) |
| GET | `/api/question-banks/:id/questions` | ✅ questions in a bank |
| POST | `/api/question-banks/:id/link-demand` | ✅ tie a bank to a JD |
| GET/POST/PATCH | `/api/question-banks` … | full CRUD + review/approve + import/generate |

### Clients · Prospects · Org · Users · Teams · Roles · Platform · KB
| Group | Base | Notes |
|---|---|---|
| Clients | `/api/clients` | list/create clients (JD owner) |
| Prospects | `/api/prospects` | ✅ setup picker uses `/api/demands/:id/prospects` |
| Org | `/api/org` | workspace info |
| Users | `/api/users/me` | profile update |
| Teams | `/api/teams` | team CRUD |
| Roles | `/api/roles/check` | permission check |
| Platform | `/api/platform/orgs…` | super-admin: tenants + per-tenant credentials |
| Knowledge base | `/api/kb/…` | collections, sources, search, eval, feedback (RAG corpus) |

### WebSockets
| Path | Direction | |
|---|---|---|
| `/ws/ingest-call?callId=&token=` | browser → backend | ✅ mic PCM16 frames → Deepgram |
| `/ws/session?callId=&token=` | backend → browser | ✅ transcript / speaker / sentiment / suggestions |
| `/ws/ingest` | desktop dual-channel (legacy) | |
| `/ws/custom-transcriber` | Vapi → backend (Sarvam/Shunya) | |
| `/ws/agent` | supervisor/agent events | |

---

## 4. Auth & permissions (server side)

- JWT verified in `backend/src/server.ts` `app.authenticate` (Bearer header **or** `?token=`).
- `req.authUser` carries `orgId` + `permissions`; routes gate with `app.requirePermission("demands.write")` etc.
- Multi-tenant: every query is org-scoped; platform admins use `app.requirePlatformAdmin`.
- The recruiter role can create JDs + candidates + link banks (migration `0039`).

---

## 5. Run them

```bash
./dev.sh          # backend + frontend + containers (full app)
./backend.sh      # backend API only (serves all the APIs above)
```
