-- Phase 2 acoustic sentiment: per-window prosodic features + valence/arousal.
-- Worker job writes one row per ~500ms window per speaker channel.
-- Keep in sync with packages/db/src/schema.ts.

CREATE TABLE IF NOT EXISTS transcript_acoustic_windows (
  id bigserial PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  speaker text NOT NULL CHECK (speaker IN ('agent','customer')),
  ts_start_ms integer NOT NULL,
  ts_end_ms integer NOT NULL,
  valence real NOT NULL,
  arousal real NOT NULL,
  f0_mean real,
  rms_energy real,
  model_version text NOT NULL
);
CREATE INDEX IF NOT EXISTS acoustic_windows_call_idx
  ON transcript_acoustic_windows(call_id, ts_start_ms);
