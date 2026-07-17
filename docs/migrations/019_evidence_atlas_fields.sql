-- Migration 019: persist ATLAS-specific evidence fields + backfill missing evidence columns
--
-- Adds columns that evidenceStore.js itemToRow() already writes but that were not
-- included in the original 011_evidence_table.sql migration:
--
--   event_date / time_basis / within_reporting_window
--     Temporal grounding: event_date = when the event occurred (not the publication date).
--     time_basis = "incident_date" | "publication_date" | "unknown".
--
--   Walkthrough / report-insight fields (from reportAnalysisToEvidence)
--     Structured attack walkthrough data extracted from long threat-intel reports.
--
-- And adds NEW ATLAS-specific fields introduced in 2026-07:
--
--   atlas_case_id
--     The ATLAS case study ID (e.g. "AML.CS0041") on all items that come from a
--     MITRE ATLAS source, enabling downstream grouping, citation, and slide selection.
--
--   atlas_origin
--     Which extraction pass produced this item:
--       chain           — Pass 1: deterministic technique-step item
--       chain_analysis  — Pass 1b: structural chain observation (trust crossings, compression)
--       reference       — Pass 1c: typed cited reference (paper / CVE / malware / code)
--       llm             — Pass 2: LLM-extracted incident-level item
--     NULL for non-ATLAS items.
--
--   cited_reference_url
--     For reference-origin items: the external URL of the cited paper, CVE, or report.
--     Enables downstream deduplication against independently ingested sources.
--
--   reference_type
--     Categorical type of the cited reference: paper | cve | malware_family | code | report.
--     NULL for non-reference-origin items.
--
-- All ALTER TABLE statements use IF NOT EXISTS to be safe on databases that already
-- have some of these columns from manual additions.

-- ── Event-date columns (already written by evidenceStore, formalised here) ────

ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS event_date              TEXT,
  ADD COLUMN IF NOT EXISTS time_basis              TEXT,
  ADD COLUMN IF NOT EXISTS within_reporting_window BOOLEAN;

COMMENT ON COLUMN evidence.event_date IS
  'When the described event occurred (ISO date). Preferred over source date_published for ATLAS incidents.';
COMMENT ON COLUMN evidence.time_basis IS
  'incident_date | publication_date | unknown — which date is in event_date.';
COMMENT ON COLUMN evidence.within_reporting_window IS
  'True if event_date falls within the active reporting window. NULL = not yet evaluated.';

-- ── Walkthrough / report-insight columns (already written, formalised here) ──

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

-- ── ATLAS-specific columns (new) ──────────────────────────────────────────────

ALTER TABLE evidence
  ADD COLUMN IF NOT EXISTS atlas_case_id        TEXT,
  ADD COLUMN IF NOT EXISTS atlas_origin         TEXT,
  ADD COLUMN IF NOT EXISTS cited_reference_url  TEXT,
  ADD COLUMN IF NOT EXISTS reference_type       TEXT;

COMMENT ON COLUMN evidence.atlas_case_id IS
  'MITRE ATLAS case study ID (e.g. AML.CS0041). Set on all items from ATLAS sources.';
COMMENT ON COLUMN evidence.atlas_origin IS
  'Extraction pass: chain | chain_analysis | reference | llm. NULL for non-ATLAS items.';
COMMENT ON COLUMN evidence.cited_reference_url IS
  'External URL of the cited resource for reference-origin items (papers, CVEs, etc.).';
COMMENT ON COLUMN evidence.reference_type IS
  'paper | cve | malware_family | code | report. Set on reference-origin items only.';

-- ── Indexes for downstream query patterns ─────────────────────────────────────

CREATE INDEX IF NOT EXISTS evidence_atlas_case_id_idx ON evidence (atlas_case_id)
  WHERE atlas_case_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS evidence_atlas_origin_idx ON evidence (atlas_origin)
  WHERE atlas_origin IS NOT NULL;

CREATE INDEX IF NOT EXISTS evidence_event_date_idx ON evidence (event_date)
  WHERE event_date IS NOT NULL;
