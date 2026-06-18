-- Per-tenant integration credentials + platform-admin (super-admin) flag.
--
-- Credentials are encrypted at the application layer with AES-256-GCM keyed
-- off env.INTEGRATIONS_KEK. Postgres only ever sees ciphertext; the master
-- key never leaves the API process. Layout of `ciphertext` is:
--   bytes [0..12)   = AES-GCM nonce (IV)
--   bytes [12..N-16) = encrypted JSON payload
--   bytes [N-16..N) = AES-GCM auth tag
-- See apps/api/src/integrations/encryption.ts.
--
-- Platform admins have no membership; they administrate tenants, not
-- conversations. The flag is on `users` and gets a non-null orgId only when
-- they're impersonating a tenant (out of scope for this milestone).

-- ---------- users.is_platform_admin ----------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;

-- Most platform admins are rare; partial index keeps lookups cheap without
-- bloating the row layout for everyone else.
CREATE INDEX IF NOT EXISTS users_platform_admin_idx
  ON users (id)
  WHERE is_platform_admin = true;

-- ---------- tenant_integrations ----------
CREATE TABLE IF NOT EXISTS tenant_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('vapi','deepgram','sarvam','shunya')),
  ciphertext bytea NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider)
);

CREATE INDEX IF NOT EXISTS tenant_integrations_org_idx
  ON tenant_integrations (org_id)
  WHERE enabled = true;
