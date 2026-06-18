-- Postgres extensions required by RecruitAssist migrations.
-- vector  — pgvector for embeddings (1536-dim, OpenAI text-embedding-3-small)
-- pgcrypto — gen_random_uuid() in 0000_init.sql and most subsequent migrations
-- citext  — case-insensitive emails/usernames in 0001_auth_and_assignments.sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
