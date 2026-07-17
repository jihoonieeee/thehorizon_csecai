-- Migration 021: create missing tables + add missing sources columns
--
-- Three gaps identified by cross-referencing lib/storage/** and lib/pipeline/**
-- against all previous migrations:
--
--   1. `snapshots` table — written by snapshotDatabase.js but never created in a migration.
--   2. `ingestion_runs` table — written by ingestionRunStore.js but never created in a migration.
--   3. Missing columns on `sources` — written by validateAndTypeSource.js and
--      snapshotDatabase.js but absent from all migrations.
--
-- All statements are idempotent (IF NOT EXISTS / IF NOT EXISTS on columns).

-- ════════════════════════════════════════════════════════════════════════════
-- 1. snapshots table
-- Written by: lib/storage/snapshotDatabase.js (upsert on conflict snapshot_id)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id    TEXT        PRIMARY KEY,
  period         TEXT,
  generated_at   TIMESTAMPTZ,
  start_utc      TIMESTAMPTZ,
  end_utc        TIMESTAMPTZ,
  start_local    TEXT,
  end_local      TEXT,
  count          INTEGER     DEFAULT 0,
  discarded_count INTEGER    DEFAULT 0,
  rejected_count  INTEGER    DEFAULT 0,
  blob_path      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS snapshots_generated_at_idx ON snapshots (generated_at DESC);
CREATE INDEX IF NOT EXISTS snapshots_period_idx       ON snapshots (period);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. ingestion_runs table
-- Written by: lib/storage/ingestionRunStore.js
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id               TEXT        PRIMARY KEY,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ,
  status           TEXT        NOT NULL DEFAULT 'running',  -- running | success | failed
  reporting_window JSONB,       -- {start_utc, end_utc}
  source_count     INTEGER,
  rejected_count   INTEGER,
  discarded_count  INTEGER,
  connector_results JSONB,      -- array of per-connector result objects
  pipeline_counts  JSONB,       -- per-layer counts
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ingestion_runs_status_idx      ON ingestion_runs (status);
CREATE INDEX IF NOT EXISTS ingestion_runs_started_at_idx  ON ingestion_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS ingestion_runs_finished_at_idx ON ingestion_runs (finished_at DESC)
  WHERE finished_at IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Missing columns on sources
-- ════════════════════════════════════════════════════════════════════════════

-- validity_score — alias for structural_validity_score written by snapshotDatabase.js
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS validity_score INTEGER DEFAULT 0;

-- credibility_label — computed by sourceValidity.js, written by snapshotDatabase.js
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS credibility_label TEXT;

-- in_test_set — boolean filter used by snapshotDatabase.js getSourcesForWindow()
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS in_test_set BOOLEAN DEFAULT FALSE;

-- Layer 3 validation outputs — written by validateAndTypeSource.js
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS validation_reasoning          TEXT,
  ADD COLUMN IF NOT EXISTS source_type_confidence        TEXT,   -- high | medium | low
  ADD COLUMN IF NOT EXISTS source_type_reason            TEXT,   -- layer3_llm | llm_fallback | skip_llm | ...
  ADD COLUMN IF NOT EXISTS final_validity_reason         TEXT;

-- Layer 3 LLM relevance fields (from layer3Llm.js / researchGate.js)
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS ai_materiality                TEXT,
  ADD COLUMN IF NOT EXISTS evidence_origin               TEXT,
  ADD COLUMN IF NOT EXISTS publisher_role                TEXT,
  ADD COLUMN IF NOT EXISTS secondary_domain              TEXT,
  ADD COLUMN IF NOT EXISTS affected_ai_layer             TEXT,
  ADD COLUMN IF NOT EXISTS boundary_rationale            TEXT,
  ADD COLUMN IF NOT EXISTS reading_value                 TEXT,   -- essential | recommended | analyst | background
  ADD COLUMN IF NOT EXISTS distribution_recommendation   TEXT,
  ADD COLUMN IF NOT EXISTS recommendation_reason         TEXT;

-- Research gate outputs (from researchGate.js)
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS research_gate_verdict          TEXT,  -- pass | reject | skip
  ADD COLUMN IF NOT EXISTS research_gate_read_value       TEXT,
  ADD COLUMN IF NOT EXISTS research_gate_reject_reason    TEXT,
  ADD COLUMN IF NOT EXISTS research_gate_contribution_type TEXT,
  ADD COLUMN IF NOT EXISTS research_gate_maturity         TEXT;

-- source_family — computed by classifySourceFamily() (Layer 4) but not persisted by the
-- L4 write-back. Adding as a top-level column enables fast filtering without JSONB extraction.
-- Populated by the L4 write-back going forward; NULL on existing rows (recomputed on read).
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS source_family TEXT;

COMMENT ON COLUMN sources.source_family IS
  'atlas_case_study | academic_paper | threat_intel_report | roundup_digest | major_capability_announcement | corporate_blog | news_blog — set by classifySourceFamily() in Layer 4';

-- Indexes for the columns most likely to be filtered on
CREATE INDEX IF NOT EXISTS sources_source_family_idx            ON sources (source_family)
  WHERE source_family IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_reading_value_idx            ON sources (reading_value)
  WHERE reading_value IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_credibility_label_idx        ON sources (credibility_label)
  WHERE credibility_label IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_research_gate_verdict_idx    ON sources (research_gate_verdict)
  WHERE research_gate_verdict IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_source_type_confidence_idx   ON sources (source_type_confidence)
  WHERE source_type_confidence IS NOT NULL;
