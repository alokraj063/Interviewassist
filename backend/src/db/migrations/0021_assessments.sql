-- Recruiter-issued candidate assessments. Templates are org-scoped, can
-- link a question_bank for the source of truth, and bundle a fixed set
-- of question_ids per template. Attempts are per-candidate-per-template
-- and can be auto-scored (MCQ) or pending-review (free-text).

CREATE TABLE IF NOT EXISTS assessment_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  question_bank_id uuid REFERENCES question_banks(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  -- Time-box from start; null = no limit. UI surfaces a countdown when set.
  duration_mins integer,
  pass_score integer NOT NULL DEFAULT 60 CHECK (pass_score >= 0 AND pass_score <= 100),
  -- Snapshot of the question_ids included; preserves the test composition
  -- even if the source bank shifts later.
  question_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  is_published boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assessment_templates_org_idx
  ON assessment_templates(org_id, is_published, created_at DESC);

CREATE TABLE IF NOT EXISTS assessment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES assessment_templates(id) ON DELETE CASCADE,
  candidate_id uuid REFERENCES candidates(id) ON DELETE SET NULL,
  -- Single-use, candidate-friendly token used in /take-assessment/:token.
  -- Long random string; revoked when attempt completes or expires.
  invite_token text NOT NULL UNIQUE,
  invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'started', 'submitted', 'reviewed', 'expired')),
  started_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  expires_at timestamptz,
  -- responses[] = [{ questionId, answer, scoredAt, score }]
  responses jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_score integer,
  pass boolean,
  reviewer_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assessment_attempts_template_idx
  ON assessment_attempts(template_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS assessment_attempts_candidate_idx
  ON assessment_attempts(candidate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS assessment_attempts_token_idx
  ON assessment_attempts(invite_token);
