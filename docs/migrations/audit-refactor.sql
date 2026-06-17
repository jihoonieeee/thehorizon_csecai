-- ── Source quality fields (added by audit refactor) ──────────────────────────
-- Run after archiving-v2.sql and archive-layer3.sql

ALTER TABLE sources ADD COLUMN IF NOT EXISTS source_quality_status text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS source_quality_reasons text[];
ALTER TABLE sources ADD COLUMN IF NOT EXISTS origin_role text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS independence_level text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS primary_origin_url text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS cited_sources text[];
ALTER TABLE sources ADD COLUMN IF NOT EXISTS relevance_path text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS taxonomy_status text;

-- Optional: index for quick filtering on quality status and origin
CREATE INDEX IF NOT EXISTS idx_sources_source_quality_status
  ON sources (source_quality_status);

CREATE INDEX IF NOT EXISTS idx_sources_origin_role
  ON sources (origin_role);

CREATE INDEX IF NOT EXISTS idx_sources_independence_level
  ON sources (independence_level);
