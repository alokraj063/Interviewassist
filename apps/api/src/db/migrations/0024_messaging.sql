-- Outbound messaging log. Every WhatsApp/SMS the recruiter sends gets a
-- row here, surfaced on the candidate timeline. The provider (mock /
-- exotel / etc) field captures who actually delivered it.

CREATE TABLE IF NOT EXISTS messaging_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  candidate_id uuid REFERENCES candidates(id) ON DELETE SET NULL,
  recruiter_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  provider text NOT NULL DEFAULT 'mock'
    CHECK (provider IN ('mock', 'exotel', 'twilio', 'whatsapp_business')),
  direction text NOT NULL DEFAULT 'outbound'
    CHECK (direction IN ('outbound', 'inbound')),
  to_address text NOT NULL,
  template_id text,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'read')),
  error_message text,
  remote_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS messaging_events_candidate_idx
  ON messaging_events(candidate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messaging_events_org_idx
  ON messaging_events(org_id, created_at DESC);
