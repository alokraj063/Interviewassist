-- Analytics enterprise rebuild (PAGE:analytics): report-engine persistence —
-- saved views, scheduled reports, export jobs — plus covering indexes for
-- every date-range + segment filter path the report aggregates use (the source
-- tables exist; the indexes do not), and the role_permissions grants the page
-- enforces. Additive, forward-only, idempotent. Keep in sync with
-- packages/db/src/schema.ts (`// >>> PAGE:analytics` block).

-- ---------- analytics_saved_views ----------
CREATE TABLE IF NOT EXISTS analytics_saved_views (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name          text NOT NULL,
  description   text,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_shared     boolean NOT NULL DEFAULT false,
  is_archived   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_saved_views_name_len CHECK (char_length(name) BETWEEN 1 AND 160)
);
CREATE INDEX IF NOT EXISTS analytics_saved_views_org_idx    ON analytics_saved_views (org_id, updated_at);
CREATE INDEX IF NOT EXISTS analytics_saved_views_owner_idx  ON analytics_saved_views (owner_user_id);
CREATE INDEX IF NOT EXISTS analytics_saved_views_keyset_idx ON analytics_saved_views (org_id, updated_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS analytics_saved_views_org_name_key
  ON analytics_saved_views (org_id, owner_user_id, name);

-- ---------- analytics_scheduled_reports ----------
CREATE TABLE IF NOT EXISTS analytics_scheduled_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  saved_view_id      uuid NOT NULL REFERENCES analytics_saved_views(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name               text NOT NULL,
  format             text NOT NULL DEFAULT 'csv'    CHECK (format IN ('csv','xlsx','pdf')),
  cadence            text NOT NULL DEFAULT 'weekly' CHECK (cadence IN ('daily','weekly','monthly')),
  recipients         text[] NOT NULL DEFAULT '{}'::text[],
  is_enabled         boolean NOT NULL DEFAULT true,
  next_run_at        timestamptz,
  last_run_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analytics_scheduled_reports_org_idx  ON analytics_scheduled_reports (org_id, next_run_at);
CREATE INDEX IF NOT EXISTS analytics_scheduled_reports_view_idx ON analytics_scheduled_reports (saved_view_id);
CREATE UNIQUE INDEX IF NOT EXISTS analytics_scheduled_reports_idem_key
  ON analytics_scheduled_reports (org_id, saved_view_id, format, cadence);

-- ---------- analytics_export_jobs ----------
CREATE TABLE IF NOT EXISTS analytics_export_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  report_key           text NOT NULL CHECK (report_key IN
                         ('funnel','velocity','source_effectiveness','recruiter_productivity',
                          'quality_distribution','voice_screener','call_volume','diversity')),
  format               text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv','xlsx','pdf')),
  params               jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               text NOT NULL DEFAULT 'ready' CHECK (status IN ('queued','running','ready','failed')),
  row_count            integer,
  blob_key             text,
  idempotency_key      text,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);
CREATE INDEX IF NOT EXISTS analytics_export_jobs_org_idx ON analytics_export_jobs (org_id, created_at);
-- Drizzle's uniqueIndex(orgId, idempotencyKey) — partial so null keys don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS analytics_export_jobs_idem_key
  ON analytics_export_jobs (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ---- Covering indexes for the report aggregates (filter/sort paths) ----
-- Funnel + velocity read submission_stage_transitions by stage and time.
CREATE INDEX IF NOT EXISTS sst_to_stage_created_idx
  ON submission_stage_transitions (to_stage, created_at);
-- Source effectiveness joins submissions -> candidates(source) within a window.
CREATE INDEX IF NOT EXISTS candidates_org_source_idx
  ON candidates (org_id, source);
-- Submissions date-range filter by org + submitted_at.
CREATE INDEX IF NOT EXISTS submissions_org_submitted_idx
  ON submissions (org_id, submitted_at);
-- Call volume / voice screener by org + started_at.
CREATE INDEX IF NOT EXISTS call_sessions_org_started_idx
  ON call_sessions (org_id, started_at);
-- Rubric distribution by criterion + created_at (join to call_sessions for org).
CREATE INDEX IF NOT EXISTS call_rubric_scores_criterion_created_idx
  ON call_rubric_scores (criterion_id, created_at);

-- ---------- permission grants ----------
-- analytics.read already exists in the catalog but the prior shallow route
-- never enforced it; the rebuilt route does. Net-new strings:
--   analytics.export         -> export + scheduled reports
--   analytics.diversity.read -> the access-controlled EEO/diversity tab
-- Granted to EVERY org (default + JoulesToWatts) via a CROSS JOIN over
-- organizations so neither the api-itest admin nor the e2e persona 403s.
-- Also (re)assert analytics.read for the reading roles in case the 0010
-- role-taxonomy TRUNCATE left gaps. role_permissions_role_check allows
-- 'recruiter','delivery_lead','account_manager','business_head','qa_reviewer',
-- 'admin','client_user','proctor'.
INSERT INTO role_permissions (org_id, role, permission)
SELECT o.id, r.role, r.permission
FROM organizations o
CROSS JOIN (VALUES
  -- analytics.read (read the dashboards/reports)
  ('admin','analytics.read'),
  ('business_head','analytics.read'),
  ('account_manager','analytics.read'),
  ('delivery_lead','analytics.read'),
  ('qa_reviewer','analytics.read'),
  ('recruiter','analytics.read'),
  -- analytics.export (CSV export + scheduled report CRUD)
  ('admin','analytics.export'),
  ('business_head','analytics.export'),
  ('account_manager','analytics.export'),
  ('delivery_lead','analytics.export'),
  -- analytics.diversity.read (gated EEO tab — leadership only)
  ('admin','analytics.diversity.read'),
  ('business_head','analytics.diversity.read')
) AS r(role, permission)
ON CONFLICT DO NOTHING;
