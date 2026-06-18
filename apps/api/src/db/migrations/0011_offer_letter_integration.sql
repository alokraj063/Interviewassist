-- Offer Letter MySQL integration: sync heartbeats + outbox.
--
-- Heartbeats let the UI surface a "stale data" banner when a sync queue
-- silently stops (the worst kind of failure). One row per (org, queue);
-- last_run_at + last_error are updated on every run.
--
-- Outbox stages submission write-back to OL. Phase 1: rows accumulate; the
-- drain worker is unimplemented until INSERT grants on applied_jobs / users
-- / candidate_profiles are confirmed with J2W ops.
--
-- recordingUrl convention: the wav-dump path was previously persisted as a
-- file:// URI. We're moving to relative paths under DUMP_DIR so the
-- authenticated playback endpoint resolves consistently across containers.
-- Strip the file:// prefix and DUMP_DIR-relative path component from any
-- legacy rows.

-- ---------- offer_letter_sync_heartbeats ----------
CREATE TABLE IF NOT EXISTS offer_letter_sync_heartbeats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  queue_name text NOT NULL,
  last_run_at timestamptz NOT NULL DEFAULT now(),
  rows_upserted integer NOT NULL DEFAULT 0,
  duration_ms integer,
  last_error text,
  UNIQUE (org_id, queue_name)
);

CREATE INDEX IF NOT EXISTS offer_letter_sync_heartbeats_queue_idx
  ON offer_letter_sync_heartbeats (queue_name, last_run_at DESC);

-- ---------- offer_letter_outbox ----------
CREATE TABLE IF NOT EXISTS offer_letter_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target text NOT NULL CHECK (target IN ('applied_jobs','candidate_create','workflow_status')),
  payload jsonb NOT NULL,
  -- Optional pointer back to the local row that triggered this write so the
  -- drain worker can update it with the new external_offer_letter_*_id.
  source_table text,
  source_row_id uuid,
  attempt_count integer NOT NULL DEFAULT 0,
  last_attempted_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Drain worker (future) will SELECT WHERE sent_at IS NULL ORDER BY created_at LIMIT N.
CREATE INDEX IF NOT EXISTS offer_letter_outbox_pending_idx
  ON offer_letter_outbox (created_at)
  WHERE sent_at IS NULL;

-- ---------- call_qa_reviews.reviewer_user_id NULL-able ----------
-- The rubric-finalize worker seeds a pending review row before any reviewer
-- has claimed the call. Nullable reviewer means "in queue, not assigned yet".
-- The QA route stamps the column on first grading action.
ALTER TABLE call_qa_reviews
  ALTER COLUMN reviewer_user_id DROP NOT NULL;

-- ---------- recordingUrl normalization ----------
-- Rewrite any legacy file:// values that pointed under ./var/audio-dumps
-- into the new relative-path convention (<dateDir>/<callId>-recruiter.wav).
-- The auth playback endpoint resolves these against DUMP_DIR. Rows that
-- already use relative paths or live elsewhere (gs://, s3://) are untouched.
UPDATE call_sessions
   SET recording_url = regexp_replace(
         recording_url,
         '^file://.*audio-dumps/',
         ''
       )
 WHERE recording_url LIKE 'file://%audio-dumps/%';
