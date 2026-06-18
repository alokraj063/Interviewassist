-- Initial schema + pgvector extension + HNSW index.
-- Matches apps/api/src/db/schema.ts. Keep in sync when schema changes.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS kb_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('URL','Upload','Confluence','SharePoint')),
  status text NOT NULL DEFAULT 'indexing' CHECK (status IN ('indexing','indexed','error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_indexed_at timestamptz,
  org_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  title text,
  uri text,
  mime text,
  bytes bigint,
  sha256 text UNIQUE,
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','parsing','embedding','indexed','error')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_source_idx ON documents(source_id);

CREATE TABLE IF NOT EXISTS chunks (
  id bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  ord integer NOT NULL,
  text text NOT NULL,
  token_count integer,
  embedding vector(1536) NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks(source_id);
CREATE INDEX IF NOT EXISTS chunks_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS call_sessions (
  id uuid PRIMARY KEY,
  agent_id uuid,
  customer_ref text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  summary jsonb
);

CREATE TABLE IF NOT EXISTS transcript_turns (
  id bigserial PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  speaker text NOT NULL CHECK (speaker IN ('agent','customer')),
  text text NOT NULL,
  is_final boolean NOT NULL DEFAULT false,
  ts_start_ms integer NOT NULL,
  ts_end_ms integer NOT NULL,
  sentiment real
);
CREATE INDEX IF NOT EXISTS transcript_turns_call_idx ON transcript_turns(call_id, ts_start_ms);

CREATE TABLE IF NOT EXISTS suggestions (
  id bigserial PRIMARY KEY,
  call_id uuid NOT NULL,
  trigger_turn_id bigint,
  kind text,
  content jsonb,
  citations jsonb,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suggestions_call_idx ON suggestions(call_id, created_at);
