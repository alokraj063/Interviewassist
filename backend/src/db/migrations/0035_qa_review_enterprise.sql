-- 0035_qa_review_enterprise.sql
-- QA Review console: sampling policies, queue items, gold answers,
-- calibration sessions, disputes, and an append-only QA audit trail.
-- Forward-only, additive, idempotent. Org-scoped. Keep in sync with
-- packages/db/src/schema.ts (PAGE:qa-review block).

-- ---------- sampling policies ----------
CREATE TABLE IF NOT EXISTS qa_sampling_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  strategy text NOT NULL DEFAULT 'percentage'
    CHECK (strategy IN ('percentage','every_n','all','risk_weighted')),
  sample_percent integer CHECK (sample_percent IS NULL OR (sample_percent BETWEEN 0 AND 100)),
  every_n integer CHECK (every_n IS NULL OR every_n > 0),
  demand_id uuid REFERENCES demands(id) ON DELETE SET NULL,
  recruiter_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  rubric_purpose text,
  min_ai_score integer CHECK (min_ai_score IS NULL OR (min_ai_score BETWEEN 0 AND 100)),
  require_double_review boolean NOT NULL DEFAULT false,
  blind_review boolean NOT NULL DEFAULT true,
  routing text NOT NULL DEFAULT 'least_loaded'
    CHECK (routing IN ('round_robin','least_loaded','manual')),
  sla_hours integer CHECK (sla_hours IS NULL OR sla_hours > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qa_sampling_policies_org_idx ON qa_sampling_policies(org_id, is_active);

-- ---------- queue items ----------
CREATE TABLE IF NOT EXISTS qa_queue_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  policy_id uuid REFERENCES qa_sampling_policies(id) ON DELETE SET NULL,
  assigned_reviewer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  review_slot integer NOT NULL DEFAULT 1 CHECK (review_slot BETWEEN 1 AND 3),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_review','completed','skipped','disputed','resolved')),
  priority integer NOT NULL DEFAULT 0,
  due_at timestamptz,
  review_id uuid REFERENCES call_qa_reviews(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS qa_queue_items_call_slot_key ON qa_queue_items(call_id, review_slot);
CREATE INDEX IF NOT EXISTS qa_queue_items_org_status_idx ON qa_queue_items(org_id, status, due_at);
CREATE INDEX IF NOT EXISTS qa_queue_items_reviewer_idx ON qa_queue_items(assigned_reviewer_id, status);
CREATE INDEX IF NOT EXISTS qa_queue_items_org_created_idx ON qa_queue_items(org_id, created_at, id);

-- ---------- gold answers ----------
CREATE TABLE IF NOT EXISTS qa_gold_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  rubric_id uuid REFERENCES call_rubrics(id) ON DELETE SET NULL,
  criterion_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  gold_overall_score integer CHECK (gold_overall_score IS NULL OR (gold_overall_score BETWEEN 0 AND 100)),
  notes text,
  authored_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  is_published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS qa_gold_answers_call_key ON qa_gold_answers(call_id);
CREATE INDEX IF NOT EXISTS qa_gold_answers_org_idx ON qa_gold_answers(org_id, created_at);

-- ---------- calibration sessions ----------
CREATE TABLE IF NOT EXISTS qa_calibration_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  rubric_id uuid REFERENCES call_rubrics(id) ON DELETE SET NULL,
  call_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewer_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  results jsonb,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS qa_calibration_sessions_org_idx ON qa_calibration_sessions(org_id, status, created_at);

-- ---------- disputes ----------
CREATE TABLE IF NOT EXISTS qa_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES call_qa_reviews(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  raised_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  requested_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','under_review','upheld','overturned','withdrawn')),
  resolver_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution_note text,
  thread jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS qa_disputes_org_status_idx ON qa_disputes(org_id, status, created_at);
CREATE INDEX IF NOT EXISTS qa_disputes_review_idx ON qa_disputes(review_id);

-- ---------- append-only QA audit ----------
CREATE TABLE IF NOT EXISTS qa_audit_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  call_id uuid REFERENCES call_sessions(id) ON DELETE SET NULL,
  before jsonb,
  after jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qa_audit_events_org_idx ON qa_audit_events(org_id, created_at);
CREATE INDEX IF NOT EXISTS qa_audit_events_target_idx ON qa_audit_events(target_type, target_id);
CREATE INDEX IF NOT EXISTS qa_audit_events_call_idx ON qa_audit_events(call_id, created_at);

-- ---------- additive columns on existing call_qa_reviews ----------
ALTER TABLE call_qa_reviews
  ADD COLUMN IF NOT EXISTS queue_item_id uuid REFERENCES qa_queue_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_slot integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS gold_variance integer,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS call_qa_reviews_queue_item_idx ON call_qa_reviews(queue_item_id);

-- ---------- permission additions ----------
-- Net-new: qa.calibrate (gold + calibration sessions), qa.sampling (policy
-- editing), qa.dispute (raise/resolve), qa.export. Granted to admin +
-- qa_reviewer for the DEFAULT and JOULESTOWATTS orgs. qa.dispute also granted
-- to recruiter/delivery_lead so they can appeal.
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'admin', p
FROM unnest(ARRAY['qa.calibrate','qa.sampling','qa.dispute','qa.export']) AS p
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'qa_reviewer', p
FROM unnest(ARRAY['qa.calibrate','qa.sampling','qa.dispute','qa.export']) AS p
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'recruiter', p
FROM unnest(ARRAY['qa.dispute']) AS p
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'delivery_lead', p
FROM unnest(ARRAY['qa.dispute']) AS p
ON CONFLICT DO NOTHING;

-- Mirror grants for the JOULESTOWATTS org (slug-resolved; no-op if absent).
INSERT INTO role_permissions (org_id, role, permission)
SELECT o.id, r.role, r.p
FROM organizations o
CROSS JOIN (VALUES
  ('admin','qa.calibrate'),('admin','qa.sampling'),('admin','qa.dispute'),('admin','qa.export'),
  ('qa_reviewer','qa.calibrate'),('qa_reviewer','qa.sampling'),('qa_reviewer','qa.dispute'),('qa_reviewer','qa.export'),
  ('recruiter','qa.dispute'),('delivery_lead','qa.dispute')
) AS r(role, p)
WHERE o.slug = 'joulestowatts'
ON CONFLICT DO NOTHING;
