-- Migration 006: Remove emerging_unmapped taxonomy status and taxonomy_confidence_score
--
-- What this migration does:
--   1. Reassigns sources with taxonomy_validation_status = 'emerging_unmapped' to
--      'no_tags_found' (they had no valid taxonomy tags; now correctly classified).
--   2. Removes emerging_unmapped from the taxonomy_validation_status CHECK constraint.
--   3. Drops the taxonomy_confidence_score column and its index.
--
-- Why:
--   emerging_unmapped was a "novelty safety valve" that preserved sources whose
--   AI threat content seemed concrete but didn't match any known taxonomy entry.
--   This created a hidden class of source that bypassed the taxonomy gate with a
--   soft "score of 20" rather than a real taxonomy classification. Sources that
--   cannot be mapped to a domain or tag are now discarded (no_tags_found /
--   no_domain_match) consistently. No numeric scoring.
--
-- Run with: node scripts/applyMigration.mjs docs/migrations/006_remove_emerging_unmapped_and_confidence_score.sql
-- Or paste directly into the Supabase SQL editor.

-- ── Step 1: Reclassify emerging_unmapped sources ──────────────────────────────
-- These sources had concrete AI-threat signals but no matching taxonomy tags.
-- They are now treated as no_tags_found (discarded from downstream layers).

UPDATE sources
SET    taxonomy_validation_status = 'no_tags_found'
WHERE  taxonomy_validation_status = 'emerging_unmapped';

-- Verify: should return 0 rows after migration
-- SELECT count(*) FROM sources WHERE taxonomy_validation_status = 'emerging_unmapped';

-- ── Step 2: Widen then narrow the CHECK constraint ────────────────────────────
-- Drop the old constraint (which still lists emerging_unmapped) and recreate it
-- without the value. The code in 000_schema.sql already has the updated constraint;
-- this migration applies it to existing databases that ran the old schema.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_taxonomy_validation_status'
      AND conrelid = 'sources'::regclass
  ) THEN
    ALTER TABLE sources DROP CONSTRAINT chk_taxonomy_validation_status;
  END IF;
END $$;

ALTER TABLE sources
  ADD CONSTRAINT chk_taxonomy_validation_status
  CHECK (taxonomy_validation_status IS NULL OR taxonomy_validation_status IN (
    'validated', 'weak', 'needs_manual_review', 'rejected',
    'no_domain_match', 'no_tags_found'
  ));

-- ── Step 3: Drop taxonomy_confidence_score ────────────────────────────────────
-- The column held a 0–100 numeric score derived from tag validation quality.
-- This is arbitrary numeric scoring and is replaced by categorical fields
-- (taxonomy_validation_status, evidence_basis on each tag, QA verdicts).

DROP INDEX IF EXISTS idx_sources_taxonomy_confidence_score;

ALTER TABLE sources
  DROP COLUMN IF EXISTS taxonomy_confidence_score;

-- ── Verification queries (run after migration) ────────────────────────────────
-- These should all return 0 or no rows:

-- SELECT count(*) FROM sources WHERE taxonomy_validation_status = 'emerging_unmapped';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'sources' AND column_name = 'taxonomy_confidence_score';

-- ── Summary ───────────────────────────────────────────────────────────────────
-- After running:
--   - All emerging_unmapped sources → no_tags_found
--   - taxonomy_validation_status constraint no longer allows emerging_unmapped
--   - taxonomy_confidence_score column removed
--   - No code writes these fields any more (understandSource.js updated)
