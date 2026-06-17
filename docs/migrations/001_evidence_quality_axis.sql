-- ===========================================================================
-- 001_evidence_quality_axis.sql — incremental migration (2026)
--
-- Brings an EXISTING database up to date with the evidence-quality-axis work.
-- These two changes are already folded into the consolidated 000_schema.sql
-- (sections 7 and 8); this standalone file applies ONLY the delta so you can
-- migrate a deployed Supabase project without re-reading the full 48 KB file.
-- (Running 000_schema.sql again is equivalent and equally safe.)
--
-- Run via the Supabase SQL editor or psql:
--   psql $SUPABASE_DB_URL -f docs/migrations/001_evidence_quality_axis.sql
--
-- Safety: every statement is idempotent (IF NOT EXISTS / drop-then-recreate),
-- so re-running is a no-op. No data is dropped. No table rewrites.
--
-- Back-compat note: the persistence writer (lib/storage/taxonomyStore.js →
-- writeRows) detects a missing column and strips it before retrying, so the
-- pipeline RUNS without this migration — it just cannot persist the new
-- quality columns until applied. Apply this to make per-evidence packet
-- quality queryable in SQL (previously only inside the deck blob).
--
-- Contents:
--   1. Widen the taxonomy_validation_status CHECK constraint (sources)
--   2. Evidence-quality-axis columns + indexes (rawfacts)
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Preconditions — this is a DELTA migration; it expects the base schema
--    (000_schema.sql sections 1 + 8) to have created the sources and rawfacts
--    tables. Fail loudly rather than half-applying if they are absent.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF to_regclass('public.sources') IS NULL THEN
    RAISE EXCEPTION 'Table "sources" not found — run docs/migrations/000_schema.sql first.';
  END IF;
  IF to_regclass('public.rawfacts') IS NULL THEN
    RAISE EXCEPTION 'Table "rawfacts" not found — run docs/migrations/000_schema.sql (section 8) first.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. taxonomy_validation_status — widen the allowed set
--
-- The original constraint allowed only validated/weak/needs_manual_review/
-- rejected. The taxonomy layer (lib/pipeline/understand/understandSource.js)
-- also emits emerging_unmapped (the novelty safety valve), no_domain_match,
-- and no_tags_found. Persisting any of those previously violated the check,
-- which silently dropped the most analytically interesting sources.
--
-- Drop-and-recreate so an already-constrained table picks up the wider set.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_taxonomy_validation_status'
      AND conrelid = 'sources'::regclass
  ) THEN
    ALTER TABLE sources DROP CONSTRAINT chk_taxonomy_validation_status;
  END IF;

  ALTER TABLE sources ADD CONSTRAINT chk_taxonomy_validation_status
    CHECK (taxonomy_validation_status IS NULL OR taxonomy_validation_status IN (
      'validated','weak','needs_manual_review','rejected',
      'emerging_unmapped','no_domain_match','no_tags_found'
    ));
END $$;

-- ---------------------------------------------------------------------------
-- 2. rawfacts — evidence-quality-axis columns
--
-- Makes per-evidence packet quality queryable in SQL. Populated by
-- lib/pipeline/rawfact/runRawfactBranch.js (row build) and persisted by
-- lib/storage/taxonomyStore.js (persistRawfacts). Mirrors the canonical
-- EvidencePacket claim_relevance + grounding + method + independence groups.
-- ---------------------------------------------------------------------------
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS evidence_type         text;   -- canonical L5A type (incident_event, exploit_chain, ...)
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS evidence_strength     text;   -- strong | usable | context | archive
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS admissibility         text;   -- passed | context_only | failed
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS permitted_uses        jsonb;  -- string[] of permitted uses
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS limitations           jsonb;  -- string[] of limitation codes
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS observed_use          boolean;-- real-world adversary use
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS materiality           text;   -- novel | escalating | confirming | redundant
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS uniqueness            text;   -- sole_support | corroborated | duplicative
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS quote_entailment      text;   -- supported | partially_supported | unsupported
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS claim_preservation    text;   -- preserved | narrowed | overstated | changed_meaning
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS method_quality        text;   -- clear_method | partial_method | unclear_method | anecdotal | not_applicable
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS statistical_use       text;   -- chart_allowed | text_only_with_caveat | context_only | not_allowed
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS origin_role           text;   -- primary_origin | secondary_reporting | tertiary_commentary | unknown_origin
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS independence_level    text;   -- independent | vendor_interested | self_reported | circular_reporting_risk | amplified_reporting | unknown
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS primary_origin_url    text;
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS source_quality_status text;   -- usable | usable_with_caveat | context_only | reject

-- Indexes for the most common analytical filters.
CREATE INDEX IF NOT EXISTS idx_rawfacts_evidence_strength ON rawfacts (evidence_strength);
CREATE INDEX IF NOT EXISTS idx_rawfacts_admissibility     ON rawfacts (admissibility);
CREATE INDEX IF NOT EXISTS idx_rawfacts_materiality       ON rawfacts (materiality);

COMMIT;

-- ===========================================================================
-- Verification (run after COMMIT; should return the new objects)
-- ===========================================================================
-- Constraint allows the widened set:
--   SELECT pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conname = 'chk_taxonomy_validation_status';
--
-- All 16 quality columns exist on rawfacts:
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_name = 'rawfacts'
--     AND column_name IN (
--       'evidence_type','evidence_strength','admissibility','permitted_uses',
--       'limitations','observed_use','materiality','uniqueness','quote_entailment',
--       'claim_preservation','method_quality','statistical_use','origin_role',
--       'independence_level','primary_origin_url','source_quality_status')
--   ORDER BY column_name;
--   -- expect 16 rows
--
-- Indexes exist:
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'rawfacts'
--     AND indexname IN ('idx_rawfacts_evidence_strength',
--                       'idx_rawfacts_admissibility','idx_rawfacts_materiality');

-- ===========================================================================
-- Rollback (DESTRUCTIVE — drops the new columns and their data).
-- Only the constraint widening is non-destructive to revert; reverting it will
-- FAIL if any row already holds one of the new statuses, so clean those first.
-- ===========================================================================
-- BEGIN;
--   ALTER TABLE rawfacts DROP COLUMN IF EXISTS evidence_type, DROP COLUMN IF EXISTS evidence_strength,
--     DROP COLUMN IF EXISTS admissibility, DROP COLUMN IF EXISTS permitted_uses,
--     DROP COLUMN IF EXISTS limitations, DROP COLUMN IF EXISTS observed_use,
--     DROP COLUMN IF EXISTS materiality, DROP COLUMN IF EXISTS uniqueness,
--     DROP COLUMN IF EXISTS quote_entailment, DROP COLUMN IF EXISTS claim_preservation,
--     DROP COLUMN IF EXISTS method_quality, DROP COLUMN IF EXISTS statistical_use,
--     DROP COLUMN IF EXISTS origin_role, DROP COLUMN IF EXISTS independence_level,
--     DROP COLUMN IF EXISTS primary_origin_url, DROP COLUMN IF EXISTS source_quality_status;
--   -- To restore the narrow constraint (only if no row uses a new status):
--   -- ALTER TABLE sources DROP CONSTRAINT IF EXISTS chk_taxonomy_validation_status;
--   -- ALTER TABLE sources ADD CONSTRAINT chk_taxonomy_validation_status
--   --   CHECK (taxonomy_validation_status IS NULL OR taxonomy_validation_status IN
--   --     ('validated','weak','needs_manual_review','rejected'));
-- COMMIT;
