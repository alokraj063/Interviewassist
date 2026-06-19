-- Rubrics page (enterprise rebuild): immutable published versions, append-only
-- audit, weighting + status + behavioral anchors, page-private idempotency.
-- Additive only; org-scoped; CHECK + FK + index on every filter/sort path.
-- Forward-only. Safe to re-run (IF NOT EXISTS / ON CONFLICT throughout).

BEGIN;

-- 1) Extend the rubric head ---------------------------------------------------
ALTER TABLE call_rubrics
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS applies_to text[] NOT NULL DEFAULT ARRAY['call']::text[],
  ADD COLUMN IF NOT EXISTS published_version integer,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE call_rubrics
  DROP CONSTRAINT IF EXISTS call_rubrics_status_chk,
  ADD CONSTRAINT call_rubrics_status_chk CHECK (status IN ('draft','published','archived'));

-- Every element of applies_to must be a known surface, and at least one.
ALTER TABLE call_rubrics
  DROP CONSTRAINT IF EXISTS call_rubrics_applies_to_chk,
  ADD CONSTRAINT call_rubrics_applies_to_chk
    CHECK (applies_to <@ ARRAY['call','coaching','async_video','assessment']::text[]
           AND array_length(applies_to, 1) >= 1);

-- Existing seeded rows are effectively published defaults — promote them so the
-- finalize worker keeps reading a live published version.
UPDATE call_rubrics SET status = 'published', published_version = version
  WHERE status = 'draft' AND jsonb_array_length(criteria) > 0;

CREATE INDEX IF NOT EXISTS call_rubrics_org_updated_idx ON call_rubrics(org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS call_rubrics_org_status_idx  ON call_rubrics(org_id, status);
CREATE INDEX IF NOT EXISTS call_rubrics_org_name_idx    ON call_rubrics(org_id, lower(name));

-- 2) Immutable published versions --------------------------------------------
CREATE TABLE IF NOT EXISTS call_rubric_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rubric_id uuid NOT NULL REFERENCES call_rubrics(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  purpose text NOT NULL CHECK (purpose IN
    ('general_screen','technical_screen','senior_technical','hr_screen','outbound_pitch')),
  name text NOT NULL,
  published_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  change_note text,
  CONSTRAINT call_rubric_versions_nonempty_chk CHECK (jsonb_array_length(criteria) >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS call_rubric_versions_rubric_version_key
  ON call_rubric_versions(rubric_id, version);
CREATE INDEX IF NOT EXISTS call_rubric_versions_org_idx
  ON call_rubric_versions(org_id, rubric_id);

-- Backfill a published snapshot for every already-published rubric so existing
-- call_rubric_scores can resolve their pinned criteria.
INSERT INTO call_rubric_versions (org_id, rubric_id, version, criteria, purpose, name, published_at)
SELECT org_id, id, version, criteria, purpose, name, updated_at
  FROM call_rubrics
 WHERE status = 'published' AND jsonb_array_length(criteria) >= 1
ON CONFLICT (rubric_id, version) DO NOTHING;

-- 3) Append-only audit --------------------------------------------------------
-- rubric_id is ON DELETE SET NULL with a rubric_name snapshot so the deletion
-- trace survives a hard-delete of an unused rubric (FK CASCADE would erase it).
CREATE TABLE IF NOT EXISTS rubric_audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rubric_id uuid REFERENCES call_rubrics(id) ON DELETE SET NULL,
  rubric_name text,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN
    ('created','updated','published','unpublished','archived','restored',
     'set_default','cleared_default','duplicated','imported','deleted')),
  from_version integer,
  to_version integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rubric_audit_log_rubric_idx ON rubric_audit_log(rubric_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rubric_audit_log_org_idx    ON rubric_audit_log(org_id, created_at DESC);

-- Append-only enforcement: block all DELETEs and any UPDATE that would tamper
-- with the recorded content. The ONE permitted UPDATE is the FK-driven
-- rubric_id -> NULL that fires when a referenced rubric is hard-deleted (that
-- is the intended "preserve the deletion trace" mechanism — every other column
-- stays identical). Any content edit (action/metadata/actor/timestamps/etc.)
-- is rejected.
CREATE OR REPLACE FUNCTION rubric_audit_log_immutable() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'rubric_audit_log is append-only (DELETE blocked)';
  END IF;
  -- UPDATE: only allow the FK SET NULL on rubric_id; everything else immutable.
  IF (NEW.id IS DISTINCT FROM OLD.id
      OR NEW.org_id IS DISTINCT FROM OLD.org_id
      OR NEW.rubric_name IS DISTINCT FROM OLD.rubric_name
      OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
      OR NEW.action IS DISTINCT FROM OLD.action
      OR NEW.from_version IS DISTINCT FROM OLD.from_version
      OR NEW.to_version IS DISTINCT FROM OLD.to_version
      OR NEW.metadata IS DISTINCT FROM OLD.metadata
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR (NEW.rubric_id IS DISTINCT FROM OLD.rubric_id AND NEW.rubric_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'rubric_audit_log is append-only (content UPDATE blocked)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS rubric_audit_log_no_mutate ON rubric_audit_log;
CREATE TRIGGER rubric_audit_log_no_mutate
  BEFORE UPDATE OR DELETE ON rubric_audit_log
  FOR EACH ROW EXECUTE FUNCTION rubric_audit_log_immutable();

-- 4) Page-private idempotency ledger -----------------------------------------
CREATE TABLE IF NOT EXISTS rubric_idempotency_keys (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  created_rubric_id uuid REFERENCES call_rubrics(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key)
);
CREATE INDEX IF NOT EXISTS rubric_idempotency_keys_created_idx
  ON rubric_idempotency_keys(created_at);

-- 5) Permission grants --------------------------------------------------------
-- rubrics.read / rubrics.write already exist for admin/business_head/etc., but
-- qa_reviewer (the QA-lead persona that authors + publishes rubrics) only had
-- rubrics.read. Grant rubrics.write to qa_reviewer across the template org AND
-- every existing tenant (permissions are cloned per-org at org creation, so a
-- template-only insert would not reach already-provisioned tenants).
-- Idempotent via ON CONFLICT DO NOTHING.
INSERT INTO role_permissions (org_id, role, permission)
SELECT DISTINCT org_id, 'qa_reviewer', 'rubrics.write'
  FROM role_permissions
 WHERE role = 'qa_reviewer'
ON CONFLICT DO NOTHING;

-- Ensure the template org has it too (in case no qa_reviewer rows exist yet).
INSERT INTO role_permissions (org_id, role, permission)
VALUES ('00000000-0000-0000-0000-000000000000', 'qa_reviewer', 'rubrics.write')
ON CONFLICT DO NOTHING;

COMMIT;
