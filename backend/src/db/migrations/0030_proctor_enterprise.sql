-- Proctor cockpit enterprise build: policies, identity, interventions,
-- append-only chain-of-custody audit, plus risk/live-state/scrubber columns on
-- the existing proctor tables. Additive + forward-only; safe to re-run
-- (IF NOT EXISTS / ON CONFLICT throughout).

BEGIN;

-- 1. Additive columns on existing tables ---------------------------------
ALTER TABLE proctor_sessions
  ADD COLUMN IF NOT EXISTS live_state text NOT NULL DEFAULT 'active'
    CHECK (live_state IN ('active','paused','ended')),
  ADD COLUMN IF NOT EXISTS risk_score integer NOT NULL DEFAULT 0
    CHECK (risk_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS policy_id uuid,
  ADD COLUMN IF NOT EXISTS policy_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS assigned_reviewer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_sla_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

ALTER TABLE proctor_events
  ADD COLUMN IF NOT EXISTS offset_ms integer,
  ADD COLUMN IF NOT EXISTS evidence_blob_key text;

-- Keyset/sort indexes for the new filter & queue paths.
CREATE INDEX IF NOT EXISTS proctor_sessions_org_risk_idx
  ON proctor_sessions(org_id, risk_score DESC, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS proctor_sessions_org_live_idx
  ON proctor_sessions(org_id, live_state, started_at DESC);
CREATE INDEX IF NOT EXISTS proctor_sessions_review_queue_idx
  ON proctor_sessions(org_id, reviewer_decision, review_sla_due_at)
  WHERE reviewer_decision IS NULL AND status = 'completed';
CREATE INDEX IF NOT EXISTS proctor_sessions_assigned_idx
  ON proctor_sessions(assigned_reviewer_user_id, review_sla_due_at);

-- 2. Policies ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proctor_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  assessment_template_id uuid REFERENCES assessment_templates(id) ON DELETE CASCADE,
  is_default boolean NOT NULL DEFAULT false,
  signal_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  require_identity boolean NOT NULL DEFAULT true,
  require_webcam boolean NOT NULL DEFAULT true,
  require_screen boolean NOT NULL DEFAULT false,
  lockdown_browser boolean NOT NULL DEFAULT false,
  auto_flag_risk_score integer NOT NULL DEFAULT 40 CHECK (auto_flag_risk_score BETWEEN 0 AND 100),
  auto_terminate_risk_score integer CHECK (auto_terminate_risk_score BETWEEN 0 AND 100),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proctor_policies_org_idx ON proctor_policies(org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS proctor_policies_template_idx ON proctor_policies(assessment_template_id);
-- One org-default policy.
CREATE UNIQUE INDEX IF NOT EXISTS proctor_policies_one_default_idx
  ON proctor_policies(org_id) WHERE is_default;
-- One policy per template.
CREATE UNIQUE INDEX IF NOT EXISTS proctor_policies_template_unique_idx
  ON proctor_policies(assessment_template_id) WHERE assessment_template_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proctor_sessions_policy_fk'
  ) THEN
    ALTER TABLE proctor_sessions
      ADD CONSTRAINT proctor_sessions_policy_fk
      FOREIGN KEY (policy_id) REFERENCES proctor_policies(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Identity checks -----------------------------------------------------
CREATE TABLE IF NOT EXISTS proctor_identity_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES proctor_sessions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verified','mismatch','skipped')),
  id_photo_blob_key text,
  selfie_blob_key text,
  env_scan_blob_key text,
  match_score integer CHECK (match_score BETWEEN 0 AND 100),
  match_provider text,
  notes text,
  verified_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proctor_identity_session_idx ON proctor_identity_checks(session_id);
CREATE INDEX IF NOT EXISTS proctor_identity_org_status_idx ON proctor_identity_checks(org_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS proctor_identity_one_per_session_idx ON proctor_identity_checks(session_id);

-- 4. Interventions (append-only) -----------------------------------------
CREATE TABLE IF NOT EXISTS proctor_interventions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES proctor_sessions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('chat','broadcast','pause','resume','extend','terminate','warn')),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  message text,
  extend_seconds integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proctor_interventions_session_idx ON proctor_interventions(session_id, created_at DESC);

-- 5. Append-only chain-of-custody audit ----------------------------------
CREATE TABLE IF NOT EXISTS proctor_audit_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id uuid REFERENCES proctor_sessions(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'session.view','session.review','session.assign','session.terminate',
    'session.pause','session.resume','session.extend','event.ack',
    'evidence.export','evidence.view','identity.verify','policy.update','intervention.send')),
  from_value text,
  to_value text,
  payload jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proctor_audit_org_idx ON proctor_audit_events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS proctor_audit_session_idx ON proctor_audit_events(session_id, created_at DESC);

-- 5b. Allow the 'rekognition' tenant-integration provider (face-match) so
--     per-tenant AWS Rekognition creds can be stored. Additive to the 0009
--     CHECK constraint.
ALTER TABLE tenant_integrations DROP CONSTRAINT IF EXISTS tenant_integrations_provider_check;
ALTER TABLE tenant_integrations
  ADD CONSTRAINT tenant_integrations_provider_check
  CHECK (provider IN ('vapi','deepgram','sarvam','shunya','rekognition'));

-- 6. Shared idempotency-key store (created here IF NOT EXISTS so the proctor
--    page's create/assign/intervene routes can dedup even if it doesn't yet
--    exist from another page).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope text NOT NULL,
  key text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope, key)
);

-- 7. Permission grants. Replace the 'workspace.read'-only placeholder for the
--    proctor role with the real proctoring.* permissions, granted to the
--    DEFAULT org (backfillRolePermissions propagates to future tenants) AND to
--    the JoulesToWatts org directly (its grants were hardcoded in 0013 and do
--    not auto-copy). admin gets the full set so the core write works.
--    CRITICAL: the original cockpit gated on 'proctor.review' which was never
--    granted — so no human could review. These grants fix that hard-fail.

-- full set (read/review/intervene/policy.write/export) for admin/qa/proctor;
-- business_head gets read+review+export but not intervene/policy.write.
INSERT INTO role_permissions (org_id, role, permission)
SELECT org_id, r.role, p.permission
FROM (VALUES
  ('00000000-0000-0000-0000-000000000000'::uuid),
  ('a6e9e1cc-9e75-4b7e-95b8-7e7eb854fdd3'::uuid)
) AS o(org_id)
CROSS JOIN (VALUES
  ('admin'),('business_head'),('qa_reviewer'),('proctor')
) AS r(role)
CROSS JOIN (VALUES
  ('proctoring.read'),('proctoring.review'),('proctoring.intervene'),
  ('proctoring.policy.write'),('proctoring.export')
) AS p(permission)
WHERE NOT (r.role = 'business_head'
           AND p.permission IN ('proctoring.intervene','proctoring.policy.write'))
ON CONFLICT DO NOTHING;

-- delivery_lead + account_manager get read-only.
INSERT INTO role_permissions (org_id, role, permission)
SELECT org_id, r.role, 'proctoring.read'
FROM (VALUES
  ('00000000-0000-0000-0000-000000000000'::uuid),
  ('a6e9e1cc-9e75-4b7e-95b8-7e7eb854fdd3'::uuid)
) AS o(org_id)
CROSS JOIN (VALUES ('delivery_lead'),('account_manager')) AS r(role)
ON CONFLICT DO NOTHING;

COMMIT;
