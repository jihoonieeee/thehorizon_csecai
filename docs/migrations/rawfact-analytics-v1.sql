-- rawfact-analytics-v1.sql
-- Persist the analysis-phase evidence the pipeline extracts per source:
--   L3 gate verdict, L5A rawfact evidence items, L5B analytics features.
-- Until this migration is applied, sourceAnalysisStore.js degrades gracefully
-- (it strips missing columns and continues), so the pipeline runs either way.
-- Safe to re-run: every statement uses IF NOT EXISTS.

-- ── Layer 3 — final gate verdict (currently computed but never stored) ──────────
ALTER TABLE sources ADD COLUMN IF NOT EXISTS layer3_status     text;   -- pass | review | reject
ALTER TABLE sources ADD COLUMN IF NOT EXISTS downstream_route  text;   -- layer4 | layer4_with_review | discard

-- ── Layer 5A — rawfact evidence (atomic, source-grounded claims) ────────────────
-- Full evidence_items array for the source (each item carries evidence_id,
-- fact, source_quote, quote_verified, evidence_type, score_data, etc.).
ALTER TABLE sources ADD COLUMN IF NOT EXISTS rawfact_evidence  jsonb;
-- Compact summary for fast querying without unpacking the array.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS rawfact_summary   jsonb;  -- { priority, score, item_count, critical, high, grounded, version }
ALTER TABLE sources ADD COLUMN IF NOT EXISTS rawfact_version   text;

-- ── Layer 5B — analytics features (controlled-vocabulary tags per source) ───────
ALTER TABLE sources ADD COLUMN IF NOT EXISTS analytics_features jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS analytics_version  text;

-- ── Indexes for the new filterable columns ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sources_layer3_status
  ON sources (layer3_status) WHERE layer3_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sources_rawfact_version
  ON sources (rawfact_version) WHERE rawfact_version IS NOT NULL;
