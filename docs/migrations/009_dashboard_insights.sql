-- Migration 009: dashboard_insights
-- Timeframe-scoped per-category insight bullets for the Overview page.
-- Written by scripts/generateDashboardInsights.js (via GitHub Actions cron).
-- Read by /api/dashboard — one row per window_key × category combination.

CREATE TABLE IF NOT EXISTS dashboard_insights (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  win          TEXT        NOT NULL,   -- 'week' | 'month' | 'quarter'
  window_key   TEXT        NOT NULL,   -- '2026-W25' | '2026-06' | '2026-Q2'
  window_label TEXT        NOT NULL,   -- 'Week of Jun 23' | 'June 2026' | 'Q2 2026'
  category     TEXT        NOT NULL,
  points       JSONB       NOT NULL DEFAULT '[]',  -- array of 2-4 short insight strings
  source_count INT         NOT NULL DEFAULT 0,
  UNIQUE (window_key, category)
);

CREATE INDEX IF NOT EXISTS dashboard_insights_window_key
  ON dashboard_insights (window_key, category);

CREATE INDEX IF NOT EXISTS dashboard_insights_win
  ON dashboard_insights (win, created_at DESC);
