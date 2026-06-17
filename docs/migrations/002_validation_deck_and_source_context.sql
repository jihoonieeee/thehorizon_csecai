-- ===========================================================================
-- 002_validation_deck_and_source_context.sql — delta migration (June 2026)
--
-- Incremental migration for existing Supabase projects that have already
-- applied docs/migrations/000_schema.sql up through section 12 (or the old
-- granular migration set: ingestion-v2 + archiving-v2 + archive-layer3 +
-- understand-layer5 + deck-layer9 + audit-refactor).
--
-- These changes are already folded into 000_schema.sql (sections 13–15);
-- this file applies ONLY the delta so you can migrate a deployed project
-- without re-running the full consolidated file.
-- (Running 000_schema.sql again is equivalent and equally safe.)
--
-- Run via the Supabase SQL editor or psql:
--   psql $SUPABASE_DB_URL -f docs/migrations/002_validation_deck_and_source_context.sql
--
-- Idempotent: every statement uses IF NOT EXISTS / drop-then-recreate, so
-- re-running is a no-op. No data is dropped. No table rewrites.
--
-- Contents:
--   1. Deck v9.1 — argument-form metadata + slide QA columns (decks)
--   2. Validation v1.1 — content quality gate + URL resolution (sources)
--   3. Source context — quality, origin tracking, relevance path (sources)
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Preconditions — base tables must exist before we alter them.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF to_regclass('public.sources') IS NULL THEN
    RAISE EXCEPTION 'Table "sources" not found — run docs/migrations/000_schema.sql first.';
  END IF;
  IF to_regclass('public.decks') IS NULL THEN
    RAISE EXCEPTION
      'Table "decks" not found — run docs/migrations/000_schema.sql (section 11) first.';
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 1. Deck v9.1 — argument-form metadata + slide QA columns
--
-- Populated by lib/pipeline/slides/slidesLayer.js (planSlides, QA pass) and
-- persisted by lib/storage/deckStore.js (saveDeck). All DEFAULT-safe so
-- existing deck rows are unaffected.
-- ---------------------------------------------------------------------------

ALTER TABLE decks ADD COLUMN IF NOT EXISTS deck_version             text;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS argument_forms_used      text[]  DEFAULT '{}';
ALTER TABLE decks ADD COLUMN IF NOT EXISTS bullet_role_violations   int     DEFAULT 0;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS analytics_not_supporting int     DEFAULT 0;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS visual_contextual_count  int     DEFAULT 0;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS notes_qa_blocking        int     DEFAULT 0;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS notes_qa_warnings        int     DEFAULT 0;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS claim_anchored_slides    int     DEFAULT 0;


-- ---------------------------------------------------------------------------
-- 2. Validation v1.1 — content quality gate + URL resolution
--
-- Populated by lib/pipeline/validation/validateAndTypeSource.js
-- (content_quality gate) and lib/pipeline/validation/urlSafety.js
-- (display_url / ai_signal_strength). All nullable — existing rows stay NULL
-- until the next pipeline run re-validates them.
-- ---------------------------------------------------------------------------

ALTER TABLE sources ADD COLUMN IF NOT EXISTS content_quality        text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS content_quality_reason text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS ai_signal_strength     text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS display_url            text;

CREATE INDEX IF NOT EXISTS idx_sources_content_quality
  ON sources (content_quality)
  WHERE content_quality IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 3. Source context — quality, origin tracking, relevance path
--
-- Populated by lib/pipeline/validation/originTracking.js and written to the
-- DB by lib/pipeline/archive/buildSourceRow.js.
--
--   source_quality_status   — usable | usable_with_caveat | context_only | reject
--   source_quality_reasons  — array of reason codes from originTracking
--   origin_role             — primary_origin | secondary_reporting | tertiary_commentary
--   independence_level      — independent | vendor_interested | self_reported | ...
--   primary_origin_url      — URL of the primary source when this is secondary reporting
--   cited_sources           — URLs of sources cited in this article
--   relevance_path          — known_signal | novelty_signal | both | none
--   taxonomy_status         — mirrors taxonomy_validation_status for fast queries
--
-- Note: independence_level is also added by 000_schema.sql section 12b; the
-- IF NOT EXISTS guard makes the statements idempotent.
-- ---------------------------------------------------------------------------

ALTER TABLE sources ADD COLUMN IF NOT EXISTS source_quality_status  text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS source_quality_reasons text[];
ALTER TABLE sources ADD COLUMN IF NOT EXISTS origin_role            text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS independence_level     text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS primary_origin_url     text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS cited_sources          text[];
ALTER TABLE sources ADD COLUMN IF NOT EXISTS relevance_path         text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS taxonomy_status        text;

CREATE INDEX IF NOT EXISTS idx_sources_source_quality_status
  ON sources (source_quality_status)
  WHERE source_quality_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_origin_role
  ON sources (origin_role)
  WHERE origin_role IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_independence_level
  ON sources (independence_level)
  WHERE independence_level IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_relevance_path
  ON sources (relevance_path)
  WHERE relevance_path IS NOT NULL;

COMMIT;


-- ===========================================================================
-- VERIFICATION QUERIES  (run manually after migration to confirm)
-- ===========================================================================

-- 1. Deck v9.1 columns:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'decks'
--   AND column_name IN (
--     'deck_version','argument_forms_used','bullet_role_violations',
--     'analytics_not_supporting','visual_contextual_count',
--     'notes_qa_blocking','notes_qa_warnings','claim_anchored_slides'
--   )
-- ORDER BY column_name;
-- Expected: 8 rows

-- 2. Validation v1.1 columns:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'sources'
--   AND column_name IN ('content_quality','content_quality_reason','ai_signal_strength','display_url')
-- ORDER BY column_name;
-- Expected: 4 rows

-- 3. Source context columns:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'sources'
--   AND column_name IN (
--     'source_quality_status','source_quality_reasons','origin_role',
--     'independence_level','primary_origin_url','cited_sources',
--     'relevance_path','taxonomy_status'
--   )
-- ORDER BY column_name;
-- Expected: 8 rows

-- 4. Indexes:
-- SELECT indexname FROM pg_indexes
-- WHERE tablename = 'sources'
--   AND indexname IN (
--     'idx_sources_content_quality','idx_sources_source_quality_status',
--     'idx_sources_origin_role','idx_sources_independence_level',
--     'idx_sources_relevance_path'
--   )
-- ORDER BY indexname;
-- Expected: 5 rows


-- ===========================================================================
-- ROLLBACK  (DESTRUCTIVE — drops the new columns and their data)
-- ===========================================================================
-- BEGIN;
--   ALTER TABLE decks
--     DROP COLUMN IF EXISTS deck_version,
--     DROP COLUMN IF EXISTS argument_forms_used,
--     DROP COLUMN IF EXISTS bullet_role_violations,
--     DROP COLUMN IF EXISTS analytics_not_supporting,
--     DROP COLUMN IF EXISTS visual_contextual_count,
--     DROP COLUMN IF EXISTS notes_qa_blocking,
--     DROP COLUMN IF EXISTS notes_qa_warnings,
--     DROP COLUMN IF EXISTS claim_anchored_slides;
--   ALTER TABLE sources
--     DROP COLUMN IF EXISTS content_quality,
--     DROP COLUMN IF EXISTS content_quality_reason,
--     DROP COLUMN IF EXISTS ai_signal_strength,
--     DROP COLUMN IF EXISTS display_url,
--     DROP COLUMN IF EXISTS source_quality_status,
--     DROP COLUMN IF EXISTS source_quality_reasons,
--     DROP COLUMN IF EXISTS origin_role,
--     DROP COLUMN IF EXISTS independence_level,
--     DROP COLUMN IF EXISTS primary_origin_url,
--     DROP COLUMN IF EXISTS cited_sources,
--     DROP COLUMN IF EXISTS relevance_path,
--     DROP COLUMN IF EXISTS taxonomy_status;
-- COMMIT;
