-- Per-recruiter activity signal on demand assignments.
--
-- Background: job_assignments in the J2W Offer Letter MySQL holds every
-- demand a recruiter has been assigned to. Coverage is real (93% of open
-- demands; 97% of demands < 30 days old) and senior recruiters legitimately
-- carry thousands of rows. The recruiter home view should not cap the list
-- by recency — it should sort by where the recruiter has live pipeline.
--
-- The demand-sync worker now joins applied_jobs per (recruiter, demand) to
-- count non-terminal candidate steps in the last 365 days, and writes the
-- counts back here. The /api/demands?assignedToMe=true endpoint orders by
-- these columns so the recruiter's actual workload surfaces first.
--
-- See docs/demand-recruiter-attribution.md for the canonical reference.

ALTER TABLE demand_assignments
  ADD COLUMN IF NOT EXISTS active_candidates_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_recruiter_activity_at timestamptz;

-- Sort index for the recruiter home view: live pipeline first, then most
-- recently touched. Partial on status='active' so we don't pay for it on
-- released rows.
CREATE INDEX IF NOT EXISTS demand_assignments_recruiter_activity_idx
  ON demand_assignments (recruiter_id, active_candidates_count DESC, last_recruiter_activity_at DESC NULLS LAST)
  WHERE status = 'active';
