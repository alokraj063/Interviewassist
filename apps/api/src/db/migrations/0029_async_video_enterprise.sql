-- Async Video Interview — enterprise rebuild. Additive only.
-- Every new table is org-scoped (org_id NOT NULL), FK-bound, CHECK-constrained,
-- and indexed on every filter/sort/cursor path. Adds an append-only audit log
-- for all state changes and grants the permission strings the routes enforce
-- (the legacy routes 403'd for every role — see grant block #10). Forward-only;
-- safe to re-run (IF NOT EXISTS / ON CONFLICT throughout).

BEGIN;

-- 1) Extend existing tables -------------------------------------------------
ALTER TABLE async_video_campaigns
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS outro_text text,
  ADD COLUMN IF NOT EXISTS intro_video_blob_key text,
  ADD COLUMN IF NOT EXISTS blind_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS require_device_check boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE async_video_campaigns
  DROP CONSTRAINT IF EXISTS async_video_campaigns_status_check,
  ADD CONSTRAINT async_video_campaigns_status_check
    CHECK (status IN ('draft','published','archived'));

-- Backfill status from the legacy is_published flag.
UPDATE async_video_campaigns
  SET status = CASE WHEN is_published THEN 'published' ELSE 'draft' END
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS async_video_campaigns_org_status_idx
  ON async_video_campaigns(org_id, status, created_at DESC);

ALTER TABLE async_video_submissions
  ADD COLUMN IF NOT EXISTS shortlisted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS drop_off_prompt_index integer,
  ADD COLUMN IF NOT EXISTS device_check jsonb,
  ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS async_video_submissions_org_status_idx
  ON async_video_submissions(org_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS async_video_submissions_shortlist_idx
  ON async_video_submissions(org_id, shortlisted, created_at DESC);

-- 2) Ordered questions ------------------------------------------------------
CREATE TABLE IF NOT EXISTS async_video_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES async_video_campaigns(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  kind text NOT NULL DEFAULT 'video' CHECK (kind IN ('video','audio')),
  text text NOT NULL,
  stimulus_text text,
  stimulus_blob_key text,
  prep_seconds integer NOT NULL DEFAULT 30 CHECK (prep_seconds BETWEEN 0 AND 600),
  max_seconds integer NOT NULL DEFAULT 120 CHECK (max_seconds BETWEEN 15 AND 600),
  max_retakes integer NOT NULL DEFAULT 0 CHECK (max_retakes BETWEEN 0 AND 5),
  competency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS async_video_questions_campaign_idx
  ON async_video_questions(campaign_id, position);
CREATE INDEX IF NOT EXISTS async_video_questions_org_idx
  ON async_video_questions(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS async_video_questions_campaign_pos_uq
  ON async_video_questions(campaign_id, position);

-- Backfill questions from the legacy prompts jsonb so existing campaigns keep
-- working under the normalized model.
INSERT INTO async_video_questions (org_id, campaign_id, position, text, max_seconds, max_retakes)
SELECT c.org_id, c.id, (ord - 1)::integer, (p->>'text'),
       c.max_seconds_per_prompt, c.max_retakes
FROM async_video_campaigns c
CROSS JOIN LATERAL jsonb_array_elements(c.prompts) WITH ORDINALITY AS e(p, ord)
WHERE NOT EXISTS (SELECT 1 FROM async_video_questions q WHERE q.campaign_id = c.id)
  AND coalesce(p->>'text','') <> '';

-- 3) Share links ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS async_video_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES async_video_submissions(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  label text,
  can_score boolean NOT NULL DEFAULT true,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS async_video_share_links_submission_idx
  ON async_video_share_links(submission_id, expires_at);
CREATE INDEX IF NOT EXISTS async_video_share_links_org_idx
  ON async_video_share_links(org_id);

-- 4) Scorecards -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS async_video_scorecards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES async_video_submissions(id) ON DELETE CASCADE,
  reviewer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  external_reviewer_label text,
  share_link_id uuid REFERENCES async_video_share_links(id) ON DELETE SET NULL,
  question_scores jsonb NOT NULL DEFAULT '[]'::jsonb,
  overall_score real CHECK (overall_score IS NULL OR (overall_score >= 0 AND overall_score <= 100)),
  recommendation text CHECK (recommendation IN ('strong_yes','yes','maybe','no','strong_no')),
  summary_note text,
  submitted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reviewer_user_id IS NOT NULL OR external_reviewer_label IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS async_video_scorecards_submission_idx
  ON async_video_scorecards(submission_id, submitted);
CREATE INDEX IF NOT EXISTS async_video_scorecards_reviewer_idx
  ON async_video_scorecards(reviewer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS async_video_scorecards_org_idx
  ON async_video_scorecards(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS async_video_scorecards_sub_reviewer_uq
  ON async_video_scorecards(submission_id, reviewer_user_id)
  WHERE reviewer_user_id IS NOT NULL;

-- 5) Comments ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS async_video_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES async_video_submissions(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  question_id uuid REFERENCES async_video_questions(id) ON DELETE SET NULL,
  timestamp_sec integer CHECK (timestamp_sec IS NULL OR timestamp_sec >= 0),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS async_video_comments_submission_idx
  ON async_video_comments(submission_id, created_at);
CREATE INDEX IF NOT EXISTS async_video_comments_org_idx
  ON async_video_comments(org_id);

-- 6) AI artifacts -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS async_video_ai_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES async_video_submissions(id) ON DELETE CASCADE,
  question_id uuid REFERENCES async_video_questions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('transcript','summary','skills')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','skipped')),
  provider text,
  model text,
  content jsonb,
  error_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS async_video_ai_submission_idx
  ON async_video_ai_artifacts(submission_id, kind, status);
CREATE INDEX IF NOT EXISTS async_video_ai_org_idx
  ON async_video_ai_artifacts(org_id);
-- one artifact per (submission, question-or-whole, kind); COALESCE folds NULL
-- question_id (whole-submission artifacts) onto the nil uuid for uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS async_video_ai_uq
  ON async_video_ai_artifacts(submission_id, COALESCE(question_id, '00000000-0000-0000-0000-000000000000'::uuid), kind);

-- 7) Append-only audit log --------------------------------------------------
CREATE TABLE IF NOT EXISTS async_video_audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_label text,
  action text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('campaign','submission','scorecard','share_link','invite')),
  target_id uuid NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS async_video_audit_target_idx
  ON async_video_audit_log(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS async_video_audit_org_idx
  ON async_video_audit_log(org_id, created_at DESC);

-- Append-only enforcement: block UPDATE and DELETE on the audit log.
CREATE OR REPLACE FUNCTION async_video_audit_log_immutable() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'async_video_audit_log is append-only (DELETE blocked)';
  END IF;
  RAISE EXCEPTION 'async_video_audit_log is append-only (UPDATE blocked)';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS async_video_audit_log_no_mutate ON async_video_audit_log;
CREATE TRIGGER async_video_audit_log_no_mutate
  BEFORE UPDATE OR DELETE ON async_video_audit_log
  FOR EACH ROW EXECUTE FUNCTION async_video_audit_log_immutable();

-- 8) Shared idempotency-key store (create IF NOT EXISTS for cross-page safety).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope text NOT NULL,
  key text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys(created_at);

-- 9) CRITICAL FIX — grant the async_video permissions that routes enforce but
--    no migration ever inserted (today every write 403s, even for admin). The
--    .write/.invite/.review strings are already referenced by the legacy code;
--    .read and .share are net-new. Grant to the default/template org literal
--    AND to every already-provisioned org (permissions are cloned per-org at
--    org creation, so a default-only insert would not reach JoulesToWatts etc.).

-- 9a. Default/template org grants.
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', r, p
FROM (VALUES
  ('admin','async_video.read'),('admin','async_video.write'),
  ('admin','async_video.invite'),('admin','async_video.review'),
  ('admin','async_video.share'),
  ('account_manager','async_video.read'),('account_manager','async_video.write'),
  ('account_manager','async_video.invite'),('account_manager','async_video.review'),
  ('account_manager','async_video.share'),
  ('delivery_lead','async_video.read'),('delivery_lead','async_video.write'),
  ('delivery_lead','async_video.invite'),('delivery_lead','async_video.review'),
  ('delivery_lead','async_video.share'),
  ('business_head','async_video.read'),('business_head','async_video.review'),
  ('recruiter','async_video.read'),('recruiter','async_video.invite'),
  ('recruiter','async_video.review'),
  ('qa_reviewer','async_video.read'),('qa_reviewer','async_video.invite'),
  ('qa_reviewer','async_video.review')
) AS x(r,p)
ON CONFLICT DO NOTHING;

-- 9b. Mirror the same grants into every org that already has role_permissions
--     rows (covers JoulesToWatts and any provisioned tenant). DISTINCT org_id
--     drives the fan-out; the role/permission matrix is the source of truth.
INSERT INTO role_permissions (org_id, role, permission)
SELECT DISTINCT rp.org_id, x.r, x.p
FROM role_permissions rp
CROSS JOIN (VALUES
  ('admin','async_video.read'),('admin','async_video.write'),
  ('admin','async_video.invite'),('admin','async_video.review'),
  ('admin','async_video.share'),
  ('account_manager','async_video.read'),('account_manager','async_video.write'),
  ('account_manager','async_video.invite'),('account_manager','async_video.review'),
  ('account_manager','async_video.share'),
  ('delivery_lead','async_video.read'),('delivery_lead','async_video.write'),
  ('delivery_lead','async_video.invite'),('delivery_lead','async_video.review'),
  ('delivery_lead','async_video.share'),
  ('business_head','async_video.read'),('business_head','async_video.review'),
  ('recruiter','async_video.read'),('recruiter','async_video.invite'),
  ('recruiter','async_video.review'),
  ('qa_reviewer','async_video.read'),('qa_reviewer','async_video.invite'),
  ('qa_reviewer','async_video.review')
) AS x(r,p)
ON CONFLICT DO NOTHING;

COMMIT;
