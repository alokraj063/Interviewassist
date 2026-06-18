-- Async-video screening: candidate records 1-N short responses to
-- recruiter prompts on their own time. The recruiter reviews from a queue.

CREATE TABLE IF NOT EXISTS async_video_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  demand_id uuid REFERENCES demands(id) ON DELETE SET NULL,
  title text NOT NULL,
  intro_text text,
  prompts jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- per-prompt cap, in seconds
  max_seconds_per_prompt integer NOT NULL DEFAULT 120,
  -- candidate retake allowance per prompt (0 = single-take)
  max_retakes integer NOT NULL DEFAULT 0,
  is_published boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS async_video_campaigns_org_idx
  ON async_video_campaigns(org_id, is_published, created_at DESC);

CREATE TABLE IF NOT EXISTS async_video_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES async_video_campaigns(id) ON DELETE CASCADE,
  candidate_id uuid REFERENCES candidates(id) ON DELETE SET NULL,
  invite_token text NOT NULL UNIQUE,
  invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'started', 'submitted', 'reviewed', 'expired')),
  expires_at timestamptz,
  -- Per-prompt video uploads. Each entry: { promptIndex, blobKey, durationSec, recordedAt }
  videos jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewer_decision text CHECK (reviewer_decision IN ('forward', 'hold', 'reject')),
  reviewer_notes text,
  reviewer_score integer,
  started_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS async_video_submissions_campaign_idx
  ON async_video_submissions(campaign_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS async_video_submissions_candidate_idx
  ON async_video_submissions(candidate_id, created_at DESC);
