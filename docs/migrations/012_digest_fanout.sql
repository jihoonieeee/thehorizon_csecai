-- 012_digest_fanout.sql
-- Multi-topic report fan-out: a digest source (weekly bulletin / roundup /
-- newsletter) is split into per-item CHILD sources, each classified into its own
-- category. Children point back to the parent digest via parent_source_id.
--
-- Safe to run more than once (IF NOT EXISTS guards).

-- The digest a child was extracted from (NULL for ordinary standalone sources).
ALTER TABLE sources ADD COLUMN IF NOT EXISTS parent_source_id text;

-- Marks a source as a multi-topic container that has been (or should be) fanned out.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS is_digest boolean DEFAULT false;

-- Fast lookup of a digest's children, and of "real" (non-child) sources.
CREATE INDEX IF NOT EXISTS idx_sources_parent_source_id ON sources (parent_source_id);

-- Optional FK for referential integrity + cascade cleanup when a digest is purged.
-- Wrapped in a DO block so re-running doesn't error on an existing constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'sources_parent_source_id_fkey'
  ) THEN
    ALTER TABLE sources
      ADD CONSTRAINT sources_parent_source_id_fkey
      FOREIGN KEY (parent_source_id) REFERENCES sources (id) ON DELETE CASCADE;
  END IF;
END $$;
