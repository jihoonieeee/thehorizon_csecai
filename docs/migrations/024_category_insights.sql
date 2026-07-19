-- Migration 024: category_insights table
-- Stores per-category strategic insights produced by lib/pipeline/analysis/runAnalysis.js.
-- Keyed by (window_key, category) so each timeframe + category combination is one row.
-- Written by scripts/generateInsights.js and runPipeline.js.
-- Read by /api/dashboard and slide generation.

CREATE TABLE IF NOT EXISTS category_insights (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_type       TEXT        NOT NULL,   -- 'week' | 'month' | 'quarter' | 'custom'
  window_key        TEXT        NOT NULL,   -- '2026-W25' | '2026-07' | '2026-Q3' | 'custom-...'
  window_label      TEXT        NOT NULL,   -- human-readable: 'July 2026', 'Q3 2026', etc.
  date_from         TEXT        NOT NULL,   -- YYYY-MM-DD inclusive
  date_to           TEXT        NOT NULL,   -- YYYY-MM-DD inclusive
  category          TEXT        NOT NULL,
  assessment_status TEXT        NOT NULL,   -- 'assessed' | 'thin' | 'error'
  source_count      INT         NOT NULL DEFAULT 0,
  selected_source_ids TEXT[]    NOT NULL DEFAULT '{}',
  insights          JSONB       NOT NULL DEFAULT '[]',   -- Insight[]
  coverage_gaps     TEXT[]      NOT NULL DEFAULT '{}',
  run_metadata      JSONB,                               -- model, latency, token counts
  UNIQUE (window_key, category)
);

CREATE INDEX IF NOT EXISTS category_insights_window_key
  ON category_insights (window_key, category);

CREATE INDEX IF NOT EXISTS category_insights_window_type
  ON category_insights (window_type, created_at DESC);

CREATE INDEX IF NOT EXISTS category_insights_date_range
  ON category_insights (date_from, date_to);

-- Insight JSONB shape (for documentation):
-- {
--   insight_id:       uuid,
--   title:            string,            -- ≤12 words, falsifiable claim
--   what_changed:     string,            -- specific event / capability shift
--   mechanism:        string,            -- technical/economic root cause
--   implication:      string,            -- which defender assumption breaks
--   evidence_maturity: string,           -- research_demonstration → operational_campaign
--   confidence:       string,            -- high | medium | low
--   technique_tags:   string[],
--   monitoring_signal: string,
--   caveats:          string[],
--   blocked:          boolean,
--   qa_issues:        string[],
--   cited_sources: [{
--     source_id:        string,          -- sources.id (URL sha256 hash)
--     source_url:       string,
--     source_title:     string,
--     publisher:        string,
--     trust_tier:       string,
--     quote:            string,          -- verbatim excerpt proving the insight
--     evidence_summary: string,          -- one sentence: what this source contributes
--   }],
--   evidence_item_ids: string[],         -- evidence item IDs resolved from cited sources
-- }
