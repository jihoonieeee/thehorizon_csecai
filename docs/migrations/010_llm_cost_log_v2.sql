-- Migration 010: llm_cost_log v2
-- Adds provider, model, and task columns so costs can be broken down
-- per model (Sonnet vs Haiku vs Gemini Flash) and per pipeline task.
-- Safe to run on existing table — uses ADD COLUMN IF NOT EXISTS.

ALTER TABLE llm_cost_log ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE llm_cost_log ADD COLUMN IF NOT EXISTS model    TEXT;
ALTER TABLE llm_cost_log ADD COLUMN IF NOT EXISTS task     TEXT;

CREATE INDEX IF NOT EXISTS llm_cost_log_provider ON llm_cost_log (provider, date);
CREATE INDEX IF NOT EXISTS llm_cost_log_model    ON llm_cost_log (model, date);
