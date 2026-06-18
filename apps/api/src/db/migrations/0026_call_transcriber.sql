-- Persist the per-call transcription provider choice on call_sessions so the
-- recruiter wedge can drive Deepgram / Sarvam / Shunya (not just Deepgram).
--
-- Until now the browser-mic wedge (/ws/ingest-call) was hardcoded to Deepgram
-- and the Live Assist provider switcher had no effect on a real recruiter call.
-- POST /api/calls now records the recruiter's selection here, and the ingest
-- WebSocket reads it back to choose the upstream STT bridge.
--
-- NOTE: these are distinct from voice_agents.transcriber_* (the autonomous Vapi
-- screener config). This triple describes the live human-recruiter call.

ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS transcriber_provider text NOT NULL DEFAULT 'deepgram',
  ADD COLUMN IF NOT EXISTS transcriber_model    text NOT NULL DEFAULT 'nova-3',
  ADD COLUMN IF NOT EXISTS transcriber_language text NOT NULL DEFAULT 'multi';

-- Guard the universe of providers at the DB layer (mirrors the TS enum used by
-- the create route + ingest WS). Application code validates credentials.
ALTER TABLE call_sessions
  DROP CONSTRAINT IF EXISTS call_sessions_transcriber_provider_check;
ALTER TABLE call_sessions
  ADD CONSTRAINT call_sessions_transcriber_provider_check
  CHECK (transcriber_provider IN ('deepgram', 'sarvam', 'shunya'));
