-- Voice agents (Vapi-backed AI voice agents) + deployment history.
-- Also extends call_sessions with voice_agent_id + "vapi" origin enum member
-- so webhook-ingested calls can attribute to a voice agent.
--
-- Keep in sync with packages/db/src/schema.ts.

CREATE TABLE IF NOT EXISTS voice_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  purpose text NOT NULL DEFAULT '',

  system_prompt text NOT NULL DEFAULT '',
  first_message text NOT NULL DEFAULT 'Hello! How can I help you today?',

  language text NOT NULL DEFAULT 'multi',

  transcriber_provider text NOT NULL DEFAULT 'deepgram',
  transcriber_model text NOT NULL DEFAULT 'nova-3',
  transcriber_language text NOT NULL DEFAULT 'multi',

  llm_provider text NOT NULL DEFAULT 'openai',
  llm_model text NOT NULL DEFAULT 'gpt-4o',
  llm_temperature real NOT NULL DEFAULT 0.5,

  voice_provider text NOT NULL DEFAULT '11labs',
  voice_id text NOT NULL DEFAULT '',

  tone text NOT NULL DEFAULT 'friendly',
  personality jsonb,

  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  knowledge_source_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  compliance jsonb,
  escalation jsonb,

  max_duration_sec integer NOT NULL DEFAULT 600,

  vapi_assistant_id text,
  vapi_phone_id text,
  phone_number text,
  last_deployed_at timestamptz,

  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_agents_org_idx ON voice_agents (org_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS voice_agents_vapi_assistant_key
  ON voice_agents (vapi_assistant_id)
  WHERE vapi_assistant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS voice_agent_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES voice_agents(id) ON DELETE CASCADE,
  deployed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  deployed_at timestamptz NOT NULL DEFAULT now(),
  vapi_config_snapshot jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'failed')),
  error_message text
);

CREATE INDEX IF NOT EXISTS voice_agent_deployments_agent_idx
  ON voice_agent_deployments (agent_id, deployed_at);

-- Extend call_sessions with voice_agent_id + allow "vapi" origin.
ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS voice_agent_id uuid REFERENCES voice_agents(id) ON DELETE SET NULL;

-- Drop + recreate the origin check constraint to include 'vapi'.
-- The constraint name is auto-assigned; find it dynamically.
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
  CHECK (origin IS NULL OR origin IN ('web', 'telephony', 'desktop', 'vapi'));

CREATE INDEX IF NOT EXISTS call_sessions_voice_agent_idx
  ON call_sessions (voice_agent_id)
  WHERE voice_agent_id IS NOT NULL;
