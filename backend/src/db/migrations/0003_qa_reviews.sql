-- QA reviews, resolution-vs-KB analysis cache, plus a handful of column
-- additions that enable Phase 2 audio sentiment without another migration.
--
-- Keep in sync with packages/db/src/schema.ts.

-- ---------- Column additions ----------
-- Phase 2 audio sentiment needs a persisted recording URL + provenance.
-- Nullable columns so existing call_sessions rows keep working.
ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS recording_url text,
  ADD COLUMN IF NOT EXISTS recording_duration_ms integer,
  ADD COLUMN IF NOT EXISTS recording_mime text;

-- Which model produced the stored sentiment for each turn. Populated by the
-- live AFINN path (="afinn") and overwritten by the post-call multilingual
-- rescore worker (e.g. "gpt-4o/multilingual").
ALTER TABLE transcript_turns
  ADD COLUMN IF NOT EXISTS sentiment_model text;

-- ---------- QA review decisions ----------
CREATE TABLE IF NOT EXISTS qa_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  reviewer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('accept','override','escalate')),
  note text,
  criterion_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewer_score integer,
  time_spent_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qa_reviews_call_idx ON qa_reviews(call_id, created_at);
CREATE INDEX IF NOT EXISTS qa_reviews_reviewer_idx ON qa_reviews(reviewer_user_id, created_at);
CREATE INDEX IF NOT EXISTS qa_reviews_org_idx ON qa_reviews(org_id, created_at);

-- ---------- Resolution-vs-KB analysis cache ----------
-- One row per call. First GET computes + caches; POST /recompute overwrites.
CREATE TABLE IF NOT EXISTS qa_resolution_analyses (
  call_id uuid PRIMARY KEY REFERENCES call_sessions(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  model_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Permission additions ----------
-- qa.override + qa.acoustic (new permissions introduced with this feature).
-- Granted to qa_reviewer, manager, and admin for the default org; existing
-- per-org matrices can add these via the Roles UI.
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'admin', p
FROM unnest(ARRAY['qa.override','qa.acoustic']) AS p
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'manager', p
FROM unnest(ARRAY['qa.override','qa.acoustic']) AS p
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'qa_reviewer', p
FROM unnest(ARRAY['qa.override','qa.acoustic']) AS p
ON CONFLICT DO NOTHING;
