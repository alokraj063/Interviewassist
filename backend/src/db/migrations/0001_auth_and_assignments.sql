-- Auth, RBAC, multi-tenant orgs, teams, invitations, MFA, audit, session mgmt,
-- notification preferences, and call-assignment extensions to call_sessions.
--
-- Keep in sync with packages/db/src/schema.ts.

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- Organizations ----------
CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  subdomain text UNIQUE,
  default_locale text DEFAULT 'en-IN',
  default_timezone text DEFAULT 'Asia/Kolkata',
  fiscal_year_start text,
  business_hours jsonb,
  session_timeout_minutes integer NOT NULL DEFAULT 480,
  mfa_required boolean NOT NULL DEFAULT false,
  allowed_email_domains text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the default org matching the DEFAULT_ORG UUID used by existing rows.
INSERT INTO organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000000', 'Default Workspace', 'default')
ON CONFLICT (id) DO NOTHING;

-- ---------- Users ----------
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL,
  password_hash text,
  name text,
  avatar_url text,
  job_title text,
  timezone text,
  locale text,
  email_verified_at timestamptz,
  mfa_secret text,
  mfa_enrolled_at timestamptz,
  telephony_ext_id text UNIQUE,
  last_active_at timestamptz,
  suspended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Memberships (user ↔ org with role) ----------
CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('agent','team_lead','manager','qa_reviewer','admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended')),
  invited_by uuid REFERENCES users(id),
  invited_at timestamptz,
  joined_at timestamptz,
  UNIQUE (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS memberships_org_idx ON memberships(org_id);

-- ---------- Role permissions (per-org, editable) ----------
CREATE TABLE IF NOT EXISTS role_permissions (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('agent','team_lead','manager','qa_reviewer','admin')),
  permission text NOT NULL,
  UNIQUE (org_id, role, permission)
);
CREATE INDEX IF NOT EXISTS role_permissions_lookup_idx ON role_permissions(org_id, role);

-- Seed the default permission matrix for the default org.
-- Admin: everything.
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'admin', p FROM unnest(ARRAY[
  'conversations.read','conversations.write',
  'qa.read','qa.write',
  'coaching.read','coaching.write',
  'scorecards.read','scorecards.write',
  'voice_agents.read','voice_agents.write',
  'knowledge.read','knowledge.write',
  'live_assist.read',
  'analytics.read',
  'calls.read','calls.assign','calls.end',
  'users.read','users.invite','users.write',
  'teams.read','teams.write',
  'roles.read','roles.write',
  'workspace.read','workspace.write',
  'security.read','security.write',
  'billing.read','billing.write',
  'integrations.read','integrations.write',
  'api_keys.read','api_keys.write',
  'audit.read',
  'notifications.read','notifications.write'
]) AS p
ON CONFLICT DO NOTHING;

-- Manager: everything except billing.write.
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'manager', p FROM unnest(ARRAY[
  'conversations.read','conversations.write',
  'qa.read','qa.write',
  'coaching.read','coaching.write',
  'scorecards.read','scorecards.write',
  'voice_agents.read','voice_agents.write',
  'knowledge.read','knowledge.write',
  'live_assist.read',
  'analytics.read',
  'calls.read','calls.assign','calls.end',
  'users.read','users.invite','users.write',
  'teams.read','teams.write',
  'roles.read',
  'workspace.read','workspace.write',
  'security.read','security.write',
  'billing.read',
  'integrations.read','integrations.write',
  'api_keys.read',
  'audit.read',
  'notifications.read','notifications.write'
]) AS p
ON CONFLICT DO NOTHING;

-- Team lead: supervise their agents.
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'team_lead', p FROM unnest(ARRAY[
  'conversations.read','conversations.write',
  'qa.read',
  'coaching.read','coaching.write',
  'scorecards.read',
  'voice_agents.read',
  'knowledge.read',
  'live_assist.read',
  'analytics.read',
  'calls.read','calls.assign','calls.end',
  'users.read','users.invite',
  'teams.read','teams.write',
  'roles.read',
  'workspace.read',
  'notifications.read','notifications.write'
]) AS p
ON CONFLICT DO NOTHING;

-- QA reviewer.
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'qa_reviewer', p FROM unnest(ARRAY[
  'conversations.read',
  'qa.read','qa.write',
  'coaching.read','coaching.write',
  'scorecards.read',
  'analytics.read',
  'calls.read',
  'knowledge.read',
  'users.read',
  'teams.read',
  'roles.read',
  'workspace.read',
  'notifications.read','notifications.write'
]) AS p
ON CONFLICT DO NOTHING;

-- Agent: minimal.
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'agent', p FROM unnest(ARRAY[
  'conversations.read',
  'coaching.read',
  'knowledge.read',
  'live_assist.read',
  'calls.read',
  'scorecards.read',
  'users.read',
  'teams.read',
  'roles.read',
  'workspace.read',
  'notifications.read','notifications.write'
]) AS p
ON CONFLICT DO NOTHING;

-- ---------- Teams ----------
CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  manager_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS teams_org_idx ON teams(org_id);

CREATE TABLE IF NOT EXISTS team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

-- ---------- Invitations ----------
CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email citext NOT NULL,
  role text NOT NULL CHECK (role IN ('agent','team_lead','manager','qa_reviewer','admin')),
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  token_hash text UNIQUE NOT NULL,
  invited_by uuid REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitations_org_email_idx ON invitations(org_id, email);

-- ---------- Email verification + password reset + refresh + MFA recovery ----------
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  user_agent text,
  ip inet,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens(user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

-- ---------- IP allowlist ----------
CREATE TABLE IF NOT EXISTS ip_allowlist (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cidr text NOT NULL,
  label text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ip_allowlist_org_idx ON ip_allowlist(org_id);

-- ---------- Audit log ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  ip inet,
  user_agent text,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(actor_user_id, created_at DESC);

-- ---------- Notification preferences ----------
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event text NOT NULL,
  in_app boolean NOT NULL DEFAULT true,
  email boolean NOT NULL DEFAULT true,
  sms boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, event)
);

-- ---------- Extend call_sessions with assignment metadata ----------
ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS origin text,
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

-- Backfill existing rows to the default org and a sensible status.
UPDATE call_sessions
  SET org_id = '00000000-0000-0000-0000-000000000000'
  WHERE org_id IS NULL;
UPDATE call_sessions
  SET status = CASE WHEN ended_at IS NOT NULL THEN 'ended' ELSE 'active' END
  WHERE status IS NULL;

-- Apply constraints now that data is clean.
ALTER TABLE call_sessions
  ALTER COLUMN status SET DEFAULT 'queued',
  ALTER COLUMN status SET NOT NULL,
  ADD CONSTRAINT call_sessions_status_check CHECK (status IN ('queued','assigned','active','ended')),
  ADD CONSTRAINT call_sessions_origin_check CHECK (origin IN ('web','telephony','desktop') OR origin IS NULL);

ALTER TABLE call_sessions
  ADD CONSTRAINT call_sessions_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  ADD CONSTRAINT call_sessions_created_by_fk FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT call_sessions_agent_fk FOREIGN KEY (agent_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS call_sessions_agent_active_idx
  ON call_sessions(agent_id, status)
  WHERE status IN ('assigned','active');

-- ---------- Add FKs on existing org_id columns ----------
ALTER TABLE kb_sources
  ADD CONSTRAINT kb_sources_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
