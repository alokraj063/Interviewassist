-- 0040: AI token-usage + cost ledger for the Live Assist co-pilot.
-- One row per LLM call (plan / next / verify / final / suggestion), so the
-- Usage tab can aggregate tokens + cost per org / per call / per operation.
CREATE TABLE IF NOT EXISTS ai_usage_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  call_id           uuid,
  operation         text NOT NULL,          -- plan | next | verify | final | suggestion | embedding
  model             text NOT NULL,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens      integer NOT NULL DEFAULT 0,
  cost_usd          numeric(14,8) NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_events_org_idx ON ai_usage_events (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_events_call_idx ON ai_usage_events (call_id);
