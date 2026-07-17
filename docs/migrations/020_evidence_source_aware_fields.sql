-- Migration 020: source-aware evidence extraction fields
--
-- Adds columns for the specialist extractor architecture introduced in 2026-07:
-- each source is classified into one of 7 source_family values and routed to a
-- specialist extractor. New fields capture epistemic provenance, claim linkage,
-- and specialist sub-objects (research_metadata, campaign_metadata).
--
-- All columns are additive and nullable. Existing evidence rows are unaffected.

-- ── Core epistemic + routing fields ──────────────────────────────────────────

ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS claim_epistemic_type TEXT,
  ADD COLUMN IF NOT EXISTS source_family        TEXT,
  ADD COLUMN IF NOT EXISTS claim_origin         TEXT;

COMMENT ON COLUMN evidence.claim_epistemic_type IS
  'observed_fact | lab_measurement | author_analysis | forecast | marketing_claim | inference';
COMMENT ON COLUMN evidence.source_family IS
  'Routing decision from classifySourceFamily(): atlas_case_study | academic_paper | threat_intel_report | roundup_digest | major_capability_announcement | corporate_blog | news_blog';
COMMENT ON COLUMN evidence.claim_origin IS
  'primary_source | secondary_report | expert_comment | analyst_interpretation — where in the source document the claim originates';

-- ── Capability announcement fields ───────────────────────────────────────────

ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS landscape_change BOOLEAN;

COMMENT ON COLUMN evidence.landscape_change IS
  'True on items that directly answer "what became possible/accessible that was not before". Set by the capability extractor.';

-- ── Academic paper fields ─────────────────────────────────────────────────────

ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS claim_id        TEXT,
  ADD COLUMN IF NOT EXISTS supports_claim  TEXT,
  ADD COLUMN IF NOT EXISTS paper_section   TEXT,
  ADD COLUMN IF NOT EXISTS relationships   JSONB,
  ADD COLUMN IF NOT EXISTS research_metadata JSONB;

COMMENT ON COLUMN evidence.claim_id IS
  'Lightweight claim ID (e.g. "C1") assigned by the academic extractor to primary attack/finding items.';
COMMENT ON COLUMN evidence.supports_claim IS
  'References a claim_id from another item in the same source — links prerequisites, results, artifacts, and boundary conditions to their primary claim.';
COMMENT ON COLUMN evidence.paper_section IS
  'abstract | introduction | related_work | methodology | results | discussion | limitations | conclusion | appendix | unknown';
COMMENT ON COLUMN evidence.relationships IS
  'Typed entity relationships extracted from the paper: [{type, from, to}]. Types: attacks, transfers_to, requires, evaluated_on, released_with.';
COMMENT ON COLUMN evidence.research_metadata IS
  'Academic specialist sub-object: {maturity, reproducibility, boundary_conditions}';

-- ── Threat intel fields ───────────────────────────────────────────────────────

ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS campaign_metadata JSONB;

COMMENT ON COLUMN evidence.campaign_metadata IS
  'Threat intel specialist sub-object: {attribution_confidence, campaign_name, is_analytic_judgment}';

-- ── Indexes for the most likely query patterns ────────────────────────────────

CREATE INDEX IF NOT EXISTS evidence_epistemic_type_idx ON evidence (claim_epistemic_type)
  WHERE claim_epistemic_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS evidence_source_family_idx ON evidence (source_family)
  WHERE source_family IS NOT NULL;

CREATE INDEX IF NOT EXISTS evidence_landscape_change_idx ON evidence (landscape_change)
  WHERE landscape_change IS TRUE;

CREATE INDEX IF NOT EXISTS evidence_claim_id_idx ON evidence (source_id, claim_id)
  WHERE claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS evidence_supports_claim_idx ON evidence (source_id, supports_claim)
  WHERE supports_claim IS NOT NULL;
