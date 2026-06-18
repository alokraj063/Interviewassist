-- Track the single Vapi query-tool id per agent. Our new KB-sync collapses
-- all of an agent's selected sources into ONE `knowledge_query` tool with N
-- `knowledgeBases` entries (the Vapi canonical pattern), so the tool id is
-- per-agent, not per-source. The per-source vapi_tool_id on kb_sources is
-- now unused but kept to avoid a destructive migration.
ALTER TABLE voice_agents
  ADD COLUMN IF NOT EXISTS vapi_kb_tool_id text;
