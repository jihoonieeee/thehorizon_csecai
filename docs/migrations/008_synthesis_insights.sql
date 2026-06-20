-- Migration 008: synthesis_insights table
-- Stores per-category strategic insights from each synthesis run.
-- Written by runSynthesisOnly.js; read by /api/dashboard for category cards.

CREATE TABLE IF NOT EXISTS synthesis_insights (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_id       TEXT        NOT NULL,
  category     TEXT        NOT NULL,
  insight_text TEXT,
  judgment_count INT       NOT NULL DEFAULT 0,
  UNIQUE (run_id, category)
);

-- Index for fast "latest run" lookup by dashboard
CREATE INDEX IF NOT EXISTS synthesis_insights_created_at
  ON synthesis_insights (created_at DESC);
