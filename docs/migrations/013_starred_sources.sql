-- 013_starred_sources.sql
-- Analyst "star" flag: mark a source as especially insightful for later use.
-- Filterable on the dashboard. Safe to run more than once.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS starred boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_sources_starred ON sources (starred) WHERE starred = true;
