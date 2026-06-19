-- Resume history for candidates. Every uploaded PDF/DOCX gets a row here so
-- recruiters can see every version they (or a teammate) ingested. The
-- candidates table's resume_blob_key + parsed_resume_json continue to mirror
-- the latest row for fast read paths.

CREATE TABLE IF NOT EXISTS candidate_resumes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  blob_key text NOT NULL,
  sha256 text,
  bytes integer,
  mime text,
  original_filename text,
  parsed_resume_json jsonb,
  model_used text,
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS candidate_resumes_candidate_idx
  ON candidate_resumes(candidate_id, created_at DESC);
