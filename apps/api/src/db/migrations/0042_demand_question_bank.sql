-- Per-JD question bank: recruiter emphasis notes + a cached, reusable
-- skill-wise question bank generated once per demand (JD) and reused across
-- calls instead of regenerating every time.
ALTER TABLE demands
  ADD COLUMN IF NOT EXISTS assessment_notes text,
  ADD COLUMN IF NOT EXISTS question_bank jsonb,
  ADD COLUMN IF NOT EXISTS question_bank_generated_at timestamptz;
