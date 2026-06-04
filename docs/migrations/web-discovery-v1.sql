-- web-discovery-v1.sql
-- Persistence for the Layer 1B/1C web-discovery branch.
--
--   1. sources table: add web-discovery provenance + early-signal columns
--      (only populated for sources with source_origin='web_discovery')
--   2. web_discovery_candidates table: audit store for ALL candidates, including
--      archive_only and rejected ones (so rejected candidates are never lost)
--   3. Indexes for the new columns + common discovery queries
--
-- Run order: after taxonomy-v9.sql. Safe to re-run (IF NOT EXISTS guards +
-- guarded constraint blocks).

-- ── 1. sources table: discovery + early-signal columns ───────────────────────

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS source_origin              TEXT DEFAULT 'fixed_feed',
  ADD COLUMN IF NOT EXISTS discovery_mission          TEXT,
  ADD COLUMN IF NOT EXISTS search_query               TEXT,
  ADD COLUMN IF NOT EXISTS opened_url                 TEXT,
  ADD COLUMN IF NOT EXISTS candidate_claim            TEXT,
  ADD COLUMN IF NOT EXISTS verbatim_quote             TEXT,
  ADD COLUMN IF NOT EXISTS quote_status               TEXT,
  ADD COLUMN IF NOT EXISTS quote_verified             BOOLEAN,
  ADD COLUMN IF NOT EXISTS quote_claim_match_status   TEXT,
  ADD COLUMN IF NOT EXISTS freshness_status           TEXT,
  ADD COLUMN IF NOT EXISTS freshness_interpretation   TEXT,
  ADD COLUMN IF NOT EXISTS novelty_assessment         TEXT,
  ADD COLUMN IF NOT EXISTS operationalization_stage   TEXT,
  ADD COLUMN IF NOT EXISTS early_signal_value         TEXT,
  ADD COLUMN IF NOT EXISTS early_signal_type          TEXT,
  ADD COLUMN IF NOT EXISTS early_signal_qa_status     TEXT,
  ADD COLUMN IF NOT EXISTS corroboration_status       TEXT,
  ADD COLUMN IF NOT EXISTS source_independence_status TEXT,
  ADD COLUMN IF NOT EXISTS hallucination_risk         TEXT,
  ADD COLUMN IF NOT EXISTS discovery_route            TEXT,
  ADD COLUMN IF NOT EXISTS web_discovery_metadata     JSONB;

-- Guarded check constraints on the new categorical columns.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_early_signal_value' AND conrelid = 'sources'::regclass) THEN
    ALTER TABLE sources ADD CONSTRAINT chk_early_signal_value
      CHECK (early_signal_value IS NULL OR early_signal_value IN ('none','weak','moderate','strong'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_freshness_status' AND conrelid = 'sources'::regclass) THEN
    ALTER TABLE sources ADD CONSTRAINT chk_freshness_status
      CHECK (freshness_status IS NULL OR freshness_status IN ('fresh','current','stale','historical','unknown'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_discovery_route' AND conrelid = 'sources'::regclass) THEN
    ALTER TABLE sources ADD CONSTRAINT chk_discovery_route
      CHECK (discovery_route IS NULL OR discovery_route IN ('accept','accept_with_review','archive_only','reject'));
  END IF;
END $$;

-- ── 2. web_discovery_candidates: full audit store ────────────────────────────
-- Stores EVERY candidate (accepted, accept_with_review, archive_only, reject) so
-- rejected/derivative candidates remain auditable and are never lost. Accepted
-- candidates also become rows in `sources`; this table keeps the discovery-side
-- provenance and validation trail.

CREATE TABLE IF NOT EXISTS web_discovery_candidates (
  candidate_id               TEXT PRIMARY KEY,
  snapshot_id                TEXT,
  run_id                     TEXT,
  source_id                  TEXT,            -- set when accepted → became a source row
  source_origin              TEXT DEFAULT 'web_discovery',
  discovery_mission          TEXT,
  search_query               TEXT,
  search_query_family        TEXT,
  opened_url                 TEXT,
  opened_url_confirmed        BOOLEAN,
  source_class               TEXT,
  title                      TEXT,
  publisher                  TEXT,
  published_date             TEXT,
  event_date                 TEXT,
  last_updated               TEXT,
  candidate_claim            TEXT,
  verbatim_quote             TEXT,
  quote_status               TEXT,
  quote_verified             BOOLEAN,
  quote_claim_match_status   TEXT,
  source_type_hint           TEXT,
  trust_tier_hint            TEXT,
  source_quality             TEXT,
  freshness_status           TEXT,
  freshness_interpretation   TEXT,
  ai_threat_specificity      TEXT,
  ai_threat_anchors          JSONB,
  novelty_assessment         TEXT,
  operationalization_stage   TEXT,
  early_signal_value         TEXT,
  early_signal_type          TEXT,
  early_signal_reason        TEXT,
  early_signal_qa_status     TEXT,
  corroboration_status       TEXT,
  source_independence_status TEXT,
  hallucination_risk         TEXT,
  duplicate_cluster_id       TEXT,
  is_cluster_representative   BOOLEAN,
  duplicate_reason           TEXT,
  original_source_url        TEXT,
  route                      TEXT,
  route_reason               TEXT,
  route_flags                JSONB,
  manual_review_required      BOOLEAN,
  rejection_reason           TEXT,
  taxonomy_hint              JSONB,
  web_discovery_metadata     JSONB,
  created_at                 TIMESTAMPTZ DEFAULT now()
);

-- ── 3. Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_sources_source_origin
  ON sources (source_origin) WHERE source_origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_discovery_mission
  ON sources (discovery_mission) WHERE discovery_mission IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_early_signal_value
  ON sources (early_signal_value) WHERE early_signal_value IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_freshness_status
  ON sources (freshness_status) WHERE freshness_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wdc_route             ON web_discovery_candidates (route);
CREATE INDEX IF NOT EXISTS idx_wdc_mission           ON web_discovery_candidates (discovery_mission);
CREATE INDEX IF NOT EXISTS idx_wdc_early_signal      ON web_discovery_candidates (early_signal_value);
CREATE INDEX IF NOT EXISTS idx_wdc_snapshot          ON web_discovery_candidates (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_wdc_source_class      ON web_discovery_candidates (source_class);
CREATE INDEX IF NOT EXISTS idx_wdc_cluster           ON web_discovery_candidates (duplicate_cluster_id);

COMMENT ON TABLE web_discovery_candidates IS
  'Audit store for every Layer 1B/1C web-discovery candidate (accepted + archive_only + rejected). '
  'Rejected/derivative candidates are retained here for audit and never enter Layer 4/5.';
