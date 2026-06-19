-- Client portal: per-submission feedback from the client_user role + the
-- linkage column that ties a client_user membership to a specific client.
--
-- The client portal is the surface where a buyer's hiring manager
-- reviews submitted candidates, gives a forward/reject/hold decision,
-- and proposes interview slots. It's gated by role=client_user; this
-- migration carries the structural pieces that wiring needs.

-- 1. Tie client_user memberships to a specific client. Existing
--    membership rows for non-client_user roles stay untouched.
ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS memberships_client_idx
  ON memberships(client_id);

-- 2. Persisted feedback, append-only. The submission's current_stage moves
--    via the existing submission_stage_transitions audit, but the
--    decision + note from the client lives here. One row per
--    (submission, client_user, createdAt) — the recruiter sees the
--    most recent.
CREATE TABLE IF NOT EXISTS submission_client_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  client_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('forward', 'hold', 'reject')),
  note text,
  proposed_interview_slots jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS submission_client_feedback_submission_idx
  ON submission_client_feedback(submission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS submission_client_feedback_user_idx
  ON submission_client_feedback(client_user_id);
