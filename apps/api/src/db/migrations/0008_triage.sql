-- Phase 2 AI triage — discriminator on voice_agents, routing rules per
-- triage flow, and an audit trail of every routing decision a call passes
-- through. Keep in sync with packages/db/src/schema.ts.

-- ---------- voice_agents discriminator + routing config ----------
ALTER TABLE voice_agents
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'specialist',
  ADD COLUMN IF NOT EXISTS routing jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'voice_agents_kind_check'
  ) THEN
    ALTER TABLE voice_agents
      ADD CONSTRAINT voice_agents_kind_check
      CHECK (kind IN ('specialist', 'triage'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS voice_agents_kind_idx
  ON voice_agents(org_id, kind, status);

-- Stored squad id per triage flow so warm-transfer to another voice agent
-- can switch members without re-creating the squad on every routing event.
ALTER TABLE voice_agents
  ADD COLUMN IF NOT EXISTS vapi_squad_id text;

-- ---------- triage_routing_rules ----------
CREATE TABLE IF NOT EXISTS triage_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  triage_agent_id uuid NOT NULL REFERENCES voice_agents(id) ON DELETE CASCADE,
  priority integer NOT NULL,
  intent text NOT NULL,
  conditions jsonb,
  destination_type text NOT NULL
    CHECK (destination_type IN ('human_team','voice_agent','external_pstn','voicemail')),
  destination_ref text NOT NULL,
  destination_label text NOT NULL,
  handoff_mode text NOT NULL DEFAULT 'warm'
    CHECK (handoff_mode IN ('warm','cold','voicemail')),
  enabled boolean NOT NULL DEFAULT true,
  ui_position jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS triage_routing_rules_lookup_idx
  ON triage_routing_rules(org_id, triage_agent_id, priority);

-- ---------- call_routing_events ----------
-- One row per stage of a call's journey through triage and handoff. The
-- supervisor live-feed and analytics both query against this.
CREATE TABLE IF NOT EXISTS call_routing_events (
  id bigserial PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  kind text NOT NULL
    CHECK (kind IN (
      'triage_started',
      'classified',
      'route_decision',
      'handoff_initiated',
      'handoff_accepted',
      'handoff_failed',
      'handoff_completed'
    )),
  from_ref jsonb,
  to_ref jsonb,
  classification jsonb,
  rule_id uuid REFERENCES triage_routing_rules(id) ON DELETE SET NULL,
  provider_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_routing_events_call_seq_idx
  ON call_routing_events(call_id, seq);
CREATE INDEX IF NOT EXISTS call_routing_events_org_at_idx
  ON call_routing_events(org_id, created_at DESC);
