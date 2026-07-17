-- Consolidated migration: 019 + 020
-- Run this if you haven't applied either 019 or 020 yet.
-- All statements use IF NOT EXISTS / safe ALTER TABLE — idempotent.

-- ════════════════════════════════════════════════════════════════════════════
-- 019: ATLAS fields + backfill of event-date and walkthrough columns
-- ════════════════════════════════════════════════════════════════════════════

-- Event-date columns
ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS event_date              TEXT,
  ADD COLUMN IF NOT EXISTS time_basis              TEXT,
  ADD COLUMN IF NOT EXISTS within_reporting_window BOOLEAN;

-- Walkthrough / report-insight columns
ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS from_report_analysis  BOOLEAN,
  ADD COLUMN IF NOT EXISTS walkthrough_actor     TEXT,
  ADD COLUMN IF NOT EXISTS walkthrough_technique TEXT,
  ADD COLUMN IF NOT EXISTS walkthrough_mechanism TEXT,
  ADD COLUMN IF NOT EXISTS walkthrough_steps     JSONB,
  ADD COLUMN IF NOT EXISTS walkthrough_impact    TEXT,
  ADD COLUMN IF NOT EXISTS report_insight        BOOLEAN,
  ADD COLUMN IF NOT EXISTS insight_finding       TEXT,
  ADD COLUMN IF NOT EXISTS insight_significance  TEXT,
  ADD COLUMN IF NOT EXISTS insight_taxonomy      TEXT;

-- ATLAS-specific columns
ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS atlas_case_id        TEXT,
  ADD COLUMN IF NOT EXISTS atlas_origin         TEXT,
  ADD COLUMN IF NOT EXISTS cited_reference_url  TEXT,
  ADD COLUMN IF NOT EXISTS reference_type       TEXT;

-- 019 indexes
CREATE INDEX IF NOT EXISTS evidence_atlas_case_id_idx ON evidence (atlas_case_id)
  WHERE atlas_case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_atlas_origin_idx  ON evidence (atlas_origin)
  WHERE atlas_origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_event_date_idx    ON evidence (event_date)
  WHERE event_date IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 020: source-aware extraction fields (specialist extractor architecture)
-- ════════════════════════════════════════════════════════════════════════════

-- Core epistemic + routing
ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS claim_epistemic_type TEXT,
  ADD COLUMN IF NOT EXISTS source_family        TEXT,
  ADD COLUMN IF NOT EXISTS claim_origin         TEXT;

-- Capability announcement
ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS landscape_change BOOLEAN;

-- Academic paper
ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS claim_id          TEXT,
  ADD COLUMN IF NOT EXISTS supports_claim    TEXT,
  ADD COLUMN IF NOT EXISTS paper_section     TEXT,
  ADD COLUMN IF NOT EXISTS relationships     JSONB,
  ADD COLUMN IF NOT EXISTS research_metadata JSONB;

-- Threat intel
ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS campaign_metadata JSONB;

-- 020 indexes
CREATE INDEX IF NOT EXISTS evidence_epistemic_type_idx  ON evidence (claim_epistemic_type)
  WHERE claim_epistemic_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_source_family_idx   ON evidence (source_family)
  WHERE source_family IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_landscape_change_idx ON evidence (landscape_change)
  WHERE landscape_change IS TRUE;
CREATE INDEX IF NOT EXISTS evidence_claim_id_idx        ON evidence (source_id, claim_id)
  WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_supports_claim_idx  ON evidence (source_id, supports_claim)
  WHERE supports_claim IS NOT NULL;
