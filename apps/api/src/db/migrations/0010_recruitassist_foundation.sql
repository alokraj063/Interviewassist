-- RecruitAssist foundation migration.
--
-- One omnibus migration that turns the contact-center schema into the
-- recruiter ATS schema:
--   * Replaces the membership/role enum with the recruiter taxonomy
--     (recruiter / delivery_lead / account_manager / business_head /
--      qa_reviewer / admin / client_user / proctor) and adds a self-FK
--      on memberships.reporting_to_user_id for the up-to-4-level org chart.
--   * Mutates transcript_turns + transcript_acoustic_windows speaker enums
--     from ('agent','customer') -> ('recruiter','candidate','unknown','mixed')
--     so mixed-mono browser-mic captures can land with speaker=unknown and
--     a post-call diarization worker can flip turns retroactively.
--   * Renames call_sessions.agent_id -> recruiter_user_id, customer_ref ->
--     candidate_ref_or_phone; adds prospect_id, demand_id, candidate_id, mode.
--   * Renames qa_reviews -> call_qa_reviews and adds ai_score.
--   * Adds the chunks.corpus discriminator (jd | company | question_bank)
--     so the suggestion engine can filter retrieval per call.
--   * Adds the new ATS core tables: clients, demands (+ skills/locations/
--     assignments), candidates, candidate_skills/experiences/qualifications,
--     submissions + submission_stage_transitions, interviews, selections,
--     offers.
--   * Adds the prospects + prospect_calls workspace.
--   * Adds taxonomy lookup tables (industries, functional_areas,
--     role_categories, job_roles, skills, locations, disqualification_reasons).
--   * Adds jd_match_runs (engine deferred), question_banks (UI deferred),
--     call_rubrics + call_rubric_scores, transcript_speaker_brackets.
--   * Extends voice_agents with demand_id + linked_rubric_id and broadens
--     the origin enum on call_sessions to include 'bridge'.
--
-- Schema strategy: in-place mutation. Dev data is ephemeral; we drop and
-- recreate role permissions for the default org. Production deploys do not
-- yet exist for RecruitAssist so backwards-compat shims are not needed.
--
-- Keep in sync with packages/db/src/schema.ts.

-- =====================================================================
-- 1. Role taxonomy: replace the contact-center role enum
-- =====================================================================

-- Drop the old CHECK constraints. They were created as named constraints
-- when the columns were defined inline in 0001, so the names are
-- predictable: <table>_role_check.
ALTER TABLE memberships     DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE invitations     DROP CONSTRAINT IF EXISTS invitations_role_check;
ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check;

-- Wipe role_permissions so we can reseed against the new taxonomy. (Dev
-- data only; production has no rows for RecruitAssist yet.)
TRUNCATE TABLE role_permissions;

-- Map any existing memberships forward (default-org dev fixtures only).
UPDATE memberships SET role = 'recruiter'       WHERE role = 'agent';
UPDATE memberships SET role = 'delivery_lead'   WHERE role = 'team_lead';
UPDATE memberships SET role = 'account_manager' WHERE role = 'manager';
UPDATE invitations SET role = 'recruiter'       WHERE role = 'agent';
UPDATE invitations SET role = 'delivery_lead'   WHERE role = 'team_lead';
UPDATE invitations SET role = 'account_manager' WHERE role = 'manager';

ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_check
  CHECK (role IN ('recruiter','delivery_lead','account_manager','business_head','qa_reviewer','admin','client_user','proctor'));

ALTER TABLE invitations
  ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('recruiter','delivery_lead','account_manager','business_head','qa_reviewer','admin','client_user','proctor'));

ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_role_check
  CHECK (role IN ('recruiter','delivery_lead','account_manager','business_head','qa_reviewer','admin','client_user','proctor'));

-- Self-reference for the org chart. NULL = top of chain (typically
-- business_head). Walked by getReportingChain() up to 4 hops.
ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS reporting_to_user_id uuid
    REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS memberships_reporting_to_idx
  ON memberships(reporting_to_user_id)
  WHERE reporting_to_user_id IS NOT NULL;

-- Reseed the default permission matrix for the recruiter taxonomy.
-- Vocabulary covers both legacy contact-center perms (still useful for
-- voice agents / KB / live-assist that we kept) and new ATS perms.
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'admin', p FROM unnest(ARRAY[
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
SELECT '00000000-0000-0000-0000-000000000000', 'business_head', p FROM unnest(ARRAY[
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
SELECT '00000000-0000-0000-0000-000000000000', 'account_manager', p FROM unnest(ARRAY[
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
SELECT '00000000-0000-0000-0000-000000000000', 'delivery_lead', p FROM unnest(ARRAY[
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
SELECT '00000000-0000-0000-0000-000000000000', 'qa_reviewer', p FROM unnest(ARRAY[
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
SELECT '00000000-0000-0000-0000-000000000000', 'recruiter', p FROM unnest(ARRAY[
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
SELECT '00000000-0000-0000-0000-000000000000', 'client_user', p FROM unnest(ARRAY[
  -- Placeholder. Real perms land with the client portal.
  'workspace.read'
]) AS p
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', 'proctor', p FROM unnest(ARRAY[
  -- Placeholder. Real perms land with the proctor cockpit.
  'workspace.read'
]) AS p
ON CONFLICT DO NOTHING;

-- =====================================================================
-- 2. transcript_turns + transcript_acoustic_windows speaker enum mutation
-- =====================================================================

-- transcript_turns. The CHECK was created inline in 0000 so the constraint
-- name is the standard <table>_<column>_check.
ALTER TABLE transcript_turns DROP CONSTRAINT IF EXISTS transcript_turns_speaker_check;
UPDATE transcript_turns SET speaker = 'recruiter' WHERE speaker = 'agent';
UPDATE transcript_turns SET speaker = 'candidate' WHERE speaker = 'customer';
ALTER TABLE transcript_turns
  ADD CONSTRAINT transcript_turns_speaker_check
  CHECK (speaker IN ('recruiter','candidate','unknown','mixed'));

-- transcript_acoustic_windows.
ALTER TABLE transcript_acoustic_windows DROP CONSTRAINT IF EXISTS transcript_acoustic_windows_speaker_check;
UPDATE transcript_acoustic_windows SET speaker = 'recruiter' WHERE speaker = 'agent';
UPDATE transcript_acoustic_windows SET speaker = 'candidate' WHERE speaker = 'customer';
ALTER TABLE transcript_acoustic_windows
  ADD CONSTRAINT transcript_acoustic_windows_speaker_check
  CHECK (speaker IN ('recruiter','candidate','unknown','mixed'));

-- call_translations also has a speaker enum (same provenance).
ALTER TABLE call_translations DROP CONSTRAINT IF EXISTS call_translations_speaker_check;
UPDATE call_translations SET speaker = 'recruiter' WHERE speaker = 'agent';
UPDATE call_translations SET speaker = 'candidate' WHERE speaker = 'customer';
ALTER TABLE call_translations
  ADD CONSTRAINT call_translations_speaker_check
  CHECK (speaker IN ('recruiter','candidate','unknown','mixed'));

-- =====================================================================
-- 3. call_sessions: rename + new FKs + new mode + extended origin
-- =====================================================================

ALTER TABLE call_sessions RENAME COLUMN agent_id     TO recruiter_user_id;
ALTER TABLE call_sessions RENAME COLUMN customer_ref TO candidate_ref_or_phone;

-- The auto-named index on agent_id moves implicitly; but the explicit named
-- index from 0001 was call_sessions_agent_active_idx. Drop and recreate so
-- the index name reflects the new column.
DROP INDEX IF EXISTS call_sessions_agent_active_idx;
CREATE INDEX IF NOT EXISTS call_sessions_recruiter_active_idx
  ON call_sessions(recruiter_user_id, status)
  WHERE status IN ('assigned','active');

-- New FKs. demand_id / prospect_id / candidate_id are all nullable because
-- a call may pre-date its prospect record (rare) or be for a candidate the
-- recruiter is creating inline. The FK definitions live further down once
-- those tables exist; we add them at the bottom of this migration.
ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS demand_id    uuid,
  ADD COLUMN IF NOT EXISTS prospect_id  uuid,
  ADD COLUMN IF NOT EXISTS candidate_id uuid,
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'browser_mixed';

ALTER TABLE call_sessions
  ADD CONSTRAINT call_sessions_mode_check
  CHECK (mode IN ('browser_mixed','desktop_dual_channel','vapi_outbound','vapi_inbound','bridge'));

-- Extend origin enum to add 'bridge' (Exotel/Knowlarity two-leg recordings).
DO $$
DECLARE
  conname_to_drop text;
BEGIN
  SELECT conname INTO conname_to_drop
  FROM pg_constraint
  WHERE conrelid = 'call_sessions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%origin%';
  IF conname_to_drop IS NOT NULL THEN
    EXECUTE format('ALTER TABLE call_sessions DROP CONSTRAINT %I', conname_to_drop);
  END IF;
END$$;

ALTER TABLE call_sessions
  ADD CONSTRAINT call_sessions_origin_check
  CHECK (origin IS NULL OR origin IN ('web','telephony','desktop','vapi','bridge'));

-- =====================================================================
-- 4. qa_reviews -> call_qa_reviews + ai_score column
-- =====================================================================

ALTER TABLE qa_reviews RENAME TO call_qa_reviews;

-- Auto-named indexes follow the table rename in Postgres only by default
-- naming convention; explicit indexes from 0003 keep their original names.
-- Rename them so they reflect the table name for tooling discoverability.
ALTER INDEX IF EXISTS qa_reviews_call_idx     RENAME TO call_qa_reviews_call_idx;
ALTER INDEX IF EXISTS qa_reviews_reviewer_idx RENAME TO call_qa_reviews_reviewer_idx;
ALTER INDEX IF EXISTS qa_reviews_org_idx      RENAME TO call_qa_reviews_org_idx;

ALTER TABLE call_qa_reviews
  ADD COLUMN IF NOT EXISTS ai_score numeric;

-- =====================================================================
-- 5. chunks.corpus discriminator
-- =====================================================================

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS corpus text NOT NULL DEFAULT 'company';

ALTER TABLE chunks
  ADD CONSTRAINT chunks_corpus_check
  CHECK (corpus IN ('jd','company','question_bank'));

CREATE INDEX IF NOT EXISTS chunks_corpus_idx ON chunks(corpus);

-- =====================================================================
-- 6. Taxonomy lookup tables
-- =====================================================================

CREATE TABLE IF NOT EXISTS industries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS functional_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  role_category_id uuid REFERENCES role_categories(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, role_category_id)
);

CREATE TABLE IF NOT EXISTS skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name citext NOT NULL UNIQUE,
  -- jsonb array of alternate names ("ReactJS", "React.js", ...). Used by
  -- skill matching in the JD-match engine.
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city text NOT NULL,
  state text,
  country text NOT NULL DEFAULT 'India',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city, state, country)
);

CREATE TABLE IF NOT EXISTS disqualification_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 7. Clients + client_recruiters
-- =====================================================================

CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_name text NOT NULL,
  slug text,
  industry text,
  -- Free-form for now (strategic / growth / standard); we'll formalize the
  -- enum if/when delivery wants enforcement.
  tier text,
  bh_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','closed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_offer_letter_client_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clients_org_idx ON clients(org_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS clients_org_slug_key ON clients(org_id, slug)
  WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS client_recruiters (
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  recruiter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, recruiter_id)
);
CREATE INDEX IF NOT EXISTS client_recruiters_recruiter_idx
  ON client_recruiters(recruiter_id) WHERE status = 'active';

-- =====================================================================
-- 8. Demands (the role to fill)
-- =====================================================================

CREATE TABLE IF NOT EXISTS demands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  title text NOT NULL,
  designation text,
  description text,
  responsibilities text,

  experience_min_years numeric,
  experience_max_years numeric,
  salary_from numeric,
  salary_to numeric,
  number_of_openings integer NOT NULL DEFAULT 1,
  max_submissions integer,
  primary_location text,

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','active','on_hold','closed','cancelled')),
  is_vip boolean NOT NULL DEFAULT false,
  client_internal_ticket_id text,
  requested_by text,
  requested_date date,
  expected_closure_date date,
  group_name text,
  sub_group_name text,
  po_opportunity_mrr numeric,
  potential_gm numeric,

  industry_id uuid REFERENCES industries(id) ON DELETE SET NULL,
  functional_area_id uuid REFERENCES functional_areas(id) ON DELETE SET NULL,
  role_category_id uuid REFERENCES role_categories(id) ON DELETE SET NULL,
  job_role_id uuid REFERENCES job_roles(id) ON DELETE SET NULL,

  -- Rich qualitative content from the AM probing call: work mode, candidate
  -- role detail, interview type, notice period acceptable, feedback ETA,
  -- urgency, project size/count, reporting manager location.
  probing_details jsonb,
  -- Array of pre-employment checks required (BGV, drug, etc.).
  mandatory_checks jsonb NOT NULL DEFAULT '[]'::jsonb,

  external_offer_letter_demand_id integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demands_org_status_idx ON demands(org_id, status);
CREATE INDEX IF NOT EXISTS demands_client_idx ON demands(client_id);
CREATE INDEX IF NOT EXISTS demands_vip_idx ON demands(org_id) WHERE is_vip = true;

CREATE TABLE IF NOT EXISTS demand_skills (
  demand_id uuid NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  is_mandatory boolean NOT NULL DEFAULT false,
  -- Per-skill weight for JD-match scoring; defaults to 1.0.
  weight numeric NOT NULL DEFAULT 1.0,
  PRIMARY KEY (demand_id, skill_id)
);
CREATE INDEX IF NOT EXISTS demand_skills_skill_idx ON demand_skills(skill_id);

CREATE TABLE IF NOT EXISTS demand_locations (
  demand_id uuid NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (demand_id, location_id)
);

CREATE TABLE IF NOT EXISTS demand_assignments (
  demand_id uuid NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  recruiter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  released_at timestamptz,
  PRIMARY KEY (demand_id, recruiter_id, assigned_at)
);
CREATE INDEX IF NOT EXISTS demand_assignments_recruiter_active_idx
  ON demand_assignments(recruiter_id) WHERE status = 'active';

-- =====================================================================
-- 9. Candidates (the people we might submit)
-- =====================================================================

CREATE TABLE IF NOT EXISTS candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  email citext,
  phone text,
  -- Normalized derivatives for org-scoped dedup. Populated by the route
  -- that creates / updates a candidate. Indexes below.
  email_normalized citext,
  phone_e164_normalized text,

  first_name text,
  last_name text,
  display_name text,

  current_title text,
  current_company text,
  total_experience_years numeric,
  current_ctc_lakhs numeric,
  expected_ctc_lakhs numeric,
  notice_period_days integer,
  notice_period_negotiable boolean,
  current_location text,
  preferred_locations text[] NOT NULL DEFAULT '{}',

  linkedin_url text,
  naukri_profile_url text,
  github_url text,
  summary text,

  resume_blob_key text,
  -- Populated by the resume_parse worker (stub today). Schema is loose
  -- because vendor parsers vary.
  parsed_resume_json jsonb,
  -- Placeholder for the consent ledger; null in MVP.
  consent_snapshot_json jsonb,

  source text NOT NULL DEFAULT 'direct'
    CHECK (source IN ('naukri','linkedin','referral','direct','internal_db','imported','other')),
  source_metadata jsonb,

  external_offer_letter_user_id integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Org-scoped dedup indexes. Email is unique per org; phone (last-10
-- normalized) is unique per org. These are partial because some legacy
-- imports may have nulls.
CREATE UNIQUE INDEX IF NOT EXISTS candidates_org_email_norm_key
  ON candidates(org_id, email_normalized)
  WHERE email_normalized IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS candidates_org_phone_norm_key
  ON candidates(org_id, phone_e164_normalized)
  WHERE phone_e164_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS candidates_org_idx ON candidates(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS candidate_skills (
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  proficiency_level integer CHECK (proficiency_level BETWEEN 1 AND 5),
  years_of_experience numeric,
  PRIMARY KEY (candidate_id, skill_id)
);
CREATE INDEX IF NOT EXISTS candidate_skills_skill_idx ON candidate_skills(skill_id);

CREATE TABLE IF NOT EXISTS candidate_experiences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  company_name text NOT NULL,
  title text,
  start_date date,
  end_date date,
  is_current boolean NOT NULL DEFAULT false,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidate_experiences_candidate_idx
  ON candidate_experiences(candidate_id, start_date DESC);

CREATE TABLE IF NOT EXISTS candidate_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  degree text,
  institution text,
  field_of_study text,
  year_of_completion integer,
  marks_or_grade text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidate_qualifications_candidate_idx
  ON candidate_qualifications(candidate_id);

-- =====================================================================
-- 10. Prospects + prospect_calls (the pre-submission workspace)
-- =====================================================================

CREATE TABLE IF NOT EXISTS prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  demand_id uuid NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  recruiter_id uuid NOT NULL REFERENCES users(id) ON DELETE SET NULL,

  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','contacted','interested','not_interested','unreachable','qualified','disqualified','submitted','parked')),
  -- Recruiter's gut score 1-5.
  interest_level integer CHECK (interest_level BETWEEN 1 AND 5),
  disqualification_reason text
    CHECK (disqualification_reason IN ('experience_mismatch','skill_mismatch','location_mismatch','compensation_mismatch','notice_period_mismatch','not_interested','unreachable','duplicate','other')),
  notes text,
  last_contacted_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A recruiter shouldn't be working the same candidate against the same
  -- demand twice in parallel.
  UNIQUE (demand_id, candidate_id, recruiter_id)
);
CREATE INDEX IF NOT EXISTS prospects_recruiter_status_idx
  ON prospects(recruiter_id, status);
CREATE INDEX IF NOT EXISTS prospects_demand_status_idx
  ON prospects(demand_id, status);

CREATE TABLE IF NOT EXISTS prospect_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  recruiter_id uuid NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  call_session_id uuid REFERENCES call_sessions(id) ON DELETE SET NULL,
  outcome text NOT NULL DEFAULT 'connected'
    CHECK (outcome IN ('connected','no_answer','busy','wrong_number','voicemail','callback_requested')),
  duration_seconds integer,
  summary text,
  next_step text,
  next_step_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prospect_calls_prospect_idx
  ON prospect_calls(prospect_id, created_at DESC);

-- =====================================================================
-- 11. Submissions + downstream stages
-- =====================================================================

-- Submission stage enum. The TS-side STAGE_METADATA map (in @j2w/db) is the
-- source of truth for transition validity; the CHECK here only enforces
-- "value is in the universe of legal stages."
CREATE TABLE IF NOT EXISTS submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  demand_id uuid NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  submitted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  current_stage text NOT NULL DEFAULT 'internal_review'
    CHECK (current_stage IN (
      'applied','internal_review','internal_reject',
      'client_submit','client_screen_reject',
      'l1_scheduled','l1_no_show','l1_reject','l1_select',
      'l2_scheduled','l2_no_show','l2_reject','l2_select',
      'l3_scheduled','l3_no_show','l3_reject','l3_select',
      'final_select','on_hold','position_closed','panel_unavailable',
      'duplicate_profile',
      'offer_pending','offer_released','offer_accepted','offer_rejected',
      'onboarded','exited','withdrawn'
    )),
  previous_stage text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  recruiter_note text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','withdrawn','closed')),

  external_offer_letter_applied_jobs_id integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS submissions_org_stage_idx ON submissions(org_id, current_stage);
CREATE INDEX IF NOT EXISTS submissions_demand_idx    ON submissions(demand_id);
CREATE INDEX IF NOT EXISTS submissions_candidate_idx ON submissions(candidate_id);
CREATE INDEX IF NOT EXISTS submissions_recruiter_idx ON submissions(submitted_by_user_id);
-- One *active* submission per (demand, candidate) at a time. After a
-- terminal stage (withdrawn / closed) a new row may be created.
CREATE UNIQUE INDEX IF NOT EXISTS submissions_active_demand_candidate_key
  ON submissions(demand_id, candidate_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS submission_stage_transitions (
  id bigserial PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  from_stage text,
  to_stage text NOT NULL,
  changed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason_text text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS submission_stage_transitions_submission_idx
  ON submission_stage_transitions(submission_id, created_at DESC);

CREATE TABLE IF NOT EXISTS interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('l1','l2','l3','l4','l5','l6','hr','final')),
  scheduled_at timestamptz,
  mode text CHECK (mode IN ('in_person','video','phone')),
  venue text,
  interviewer_name text,
  client_spoc text,
  outcome text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending','select','reject','no_show','reschedule','on_hold','panel_unavailable','position_closed')),
  feedback_text text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interviews_submission_idx
  ON interviews(submission_id, scheduled_at DESC);

CREATE TABLE IF NOT EXISTS selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  selected_at timestamptz NOT NULL DEFAULT now(),
  tentative_doj_date date,
  current_ctc_lakhs numeric,
  offered_ctc_lakhs numeric,
  po_value_lakhs numeric,
  margin_lakhs numeric,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_id uuid NOT NULL REFERENCES selections(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','approved','released','accepted','onboarded','exited','terminated','rejected')),
  joining_date date,
  client_onboard_date date,
  po_value_lakhs numeric,
  margin_lakhs numeric,
  employee_type text,
  released_at timestamptz,
  accepted_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offers_selection_idx ON offers(selection_id);

-- =====================================================================
-- 12. Backfill the FK constraints on call_sessions added in section 3
-- =====================================================================

ALTER TABLE call_sessions
  ADD CONSTRAINT call_sessions_demand_fk
    FOREIGN KEY (demand_id) REFERENCES demands(id) ON DELETE SET NULL,
  ADD CONSTRAINT call_sessions_prospect_fk
    FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE SET NULL,
  ADD CONSTRAINT call_sessions_candidate_fk
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE SET NULL;

-- =====================================================================
-- 13. Rubrics + JD-match runs + question banks
-- =====================================================================

CREATE TABLE IF NOT EXISTS call_rubrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  purpose text NOT NULL DEFAULT 'general_screen'
    CHECK (purpose IN ('general_screen','technical_screen','senior_technical','hr_screen','outbound_pitch')),
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  -- Array of { id, name, description, weight, bandThresholds, autoScoreEnabled, kind }.
  -- See packages/db/src/schema.ts for the TS shape.
  criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_rubrics_org_idx ON call_rubrics(org_id, purpose);
CREATE UNIQUE INDEX IF NOT EXISTS call_rubrics_org_default_key
  ON call_rubrics(org_id, purpose) WHERE is_default = true;

-- Per-call, per-criterion final score. Written by the rubric_finalize
-- worker on call end; the QA reviewer can also override these via
-- call_qa_reviews.criterion_overrides.
CREATE TABLE IF NOT EXISTS call_rubric_scores (
  id bigserial PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  rubric_id uuid NOT NULL REFERENCES call_rubrics(id) ON DELETE CASCADE,
  criterion_id text NOT NULL,
  score numeric NOT NULL,
  band text CHECK (band IN ('fail','pass','excellent')),
  evidence_quotes jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale text,
  confidence numeric,
  model_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, criterion_id)
);
CREATE INDEX IF NOT EXISTS call_rubric_scores_call_idx
  ON call_rubric_scores(call_id);

CREATE TABLE IF NOT EXISTS jd_match_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id uuid NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  triggered_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  triggered_by text NOT NULL DEFAULT 'manual'
    CHECK (triggered_by IN ('manual','submission','post_call','batch')),
  model_version text NOT NULL,
  overall_score numeric NOT NULL,
  must_haves_score numeric,
  nice_to_haves_score numeric,
  experience_fit_score numeric,
  compensation_fit_score numeric,
  location_fit_score numeric,
  notice_period_fit_score numeric,
  semantic_score numeric,
  explanation jsonb NOT NULL DEFAULT '[]'::jsonb,
  gaps jsonb NOT NULL DEFAULT '[]'::jsonb,
  strengths jsonb NOT NULL DEFAULT '[]'::jsonb,
  verdict text NOT NULL CHECK (verdict IN ('strong_match','partial_match','weak_match','no_match')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jd_match_runs_demand_idx
  ON jd_match_runs(demand_id, overall_score DESC);
CREATE INDEX IF NOT EXISTS jd_match_runs_candidate_idx
  ON jd_match_runs(candidate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS question_banks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS question_banks_org_idx ON question_banks(org_id);

CREATE TABLE IF NOT EXISTS question_bank_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_id uuid NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
  skill_id uuid REFERENCES skills(id) ON DELETE SET NULL,
  level text CHECK (level IN ('junior','mid','senior','staff')),
  difficulty integer CHECK (difficulty BETWEEN 1 AND 5),
  prompt text NOT NULL,
  expected_answer_hints text,
  -- Key points to look for in the candidate's answer; consumed by the
  -- post-call technical_qa_extract worker.
  evaluation_rubric jsonb NOT NULL DEFAULT '[]'::jsonb,
  follow_up_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  common_mistakes jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qbq_bank_idx  ON question_bank_questions(bank_id);
CREATE INDEX IF NOT EXISTS qbq_skill_idx ON question_bank_questions(skill_id) WHERE skill_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS question_bank_demand_links (
  bank_id uuid NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE,
  demand_id uuid NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  PRIMARY KEY (bank_id, demand_id)
);

-- =====================================================================
-- 14. Voice agents: link to demand + linked rubric, recruiter purpose vocab
-- =====================================================================

ALTER TABLE voice_agents
  ADD COLUMN IF NOT EXISTS demand_id uuid REFERENCES demands(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_rubric_id uuid REFERENCES call_rubrics(id) ON DELETE SET NULL;

-- =====================================================================
-- 15. Manual speaker brackets (optional recruiter-driven labeling)
-- =====================================================================

-- "I am speaking now" / "Candidate speaking now" markers from the live UI.
-- The post-call diarization worker uses these as ground truth before
-- falling back to Deepgram diarization confidence.
CREATE TABLE IF NOT EXISTS transcript_speaker_brackets (
  id bigserial PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  speaker text NOT NULL CHECK (speaker IN ('recruiter','candidate')),
  ts_ms integer NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','diarize','vapi')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transcript_speaker_brackets_call_idx
  ON transcript_speaker_brackets(call_id, ts_ms);
