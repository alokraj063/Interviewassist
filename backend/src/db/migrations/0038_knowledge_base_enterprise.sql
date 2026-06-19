-- Knowledge Base enterprise rebuild: collections, grants, retrieval telemetry,
-- eval suites/runs, answer feedback, append-only audit. Additive + org-scoped.
-- Forward-only & idempotent (CREATE/ALTER ... IF NOT EXISTS, ON CONFLICT DO NOTHING).

BEGIN;

-- 1. Collections ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_collections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  corpus          text NOT NULL DEFAULT 'company' CHECK (corpus IN ('jd','company','question_bank')),
  status          text NOT NULL DEFAULT 'active'  CHECK (status IN ('active','deprecated')),
  stale_after_days integer CHECK (stale_after_days IS NULL OR stale_after_days > 0),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_collections_org_idx ON kb_collections(org_id);
CREATE INDEX IF NOT EXISTS kb_collections_org_status_updated_idx
  ON kb_collections(org_id, status, updated_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS kb_collections_org_name_uniq ON kb_collections(org_id, name);

-- 2. Per-collection grants ------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_collection_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES kb_collections(id) ON DELETE CASCADE,
  role          text,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  level         text NOT NULL DEFAULT 'read' CHECK (level IN ('read','manage')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((role IS NOT NULL AND user_id IS NULL) OR (role IS NULL AND user_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS kb_collection_grants_collection_idx ON kb_collection_grants(collection_id);
CREATE UNIQUE INDEX IF NOT EXISTS kb_collection_grants_role_uniq ON kb_collection_grants(collection_id, role);
CREATE UNIQUE INDEX IF NOT EXISTS kb_collection_grants_user_uniq ON kb_collection_grants(collection_id, user_id);

-- 3. Extend kb_sources ----------------------------------------------------
ALTER TABLE kb_sources ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES kb_collections(id) ON DELETE SET NULL;
ALTER TABLE kb_sources ADD COLUMN IF NOT EXISTS deprecated_at timestamptz;
ALTER TABLE kb_sources ADD COLUMN IF NOT EXISTS last_retrieved_at timestamptz;
-- widen status CHECK to include 'deprecated' (drop+recreate; original constraint is unnamed-by-default)
ALTER TABLE kb_sources DROP CONSTRAINT IF EXISTS kb_sources_status_check;
ALTER TABLE kb_sources ADD CONSTRAINT kb_sources_status_check
  CHECK (status IN ('indexing','indexed','error','deprecated'));
CREATE INDEX IF NOT EXISTS kb_sources_collection_idx ON kb_sources(collection_id);
CREATE INDEX IF NOT EXISTS kb_sources_org_status_created_idx ON kb_sources(org_id, status, created_at, id);

-- Backfill: one default collection per org that currently owns sources, so the
-- page is non-empty and every existing source belongs to a collection.
INSERT INTO kb_collections (org_id, name, corpus, created_at)
SELECT DISTINCT s.org_id, 'General knowledge', 'company', now()
FROM kb_sources s
WHERE s.collection_id IS NULL
ON CONFLICT (org_id, name) DO NOTHING;

UPDATE kb_sources s
SET collection_id = c.id
FROM kb_collections c
WHERE s.collection_id IS NULL AND c.org_id = s.org_id AND c.name = 'General knowledge';

-- 4. Retrieval telemetry --------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_retrieval_events (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  collection_id uuid REFERENCES kb_collections(id) ON DELETE SET NULL,
  source_id     uuid REFERENCES kb_sources(id) ON DELETE SET NULL,
  document_id   uuid,
  chunk_id      bigint,
  corpus        text CHECK (corpus IS NULL OR corpus IN ('jd','company','question_bank')),
  surface       text NOT NULL CHECK (surface IN ('suggest','kb_search','live_rubric','eval')),
  query_hash    text NOT NULL,
  rank          integer NOT NULL,
  score         double precision,
  is_top_hit    boolean NOT NULL DEFAULT false,
  had_results   boolean NOT NULL DEFAULT true,
  latency_ms    integer,
  call_id       uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_retr_org_created_idx ON kb_retrieval_events(org_id, created_at);
CREATE INDEX IF NOT EXISTS kb_retr_source_idx ON kb_retrieval_events(source_id);
CREATE INDEX IF NOT EXISTS kb_retr_collection_idx ON kb_retrieval_events(collection_id);
CREATE INDEX IF NOT EXISTS kb_retr_queryhash_idx ON kb_retrieval_events(org_id, query_hash);

-- 5. Eval suites / cases / runs ------------------------------------------
CREATE TABLE IF NOT EXISTS kb_eval_suites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  corpus        text CHECK (corpus IS NULL OR corpus IN ('jd','company','question_bank')),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_eval_suites_org_idx ON kb_eval_suites(org_id, updated_at, id);

CREATE TABLE IF NOT EXISTS kb_eval_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id      uuid NOT NULL REFERENCES kb_eval_suites(id) ON DELETE CASCADE,
  query         text NOT NULL,
  expected_source_id     uuid REFERENCES kb_sources(id) ON DELETE SET NULL,
  expected_collection_id uuid REFERENCES kb_collections(id) ON DELETE SET NULL,
  expected_snippet_contains text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_eval_cases_suite_idx ON kb_eval_cases(suite_id);

CREATE TABLE IF NOT EXISTS kb_eval_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  suite_id      uuid NOT NULL REFERENCES kb_eval_suites(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','error')),
  case_count    integer NOT NULL DEFAULT 0,
  hit_rate      double precision,
  mrr           double precision,
  citation_accuracy double precision,
  used_real_embeddings boolean NOT NULL DEFAULT false,
  error_message text,
  triggered_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS kb_eval_runs_suite_idx ON kb_eval_runs(suite_id, created_at);

CREATE TABLE IF NOT EXISTS kb_eval_run_cases (
  id            bigserial PRIMARY KEY,
  run_id        uuid NOT NULL REFERENCES kb_eval_runs(id) ON DELETE CASCADE,
  case_id       uuid REFERENCES kb_eval_cases(id) ON DELETE SET NULL,
  query         text NOT NULL,
  hit           boolean NOT NULL DEFAULT false,
  rank_of_expected integer,
  citation_ok   boolean,
  top_source_id uuid,
  top_snippet   text
);
CREATE INDEX IF NOT EXISTS kb_eval_run_cases_run_idx ON kb_eval_run_cases(run_id);

-- 6. Answer feedback ------------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_answer_feedback (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id     uuid REFERENCES kb_sources(id) ON DELETE SET NULL,
  collection_id uuid REFERENCES kb_collections(id) ON DELETE SET NULL,
  chunk_id      bigint,
  query         text,
  rating        text NOT NULL CHECK (rating IN ('up','down')),
  reason        text CHECK (reason IS NULL OR reason IN ('outdated','wrong','irrelevant','incomplete','helpful','other')),
  comment       text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  submitted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
CREATE INDEX IF NOT EXISTS kb_feedback_org_status_idx ON kb_answer_feedback(org_id, status, created_at);
CREATE INDEX IF NOT EXISTS kb_feedback_source_idx ON kb_answer_feedback(source_id);

-- 7. Append-only audit ----------------------------------------------------
CREATE TABLE IF NOT EXISTS kb_audit (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  entity_type   text NOT NULL CHECK (entity_type IN ('collection','source','document','grant','eval_suite','eval_run','feedback')),
  entity_id     text NOT NULL,
  action        text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_audit_org_entity_idx ON kb_audit(org_id, entity_type, entity_id, created_at);

-- 8. New permission strings (additive grant to existing roles) ------------
-- knowledge.read / knowledge.write already exist (migrations 0001/0010/0013).
-- Net-new fine-grained perms: grant write-tier to roles that already hold
-- knowledge.write, read-tier to roles that hold knowledge.read. Covers BOTH
-- the default org and the JoulesToWatts org (any org with the base grants).
INSERT INTO role_permissions (org_id, role, permission)
SELECT DISTINCT org_id, role, 'knowledge.manage'
FROM role_permissions WHERE permission = 'knowledge.write'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (org_id, role, permission)
SELECT DISTINCT org_id, role, 'knowledge.eval'
FROM role_permissions WHERE permission = 'knowledge.write'
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (org_id, role, permission)
SELECT DISTINCT org_id, role, 'knowledge.feedback'
FROM role_permissions WHERE permission = 'knowledge.write'
ON CONFLICT DO NOTHING;

COMMIT;
