-- 0041: track audio-based usage (Deepgram STT is billed by minutes, not tokens).
ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS audio_seconds numeric(12,2) NOT NULL DEFAULT 0;
