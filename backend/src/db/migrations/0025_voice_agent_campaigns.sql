-- Bulk-call campaigns for voice agents. A recruiter picks a voice agent,
-- a candidate list, and a launch window; the worker dials each target
-- and writes status back to voice_agent_call_targets.

CREATE TABLE IF NOT EXISTS voice_agent_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  voice_agent_id uuid NOT NULL REFERENCES voice_agents(id) ON DELETE CASCADE,
  demand_id uuid REFERENCES demands(id) ON DELETE SET NULL,
  name text NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled')),
  scheduled_for timestamptz,
  rate_per_minute integer NOT NULL DEFAULT 10,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_agent_campaigns_org_idx
  ON voice_agent_campaigns(org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_agent_campaigns_agent_idx
  ON voice_agent_campaigns(voice_agent_id);

CREATE TABLE IF NOT EXISTS voice_agent_call_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES voice_agent_campaigns(id) ON DELETE CASCADE,
  candidate_id uuid REFERENCES candidates(id) ON DELETE SET NULL,
  phone text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'dialing', 'connected', 'completed', 'failed', 'no_answer', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  call_id uuid REFERENCES call_sessions(id) ON DELETE SET NULL,
  outcome text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_agent_call_targets_campaign_idx
  ON voice_agent_call_targets(campaign_id, status, created_at);
CREATE INDEX IF NOT EXISTS voice_agent_call_targets_candidate_idx
  ON voice_agent_call_targets(candidate_id);
