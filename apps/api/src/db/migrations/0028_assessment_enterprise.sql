-- Assessment Authoring enterprise rebuild.
-- Additive only. Every new table is org-scoped (org_id NOT NULL), FK-bound,
-- CHECK-constrained, and indexed on every filter/sort/cursor path. Adds an
-- append-only audit log for all state changes. Forward-only; safe to re-run
-- (IF NOT EXISTS / ON CONFLICT throughout).

BEGIN;

-- 1. Extend assessment_templates -----------------------------------------
ALTER TABLE assessment_templates
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS published_version integer,
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS proctoring_policy jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE assessment_templates
  DROP CONSTRAINT IF EXISTS assessment_templates_status_check,
  ADD CONSTRAINT assessment_templates_status_check
    CHECK (status IN ('draft','published','archived'));

-- backfill status from legacy is_published flag
UPDATE assessment_templates SET status = 'published'
  WHERE is_published = true AND status = 'draft';

CREATE INDEX IF NOT EXISTS assessment_templates_org_status_idx
  ON assessment_templates(org_id, status, created_at DESC);
-- keyset cursor path (created_at, id) for stable pagination
CREATE INDEX IF NOT EXISTS assessment_templates_org_cursor_idx
  ON assessment_templates(org_id, created_at DESC, id DESC);

-- 2. Sections ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES assessment_templates(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  position integer NOT NULL DEFAULT 0,
  time_limit_seconds integer CHECK (time_limit_seconds IS NULL OR time_limit_seconds > 0),
  shuffle_items boolean NOT NULL DEFAULT false,
  pool_draw_count integer CHECK (pool_draw_count IS NULL OR pool_draw_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assessment_sections_template_idx ON assessment_sections(template_id, position);
CREATE INDEX IF NOT EXISTS assessment_sections_org_idx ON assessment_sections(org_id);

-- 3. Items ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES assessment_templates(id) ON DELETE CASCADE,
  section_id uuid REFERENCES assessment_sections(id) ON DELETE SET NULL,
  source_question_id uuid REFERENCES question_bank_questions(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN
    ('mcq_single','mcq_multi','true_false','short_answer','long_answer','coding','file_upload','video_response')),
  position integer NOT NULL DEFAULT 0,
  prompt text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  points integer NOT NULL DEFAULT 1 CHECK (points >= 0),
  negative_points integer NOT NULL DEFAULT 0 CHECK (negative_points >= 0),
  partial_credit boolean NOT NULL DEFAULT false,
  required boolean NOT NULL DEFAULT true,
  time_limit_seconds integer CHECK (time_limit_seconds IS NULL OR time_limit_seconds > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assessment_items_template_idx ON assessment_items(template_id, position);
CREATE INDEX IF NOT EXISTS assessment_items_section_idx ON assessment_items(section_id, position);
CREATE INDEX IF NOT EXISTS assessment_items_org_idx ON assessment_items(org_id);
CREATE INDEX IF NOT EXISTS assessment_items_source_idx ON assessment_items(source_question_id);

-- 4. Immutable versions --------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES assessment_templates(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  published_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);
CREATE INDEX IF NOT EXISTS assessment_versions_org_idx ON assessment_versions(org_id);

-- 5. Extend attempts -----------------------------------------------------
ALTER TABLE assessment_attempts
  ADD COLUMN IF NOT EXISTS version_id uuid REFERENCES assessment_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS server_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_score integer,
  ADD COLUMN IF NOT EXISTS manual_score integer,
  ADD COLUMN IF NOT EXISTS max_score integer,
  ADD COLUMN IF NOT EXISTS pass_band text,
  ADD COLUMN IF NOT EXISTS item_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reviewer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reminders_sent integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- widen status CHECK to include 'revoked'
ALTER TABLE assessment_attempts DROP CONSTRAINT IF EXISTS assessment_attempts_status_check;
ALTER TABLE assessment_attempts ADD CONSTRAINT assessment_attempts_status_check
  CHECK (status IN ('invited','started','submitted','reviewed','expired','revoked'));

-- keyset cursor + filter paths for the attempts list
CREATE INDEX IF NOT EXISTS assessment_attempts_org_cursor_idx
  ON assessment_attempts(org_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS assessment_attempts_org_status_idx
  ON assessment_attempts(org_id, status, created_at DESC);

-- 6. Audit log (append-only) ---------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN (
    'template.created','template.updated','template.published','template.unpublished',
    'template.duplicated','template.archived','item.created','item.updated','item.deleted',
    'item.reordered','invite.created','invite.resent','invite.revoked','attempt.started',
    'attempt.submitted','attempt.autograded','attempt.reviewed','attempt.reopened')),
  target_kind text NOT NULL,
  target_id uuid,
  template_id uuid REFERENCES assessment_templates(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assessment_audit_template_idx ON assessment_audit_log(template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS assessment_audit_org_idx ON assessment_audit_log(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS assessment_audit_target_idx ON assessment_audit_log(target_kind, target_id);

-- Append-only enforcement: block DELETE and any content UPDATE. The only
-- permitted UPDATE is the FK-driven template_id -> NULL when a referenced
-- template is hard-deleted (CASCADE deletes the row, so in practice no UPDATE
-- happens; this guards manual tampering).
CREATE OR REPLACE FUNCTION assessment_audit_log_immutable() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'assessment_audit_log is append-only (DELETE blocked)';
  END IF;
  RAISE EXCEPTION 'assessment_audit_log is append-only (UPDATE blocked)';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS assessment_audit_log_no_mutate ON assessment_audit_log;
CREATE TRIGGER assessment_audit_log_no_mutate
  BEFORE UPDATE OR DELETE ON assessment_audit_log
  FOR EACH ROW EXECUTE FUNCTION assessment_audit_log_immutable();

-- 7. Idempotency-key store for create/invite/send -----------------------
-- shared utility table; create IF NOT EXISTS so cross-page co-creation is safe.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope text NOT NULL,            -- e.g. 'assessment.template.create'
  key text NOT NULL,
  response jsonb,                 -- cached response body to replay
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys(created_at);

-- 8. CRITICAL FIX — grant the assessment permissions that routes already
--    enforce but no migration ever inserted (today every write 403s, even for
--    admin). Grant to the template/default org literal AND to every existing
--    org (permissions are cloned per-org at org creation, so a default-only
--    insert would not reach already-provisioned tenants such as JoulesToWatts).

-- 8a. Default/template org grants.
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', r, p
FROM (VALUES
  ('admin','assessments.read'),('admin','assessments.write'),
  ('admin','assessments.invite'),('admin','assessments.review'),
  ('recruiter','assessments.read'),('recruiter','assessments.write'),
  ('recruiter','assessments.invite'),
  ('delivery_lead','assessments.read'),('delivery_lead','assessments.write'),
  ('delivery_lead','assessments.invite'),('delivery_lead','assessments.review'),
  ('account_manager','assessments.read'),
  ('business_head','assessments.read'),('business_head','assessments.review'),
  ('qa_reviewer','assessments.read'),('qa_reviewer','assessments.review')
) AS x(r,p)
ON CONFLICT DO NOTHING;

-- 8b. Mirror the same grants into every org that already has role_permissions
--     rows (covers JoulesToWatts and any provisioned tenant). DISTINCT org_id
--     drives the fan-out; the role/permission matrix is the source of truth.
INSERT INTO role_permissions (org_id, role, permission)
SELECT DISTINCT rp.org_id, x.r, x.p
FROM role_permissions rp
CROSS JOIN (VALUES
  ('admin','assessments.read'),('admin','assessments.write'),
  ('admin','assessments.invite'),('admin','assessments.review'),
  ('recruiter','assessments.read'),('recruiter','assessments.write'),
  ('recruiter','assessments.invite'),
  ('delivery_lead','assessments.read'),('delivery_lead','assessments.write'),
  ('delivery_lead','assessments.invite'),('delivery_lead','assessments.review'),
  ('account_manager','assessments.read'),
  ('business_head','assessments.read'),('business_head','assessments.review'),
  ('qa_reviewer','assessments.read'),('qa_reviewer','assessments.review')
) AS x(r,p)
ON CONFLICT DO NOTHING;

COMMIT;
