-- taxonomy-v9.sql
-- Migrate taxonomy storage to support taxonomy-v9 architecture.
--
-- Key changes:
--   1. sources table: add primary_tags, sub_techniques, ai_enabled overlay columns
--   2. rawfacts table: add sub_techniques, ai_enabled overlay columns
--   3. analytics_metrics table: add sub_technique/ai_enabled_role metric types
--   4. Indexes for new columns
--   5. Preserve old columns (main_category, primary_threat_tags, etc.) for back-compat
--
-- Run order: after taxonomy-v2.sql has been applied.
-- Safe to run multiple times (uses IF NOT EXISTS / IF NOT EXISTS guards).

-- ── 1. sources table ──────────────────────────────────────────────────────────

-- New primary_tags column (v9 coded IDs: TAI01, LLM01, ASI01, AE01, etc.)
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS primary_tags           JSONB,
  ADD COLUMN IF NOT EXISTS sub_techniques         JSONB,
  ADD COLUMN IF NOT EXISTS taxonomy_assignments   JSONB,
  ADD COLUMN IF NOT EXISTS ai_enabled             BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_enabled_roles       JSONB,
  ADD COLUMN IF NOT EXISTS ai_capabilities        JSONB,
  ADD COLUMN IF NOT EXISTS automation_level       TEXT,
  ADD COLUMN IF NOT EXISTS autonomy_level         TEXT,
  ADD COLUMN IF NOT EXISTS mapped_frameworks      JSONB,
  ADD COLUMN IF NOT EXISTS mapping_type           TEXT,
  ADD COLUMN IF NOT EXISTS taxonomy_version       TEXT,
  ADD COLUMN IF NOT EXISTS taxonomy_validation_status   TEXT,
  ADD COLUMN IF NOT EXISTS taxonomy_validation_reasons  JSONB;

-- Constraints on new enum columns (guarded: safe to run multiple times)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_automation_level' AND conrelid = 'sources'::regclass
  ) THEN
    ALTER TABLE sources ADD CONSTRAINT chk_automation_level
      CHECK (automation_level IS NULL OR automation_level IN (
        'human_assisted','semi_autonomous','autonomous','unknown'
      ));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_autonomy_level' AND conrelid = 'sources'::regclass
  ) THEN
    ALTER TABLE sources ADD CONSTRAINT chk_autonomy_level
      CHECK (autonomy_level IS NULL OR autonomy_level IN (
        'human_assisted','semi_autonomous','autonomous','multi_agent','unknown'
      ));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_taxonomy_validation_status' AND conrelid = 'sources'::regclass
  ) THEN
    ALTER TABLE sources ADD CONSTRAINT chk_taxonomy_validation_status
      CHECK (taxonomy_validation_status IS NULL OR taxonomy_validation_status IN (
        'validated','weak','rejected','needs_manual_review'
      ));
  END IF;
END $$;

-- ── 2. rawfacts table ─────────────────────────────────────────────────────────

ALTER TABLE rawfacts
  ADD COLUMN IF NOT EXISTS primary_tags           JSONB,
  ADD COLUMN IF NOT EXISTS sub_techniques         JSONB,
  ADD COLUMN IF NOT EXISTS ai_enabled             BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_enabled_roles       JSONB,
  ADD COLUMN IF NOT EXISTS ai_capabilities        JSONB,
  ADD COLUMN IF NOT EXISTS automation_level       TEXT,
  ADD COLUMN IF NOT EXISTS autonomy_level         TEXT,
  ADD COLUMN IF NOT EXISTS taxonomy_version       TEXT;

-- ── 3. analytics_metrics table ────────────────────────────────────────────────

ALTER TABLE analytics_metrics
  ADD COLUMN IF NOT EXISTS sub_technique          TEXT,
  ADD COLUMN IF NOT EXISTS ai_enabled_role        TEXT,
  ADD COLUMN IF NOT EXISTS taxonomy_version       TEXT;

-- ── 4. Indexes ────────────────────────────────────────────────────────────────

-- sources indexes
CREATE INDEX IF NOT EXISTS idx_sources_primary_domain
  ON sources (primary_domain)
  WHERE primary_domain IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sources_ai_enabled
  ON sources (ai_enabled)
  WHERE ai_enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_sources_taxonomy_version
  ON sources (taxonomy_version)
  WHERE taxonomy_version IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sources_primary_tags_gin
  ON sources USING GIN (primary_tags)
  WHERE primary_tags IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sources_sub_techniques_gin
  ON sources USING GIN (sub_techniques)
  WHERE sub_techniques IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sources_ai_enabled_roles_gin
  ON sources USING GIN (ai_enabled_roles)
  WHERE ai_enabled_roles IS NOT NULL;

-- rawfacts indexes
CREATE INDEX IF NOT EXISTS idx_rawfacts_ai_enabled
  ON rawfacts (ai_enabled)
  WHERE ai_enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_rawfacts_primary_tags_gin
  ON rawfacts USING GIN (primary_tags)
  WHERE primary_tags IS NOT NULL;

-- ── 5. View: taxonomy_v9_assignments ─────────────────────────────────────────
-- Convenience view exposing the new taxonomy columns with back-compat aliases.

CREATE OR REPLACE VIEW taxonomy_v9_assignments AS
SELECT
  id                              AS source_id,
  title,
  url,
  primary_domain,
  primary_tags,
  sub_techniques,
  ai_enabled,
  ai_enabled_roles,
  ai_capabilities,
  automation_level,
  autonomy_level,
  taxonomy_version,
  taxonomy_validation_status,
  taxonomy_validation_reasons,
  -- Legacy back-compat (pre-v9 columns preserved)
  intelligence                    AS legacy_intelligence,
  claim_extraction_status
FROM sources
WHERE taxonomy_version IS NOT NULL;

COMMENT ON VIEW taxonomy_v9_assignments IS
  'Exposes taxonomy-v9 fields for sources that have been processed by the v9 pipeline. '
  'Legacy sources use NULL for new columns until re-processed.';

-- ── 6. Backfill helper: migrate primary_threat_tags JSON → primary_tags ───────
-- This is a one-time migration for existing processed sources.
-- Run manually after reviewing the output.
--
-- UPDATE sources
-- SET
--   primary_tags = (
--     SELECT jsonb_agg(
--       jsonb_build_object(
--         'tag', t->>'tag',
--         'domain', t->>'domain',
--         'supporting_quote', t->>'supporting_quote',
--         'confidence', COALESCE(t->>'confidence', 'low'),
--         'validation_status', COALESCE(t->>'validation_status', 'weak'),
--         'origin', 'migrated_from_v8'
--       )
--     )
--     FROM jsonb_array_elements(
--       COALESCE(intelligence->'primary_threat_tags', '[]'::jsonb)
--     ) AS t
--   ),
--   taxonomy_version = 'taxonomy-v9-migrated'
-- WHERE intelligence IS NOT NULL
--   AND intelligence ? 'primary_threat_tags'
--   AND primary_tags IS NULL;
