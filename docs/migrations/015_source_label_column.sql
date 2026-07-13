-- 015_source_label_column.sql
-- Add source_label column for LLM-validated importance labels.
-- Values: critical | important | supporting | archive | NULL (not yet assessed)
-- Written by assessSourceLabel.js at Layer 4 for incident/TI/exploit sources.
-- labelOf() in sourceLabel.js reads this first, falls back to deterministic logic.

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS source_label text
    CHECK (source_label IN ('critical', 'important', 'supporting', 'archive'));

CREATE INDEX IF NOT EXISTS idx_sources_source_label
  ON sources (source_label)
  WHERE source_label IS NOT NULL;
