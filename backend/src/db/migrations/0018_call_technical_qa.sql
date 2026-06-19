-- Technical Q&A spans extracted from a recruiter-candidate call by the
-- technical_qa_extract worker. Surfaced in the QA reviewer drawer and on
-- the Call Detail "Q&A" tab so reviewers can validate the candidate's
-- technical depth without re-listening to the recording.

CREATE TABLE IF NOT EXISTS call_technical_qa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  -- One row per (call, question_index). Re-running the worker overwrites.
  question_index integer NOT NULL,
  skill text,
  difficulty text CHECK (difficulty IN ('easy', 'medium', 'hard')),
  question text NOT NULL,
  answer text,
  evaluation text CHECK (evaluation IN ('correct', 'partially_correct', 'incorrect', 'no_answer')),
  ts_question_start_ms integer,
  ts_answer_end_ms integer,
  rationale text,
  confidence numeric(4, 3),
  model_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, question_index)
);

CREATE INDEX IF NOT EXISTS call_technical_qa_call_idx
  ON call_technical_qa(call_id, question_index);

CREATE INDEX IF NOT EXISTS call_technical_qa_skill_idx
  ON call_technical_qa(skill);
