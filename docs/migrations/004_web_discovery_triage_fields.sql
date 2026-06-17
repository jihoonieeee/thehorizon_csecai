-- =============================================================================
-- 004_web_discovery_triage_fields.sql
-- Adds web-discovery candidate triage fields introduced in the L1C audit.
--
-- Idempotent: every statement uses ADD COLUMN IF NOT EXISTS.
-- Safe to re-run against a database that already has some or all columns.
--
-- Affected tables:
--   web_discovery_candidates  — candidate-level triage + provenance fields
--   sources                   — discovery provenance columns on accepted candidates
--
-- Run via the Supabase SQL editor or psql:
--   psql $SUPABASE_DB_URL -f docs/migrations/004_web_discovery_triage_fields.sql
-- =============================================================================

BEGIN;

-- ===========================================================================
-- web_discovery_candidates: new triage + provenance columns
-- ===========================================================================

-- Quote support (replaces legacy quote_claim_match_status binary accept/reject)
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS quote_support           text;
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS requires_entailment_qa  boolean DEFAULT false;

-- Freshness enrichment
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS freshness_class         text;
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS age_days                integer;

-- Evidence novelty classification
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS evidence_novelty        text;

-- Defensive content type (replaces boolean is_defensive_only)
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS defensive_content_type  text;

-- Relevance path (known_signal / novelty_signal / both / none)
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS relevance_path          text;

-- Origin clustering + independence
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS origin_role             text;
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS primary_origin_url      text;
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS cited_sources           jsonb DEFAULT '[]'::jsonb;
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS independence_level      text;
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS candidate_origin_cluster_id text;

-- Candidate usefulness roles (array of roles from CANDIDATE_USEFULNESS_ROLES vocab)
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS candidate_usefulness_roles jsonb DEFAULT '[]'::jsonb;

-- Richer route reason codes (replaces single route_reason string)
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS candidate_route_reasons jsonb DEFAULT '[]'::jsonb;

-- Redundant-work prevention hashes
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS canonical_url_hash      text;
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS content_hash            text;
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS quote_hash              text;
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS claim_hash              text;
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS primary_origin_hash     text;

-- Cache status: controls whether expensive downstream work should be skipped
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS processing_cache_status text DEFAULT 'new';

-- Timestamps for cache staleness tracking
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS first_seen_at           timestamptz DEFAULT now();
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS last_seen_at            timestamptz DEFAULT now();

-- Fix missing columns from the ADD COLUMN block in section 9 of 000_schema.sql
-- (novelty_assessment and early_signal_qa_status were in CREATE TABLE but not
-- in the ALTER TABLE block for existing databases)
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS novelty_assessment      text;
ALTER TABLE web_discovery_candidates
  ADD COLUMN IF NOT EXISTS early_signal_qa_status  text;

-- ===========================================================================
-- sources: discovery provenance columns for accepted web-discovery candidates
-- ===========================================================================

-- Quote support fields carried through from candidate triage
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS quote_support            text;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS requires_entailment_qa   boolean DEFAULT false;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS freshness_class          text;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS evidence_novelty         text;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS defensive_content_type   text;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS candidate_route_reasons  jsonb DEFAULT '[]'::jsonb;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS candidate_usefulness_roles jsonb DEFAULT '[]'::jsonb;

-- Origin provenance
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS origin_role              text;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS primary_origin_url       text;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS cited_sources            jsonb DEFAULT '[]'::jsonb;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS independence_level       text;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS candidate_origin_cluster_id text;

-- Fix stale check constraint: discovery_route now includes additional route values
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
-- Indexes on new columns (all partial — only index non-null rows)
-- ===========================================================================

CREATE INDEX IF NOT EXISTS idx_wdc_quote_support
  ON web_discovery_candidates (quote_support) WHERE quote_support IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wdc_freshness_class
  ON web_discovery_candidates (freshness_class) WHERE freshness_class IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wdc_evidence_novelty
  ON web_discovery_candidates (evidence_novelty) WHERE evidence_novelty IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wdc_origin_cluster
  ON web_discovery_candidates (candidate_origin_cluster_id)
  WHERE candidate_origin_cluster_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wdc_canonical_url_hash
  ON web_discovery_candidates (canonical_url_hash) WHERE canonical_url_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wdc_content_hash
  ON web_discovery_candidates (content_hash) WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wdc_primary_origin_hash
  ON web_discovery_candidates (primary_origin_hash) WHERE primary_origin_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wdc_processing_cache_status
  ON web_discovery_candidates (processing_cache_status)
  WHERE processing_cache_status NOT IN ('new');

CREATE INDEX IF NOT EXISTS idx_wdc_independence_level
  ON web_discovery_candidates (independence_level) WHERE independence_level IS NOT NULL;

COMMIT;
