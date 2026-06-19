-- Coaching enterprise rebuild (PAGE:coaching): scenario authoring depth, real
-- per-criterion scoring, curricula + assignments, an append-only audit trail,
-- and the role_permissions grants the page enforces (none of the coaching.*
-- permissions survived the 0010 role-taxonomy TRUNCATE — every role currently
-- 403s on the page). Additive + idempotent. Keep in sync with
-- packages/db/src/schema.ts (`// >>> PAGE:coaching` block + inline columns).

-- ---------- scenario depth columns ----------
ALTER TABLE coaching_scenarios
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'hinglish'
    CHECK (language IN ('hinglish','en-IN','hi-IN')),
  ADD COLUMN IF NOT EXISTS opening_line text,
  ADD COLUMN IF NOT EXISTS objections jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS success_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS estimated_minutes integer NOT NULL DEFAULT 8
    CHECK (estimated_minutes BETWEEN 1 AND 120),
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS published_version integer,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

DROP INDEX IF EXISTS coaching_scenarios_org_idx;
CREATE INDEX IF NOT EXISTS coaching_scenarios_org_list_idx
  ON coaching_scenarios(org_id, archived_at, is_published, difficulty, created_at DESC);

-- ---------- run columns ----------
ALTER TABLE coaching_runs
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'ai_roleplay'
    CHECK (mode IN ('ai_roleplay','self_recorded','live_call')),
  ADD COLUMN IF NOT EXISTS assignment_id uuid,
  ADD COLUMN IF NOT EXISTS scenario_version integer,
  ADD COLUMN IF NOT EXISTS score_source text
    CHECK (score_source IN ('ai','manual','ai_overridden')),
  ADD COLUMN IF NOT EXISTS scored_at timestamptz,
  ADD COLUMN IF NOT EXISTS scoring_status text NOT NULL DEFAULT 'pending'
    CHECK (scoring_status IN ('pending','scoring','scored','failed','skipped')),
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS coaching_runs_idem_uq
  ON coaching_runs(org_id, recruiter_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------- coaching_run_scores ----------
CREATE TABLE IF NOT EXISTS coaching_run_scores (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES coaching_runs(id) ON DELETE CASCADE,
  criterion_id text NOT NULL,
  criterion_name text NOT NULL,
  weight numeric(5,2) NOT NULL DEFAULT 1,
  score numeric(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
  band text CHECK (band IN ('fail','pass','excellent')),
  evidence text,
  source text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai','manual','ai_overridden')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS coaching_run_scores_run_crit_uq
  ON coaching_run_scores(run_id, criterion_id);
CREATE INDEX IF NOT EXISTS coaching_run_scores_org_crit_idx
  ON coaching_run_scores(org_id, criterion_id, created_at DESC);

-- ---------- coaching_curricula ----------
CREATE TABLE IF NOT EXISTS coaching_curricula (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  scenario_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_published boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_curricula_org_idx
  ON coaching_curricula(org_id, archived_at, created_at DESC);

-- ---------- coaching_assignments ----------
CREATE TABLE IF NOT EXISTS coaching_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scenario_id uuid REFERENCES coaching_scenarios(id) ON DELETE CASCADE,
  curriculum_id uuid REFERENCES coaching_curricula(id) ON DELETE CASCADE,
  assignee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'assigned'
    CHECK (status IN ('assigned','in_progress','completed','overdue','waived')),
  due_at timestamptz,
  completed_run_id uuid REFERENCES coaching_runs(id) ON DELETE SET NULL,
  completed_at timestamptz,
  min_pass_score numeric(5,2),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coaching_assignments_target_chk
    CHECK ((scenario_id IS NOT NULL) <> (curriculum_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS coaching_assignments_assignee_idx
  ON coaching_assignments(assignee_user_id, status, due_at);
CREATE INDEX IF NOT EXISTS coaching_assignments_org_idx
  ON coaching_assignments(org_id, status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS coaching_assignments_idem_uq
  ON coaching_assignments(org_id, assigned_by_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- FK from runs to assignments (added after the assignments table exists).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coaching_runs_assignment_fk') THEN
    ALTER TABLE coaching_runs
      ADD CONSTRAINT coaching_runs_assignment_fk
      FOREIGN KEY (assignment_id) REFERENCES coaching_assignments(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------- coaching_audit_events (append-only) ----------
CREATE TABLE IF NOT EXISTS coaching_audit_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action text NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  scenario_id uuid REFERENCES coaching_scenarios(id) ON DELETE SET NULL,
  run_id uuid REFERENCES coaching_runs(id) ON DELETE SET NULL,
  curriculum_id uuid REFERENCES coaching_curricula(id) ON DELETE SET NULL,
  assignment_id uuid REFERENCES coaching_assignments(id) ON DELETE SET NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coaching_audit_scenario_idx ON coaching_audit_events(scenario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS coaching_audit_run_idx ON coaching_audit_events(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS coaching_audit_org_idx ON coaching_audit_events(org_id, created_at DESC);

-- ---------- permission grants (FIX THE DEAD PAGE) ----------
-- The 0010 role-taxonomy TRUNCATE wiped every coaching.* grant, so NO role can
-- currently read/author/run on this page. Re-grant the full set against the
-- CURRENT recruiter-ATS role taxonomy (role_permissions_role_check allows
-- 'recruiter','delivery_lead','account_manager','business_head','qa_reviewer',
-- 'admin','client_user','proctor' — NOT the legacy 'agent'/'team_lead'/
-- 'manager' names). Granted to EVERY org (default + JoulesToWatts) via a
-- CROSS JOIN over organizations so neither the api-itest admin nor the e2e
-- persona 403s. Net-new strings coaching.assign / coaching.manage are included.
INSERT INTO role_permissions (org_id, role, permission)
SELECT o.id, r.role, r.permission
FROM organizations o
CROSS JOIN (VALUES
  -- admin: full set
  ('admin','coaching.read'), ('admin','coaching.write'), ('admin','coaching.run'),
  ('admin','coaching.read.all'), ('admin','coaching.assign'), ('admin','coaching.manage'),
  -- business_head: org-wide visibility + assign + author
  ('business_head','coaching.read'), ('business_head','coaching.write'), ('business_head','coaching.run'),
  ('business_head','coaching.read.all'), ('business_head','coaching.assign'), ('business_head','coaching.manage'),
  -- account_manager: author + assign + team view
  ('account_manager','coaching.read'), ('account_manager','coaching.write'), ('account_manager','coaching.run'),
  ('account_manager','coaching.read.all'), ('account_manager','coaching.assign'), ('account_manager','coaching.manage'),
  -- delivery_lead: author + assign + team view (manages a pod)
  ('delivery_lead','coaching.read'), ('delivery_lead','coaching.write'), ('delivery_lead','coaching.run'),
  ('delivery_lead','coaching.read.all'), ('delivery_lead','coaching.assign'),
  -- qa_reviewer: read team + run + score override
  ('qa_reviewer','coaching.read'), ('qa_reviewer','coaching.run'),
  ('qa_reviewer','coaching.read.all'), ('qa_reviewer','coaching.manage'),
  -- recruiter: read + run their own practice
  ('recruiter','coaching.read'), ('recruiter','coaching.run')
) AS r(role, permission)
ON CONFLICT DO NOTHING;
