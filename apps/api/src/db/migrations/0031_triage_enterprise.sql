-- Triage enterprise rebuild: versioned rule sets, SLA/capacity/weight on rules,
-- append-only config audit, permission grants. Additive + forward-only; safe to
-- re-run (ADD COLUMN IF NOT EXISTS / CREATE ... IF NOT EXISTS / ON CONFLICT).

BEGIN;

-- ---------- rule SLA / capacity / strategy columns ----------
ALTER TABLE triage_routing_rules
  ADD COLUMN IF NOT EXISTS sla_target_sec integer,
  ADD COLUMN IF NOT EXISTS routing_strategy text NOT NULL DEFAULT 'first_idle',
  ADD COLUMN IF NOT EXISTS weight integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS max_concurrent integer,
  ADD COLUMN IF NOT EXISTS required_skill text,
  ADD COLUMN IF NOT EXISTS rule_set_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'triage_routing_rules_strategy_check') THEN
    ALTER TABLE triage_routing_rules ADD CONSTRAINT triage_routing_rules_strategy_check
      CHECK (routing_strategy IN ('first_idle','round_robin','weighted','least_loaded'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'triage_routing_rules_weight_check') THEN
    ALTER TABLE triage_routing_rules ADD CONSTRAINT triage_routing_rules_weight_check
      CHECK (weight >= 1 AND weight <= 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'triage_routing_rules_sla_check') THEN
    ALTER TABLE triage_routing_rules ADD CONSTRAINT triage_routing_rules_sla_check
      CHECK (sla_target_sec IS NULL OR sla_target_sec BETWEEN 5 AND 3600);
  END IF;
END $$;

-- ---------- versioned rule sets ----------
CREATE TABLE IF NOT EXISTS triage_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  triage_agent_id uuid NOT NULL REFERENCES voice_agents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','published','archived')),
  rules_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  published_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS triage_rule_sets_agent_version_uidx
  ON triage_rule_sets(org_id, triage_agent_id, version);
CREATE INDEX IF NOT EXISTS triage_rule_sets_agent_status_idx
  ON triage_rule_sets(org_id, triage_agent_id, status);

-- backfill FK now that the table exists
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'triage_routing_rules_rule_set_fk') THEN
    ALTER TABLE triage_routing_rules ADD CONSTRAINT triage_routing_rules_rule_set_fk
      FOREIGN KEY (rule_set_id) REFERENCES triage_rule_sets(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS triage_routing_rules_rule_set_idx
  ON triage_routing_rules(rule_set_id);

-- ---------- append-only config audit ----------
CREATE TABLE IF NOT EXISTS triage_audit_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  triage_agent_id uuid REFERENCES voice_agents(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'ruleset.saved_draft','ruleset.published','ruleset.rolled_back',
    'flow.status_changed','flow.archived','session.reassigned',
    'session.classification_overridden','session.terminated','dryrun.executed'
  )),
  target_type text,
  target_id text,
  diff jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS triage_audit_events_org_at_idx
  ON triage_audit_events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS triage_audit_events_agent_at_idx
  ON triage_audit_events(triage_agent_id, created_at DESC);

-- ---------- supporting indexes for new filter/sort/keyset paths ----------
-- Live-board keyset: (org_id, started_at DESC, id).
CREATE INDEX IF NOT EXISTS call_sessions_org_started_keyset_idx
  ON call_sessions(org_id, started_at DESC, id);
-- Per-rule hit-rate analytics scan over route_decision events by rule_id.
CREATE INDEX IF NOT EXISTS call_routing_events_rule_at_idx
  ON call_routing_events(rule_id, created_at DESC)
  WHERE rule_id IS NOT NULL;

-- ---------- shared idempotency-key store (created here IF NOT EXISTS so the
--            triage page's publish/rollback/reassign routes can dedup even if
--            it doesn't yet exist from another page) ----------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope text NOT NULL,
  key text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys(created_at);

-- ---------- permission catalog: net-new triage.* perms ----------
-- triage.read  → read-capable roles
-- triage.write → admin/business_head/account_manager/delivery_lead (rule authoring)
-- triage.operate → admin/business_head/delivery_lead (live override/reassign/terminate)
-- admin gets the full set so the core write works.

-- Default/template org grants.
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', r, p
FROM (VALUES
  ('admin','triage.read'),('admin','triage.write'),('admin','triage.operate'),
  ('business_head','triage.read'),('business_head','triage.write'),('business_head','triage.operate'),
  ('account_manager','triage.read'),('account_manager','triage.write'),
  ('delivery_lead','triage.read'),('delivery_lead','triage.operate'),
  ('qa_reviewer','triage.read'),
  ('recruiter','triage.read')
) AS x(r,p)
ON CONFLICT DO NOTHING;

-- Mirror the same grants into every org that already has role_permissions rows
-- (covers JoulesToWatts and any provisioned tenant).
INSERT INTO role_permissions (org_id, role, permission)
SELECT DISTINCT rp.org_id, x.r, x.p
FROM role_permissions rp
CROSS JOIN (VALUES
  ('admin','triage.read'),('admin','triage.write'),('admin','triage.operate'),
  ('business_head','triage.read'),('business_head','triage.write'),('business_head','triage.operate'),
  ('account_manager','triage.read'),('account_manager','triage.write'),
  ('delivery_lead','triage.read'),('delivery_lead','triage.operate'),
  ('qa_reviewer','triage.read'),
  ('recruiter','triage.read')
) AS x(r,p)
ON CONFLICT DO NOTHING;

COMMIT;
