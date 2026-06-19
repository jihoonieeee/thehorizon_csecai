-- Migration 007: persistent LLM cost log
-- Stores one row per pipeline run (context='pipeline') or per agent query (context='agent').
-- Never reset — accumulates indefinitely for cost tracking.

CREATE TABLE IF NOT EXISTS llm_cost_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  logged_at     TIMESTAMPTZ NOT NULL    DEFAULT NOW(),
  date          DATE        NOT NULL,
  context       TEXT        NOT NULL,   -- 'pipeline' | 'agent'
  input_tokens  BIGINT      NOT NULL    DEFAULT 0,
  output_tokens BIGINT      NOT NULL    DEFAULT 0,
  calls         INT         NOT NULL    DEFAULT 0,
  cost_usd      NUMERIC(12, 8) NOT NULL DEFAULT 0,
  run_id        TEXT                    -- ingestion run ID when context='pipeline'
);

CREATE INDEX IF NOT EXISTS llm_cost_log_date_idx    ON llm_cost_log (date DESC);
CREATE INDEX IF NOT EXISTS llm_cost_log_context_idx ON llm_cost_log (context, date DESC);
