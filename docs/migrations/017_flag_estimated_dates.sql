-- ===========================================================================
-- 017_flag_estimated_dates.sql
--
-- Extends the date-confidence review gate (016) to cover "estimated" and
-- "inferred" sources. Only "exact" confidence dates are trusted for period
-- bucketing and synthesis. Estimated/inferred sources are routed to
-- needs_review so they are excluded from reports until confirmed.
--
-- Safe to re-run: WHERE guard skips already-flagged rows.
-- ===========================================================================

BEGIN;

UPDATE sources
SET needs_review = true
WHERE date_confidence IN ('estimated', 'inferred')
  AND (needs_review IS NULL OR needs_review = false);

COMMIT;

-- Verification:
-- SELECT date_confidence, COUNT(*) FROM sources WHERE needs_review = true GROUP BY 1 ORDER BY 2 DESC;
-- SELECT COUNT(*) FROM sources WHERE date_confidence = 'exact' AND (needs_review IS NULL OR needs_review = false);
