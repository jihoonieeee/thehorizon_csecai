-- Migration 023: drop source_label column
--
-- source_label (critical/important/supporting/archive) was a deterministic
-- importance label set by the old sourceLabel.js scoring pass. It has been
-- superseded by reading_value (essential/recommended/analyst/background) which
-- is assigned by the Layer 3 LLM and is a richer, audience-aware signal.
--
-- All references to source_label have been removed from the codebase:
--   - api/sources.js now reads reading_value as the label field
--   - digestFanout.js importance_label schema field removed
--   - digest-decompose.md prompt updated
--   - tests/sourceLabel.test.js deleted
--   - docs/migrations/015_source_label_column.sql kept for history only

DROP INDEX IF EXISTS idx_sources_source_label;
ALTER TABLE sources DROP COLUMN IF EXISTS source_label;
