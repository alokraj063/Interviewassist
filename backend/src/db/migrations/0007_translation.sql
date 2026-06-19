-- Phase 2 live translation.
-- Workspace defaults, per-turn translation records, and custom glossaries.
-- Keep in sync with packages/db/src/schema.ts.

-- ---------- Workspace defaults ----------
CREATE TABLE IF NOT EXISTS workspace_translation_settings (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'mock',
  model text NOT NULL DEFAULT 'mock-v1',
  default_source_lang text NOT NULL DEFAULT 'auto',
  default_target_lang text NOT NULL DEFAULT 'en-US',
  latency_mode text NOT NULL DEFAULT 'balanced'
    CHECK (latency_mode IN ('realtime','balanced','accurate')),
  preserve_tone boolean NOT NULL DEFAULT true,
  voice_cloning boolean NOT NULL DEFAULT false,
  confidence_threshold real NOT NULL DEFAULT 0.6,
  low_confidence_action text NOT NULL DEFAULT 'show-warning'
    CHECK (low_confidence_action IN ('show-warning','insert-original','drop')),
  glossary_id uuid,
  redact_pii boolean NOT NULL DEFAULT false,
  profanity_filter boolean NOT NULL DEFAULT false,
  custom_phrases text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Glossaries ----------
CREATE TABLE IF NOT EXISTS translation_glossaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS translation_glossaries_org_idx
  ON translation_glossaries(org_id);

CREATE TABLE IF NOT EXISTS translation_glossary_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  glossary_id uuid NOT NULL REFERENCES translation_glossaries(id) ON DELETE CASCADE,
  source_text text NOT NULL,
  target_text text NOT NULL,
  source_lang text,
  target_lang text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS translation_glossary_entries_glossary_idx
  ON translation_glossary_entries(glossary_id);

-- Bridge workspace_translation_settings.glossary_id → translation_glossaries.id
-- with ON DELETE SET NULL so deleting a glossary doesn't orphan settings rows.
-- (Added after the glossaries table exists so the FK target resolves.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_translation_settings_glossary_fk'
  ) THEN
    ALTER TABLE workspace_translation_settings
      ADD CONSTRAINT workspace_translation_settings_glossary_fk
      FOREIGN KEY (glossary_id) REFERENCES translation_glossaries(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ---------- Per-turn translation records ----------
CREATE TABLE IF NOT EXISTS call_translations (
  id bigserial PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  turn_id bigint NOT NULL REFERENCES transcript_turns(id) ON DELETE CASCADE,
  speaker text NOT NULL CHECK (speaker IN ('agent','customer')),
  source_lang text NOT NULL,
  source_text text NOT NULL,
  target_lang text NOT NULL,
  target_text text NOT NULL,
  confidence real NOT NULL,
  latency_ms integer NOT NULL,
  provider text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_translations_call_idx
  ON call_translations(call_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS call_translations_turn_key
  ON call_translations(turn_id);
