-- Question Bank enterprise rebuild: governance, versioning, rich tagging,
-- calibration cache, usage facts, review/approval workflow, bulk import, audit.
-- Forward-only, additive, idempotent. All new tables org-scoped (org_id NOT NULL).
-- Order: alter existing -> backfill -> create new -> indexes -> CHECKs -> grants.

-- ===========================================================================
-- 1) question_banks: governance + soft-archive + optimistic-concurrency token
-- ===========================================================================
ALTER TABLE question_banks
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS default_language text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

DO $$ BEGIN
  ALTER TABLE question_banks
    ADD CONSTRAINT question_banks_status_check CHECK (status IN ('active','archived'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE question_banks
    ADD CONSTRAINT question_banks_lang_check CHECK (default_language IN ('en','hi','hinglish'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS question_banks_org_status_idx
  ON question_banks (org_id, status, updated_at DESC);

-- ===========================================================================
-- 2) question_bank_questions: tagging / lifecycle / version / dedup / calibration
-- ===========================================================================
ALTER TABLE question_bank_questions
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS question_type text NOT NULL DEFAULT 'verbal',
  ADD COLUMN IF NOT EXISTS role_family text,
  ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS current_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS calibrated_difficulty numeric(4,3),
  ADD COLUMN IF NOT EXISTS exposure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill org_id from the parent bank.
UPDATE question_bank_questions q
  SET org_id = b.org_id
  FROM question_banks b
  WHERE q.bank_id = b.id AND q.org_id IS NULL;

-- Existing pre-rebuild rows are treated as already-approved corpus.
UPDATE question_bank_questions
  SET status = 'approved'
  WHERE status = 'draft' AND content_hash IS NULL;

-- Backfill content_hash = sha256(lower(trim(prompt))) — duplicate detection key.
-- pgcrypto digest() is available (CREATE EXTENSION pgcrypto in pg-init).
UPDATE question_bank_questions
  SET content_hash = encode(digest(lower(btrim(prompt)), 'sha256'), 'hex')
  WHERE content_hash IS NULL;

-- Backfill skill_id from legacy metadata->>'skill' (insert missing skills).
INSERT INTO skills (name)
  SELECT DISTINCT btrim(metadata->>'skill')
  FROM question_bank_questions
  WHERE metadata ? 'skill' AND btrim(metadata->>'skill') <> ''
  ON CONFLICT (name) DO NOTHING;

UPDATE question_bank_questions q
  SET skill_id = s.id
  FROM skills s
  WHERE q.skill_id IS NULL
    AND q.metadata ? 'skill'
    AND lower(s.name) = lower(btrim(q.metadata->>'skill'));

-- Now that backfills are done, tighten NOT NULLs.
ALTER TABLE question_bank_questions ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE question_bank_questions ALTER COLUMN content_hash SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE question_bank_questions
    ADD CONSTRAINT qbq_status_check CHECK (status IN ('draft','in_review','approved','rejected','archived'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE question_bank_questions
    ADD CONSTRAINT qbq_language_check CHECK (language IN ('en','hi','hinglish'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE question_bank_questions
    ADD CONSTRAINT qbq_type_check CHECK (question_type IN ('verbal','mcq_single','mcq_multi','true_false','short_answer','coding'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE question_bank_questions
    ADD CONSTRAINT qbq_difficulty_range CHECK (difficulty IS NULL OR (difficulty BETWEEN 1 AND 5));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE question_bank_questions
    ADD CONSTRAINT qbq_calib_range CHECK (calibrated_difficulty IS NULL OR (calibrated_difficulty BETWEEN 0 AND 1));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS qbq_org_status_idx  ON question_bank_questions (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS qbq_org_lang_idx    ON question_bank_questions (org_id, language);
CREATE INDEX IF NOT EXISTS qbq_org_role_idx    ON question_bank_questions (org_id, role_family);
CREATE INDEX IF NOT EXISTS qbq_org_hash_idx    ON question_bank_questions (org_id, content_hash);
CREATE INDEX IF NOT EXISTS qbq_bank_status_idx ON question_bank_questions (bank_id, status);
-- Keyset cursor path: stable order by (created_at, id).
CREATE INDEX IF NOT EXISTS qbq_org_keyset_idx  ON question_bank_questions (org_id, created_at DESC, id DESC);

-- ===========================================================================
-- 3) question_versions — per-item immutable version history
-- ===========================================================================
CREATE TABLE IF NOT EXISTS question_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  question_id  uuid NOT NULL REFERENCES question_bank_questions(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  snapshot     jsonb NOT NULL,
  reason       text NOT NULL CHECK (reason IN ('created','edited','approved','rejected','reverted')),
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS question_versions_q_idx
  ON question_versions (question_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS question_versions_q_version_uniq
  ON question_versions (question_id, version);

-- ===========================================================================
-- 4) question_reviews — review/approval workflow (one row per decision)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS question_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  question_id   uuid NOT NULL REFERENCES question_bank_questions(id) ON DELETE CASCADE,
  decision      text NOT NULL CHECK (decision IN ('submitted','approved','rejected','changes_requested')),
  reviewer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS question_reviews_q_idx
  ON question_reviews (question_id, created_at);
CREATE INDEX IF NOT EXISTS question_reviews_org_idx
  ON question_reviews (org_id, created_at);

-- ===========================================================================
-- 5) question_usage_events — append-only usage facts (p-value + over-use source)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS question_usage_events (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  question_id   uuid NOT NULL REFERENCES question_bank_questions(id) ON DELETE CASCADE,
  source        text NOT NULL CHECK (source IN ('assessment_attempt','live_assist','manual')),
  attempt_id    uuid REFERENCES assessment_attempts(id) ON DELETE SET NULL,
  call_id       uuid REFERENCES call_sessions(id) ON DELETE SET NULL,
  scored        boolean NOT NULL DEFAULT false,
  correct       boolean,
  score_fraction numeric(4,3) CHECK (score_fraction IS NULL OR (score_fraction BETWEEN 0 AND 1)),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS question_usage_q_idx
  ON question_usage_events (question_id, created_at);
CREATE INDEX IF NOT EXISTS question_usage_org_idx
  ON question_usage_events (org_id, created_at);

-- ===========================================================================
-- 6) question_bank_audit — dedicated append-only domain audit
-- ===========================================================================
CREATE TABLE IF NOT EXISTS question_bank_audit (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL CHECK (action IN (
    'bank.created','bank.updated','bank.archived','bank.restored',
    'question.created','question.updated','question.archived',
    'question.submitted_for_review','question.approved','question.rejected','question.reverted',
    'question.imported','questions.bulk_archived','questions.bulk_approved',
    'question.linked_demand','question.unlinked_demand')),
  bank_id       uuid REFERENCES question_banks(id) ON DELETE CASCADE,
  question_id   uuid REFERENCES question_bank_questions(id) ON DELETE CASCADE,
  payload       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS question_bank_audit_org_idx
  ON question_bank_audit (org_id, created_at);
CREATE INDEX IF NOT EXISTS question_bank_audit_bank_idx
  ON question_bank_audit (bank_id, created_at);
CREATE INDEX IF NOT EXISTS question_bank_audit_q_idx
  ON question_bank_audit (question_id, created_at);

-- ===========================================================================
-- 7) question_import_jobs — bulk import (CSV/QTI) preview/commit + idempotency
-- ===========================================================================
CREATE TABLE IF NOT EXISTS question_import_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bank_id         uuid NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
  format          text NOT NULL CHECK (format IN ('csv','qti')),
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','parsing','ready','committed','failed')),
  idempotency_key text,
  row_count       integer NOT NULL DEFAULT 0,
  valid_count     integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  error_count     integer NOT NULL DEFAULT 0,
  preview         jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS question_import_jobs_org_idx
  ON question_import_jobs (org_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS question_import_jobs_idem_uniq
  ON question_import_jobs (org_id, idempotency_key);

-- ===========================================================================
-- 8) Permissions — net-new question_banks.approve (review/approval gate).
--    question_banks.read / .write already seeded in 0010; granted here too
--    (ON CONFLICT DO NOTHING) so a freshly-migrated DB gates correctly.
-- ===========================================================================
-- Default/template org explicit grants.
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', r, p
FROM (VALUES
  ('admin','question_banks.read'),('admin','question_banks.write'),('admin','question_banks.approve'),
  ('business_head','question_banks.read'),('business_head','question_banks.write'),('business_head','question_banks.approve'),
  ('delivery_lead','question_banks.read'),('delivery_lead','question_banks.write'),('delivery_lead','question_banks.approve'),
  ('account_manager','question_banks.read'),('account_manager','question_banks.write'),
  ('qa_reviewer','question_banks.read'),('qa_reviewer','question_banks.approve'),
  ('recruiter','question_banks.read')
) AS x(r,p)
ON CONFLICT DO NOTHING;

-- Mirror the same grants into every org that already has role_permissions rows
-- (covers JoulesToWatts and any provisioned tenant).
INSERT INTO role_permissions (org_id, role, permission)
SELECT DISTINCT rp.org_id, x.r, x.p
FROM role_permissions rp
CROSS JOIN (VALUES
  ('admin','question_banks.read'),('admin','question_banks.write'),('admin','question_banks.approve'),
  ('business_head','question_banks.read'),('business_head','question_banks.write'),('business_head','question_banks.approve'),
  ('delivery_lead','question_banks.read'),('delivery_lead','question_banks.write'),('delivery_lead','question_banks.approve'),
  ('account_manager','question_banks.read'),('account_manager','question_banks.write'),
  ('qa_reviewer','question_banks.read'),('qa_reviewer','question_banks.approve'),
  ('recruiter','question_banks.read')
) AS x(r,p)
ON CONFLICT DO NOTHING;
