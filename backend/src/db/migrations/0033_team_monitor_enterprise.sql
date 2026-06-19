-- Team Monitor enterprise rebuild: presence, supervision, SLA policies, alerts, audit.
-- Forward-only, additive, idempotent. All tables org-scoped (org_id NOT NULL).

-- 1) recruiter_presence -------------------------------------------------
CREATE TABLE IF NOT EXISTS recruiter_presence (
  org_id                  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_activity        text NOT NULL DEFAULT 'offline'
                            CHECK (current_activity IN ('on_call','idle','in_meeting','offline')),
  active_call_id          uuid REFERENCES call_sessions(id) ON DELETE SET NULL,
  last_heartbeat_at       timestamptz NOT NULL DEFAULT now(),
  last_activity_change_at timestamptz NOT NULL DEFAULT now(),
  status_note             text,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS recruiter_presence_org_activity_idx
  ON recruiter_presence (org_id, current_activity);
CREATE INDEX IF NOT EXISTS recruiter_presence_heartbeat_idx
  ON recruiter_presence (org_id, last_heartbeat_at);

-- 2) call_supervision_sessions -----------------------------------------
CREATE TABLE IF NOT EXISTS call_supervision_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id             uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  supervisor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  recruiter_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  mode                text NOT NULL CHECK (mode IN ('whisper','barge','takeover')),
  state               text NOT NULL DEFAULT 'requested'
                        CHECK (state IN ('requested','active','ended','denied','failed')),
  idempotency_key     text NOT NULL,
  provider_listen_url text,
  provider_control_url text,
  provider            text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  ended_reason        text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_supervision_call_idx
  ON call_supervision_sessions (call_id, started_at);
CREATE INDEX IF NOT EXISTS call_supervision_org_state_idx
  ON call_supervision_sessions (org_id, state);
CREATE INDEX IF NOT EXISTS call_supervision_supervisor_idx
  ON call_supervision_sessions (supervisor_user_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS call_supervision_idem_key
  ON call_supervision_sessions (org_id, idempotency_key);

-- 3) team_sla_policies --------------------------------------------------
CREATE TABLE IF NOT EXISTS team_sla_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric              text NOT NULL CHECK (metric IN
                        ('queue_depth','call_duration_ms','recruiter_idle_ms','abandoned_rate','answer_rate')),
  warning_threshold   integer NOT NULL,
  critical_threshold  integer NOT NULL,
  enabled             boolean NOT NULL DEFAULT true,
  scope_lead_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  notify_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- One policy per (org, metric, scope). NULL scope = org-wide; COALESCE so the
-- org-wide row is unique too.
CREATE UNIQUE INDEX IF NOT EXISTS team_sla_policies_metric_scope_key
  ON team_sla_policies (org_id, metric, COALESCE(scope_lead_user_id, '00000000-0000-0000-0000-000000000000'));
CREATE INDEX IF NOT EXISTS team_sla_policies_org_idx
  ON team_sla_policies (org_id, enabled);

-- 4) team_alerts --------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  policy_id       uuid REFERENCES team_sla_policies(id) ON DELETE SET NULL,
  metric          text NOT NULL CHECK (metric IN
                    ('queue_depth','call_duration_ms','recruiter_idle_ms','abandoned_rate','answer_rate')),
  severity        text NOT NULL CHECK (severity IN ('info','warning','critical')),
  state           text NOT NULL DEFAULT 'open' CHECK (state IN ('open','acked','resolved','expired')),
  subject_type    text CHECK (subject_type IN ('user','call','pod','org')),
  subject_id      text,
  observed_value  integer NOT NULL,
  threshold_value integer NOT NULL,
  message         text NOT NULL,
  acked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  acked_at        timestamptz,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_alerts_org_state_idx
  ON team_alerts (org_id, state, created_at);
CREATE INDEX IF NOT EXISTS team_alerts_subject_idx
  ON team_alerts (org_id, subject_type, subject_id);
-- Dedupe: at most one OPEN alert per (org, metric, subject).
CREATE UNIQUE INDEX IF NOT EXISTS team_alerts_open_dedupe_idx
  ON team_alerts (org_id, metric, COALESCE(subject_id, ''))
  WHERE state = 'open';

-- 5) team_monitor_audit (append-only) -----------------------------------
CREATE TABLE IF NOT EXISTS team_monitor_audit (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  payload      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_monitor_audit_org_at_idx
  ON team_monitor_audit (org_id, created_at);
CREATE INDEX IF NOT EXISTS team_monitor_audit_target_idx
  ON team_monitor_audit (org_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS team_monitor_audit_actor_idx
  ON team_monitor_audit (actor_user_id, created_at);

-- 6) Permissions for the new supervisor capabilities --------------------
-- Net-new strings: team_monitor.{read,supervise,reassign,alerts.write,sla.write}.
-- Default/template org grants (explicit so a freshly-migrated DB still gates).
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', r, p
FROM (VALUES
  ('admin','team_monitor.read'),('admin','team_monitor.supervise'),
  ('admin','team_monitor.reassign'),('admin','team_monitor.alerts.write'),
  ('admin','team_monitor.sla.write'),
  ('business_head','team_monitor.read'),('business_head','team_monitor.supervise'),
  ('business_head','team_monitor.reassign'),('business_head','team_monitor.alerts.write'),
  ('business_head','team_monitor.sla.write'),
  ('delivery_lead','team_monitor.read'),('delivery_lead','team_monitor.supervise'),
  ('delivery_lead','team_monitor.reassign'),('delivery_lead','team_monitor.alerts.write'),
  ('delivery_lead','team_monitor.sla.write'),
  ('account_manager','team_monitor.read'),('account_manager','team_monitor.reassign'),
  ('account_manager','team_monitor.alerts.write'),('account_manager','team_monitor.sla.write'),
  ('recruiter','team_monitor.read'),
  ('qa_reviewer','team_monitor.read')
) AS x(r,p)
ON CONFLICT DO NOTHING;

-- Mirror the same grants into every org that already has role_permissions rows
-- (covers JoulesToWatts and any provisioned tenant).
INSERT INTO role_permissions (org_id, role, permission)
SELECT DISTINCT rp.org_id, x.r, x.p
FROM role_permissions rp
CROSS JOIN (VALUES
  ('admin','team_monitor.read'),('admin','team_monitor.supervise'),
  ('admin','team_monitor.reassign'),('admin','team_monitor.alerts.write'),
  ('admin','team_monitor.sla.write'),
  ('business_head','team_monitor.read'),('business_head','team_monitor.supervise'),
  ('business_head','team_monitor.reassign'),('business_head','team_monitor.alerts.write'),
  ('business_head','team_monitor.sla.write'),
  ('delivery_lead','team_monitor.read'),('delivery_lead','team_monitor.supervise'),
  ('delivery_lead','team_monitor.reassign'),('delivery_lead','team_monitor.alerts.write'),
  ('delivery_lead','team_monitor.sla.write'),
  ('account_manager','team_monitor.read'),('account_manager','team_monitor.reassign'),
  ('account_manager','team_monitor.alerts.write'),('account_manager','team_monitor.sla.write'),
  ('recruiter','team_monitor.read'),
  ('qa_reviewer','team_monitor.read')
) AS x(r,p)
ON CONFLICT DO NOTHING;
