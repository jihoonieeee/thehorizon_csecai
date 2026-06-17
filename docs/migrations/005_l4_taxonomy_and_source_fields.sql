-- =============================================================================
-- 005_l4_taxonomy_and_source_fields.sql
-- Adds Layer 4 taxonomy fields and missing L1C triage columns to `sources`.
--
-- Idempotent: every statement uses ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT
-- with existence guards. Safe to re-run.
--
-- Context:
--   L4 rework (2026-06-12) added taxonomy_confidence_score, evidence_basis,
--   requires_entailment_qa on primary_tags (stored inside the primary_tags JSONB),
--   and a QA stage. Only taxonomy_confidence_score needs a dedicated column.
--
--   L1C triage audit (2026-06-12) added web-discovery fields that candidateToSource
--   now copies to pipeline sources but were missing from the `sources` table.
--
--   This migration also fixes the stale chk_discovery_route CHECK constraint
--   in 000_schema.sql which only listed 4 old route values; migration 004 already
--   rebuilds it for new databases, but 005 catches any that skipped 004 or ran
--   000_schema.sql after 004.
--
-- Run via the Supabase SQL editor or psql:
--   psql $SUPABASE_DB_URL -f docs/migrations/005_l4_taxonomy_and_source_fields.sql
-- =============================================================================

BEGIN;

-- ===========================================================================
-- 1. Layer 4 taxonomy fields on `sources`
-- ===========================================================================

-- taxonomy_confidence_score: 0–100 evidence quality signal from the QA stage.
-- 0 = no_domain_match/no_tags_found; 20 = emerging_unmapped;
-- up to 85 for fully validated tags (QA can push to 100).
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS taxonomy_confidence_score integer;

-- taxonomy_stage_results is already stored inside source.understanding (JSONB).
-- No separate column needed — the full audit trail is in understanding.taxonomy_stage_results.

-- ===========================================================================
-- 2. L1C web-discovery triage fields on `sources`
--    (candidateToSource now copies these; buildSourceRow now persists them)
-- ===========================================================================

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS freshness_class          text;

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS quote_support            text;

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS requires_entailment_qa   boolean DEFAULT false;

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS evidence_novelty         text;

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS defensive_content_type   text;

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS candidate_route_reasons  jsonb DEFAULT '[]'::jsonb;

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS candidate_usefulness_roles jsonb DEFAULT '[]'::jsonb;

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS candidate_origin_cluster_id text;

-- ===========================================================================
-- 3. Fix stale chk_discovery_route CHECK constraint
--    (000_schema.sql still has the old 4-value list; migration 004 rebuilds it
--    for new installs, but this catches existing databases that ran 004 before
--    this migration or skipped 004 entirely)
-- ===========================================================================

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_discovery_route' AND conrelid = 'sources'::regclass
  ) THEN
    ALTER TABLE sources DROP CONSTRAINT chk_discovery_route;
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE sources ADD CONSTRAINT chk_discovery_route
    CHECK (discovery_route IS NULL OR discovery_route IN (
      'accept_high_priority',
      'accept_evidence_candidate',
      'accept_with_review',
      'context_only',
      'archive_only',
      'reject'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ===========================================================================
-- 4. Indexes on new columns
-- ===========================================================================

CREATE INDEX IF NOT EXISTS idx_sources_taxonomy_confidence
  ON sources (taxonomy_confidence_score)
  WHERE taxonomy_confidence_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sources_freshness_class
  ON sources (freshness_class)
  WHERE freshness_class IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sources_evidence_novelty
  ON sources (evidence_novelty)
  WHERE evidence_novelty IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sources_candidate_origin_cluster
  ON sources (candidate_origin_cluster_id)
  WHERE candidate_origin_cluster_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sources_requires_entailment_qa
  ON sources (requires_entailment_qa)
  WHERE requires_entailment_qa = true;

COMMIT;
