-- Proctor cockpit: live integrity monitoring of an assessment / async-video
-- session. Sessions are 1:1 with an assessment_attempt or
-- async_video_submission; proctor_events are a time-ordered log of
-- candidate-side instrumentation flags (tab switch, paste, multi-face,
-- etc) that the reviewer can ack/clear.

CREATE TABLE IF NOT EXISTS proctor_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- One of these is set per session; never both.
  assessment_attempt_id uuid REFERENCES assessment_attempts(id) ON DELETE CASCADE,
  async_video_submission_id uuid REFERENCES async_video_submissions(id) ON DELETE CASCADE,
  candidate_id uuid REFERENCES candidates(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'live'
    CHECK (status IN ('live', 'completed', 'abandoned')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  flag_count integer NOT NULL DEFAULT 0,
  reviewer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewer_decision text CHECK (reviewer_decision IN ('clean', 'flagged', 'invalidated')),
  reviewer_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (assessment_attempt_id IS NOT NULL AND async_video_submission_id IS NULL) OR
    (assessment_attempt_id IS NULL AND async_video_submission_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS proctor_sessions_org_status_idx
  ON proctor_sessions(org_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS proctor_sessions_attempt_idx
  ON proctor_sessions(assessment_attempt_id);
CREATE INDEX IF NOT EXISTS proctor_sessions_av_idx
  ON proctor_sessions(async_video_submission_id);

CREATE TABLE IF NOT EXISTS proctor_events (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES proctor_sessions(id) ON DELETE CASCADE,
  -- e.g. tab_switch, window_blur, paste, copy, multi_face, no_face,
  -- audio_other_voice, network_drop, fullscreen_exit
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'medium', 'high')),
  payload jsonb,
  flagged boolean NOT NULL DEFAULT true,
  reviewer_acked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proctor_events_session_idx
  ON proctor_events(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS proctor_events_severity_idx
  ON proctor_events(severity, flagged, created_at DESC);
