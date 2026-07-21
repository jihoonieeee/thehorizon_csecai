-- Migration 025: all_categories for digest/report parent sources
-- Stores the union of children's main_category values so reports
-- can be displayed and filtered across multiple threat categories.

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS all_categories text[] DEFAULT NULL;

-- Backfill: compute from existing children
UPDATE sources AS p
SET all_categories = sub.cats
FROM (
  SELECT
    parent_source_id,
    array_agg(DISTINCT main_category ORDER BY main_category) FILTER (WHERE main_category IS NOT NULL) AS cats
  FROM sources
  WHERE parent_source_id IS NOT NULL
    AND main_category IS NOT NULL
  GROUP BY parent_source_id
) sub
WHERE p.id = sub.parent_source_id
  AND sub.cats IS NOT NULL;
