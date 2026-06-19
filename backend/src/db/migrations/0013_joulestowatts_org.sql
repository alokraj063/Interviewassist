-- JoulesToWatts production tenant.
--
-- Adds a second org alongside the demo workspace. The demo org keeps every
-- piece of seeded ATS data (clients, demands, candidates, prospects,
-- submissions, rubrics, question banks, voice agents) so /pnpm db:seed/
-- continues to give a self-contained playground. The JoulesToWatts org
-- starts empty locally — its demands, clients, and candidates are pulled
-- from the J2W Offer Letter MySQL DB by the offerLetterDemandSync worker.
--
-- The admin user (cognition.engine@joulestowatts.com) is created by the
-- seed script (apps/api/src/db/seed.ts) because argon2id password hashing
-- can't run inside a SQL migration. The migration only ensures the org row
-- and per-role permission matrix exist.
--
-- Idempotent against earlier ad-hoc inserts: if a row with this slug
-- already exists (e.g. from a manual /api/platform/orgs call) we keep its
-- id and just back-fill role_permissions against whatever id is there.

INSERT INTO organizations (id, name, slug)
VALUES ('a6e9e1cc-9e75-4b7e-95b8-7e7eb854fdd3', 'JoulesToWatts', 'joulestowatts')
ON CONFLICT (slug) DO NOTHING;

-- Resolve the actual org id (could be the canonical UUID above or an
-- earlier hand-inserted one) and seed role permissions against it. The
-- matrix mirrors what 0010 seeded for the demo org so role behavior is
-- consistent across tenants.
DO $$
DECLARE
  jt_org_id uuid;
BEGIN
  SELECT id INTO jt_org_id FROM organizations WHERE slug = 'joulestowatts';

  INSERT INTO role_permissions (org_id, role, permission)
  SELECT jt_org_id, 'admin', p FROM unnest(ARRAY[
    'demands.read','demands.write','demands.assign',
    'candidates.read','candidates.write',
    'prospects.read','prospects.write',
    'submissions.read','submissions.write','submissions.transition',
    'calls.read','calls.write','calls.end',
    'rubrics.read','rubrics.write',
    'question_banks.read','question_banks.write',
    'qa.read','qa.write',
    'clients.read','clients.write',
    'voice_agents.read','voice_agents.write',
    'knowledge.read','knowledge.write',
    'live_assist.read',
    'analytics.read',
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

  INSERT INTO role_permissions (org_id, role, permission)
  SELECT jt_org_id, 'business_head', p FROM unnest(ARRAY[
    'demands.read','demands.write','demands.assign',
    'candidates.read','candidates.write',
    'prospects.read',
    'submissions.read','submissions.transition',
    'calls.read',
    'rubrics.read','rubrics.write',
    'question_banks.read',
    'qa.read',
    'clients.read','clients.write',
    'voice_agents.read','voice_agents.write',
    'knowledge.read','knowledge.write',
    'live_assist.read',
    'analytics.read',
    'users.read','users.invite',
    'teams.read','teams.write',
    'roles.read',
    'workspace.read',
    'integrations.read',
    'audit.read',
    'notifications.read','notifications.write'
  ]) AS p
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permissions (org_id, role, permission)
  SELECT jt_org_id, 'account_manager', p FROM unnest(ARRAY[
    'demands.read','demands.write','demands.assign',
    'candidates.read','candidates.write',
    'prospects.read',
    'submissions.read','submissions.transition',
    'calls.read',
    'rubrics.read',
    'question_banks.read',
    'qa.read',
    'clients.read','clients.write',
    'knowledge.read',
    'live_assist.read',
    'analytics.read',
    'users.read',
    'teams.read',
    'roles.read',
    'workspace.read',
    'notifications.read','notifications.write'
  ]) AS p
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permissions (org_id, role, permission)
  SELECT jt_org_id, 'delivery_lead', p FROM unnest(ARRAY[
    'demands.read',
    'candidates.read','candidates.write',
    'prospects.read','prospects.write',
    'submissions.read','submissions.transition',
    'calls.read',
    'rubrics.read',
    'question_banks.read',
    'qa.read',
    'knowledge.read',
    'live_assist.read',
    'analytics.read',
    'users.read',
    'teams.read',
    'roles.read',
    'workspace.read',
    'notifications.read','notifications.write'
  ]) AS p
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permissions (org_id, role, permission)
  SELECT jt_org_id, 'qa_reviewer', p FROM unnest(ARRAY[
    'calls.read',
    'rubrics.read',
    'qa.read','qa.write',
    'knowledge.read',
    'analytics.read',
    'users.read',
    'teams.read',
    'roles.read',
    'workspace.read',
    'notifications.read','notifications.write'
  ]) AS p
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permissions (org_id, role, permission)
  SELECT jt_org_id, 'recruiter', p FROM unnest(ARRAY[
    'demands.read',
    'candidates.read','candidates.write',
    'prospects.read','prospects.write',
    'submissions.read','submissions.write','submissions.transition',
    'calls.read','calls.write','calls.end',
    'rubrics.read',
    'question_banks.read',
    'knowledge.read',
    'live_assist.read',
    'users.read',
    'teams.read',
    'roles.read',
    'workspace.read',
    'notifications.read','notifications.write'
  ]) AS p
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permissions (org_id, role, permission)
  SELECT jt_org_id, 'client_user', p FROM unnest(ARRAY[
    'workspace.read'
  ]) AS p
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permissions (org_id, role, permission)
  SELECT jt_org_id, 'proctor', p FROM unnest(ARRAY[
    'workspace.read'
  ]) AS p
  ON CONFLICT DO NOTHING;
END $$;
