# AI Interview backend — OfferLetter SSO migration

This service used to run its own multi-tenant world: its own `users`,
`organizations`, `memberships`, `clients`, `demands`, `candidates`,
`question_banks` and a separate `/api/auth/login` flow. **None of that is
needed when the recruiter is already logged into the OfferLetter (OL) app.**

The changes below tear that out and rewire the service to:

1. **Verify the OL cookie directly** — shared `JWT_KEY` secret, no second login.
2. **Pull jobs live from OL's `jobPostings`** — scoped to the logged-in recruiter
   via OL's `jobAssignMappings` (one row per recruiter assigned to a job).
3. **Ephemeral candidates** — résumé is parsed at call-start, the parsed JSON
   lives **inline** on the call session document, and there is no `candidates`
   collection any more.
4. **Same MongoDB cluster** as OL — both apps point at the same Mongo. Locally,
   `mongodb://localhost:27017/j2w_offerletter_2026` is the default.
5. **Keep every transcript** — `ia_transcriptTurns` + `ia_callSessions` +
   `ia_evaluations` are owned by this service so recruiters can re-open any
   past interview and replay the conversation + see the AI verdict.

---

## What changed (file-by-file)

### `src/env.ts`
- Added `OL_JWT_KEY` (same value as OL's `JWT_KEY`).
- Added `OL_AUTH_COOKIE_NAME` (default `authToken`) and
  `OL_VERIFY_SESSION_REVOCATION` (default `true`).
- `MONGO_DB` default flipped to `j2w_offerletter_2026` (shared with OL).
- `JWT_SECRET` is now optional with a placeholder default — we don't sign any
  tokens here any more.

### `src/auth/olAuth.ts` *(new)*
The single piece of code that verifies incoming requests. Mirrors OL's
`backend/middleware/jwtMiddleware.js`:
1. Reads `authToken` cookie / `Authorization: Bearer` / `?token=`.
2. `jwt.verify(token, OL_JWT_KEY)` (HS256, payload `{ uid, role, jti }`).
3. If `jti` is set and `OL_VERIFY_SESSION_REVOCATION=true`, looks up the
   `sessions` collection and rejects when `revokedAt` is set.
4. Resolves the actor with `users.findOne({ uid: decoded.uid })`.
5. Returns `OlAuthUser` — `{ uid, mongoId, email, name, role, jti }`.

### `src/auth/context.ts`, `password.ts`, `tokens.ts` *(deleted)*
The old `loadAuthUser` walked our own `users` → `memberships` →
`role_permissions` chain. All three files removed.

### `src/server.ts`
- `authenticate` decorator now calls `authenticateOl(request)`.
- `requirePermission(perm)` becomes "logged-in only" — fine-grained gates are
  enforced by OL.
- `requirePlatformAdmin` accepts `role === "UserAdmin"`.
- **Removed** route registrations:
  `authRoutes`, `clientsRoutes`, `prospectsRoutes`, `usersRoutes`,
  `teamsRoutes`, `rolesRoutes`, `orgRoutes`, `platformRoutes`,
  `questionBanksRoutes`. The corresponding route files were deleted.

### `src/mongo.ts`
Split collection accessors into two groups:

| Group | Accessors | Notes |
|---|---|---|
| **OL-owned, read-only** | `olUsers`, `olSessions`, `olJobPostings`, `olJobAssignMappings`, `olClients` | Names match OL's actual collection names. |
| **IA-owned, writeable** | `callSessions`, `transcriptTurns`, `suggestions`, `evaluations`, `aiUsageEvents` | All prefixed with `ia_` on disk so they can't collide with OL when we share a cluster. |

Legacy `users`, `organizations`, `memberships`, etc. accessors are still
exported but point at `ia_*_legacy` namespaces — no real reads/writes ever
land in OL collections by accident.

`ensureIndexes()` now only touches the `ia_*` collections.

### `src/routes/demands.ts`
- `GET /api/demands` — finds every `jobAssignMappings` row for
  `userId === req.authUser.mongoId` and `status === "assigned"`, then loads
  those `jobPostings` (excluding `Closed`/`Hold`) and joins the client name.
  Returns the same `{ demands: [...] }` shape the inter/frontend hook expects.
- `GET /api/demands/:id` — ownership-checked detail.
- Old `POST /` (create), `parse-jd`, prospects, submissions are **gone** —
  those are OL surfaces.

### `src/routes/candidates.ts`
- `POST /api/candidates/parse-resume-preview` — kept as the ephemeral résumé
  parser. Returns `{ parsed, blobKey, modelUsed, ... }` for the caller to
  pass into `POST /api/calls`.
- `GET /api/candidates` returns `{ candidates: [] }` (no listing, for graceful
  back-compat with stale clients).
- Everything else (create, get, patch, attach résumé) returns **410 Gone**
  with `error: "candidate_persistence_removed"`.

### `src/routes/calls.ts`
- `POST /api/calls` accepts `{ demandId, candidate, transcription, mode, ... }`.
  `demandId` is OL's `jobPostings._id` hex; ownership is re-verified through
  `jobAssignMappings`. The `candidate` object is whatever you have — name +
  parsed résumé JSON is plenty.
- A **demand snapshot** is written onto the call session at creation time so
  the call's display info survives even if the JD is later edited/closed.
- Recruiter ownership is enforced on every call route by comparing
  `call.recruiterUserId === req.authUser.uid`.
- New `GET /api/calls/:id/transcripts` returns the full ordered transcript
  for the post-call review screen.

### `src/routes/assist.ts`
- `loadJdResume(callId, recruiterUserId)` now reads from the **inline**
  `demandSnapshot` and `candidate` on the call session — no `demands` or
  `candidates` queries.
- `req.authUser.orgId` → `req.authUser.uid` everywhere (usage events are
  attributed per-recruiter).
- `call.orgId` → `call.recruiterUserId`.

### `src/integrations/resolver.ts`
- Multi-tenant `tenant_integrations` lookup deleted. Every provider falls
  back to env vars only (single-tenant mode for this whole service).
- `listTenantIntegrations` kept as a stub returning `[]` to avoid breaking
  any background importer.

### `src/db/seed.ts` *(deleted)*
Seeded internal users / orgs / memberships that no longer exist.

---

## Environment

Add to `recruit-assist-ai/.env` (or the root `.env` if you're sharing one):

```
# OL SSO
OL_JWT_KEY=7ff3629c451a6088086ea601e16cf11bd4e8ec3f-secret-j2w-offerletter-2026-key
OL_AUTH_COOKIE_NAME=authToken
OL_VERIFY_SESSION_REVOCATION=true

# Mongo — same cluster + DB as OL
MONGO_URL=mongodb://localhost:27017                 # or OL's STAGING_MONGOURI_LOCAL
MONGO_DB=j2w_offerletter_2026                       # OL's DB name
```

Set `OL_VERIFY_SESSION_REVOCATION=false` in local dev when minting test JWTs
that don't have a matching `sessions` row.

---

## Verified end-to-end

1. **Auth — no token → 401**
   ```bash
   curl -s http://localhost:8787/api/demands
   # → {"error":"unauthorized"}
   ```

2. **Auth — OL Bearer JWT → 200**
   ```bash
   curl -s -H "Authorization: Bearer $OL_JWT" http://localhost:8787/api/demands
   # → {"demands":[ ... assigned jobs ... ]}
   ```

3. **Auth — OL cookie → 200** (same result; both transports supported).

4. **Demands are scoped** — a recruiter with zero `jobAssignMappings` rows
   gets `{"demands":[]}`. Seed one mapping and the matching job appears.

5. **Call lifecycle**
   ```bash
   # Create
   curl -X POST -H "Authorization: Bearer $OL_JWT" \
        -H 'Content-Type: application/json' \
        -d '{"demandId":"<hex>","candidate":{"name":"Aarti","email":"a@x"}}' \
        http://localhost:8787/api/calls
   # → { callId, wsIngestUrl, wsSessionUrl, demand, candidate }

   # End
   curl -X POST -H "Authorization: Bearer $OL_JWT" http://localhost:8787/api/calls/$CALL_ID/end
   # → {"ok":true}

   # List (recruiter-scoped)
   curl -H "Authorization: Bearer $OL_JWT" http://localhost:8787/api/calls
   ```

6. **Demand not assigned → 403**
   `POST /api/calls` with a `demandId` the recruiter doesn't own returns
   `{"error":"demand_not_assigned"}`.

---

## Things to know

- **Recruiter ID format**: throughout the IA-owned collections, the recruiter
  is identified by `recruiterUserId = User.uid` (the OL business UID string).
  We also keep `recruiterMongoId` on the call session for any join back into
  the OL collections.
- **Demand ID format**: API surfaces `id` as the OL job posting's Mongo
  `_id` hex. The OL `uid` is also returned as `uid` for logging.
- **Candidate "ID"**: there is no addressable candidate. If the post-call
  review needs to surface "the candidate from call X", read it from
  `call.candidate` directly.
- **Transcripts** are persisted to `ia_transcriptTurns` by the existing
  `/ws/session` pipeline — no changes there. `GET /api/calls/:id/transcripts`
  now exposes the history sorted by `t` (turn timestamp).
- **Removed routes** that returned 404/410 now: every `/api/clients/*`,
  `/api/prospects/*`, `/api/users/*`, `/api/teams/*`, `/api/roles/*`,
  `/api/org/*`, `/api/platform/*`, `/api/question-banks/*`,
  `/api/auth/*`. The OL app owns those surfaces.
