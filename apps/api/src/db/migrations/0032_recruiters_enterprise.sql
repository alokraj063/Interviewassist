-- Recruiters page (enterprise rebuild): per-recruiter quarterly goals/targets,
-- capacity caps (over-allocation warnings), configurable+fairness-guarded saved
-- leaderboards, idempotent manager→recruiter nudges, and an append-only audit of
-- every management state change. Forward-only, additive, org-scoped. Safe to
-- re-run (CREATE ... IF NOT EXISTS / ON CONFLICT DO NOTHING).

BEGIN;

-- ---------- recruiter goals / targets ----------
CREATE TABLE IF NOT EXISTS recruiter_goals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recruiter_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric             text NOT NULL CHECK (metric IN
                       ('submissions','client_submits','selects','offers','joins','calls','conversion_rate')),
  period             text NOT NULL CHECK (period IN ('weekly','monthly','quarterly')),
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  target_value       integer NOT NULL CHECK (target_value >= 0),
  note               text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz,
  CHECK (period_end > period_start)
);
CREATE INDEX IF NOT EXISTS recruiter_goals_org_recruiter_idx ON recruiter_goals(org_id, recruiter_user_id);
CREATE INDEX IF NOT EXISTS recruiter_goals_org_period_idx ON recruiter_goals(org_id, period_start, period_end);
CREATE UNIQUE INDEX IF NOT EXISTS recruiter_goals_uniq_live
  ON recruiter_goals(recruiter_user_id, metric, period_start, period_end) WHERE archived_at IS NULL;

-- ---------- recruiter capacity (max concurrent active load) ----------
CREATE TABLE IF NOT EXISTS recruiter_capacity (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recruiter_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_active_demands   integer NOT NULL DEFAULT 8  CHECK (max_active_demands   BETWEEN 0 AND 1000),
  max_active_prospects integer NOT NULL DEFAULT 40 CHECK (max_active_prospects BETWEEN 0 AND 10000),
  weekly_call_target   integer NOT NULL DEFAULT 25 CHECK (weekly_call_target   BETWEEN 0 AND 10000),
  notes                text,
  updated_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recruiter_capacity_uniq ON recruiter_capacity(org_id, recruiter_user_id);

-- ---------- leaderboard saved views (configurable, fairness-guarded) ----------
CREATE TABLE IF NOT EXISTS recruiter_leaderboards (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  config             jsonb NOT NULL,
  is_shared          boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz
);
CREATE INDEX IF NOT EXISTS recruiter_leaderboards_org_idx ON recruiter_leaderboards(org_id, updated_at DESC);

-- ---------- recruiter nudges (manager → recruiter message) ----------
CREATE TABLE IF NOT EXISTS recruiter_nudges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recruiter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('coaching','sla_breach','capacity','goal','kudos')),
  message           text NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  delivery          text NOT NULL DEFAULT 'in_app_only' CHECK (delivery IN ('in_app_only','email')),
  sent_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key   text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recruiter_nudges_recruiter_idx ON recruiter_nudges(recruiter_user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS recruiter_nudges_idem_uniq
  ON recruiter_nudges(org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ---------- append-only audit of recruiter-management state changes ----------
CREATE TABLE IF NOT EXISTS recruiter_admin_events (
  id                bigserial PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recruiter_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action            text NOT NULL CHECK (action IN (
                      'goal.set','goal.update','goal.archive','capacity.set',
                      'leaderboard.save','leaderboard.update','leaderboard.archive',
                      'nudge.send','demand.reassign')),
  before            jsonb,
  after             jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recruiter_admin_events_recruiter_idx
  ON recruiter_admin_events(org_id, recruiter_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recruiter_admin_events_actor_idx
  ON recruiter_admin_events(org_id, actor_user_id, created_at DESC);

-- Supporting index for the list keyset/sort (per-recruiter submission aggregates).
CREATE INDEX IF NOT EXISTS submissions_recruiter_created_idx
  ON submissions(org_id, submitted_by_user_id, created_at);

-- ---------- permission catalog: net-new recruiters.* perms ----------
-- recruiters.read   → read-capable roles (manager taxonomy + qa + recruiter self-view)
-- recruiters.manage → goals, capacity, leaderboards, nudges, reassignment
-- admin gets the full set so the core write works.

-- Default/template org grants (explicit so a freshly-migrated DB with no other
-- role_permissions rows still gates correctly).
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', r, p
FROM (VALUES
  ('admin','recruiters.read'),('admin','recruiters.manage'),
  ('business_head','recruiters.read'),('business_head','recruiters.manage'),
  ('account_manager','recruiters.read'),('account_manager','recruiters.manage'),
  ('delivery_lead','recruiters.read'),('delivery_lead','recruiters.manage'),
  ('qa_reviewer','recruiters.read'),
  ('recruiter','recruiters.read')
) AS x(r,p)
ON CONFLICT DO NOTHING;

-- Mirror the same grants into every org that already has role_permissions rows
-- (covers JoulesToWatts and any provisioned tenant).
INSERT INTO role_permissions (org_id, role, permission)
SELECT DISTINCT rp.org_id, x.r, x.p
FROM role_permissions rp
CROSS JOIN (VALUES
  ('admin','recruiters.read'),('admin','recruiters.manage'),
  ('business_head','recruiters.read'),('business_head','recruiters.manage'),
  ('account_manager','recruiters.read'),('account_manager','recruiters.manage'),
  ('delivery_lead','recruiters.read'),('delivery_lead','recruiters.manage'),
  ('qa_reviewer','recruiters.read'),
  ('recruiter','recruiters.read')
) AS x(r,p)
ON CONFLICT DO NOTHING;

COMMIT;
