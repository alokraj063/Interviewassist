-- Recruiter coaching: a library of scripted practice scenarios + a log of
-- recruiter runs against them. Each scenario carries a candidate persona
-- (used as the Vapi agent's system prompt during the practice call) and
-- targets a specific rubric for scoring. Runs are linked to a real
-- call_sessions row so transcripts, summaries, rubric scores all flow
-- through the standard pipeline.

CREATE TABLE IF NOT EXISTS coaching_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  difficulty text NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  -- Free-form JSON: candidate persona, expected probes, scripted resistance
  -- patterns, target outcome. The runtime feeds this verbatim to the Vapi
  -- agent's system prompt — see apps/api/src/coaching/prompt.ts.
  candidate_persona jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_rubric_id uuid REFERENCES call_rubrics(id) ON DELETE SET NULL,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  is_published boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coaching_scenarios_org_idx
  ON coaching_scenarios(org_id, is_published, created_at DESC);

CREATE TABLE IF NOT EXISTS coaching_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scenario_id uuid NOT NULL REFERENCES coaching_scenarios(id) ON DELETE CASCADE,
  recruiter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Optional FK — the practice call's call_sessions row. Null until the
  -- recruiter actually starts the call from SimulationRunner.
  call_id uuid REFERENCES call_sessions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'live', 'completed', 'abandoned')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  -- Cached score so the Coaching home page list can sort by recent perf
  -- without joining call_rubric_scores. Synced by the rubric_finalize
  -- worker (sees coaching_run row → updates here).
  cached_overall_score numeric(5, 2),
  feedback jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coaching_runs_scenario_idx
  ON coaching_runs(scenario_id, started_at DESC);
CREATE INDEX IF NOT EXISTS coaching_runs_recruiter_idx
  ON coaching_runs(recruiter_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS coaching_runs_call_idx
  ON coaching_runs(call_id);
