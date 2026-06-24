-- Migration 011: per-source evidence cache table (Layer 5 persistence)
--
-- Evidence extraction (lib/pipeline/v2/extractEvidence.js) used to run only at
-- deck-generation time, in-memory, and was re-computed from scratch every run.
-- This table persists extracted evidence per source, keyed by a content hash of
-- the source's full_text, so:
--   • the ingestion loop can extract evidence once per source (incremental);
--   • deck runs load cached evidence and only (re)extract new/changed sources.
--
-- One row per evidence item. Re-extraction for a source deletes its rows and
-- re-inserts (keyed by source_id). content_hash detects stale full_text.

CREATE TABLE IF NOT EXISTS evidence (
  id               TEXT        PRIMARY KEY,                 -- `${source_id}__${evidence_id}`
  source_id        TEXT        NOT NULL,
  evidence_id      TEXT        NOT NULL,
  content_hash     TEXT        NOT NULL,                    -- sha256 of source full_text at extraction
  source_url       TEXT,
  source_title     TEXT,
  publisher        TEXT,
  source_type      TEXT,
  trust_tier       TEXT,
  category         TEXT,
  fact             TEXT,
  quote            TEXT,
  quote_grounded   BOOLEAN     NOT NULL DEFAULT FALSE,
  evidence_type    TEXT,
  specificity      TEXT,
  numbers          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  technique_tags   TEXT[]      NOT NULL DEFAULT '{}',
  entities         TEXT[]      NOT NULL DEFAULT '{}',
  evidence_version TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS evidence_source_id_idx ON evidence (source_id);
CREATE INDEX IF NOT EXISTS evidence_category_idx  ON evidence (category);
