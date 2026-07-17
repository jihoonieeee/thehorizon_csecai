-- 018_parent_title.sql
-- Add parent_title column to sources for child sources produced by digest fanout.
-- Child sources (parent_source_id IS NOT NULL) carry the parent report's title here
-- so agent search, newsletter, and any consumer can cite the main source cleanly
-- without parsing the compound "Parent [Sub-title]" title string or joining intelligence jsonb.
--
-- Standalone sources: parent_title IS NULL (use title directly).
-- Child sources:      parent_title = original report title; title = "Report [Finding]".

ALTER TABLE sources ADD COLUMN IF NOT EXISTS parent_title text;

COMMENT ON COLUMN sources.parent_title IS
  'For child sources from digest fanout: the title of the parent report. NULL for standalone sources.';

-- Backfill existing child rows from intelligence.report_finding.parent_report_title.
UPDATE sources
SET parent_title = intelligence->'report_finding'->>'parent_report_title'
WHERE parent_source_id IS NOT NULL
  AND parent_title IS NULL
  AND intelligence->'report_finding'->>'parent_report_title' IS NOT NULL;
