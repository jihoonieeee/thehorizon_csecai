-- ===========================================================================
-- 016_flag_unconfirmed_dates.sql
--
-- Flags sources whose publish date cannot be confirmed as needing review,
-- and ensures date_discovered is populated for sources that have none.
--
-- Safe to re-run: uses WHERE guards so already-flagged rows are skipped.
-- ===========================================================================

BEGIN;

-- 1. Set needs_review = true for sources with low or no date confidence.
--    These sources have incorrect or unverifiable publish dates and should be
--    reviewed by an analyst to confirm, correct, or clear the date.
UPDATE sources
SET needs_review = true
WHERE date_confidence IN ('low', 'none')
  AND needs_review = false;

-- 2. For sources with no date_published and no date_confidence set,
--    also flag them for review since we cannot trust the date.
UPDATE sources
SET needs_review = true
WHERE date_published IS NULL
  AND needs_review = false
  AND date_confidence IS DISTINCT FROM 'exact';

-- 3. Backfill date_discovered from collected_date for older rows that
--    have collected_date but no date_discovered (taxonomy-era imports).
UPDATE sources
SET date_discovered = collected_date
WHERE date_discovered IS NULL
  AND collected_date IS NOT NULL;

COMMIT;

-- Verification queries (run manually after applying):
--
-- Count flagged by confidence level:
-- SELECT date_confidence, COUNT(*) FROM sources WHERE needs_review = true GROUP BY 1 ORDER BY 2 DESC;
--
-- Sources with publish dates we can't confirm, sorted by ingestion date:
-- SELECT id, title, date_published, date_discovered, date_confidence
-- FROM sources
-- WHERE needs_review = true AND date_confidence IN ('low','none')
-- ORDER BY date_discovered DESC NULLS LAST
-- LIMIT 50;
--
-- Coverage of date_discovered:
-- SELECT
--   COUNT(*) FILTER (WHERE date_discovered IS NOT NULL) AS has_ingest_date,
--   COUNT(*) FILTER (WHERE date_discovered IS NULL)     AS missing_ingest_date,
--   COUNT(*)                                             AS total
-- FROM sources;
