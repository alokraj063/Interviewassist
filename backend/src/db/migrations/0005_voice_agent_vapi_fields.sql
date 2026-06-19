-- Add the remaining Vapi assistant fields to voice_agents so an agent in our
-- builder maps 1:1 to a Vapi assistant. Also add columns that let us track
-- Vapi-side KB artifacts (file ids on documents, tool id on sources) so we
-- can push KB uploads to Vapi's native query-tool instead of running our own
-- vector DB at call time.
--
-- Keep in sync with packages/db/src/schema.ts.

ALTER TABLE voice_agents
  ADD COLUMN IF NOT EXISTS voice_config jsonb,
  ADD COLUMN IF NOT EXISTS transcriber_endpointing integer,
  ADD COLUMN IF NOT EXISTS voicemail_message text,
  ADD COLUMN IF NOT EXISTS end_call_message text,
  ADD COLUMN IF NOT EXISTS end_call_phrases jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS client_messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS server_messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS artifact_plan jsonb,
  ADD COLUMN IF NOT EXISTS start_speaking_plan jsonb,
  ADD COLUMN IF NOT EXISTS stop_speaking_plan jsonb,
  ADD COLUMN IF NOT EXISTS compliance_plan jsonb;

ALTER TABLE kb_sources
  ADD COLUMN IF NOT EXISTS vapi_tool_id text;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS vapi_file_id text;
