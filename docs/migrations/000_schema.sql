-- ===========================================================================
-- 000_schema.sql — The Horizon: complete database schema migration
--
-- Single consolidated file. Safe to run in one pass against a fresh or
-- existing Supabase project. Every statement uses IF NOT EXISTS / IF EXISTS
-- guards, so re-running is a no-op for already-applied changes.
--
-- Run via the Supabase SQL editor or psql:
--   psql $SUPABASE_DB_URL -f docs/migrations/000_schema.sql
--
-- Sections (in dependency order):
--   1.  Base ingestion columns (sources)
--   2.  Archiving + source_snapshots table
--   3.  Layer 3 validation columns
--   4.  Layer 4 understanding stamp
--   5.  Layer 5A rawfact + Layer 5B analytics feature columns
--   6.  Source type vocabulary remap
--   7.  Taxonomy v9 columns (primary_tags, sub_techniques, AI-enabled overlay)
--   8.  Taxonomy support tables (rawfacts, analytics_metrics, visual_evidence)
--   9.  Web discovery (Layer 1B/1C) columns + web_discovery_candidates table
--   10. Web evidence (Layer 5C) tables
--   11. Deck output metadata table
--   12. Source context & eligibility refactor (June 2026)
-- ===========================================================================

BEGIN;


-- ===========================================================================
-- 1. Base ingestion columns
-- ===========================================================================

-- Date metadata
ALTER TABLE sources ADD COLUMN IF NOT EXISTS date_published_actual timestamptz;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS date_discovered       timestamptz;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS date_confidence       text DEFAULT 'exact';

-- URL safety
ALTER TABLE sources ADD COLUMN IF NOT EXISTS url_safety_status text DEFAULT 'safe';
ALTER TABLE sources ADD COLUMN IF NOT EXISTS final_url          text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS url_reachable      boolean;

-- Validity scores (structural vs trust — kept separate)
ALTER TABLE sources ADD COLUMN IF NOT EXISTS structural_validity_score integer DEFAULT 0;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS publisher_trust_score     integer DEFAULT 0;

-- Eligibility flags (ingestion-era; period-label flags added in section 12)
ALTER TABLE sources ADD COLUMN IF NOT EXISTS eligible_for_weekly_report     boolean DEFAULT true;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS eligible_for_monthly_report    boolean DEFAULT true;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS eligible_for_archive           boolean DEFAULT true;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS eligible_for_trend_analysis    boolean DEFAULT true;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS eligible_for_reference_context boolean DEFAULT false;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS eligible_for_horizon_scan      boolean DEFAULT false;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS needs_review                   boolean DEFAULT false;

-- Event clustering (populated by a future clustering step)
ALTER TABLE sources ADD COLUMN IF NOT EXISTS event_cluster_id    text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS cluster_key         text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS is_primary_source   boolean;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS is_follow_on_source boolean;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS adds_new_information boolean;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS related_sources     text[];

-- Ingestion indexes
CREATE INDEX IF NOT EXISTS idx_sources_needs_review    ON sources (needs_review) WHERE needs_review = true;
CREATE INDEX IF NOT EXISTS idx_sources_event_cluster   ON sources (event_cluster_id) WHERE event_cluster_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_date_confidence ON sources (date_confidence);
CREATE INDEX IF NOT EXISTS idx_sources_date_discovered ON sources (date_discovered);


-- ===========================================================================
-- 2. Archiving + source_snapshots table
-- ===========================================================================

ALTER TABLE sources ADD COLUMN IF NOT EXISTS original_url   text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS canonical_url  text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS raw_text       text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS clean_text     text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS extracted_code_blocks jsonb DEFAULT '[]'::jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS extracted_iocs        jsonb DEFAULT '{}'::jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS cleaning_version text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS trust_version    text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS is_curated       boolean DEFAULT false;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS curated_metadata jsonb;

CREATE TABLE IF NOT EXISTS source_snapshots (
  id                    bigserial PRIMARY KEY,
  source_id             text        NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  snapshot_id           text        NOT NULL,
  captured_at           timestamptz NOT NULL DEFAULT now(),
  content_hash          text        NOT NULL,
  clean_text_hash       text,
  raw_text              text        NOT NULL DEFAULT '',
  clean_text            text        NOT NULL DEFAULT '',
  raw_html              text        NOT NULL DEFAULT '',
  cleaning_version      text,
  extracted_code_blocks jsonb       NOT NULL DEFAULT '[]'::jsonb,
  extracted_iocs        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT uq_source_snapshots_source_content UNIQUE (source_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_sources_canonical_url    ON sources (canonical_url);
CREATE INDEX IF NOT EXISTS idx_sources_is_curated       ON sources (is_curated) WHERE is_curated = true;
CREATE INDEX IF NOT EXISTS idx_sources_cleaning_version ON sources (cleaning_version);
CREATE INDEX IF NOT EXISTS idx_source_snapshots_source_id   ON source_snapshots (source_id);
CREATE INDEX IF NOT EXISTS idx_source_snapshots_snapshot_id ON source_snapshots (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_source_snapshots_captured_at ON source_snapshots (captured_at DESC);


-- ===========================================================================
-- 3. Layer 3 validation columns
-- ===========================================================================

-- Layer 2 validation outputs
ALTER TABLE sources ADD COLUMN IF NOT EXISTS validation_flags   text[] DEFAULT '{}';
ALTER TABLE sources ADD COLUMN IF NOT EXISTS layer2_status      text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS ai_relevance_score integer;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS archive_version    text;

-- Layer 3 LLM relevance triage outputs
ALTER TABLE sources ADD COLUMN IF NOT EXISTS validation_summary          text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS validation_status           text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS validation_version          text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS ai_threat_focus             text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS candidate_domain            text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS validation_relevance_method text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS validation_qa_status        text;

-- Layer 3 final gate verdict
ALTER TABLE sources ADD COLUMN IF NOT EXISTS layer3_status    text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS downstream_route text;

CREATE INDEX IF NOT EXISTS idx_sources_eligible_horizon_scan
  ON sources (eligible_for_horizon_scan, date_published DESC) WHERE eligible_for_horizon_scan = true;
CREATE INDEX IF NOT EXISTS idx_sources_layer2_status
  ON sources (layer2_status) WHERE layer2_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_relevance_tier
  ON sources (relevance_tier) WHERE relevance_tier IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_ai_specificity
  ON sources (ai_specificity_score DESC) WHERE ai_specificity_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_validation_status ON sources (validation_status);
CREATE INDEX IF NOT EXISTS idx_sources_candidate_domain  ON sources (candidate_domain);
CREATE INDEX IF NOT EXISTS idx_sources_layer3_status
  ON sources (layer3_status) WHERE layer3_status IS NOT NULL;


-- ===========================================================================
-- 4. Layer 4 understanding stamp
-- ===========================================================================

ALTER TABLE sources ADD COLUMN IF NOT EXISTS understand_version text;

CREATE INDEX IF NOT EXISTS idx_sources_understand_version
  ON sources (understand_version) WHERE understand_version IS NOT NULL;


-- ===========================================================================
-- 5. Layer 5A rawfact + Layer 5B analytics feature columns
-- ===========================================================================

ALTER TABLE sources ADD COLUMN IF NOT EXISTS rawfact_evidence  jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS rawfact_summary   jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS rawfact_version   text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS analytics_features jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS analytics_version  text;

CREATE INDEX IF NOT EXISTS idx_sources_rawfact_version
  ON sources (rawfact_version) WHERE rawfact_version IS NOT NULL;


-- ===========================================================================
-- 6. Source type vocabulary remap (15 → 12 + unknown)
--    Retires: ecosystem_signal, infrastructure_dependency_signal,
--             trust_boundary_shift, strategic_signal → attack_surface_signal
-- ===========================================================================

UPDATE sources
SET source_type = 'attack_surface_signal'
WHERE source_type IN (
  'ecosystem_signal', 'infrastructure_dependency_signal',
  'trust_boundary_shift', 'strategic_signal',
  'ecosystem_market_signal', 'strategic_foresight_signal',
  'tooling_platform_development'
);

DO $$
BEGIN
  IF to_regclass('public.web_discovery_candidates') IS NOT NULL THEN
    UPDATE web_discovery_candidates
    SET source_type_hint = 'attack_surface_signal'
    WHERE source_type_hint IN (
      'ecosystem_signal', 'infrastructure_dependency_signal',
      'trust_boundary_shift', 'strategic_signal',
      'ecosystem_market_signal', 'strategic_foresight_signal',
      'tooling_platform_development'
    );
  END IF;
END $$;


-- ===========================================================================
-- 7. Taxonomy v9 columns (primary_tags, sub_techniques, AI-enabled overlay)
-- ===========================================================================

-- Legacy taxonomy columns (taxonomy-v2 / earlier)
ALTER TABLE sources ADD COLUMN IF NOT EXISTS collected_date       timestamptz;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS primary_domain       text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS primary_threat_tags  jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS secondary_dimensions jsonb;

-- Taxonomy v9 additions
ALTER TABLE sources ADD COLUMN IF NOT EXISTS primary_tags                jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS sub_techniques              jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS taxonomy_assignments        jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS ai_enabled                  boolean DEFAULT false;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS ai_enabled_roles            jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS ai_capabilities             jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS automation_level            text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS autonomy_level              text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS mapped_frameworks           jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS mapping_type                text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS taxonomy_version            text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS taxonomy_validation_status  text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS taxonomy_validation_reasons jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_automation_level' AND conrelid = 'sources'::regclass) THEN
    ALTER TABLE sources ADD CONSTRAINT chk_automation_level
      CHECK (automation_level IS NULL OR automation_level IN ('human_assisted','semi_autonomous','autonomous','unknown'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_autonomy_level' AND conrelid = 'sources'::regclass) THEN
    ALTER TABLE sources ADD CONSTRAINT chk_autonomy_level
      CHECK (autonomy_level IS NULL OR autonomy_level IN ('human_assisted','semi_autonomous','autonomous','multi_agent','unknown'));
  END IF;
END $$;

-- taxonomy_validation_status allowed values MUST match the producers in
-- understandSource.js: validated | weak | needs_manual_review | rejected
-- PLUS the gate/novelty statuses emerging_unmapped | no_domain_match | no_tags_found.
-- The original constraint omitted the last three, so persisting an emerging_unmapped
-- source (the novelty safety valve) or a gate-discarded source violated the check.
-- Drop-and-recreate so existing databases pick up the widened set.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_taxonomy_validation_status' AND conrelid = 'sources'::regclass) THEN
    ALTER TABLE sources DROP CONSTRAINT chk_taxonomy_validation_status;
  END IF;
  ALTER TABLE sources ADD CONSTRAINT chk_taxonomy_validation_status
    CHECK (taxonomy_validation_status IS NULL OR taxonomy_validation_status IN (
      'validated','weak','needs_manual_review','rejected',
      'emerging_unmapped','no_domain_match','no_tags_found'
    ));
END $$;

CREATE INDEX IF NOT EXISTS idx_sources_primary_domain
  ON sources (primary_domain) WHERE primary_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_ai_enabled
  ON sources (ai_enabled) WHERE ai_enabled = true;
CREATE INDEX IF NOT EXISTS idx_sources_taxonomy_version
  ON sources (taxonomy_version) WHERE taxonomy_version IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_primary_tags_gin
  ON sources USING GIN (primary_tags) WHERE primary_tags IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_sub_techniques_gin
  ON sources USING GIN (sub_techniques) WHERE sub_techniques IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_ai_enabled_roles_gin
  ON sources USING GIN (ai_enabled_roles) WHERE ai_enabled_roles IS NOT NULL;


-- ===========================================================================
-- 8. Taxonomy support tables
-- ===========================================================================

CREATE TABLE IF NOT EXISTS taxonomy_references (
  reference_id   text PRIMARY KEY,
  framework      text NOT NULL,
  framework_item text,
  url            text,
  description    text
);

CREATE TABLE IF NOT EXISTS rawfacts (
  rawfact_id           text PRIMARY KEY,
  source_id            text REFERENCES sources(id) ON DELETE CASCADE,
  claim                text,
  supporting_quote     text,
  evidence_location    text,
  primary_domain       text,
  primary_threat_tags  jsonb,
  secondary_dimensions jsonb,
  primary_tags         jsonb,
  sub_techniques       jsonb,
  ai_enabled           boolean DEFAULT false,
  ai_enabled_roles     jsonb,
  ai_capabilities      jsonb,
  automation_level     text,
  autonomy_level       text,
  taxonomy_version     text,
  taxonomy_confidence  text,
  validation_status    text,
  caveat_if_any        text,
  snapshot_id          text,
  created_at           timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rawfacts_source     ON rawfacts (source_id);
CREATE INDEX IF NOT EXISTS idx_rawfacts_domain     ON rawfacts (primary_domain);
CREATE INDEX IF NOT EXISTS idx_rawfacts_validation ON rawfacts (validation_status);
CREATE INDEX IF NOT EXISTS idx_rawfacts_ai_enabled ON rawfacts (ai_enabled) WHERE ai_enabled = true;
CREATE INDEX IF NOT EXISTS idx_rawfacts_primary_tags_gin
  ON rawfacts USING GIN (primary_tags) WHERE primary_tags IS NOT NULL;

-- For existing databases: add rawfacts columns that were added in taxonomy-v9
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS primary_tags     jsonb;
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS sub_techniques   jsonb;
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS ai_enabled       boolean DEFAULT false;
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS ai_enabled_roles jsonb;
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS ai_capabilities  jsonb;
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS automation_level text;
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS autonomy_level   text;
ALTER TABLE rawfacts ADD COLUMN IF NOT EXISTS taxonomy_version text;

CREATE TABLE IF NOT EXISTS analytics_metrics (
  metric_id          text PRIMARY KEY,
  metric_name        text,
  domain             text,
  primary_threat_tag text,
  parent_tag         text,
  subdomain          text,
  sub_technique      text,
  ai_enabled_role    text,
  taxonomy_version   text,
  value              numeric,
  source_ids         jsonb,
  evidence_ids       jsonb,
  calculation_method text,
  confidence         text,
  caveat_if_any      text,
  snapshot_id        text,
  created_at         timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metrics_domain   ON analytics_metrics (domain);
CREATE INDEX IF NOT EXISTS idx_metrics_tag      ON analytics_metrics (primary_threat_tag);
CREATE INDEX IF NOT EXISTS idx_metrics_snapshot ON analytics_metrics (snapshot_id);

-- For existing databases: add analytics_metrics columns from taxonomy-v9
ALTER TABLE analytics_metrics ADD COLUMN IF NOT EXISTS sub_technique     text;
ALTER TABLE analytics_metrics ADD COLUMN IF NOT EXISTS ai_enabled_role   text;
ALTER TABLE analytics_metrics ADD COLUMN IF NOT EXISTS taxonomy_version  text;

-- visual_evidence: includes all columns (session-2026-06-08 additions already baked in)
CREATE TABLE IF NOT EXISTS visual_evidence (
  evidence_id          text PRIMARY KEY,
  category             text,
  title                text,
  publisher            text,
  url                  text,
  image_url            text,
  evidence_type        text,
  evidence_class       text,
  abstraction_level    text,
  type_justification   text,
  event_date           text,
  date_range           jsonb,
  metric               jsonb,
  metric_name          text,
  metric_value         text,
  is_visual            boolean,
  chart_data           jsonb,
  evidence_confidence  text,
  needs_manual_review  boolean,
  snapshot_id          text,
  created_at           timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_visual_evidence_category ON visual_evidence (category);
CREATE INDEX IF NOT EXISTS idx_visual_evidence_snapshot ON visual_evidence (snapshot_id);

-- For existing databases: add visual_evidence columns from session-2026-06-08
ALTER TABLE visual_evidence ADD COLUMN IF NOT EXISTS evidence_class    text;
ALTER TABLE visual_evidence ADD COLUMN IF NOT EXISTS abstraction_level text;
ALTER TABLE visual_evidence ADD COLUMN IF NOT EXISTS type_justification text;
ALTER TABLE visual_evidence ADD COLUMN IF NOT EXISTS event_date        text;
ALTER TABLE visual_evidence ADD COLUMN IF NOT EXISTS date_range        jsonb;
ALTER TABLE visual_evidence ADD COLUMN IF NOT EXISTS metric            jsonb;

-- Clean up legacy invalid evidence_type values in visual_evidence
UPDATE visual_evidence SET evidence_type = 'research_result'
  WHERE evidence_type IN ('statistic','timeline_event');
UPDATE visual_evidence SET evidence_type = NULL
  WHERE evidence_type IN ('strategic_signal','ecosystem_shift','trust_boundary_shift');

CREATE TABLE IF NOT EXISTS ai_enabled_mappings (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  primary_threat_tag         text,
  operational_attack_mapping text,
  ai_capability_modifier     text,
  supporting_evidence_ids    jsonb,
  confidence                 text,
  source_id                  text,
  snapshot_id                text,
  created_at                 timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_enabled_tag      ON ai_enabled_mappings (primary_threat_tag);
CREATE INDEX IF NOT EXISTS idx_ai_enabled_snapshot ON ai_enabled_mappings (snapshot_id);

-- Taxonomy v9 convenience view
CREATE OR REPLACE VIEW taxonomy_v9_assignments AS
SELECT
  id                           AS source_id,
  title,
  url,
  primary_domain,
  primary_tags,
  sub_techniques,
  ai_enabled,
  ai_enabled_roles,
  ai_capabilities,
  automation_level,
  autonomy_level,
  taxonomy_version,
  taxonomy_validation_status,
  taxonomy_validation_reasons,
  intelligence                 AS legacy_intelligence,
  claim_extraction_status
FROM sources
WHERE taxonomy_version IS NOT NULL;


-- ===========================================================================
-- 9. Web discovery (Layer 1B/1C) columns + web_discovery_candidates table
-- ===========================================================================

-- sources: discovery provenance + early-signal columns
ALTER TABLE sources ADD COLUMN IF NOT EXISTS source_origin              text DEFAULT 'fixed_feed';
ALTER TABLE sources ADD COLUMN IF NOT EXISTS discovery_mission          text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS search_query               text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS opened_url                 text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS candidate_claim            text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS verbatim_quote             text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS quote_status               text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS quote_verified             boolean;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS quote_claim_match_status   text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS freshness_status           text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS freshness_interpretation   text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS novelty_assessment         text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS operationalization_stage   text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS early_signal_value         text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS early_signal_type          text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS early_signal_qa_status     text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS corroboration_status       text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS source_independence_status text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS hallucination_risk         text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS discovery_route            text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS web_discovery_metadata     jsonb;

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

CREATE INDEX IF NOT EXISTS idx_sources_source_origin
  ON sources (source_origin) WHERE source_origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_discovery_mission
  ON sources (discovery_mission) WHERE discovery_mission IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_early_signal_value
  ON sources (early_signal_value) WHERE early_signal_value IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_freshness_status
  ON sources (freshness_status) WHERE freshness_status IS NOT NULL;

-- web_discovery_candidates: full audit store for ALL candidates
-- (accepted, accept_with_review, archive_only, rejected)
CREATE TABLE IF NOT EXISTS web_discovery_candidates (
  candidate_id               text PRIMARY KEY,
  snapshot_id                text,
  run_id                     text,
  source_id                  text,
  source_origin              text DEFAULT 'web_discovery',
  discovery_mission          text,
  search_query               text,
  search_query_family        text,
  provider                   text,
  fetch_pending              boolean,
  opened_url                 text,
  opened_url_confirmed       boolean,
  source_class               text,
  title                      text,
  publisher                  text,
  published_date             text,
  event_date                 text,
  last_updated               text,
  candidate_claim            text,
  verbatim_quote             text,
  quote_status               text,
  quote_verified             boolean,
  quote_claim_match_status   text,
  source_type_hint           text,
  trust_tier_hint            text,
  source_quality             text,
  freshness_status           text,
  freshness_interpretation   text,
  ai_threat_specificity      text,
  ai_threat_anchors          jsonb,
  novelty_assessment         text,
  operationalization_stage   text,
  early_signal_value         text,
  early_signal_type          text,
  early_signal_reason        text,
  early_signal_qa_status     text,
  corroboration_status       text,
  source_independence_status text,
  hallucination_risk         text,
  duplicate_cluster_id       text,
  is_cluster_representative  boolean,
  duplicate_reason           text,
  original_source_url        text,
  route                      text,
  route_reason               text,
  route_flags                jsonb,
  manual_review_required     boolean,
  rejection_reason           text,
  taxonomy_hint              jsonb,
  web_discovery_metadata     jsonb,
  created_at                 timestamptz DEFAULT now()
);

-- For existing databases that had the simplified web_discovery_candidates schema:
-- add all columns the code writes that were not in the old simplified schema
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS run_id                     text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS source_id                  text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS source_origin              text DEFAULT 'web_discovery';
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS search_query_family        text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS provider                   text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS fetch_pending              boolean;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS opened_url                 text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS opened_url_confirmed       boolean;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS source_class               text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS title                      text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS publisher                  text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS published_date             text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS event_date                 text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS last_updated               text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS trust_tier_hint            text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS source_quality             text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS freshness_status           text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS freshness_interpretation   text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS ai_threat_specificity      text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS ai_threat_anchors          jsonb;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS operationalization_stage   text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS early_signal_reason        text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS duplicate_cluster_id       text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS is_cluster_representative  boolean;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS duplicate_reason           text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS original_source_url        text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS route                      text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS route_reason               text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS route_flags                jsonb;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS manual_review_required     boolean;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS rejection_reason           text;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS taxonomy_hint              jsonb;
ALTER TABLE web_discovery_candidates ADD COLUMN IF NOT EXISTS web_discovery_metadata     jsonb;

CREATE INDEX IF NOT EXISTS idx_wdc_route        ON web_discovery_candidates (route);
CREATE INDEX IF NOT EXISTS idx_wdc_mission      ON web_discovery_candidates (discovery_mission);
CREATE INDEX IF NOT EXISTS idx_wdc_early_signal ON web_discovery_candidates (early_signal_value);
CREATE INDEX IF NOT EXISTS idx_wdc_snapshot     ON web_discovery_candidates (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_wdc_source_class ON web_discovery_candidates (source_class);
CREATE INDEX IF NOT EXISTS idx_wdc_cluster      ON web_discovery_candidates (duplicate_cluster_id);


-- ===========================================================================
-- 10. Web evidence (Layer 5C) tables
-- ===========================================================================

CREATE TABLE IF NOT EXISTS web_evidence_items (
  web_evidence_id            text PRIMARY KEY,
  snapshot_id                text,
  category                   text,
  discovery_mission          text,
  evidence_label             text,
  evidence_depth             text,
  analysis_usefulness        text,
  why_this_is_useful         text,
  concrete_claim             text,
  operational_details        jsonb,
  walkthrough_status         text,
  source_url                 text,
  opened_url_confirmed       boolean,
  publisher                  text,
  title                      text,
  published_date             text,
  verbatim_quotes            jsonb,
  taxonomy_context           jsonb,
  source_lineage             jsonb,
  confidence                 text,
  validation_status          text,
  validation_violations      jsonb,
  qa_status                  text,
  selection_reason           text,
  duplicate_cluster_id       text,
  is_cluster_representative  boolean,
  duplicate_reason           text,
  manual_review_required     boolean,
  rejection_reason           text,
  created_at                 timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wei_category ON web_evidence_items (category);
CREATE INDEX IF NOT EXISTS idx_wei_depth    ON web_evidence_items (evidence_depth);
CREATE INDEX IF NOT EXISTS idx_wei_snapshot ON web_evidence_items (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_wei_cluster  ON web_evidence_items (duplicate_cluster_id);

CREATE TABLE IF NOT EXISTS web_visual_evidence (
  visual_evidence_id         text PRIMARY KEY,
  snapshot_id                text,
  category                   text,
  visual_label               text,
  visual_kind                text,
  source_url                 text,
  visual_url                 text,
  local_image_path           text,
  screenshot_path            text,
  full_page_screenshot_path  text,
  cropped_visual_path        text,
  crop_method                text,
  capture_method             text,
  page_number                integer,
  caption_or_nearby_text     text,
  what_it_shows              text,
  why_it_is_relevant         text,
  supports_evidence_ids      jsonb,
  visual_claim               text,
  image_hash                 text,
  taxonomy_context           jsonb,
  visual_quality             jsonb,
  usage                      jsonb,
  visual_usefulness          jsonb,
  slide_suitability          jsonb,
  table_data                 jsonb,
  validation_status          text,
  qa_status                  text,
  duplicate_cluster_id       text,
  is_cluster_representative  boolean,
  duplicate_reason           text,
  manual_review_required     boolean,
  rejection_reason           text,
  created_at                 timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wve_category ON web_visual_evidence (category);
CREATE INDEX IF NOT EXISTS idx_wve_snapshot ON web_visual_evidence (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_wve_cluster  ON web_visual_evidence (duplicate_cluster_id);

-- For existing databases that had the simplified web_visual_evidence schema:
ALTER TABLE web_visual_evidence ADD COLUMN IF NOT EXISTS full_page_screenshot_path  text;
ALTER TABLE web_visual_evidence ADD COLUMN IF NOT EXISTS cropped_visual_path        text;
ALTER TABLE web_visual_evidence ADD COLUMN IF NOT EXISTS crop_method                text;
ALTER TABLE web_visual_evidence ADD COLUMN IF NOT EXISTS capture_method             text;
ALTER TABLE web_visual_evidence ADD COLUMN IF NOT EXISTS page_number                integer;
ALTER TABLE web_visual_evidence ADD COLUMN IF NOT EXISTS image_hash                 text;
ALTER TABLE web_visual_evidence ADD COLUMN IF NOT EXISTS table_data                 jsonb;
ALTER TABLE web_visual_evidence ADD COLUMN IF NOT EXISTS validation_status          text;
ALTER TABLE web_visual_evidence ADD COLUMN IF NOT EXISTS qa_status                  text;
ALTER TABLE web_visual_evidence ADD COLUMN IF NOT EXISTS duplicate_reason           text;
ALTER TABLE web_visual_evidence ADD COLUMN IF NOT EXISTS rejection_reason           text;

-- web_evidence_failures: uses text PK (failure_id) for idempotent upserts
CREATE TABLE IF NOT EXISTS web_evidence_failures (
  failure_id      text PRIMARY KEY,
  snapshot_id     text,
  provider        text,
  query           text,
  failed_url      text,
  failure_reason  text,
  retry_attempted boolean,
  fallback_used   text,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wef_snapshot ON web_evidence_failures (snapshot_id);

-- For existing databases that had the old bigserial-PK web_evidence_failures:
ALTER TABLE web_evidence_failures ADD COLUMN IF NOT EXISTS failure_id      text;
ALTER TABLE web_evidence_failures ADD COLUMN IF NOT EXISTS retry_attempted boolean;
ALTER TABLE web_evidence_failures ADD COLUMN IF NOT EXISTS fallback_used   text;

COMMENT ON TABLE web_evidence_items IS
  'Layer 5C web evidence (accepted + rejected + manual_review) for analysis + audit.';
COMMENT ON TABLE web_visual_evidence IS
  'Layer 5C visual evidence with usefulness + slide-suitability decisions.';
COMMENT ON TABLE web_discovery_candidates IS
  'Audit store for every Layer 1B/1C web-discovery candidate (accepted + archive_only + rejected). '
  'Rejected/derivative candidates are retained here for audit and never enter Layer 4/5.';


-- ===========================================================================
-- 11. Deck output metadata table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS decks (
  deck_id              text        PRIMARY KEY,
  generated_at         timestamptz NOT NULL,
  source_window_start  date,
  source_window_end    date,
  source_count         integer     DEFAULT 0,
  must_read_count      integer     DEFAULT 0,
  viewpoint_count      integer     DEFAULT 0,
  slide_count          integer     DEFAULT 0,
  synthesis_version    text,
  deck_version         text,
  qa_version           text,
  overall_pass         boolean,
  qa_errors            integer     DEFAULT 0,
  qa_warnings          integer     DEFAULT 0,
  coverage_pct         integer,
  blob_path            text,
  created_at           timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_decks_generated_at ON decks (generated_at DESC);


-- ===========================================================================
-- 12. Source context & eligibility refactor (June 2026)
--
--   a. Remove legacy daily-report flag; add quarterly flag + period-label keys
--   b. Replace numeric source_credibility_score with qualitative annotation fields
--   c. Clean up rawfact_evidence JSONB: remove retired evidence types
-- ===========================================================================

-- 12a. Eligibility flags

ALTER TABLE sources DROP COLUMN IF EXISTS eligible_for_daily_report;

ALTER TABLE sources ADD COLUMN IF NOT EXISTS eligible_for_quarterly_report boolean NOT NULL DEFAULT false;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS report_period_week            text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS report_period_month           text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS report_period_quarter         text;

-- Backfill period keys for existing sources (SGT-anchored)
UPDATE sources
SET
  report_period_week    = to_char(date_published AT TIME ZONE 'Asia/Singapore', 'IYYY-"W"IW'),
  report_period_month   = to_char(date_published AT TIME ZONE 'Asia/Singapore', 'YYYY-MM'),
  report_period_quarter = to_char(date_published AT TIME ZONE 'Asia/Singapore', 'YYYY-"Q"Q')
WHERE date_published IS NOT NULL AND report_period_week IS NULL;

UPDATE sources
SET eligible_for_quarterly_report = true
WHERE date_published IS NOT NULL
  AND eligible_for_quarterly_report = false
  AND date_published >= (date_trunc('quarter', now() AT TIME ZONE 'Asia/Singapore') AT TIME ZONE 'Asia/Singapore')
  AND date_published < now();

CREATE INDEX IF NOT EXISTS sources_report_period_week
  ON sources (report_period_week)    WHERE report_period_week    IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_report_period_month
  ON sources (report_period_month)   WHERE report_period_month   IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_report_period_quarter
  ON sources (report_period_quarter) WHERE report_period_quarter IS NOT NULL;

-- 12b. Source context annotation (qualitative, replaces numeric credibility score)

ALTER TABLE sources DROP COLUMN IF EXISTS source_credibility_score;
ALTER TABLE sources DROP COLUMN IF EXISTS credibility_reason;

ALTER TABLE sources ADD COLUMN IF NOT EXISTS publisher_class        text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS evidence_role          text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS independence_level     text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS verification_status    text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS evidence_strength_hint text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS reliability_notes      jsonb DEFAULT '[]'::jsonb;

UPDATE sources SET publisher_class = CASE
  WHEN trust_tier IN ('primary','curated') THEN 'primary_authority'
  WHEN trust_tier = 'high'                 THEN 'security_firm'
  ELSE 'other'
END WHERE publisher_class IS NULL;

UPDATE sources SET evidence_strength_hint = CASE
  WHEN trust_tier IN ('primary','curated') THEN 'strong'
  WHEN trust_tier = 'high'                 THEN 'moderate'
  ELSE 'weak'
END WHERE evidence_strength_hint IS NULL;

CREATE INDEX IF NOT EXISTS sources_publisher_class
  ON sources (publisher_class)        WHERE publisher_class        IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_evidence_role
  ON sources (evidence_role)          WHERE evidence_role          IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_verification_status
  ON sources (verification_status)    WHERE verification_status    IS NOT NULL;
CREATE INDEX IF NOT EXISTS sources_evidence_strength_hint
  ON sources (evidence_strength_hint) WHERE evidence_strength_hint IS NOT NULL;

-- 12c. Remove retired evidence types from rawfact_evidence JSONB

UPDATE sources
SET rawfact_evidence = (
  SELECT COALESCE(jsonb_agg(item ORDER BY (item->>'evidence_id')), '[]'::jsonb)
  FROM jsonb_array_elements(rawfact_evidence) AS item
  WHERE (item->>'evidence_type') NOT IN (
    'timeline_event','statistic','strategic_signal','ecosystem_shift','trust_boundary_shift'
  )
)
WHERE rawfact_evidence IS NOT NULL
  AND jsonb_typeof(rawfact_evidence) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(rawfact_evidence) AS item
    WHERE (item->>'evidence_type') IN (
      'timeline_event','statistic','strategic_signal','ecosystem_shift','trust_boundary_shift'
    )
  );


COMMIT;


-- ===========================================================================
-- VERIFICATION QUERIES  (run manually after migration to confirm)
-- ===========================================================================

-- Key columns on sources:
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'sources'
--   AND column_name IN (
--     'report_period_week','report_period_month','report_period_quarter',
--     'publisher_class','evidence_strength_hint',
--     'primary_tags','sub_techniques','taxonomy_validation_status',
--     'rawfact_evidence','analytics_features',
--     'source_origin','early_signal_value',
--     'layer3_status','downstream_route'
--   )
-- ORDER BY column_name;

-- Confirm removed columns are gone:
-- SELECT COUNT(*) FROM information_schema.columns
-- WHERE table_name = 'sources' AND column_name IN (
--   'eligible_for_daily_report','source_credibility_score','credibility_reason'
-- );
-- Expected: 0

-- Tables created:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN (
--     'source_snapshots','rawfacts','analytics_metrics',
--     'visual_evidence','ai_enabled_mappings','taxonomy_references',
--     'web_discovery_candidates','web_evidence_items',
--     'web_visual_evidence','web_evidence_failures','decks'
--   )
-- ORDER BY table_name;
-- Expected: 11 rows

-- web_discovery_candidates key columns (code-facing):
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'web_discovery_candidates'
--   AND column_name IN ('provider','route','opened_url','taxonomy_hint','route_flags')
-- ORDER BY column_name;
-- Expected: 5 rows

-- Evidence type distribution after cleanup:
-- SELECT evidence_type, COUNT(*) FROM visual_evidence GROUP BY 1 ORDER BY 2 DESC;

-- Period key coverage:
-- SELECT report_period_month, COUNT(*) FROM sources
-- WHERE report_period_month IS NOT NULL
-- GROUP BY 1 ORDER BY 1 DESC LIMIT 12;


-- ===========================================================================
-- 13. Deck v9.1 — argument-form metadata + slide QA columns (June 2026)
--
-- These columns extend the `decks` table to store deck-v9.1 planning
-- metadata: argument forms used, bullet-role QA results, visual support
-- stats, and speaker-notes QA flags. All are nullable so older deck rows
-- are unaffected.
-- ===========================================================================

-- Deck-level argument-form and QA metadata
ALTER TABLE decks ADD COLUMN IF NOT EXISTS deck_version          text;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS argument_forms_used   text[]  DEFAULT '{}';
ALTER TABLE decks ADD COLUMN IF NOT EXISTS bullet_role_violations int     DEFAULT 0;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS analytics_not_supporting int   DEFAULT 0;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS visual_contextual_count  int   DEFAULT 0;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS notes_qa_blocking        int   DEFAULT 0;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS notes_qa_warnings        int   DEFAULT 0;
ALTER TABLE decks ADD COLUMN IF NOT EXISTS claim_anchored_slides    int   DEFAULT 0;

-- Verification queries for section 13:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'decks'
--   AND column_name IN (
--     'deck_version','argument_forms_used','bullet_role_violations',
--     'analytics_not_supporting','visual_contextual_count',
--     'notes_qa_blocking','notes_qa_warnings','claim_anchored_slides'
--   )
-- ORDER BY column_name;
-- Expected: 8 rows


-- ===========================================================================
-- 14. Validation v1.1 — content quality gate + URL resolution (June 2026)
--
-- Adds columns populated by the new Layer 3.3 content quality gate and the
-- URL resolution step in validateAndTypeSource.js.
-- All nullable — existing rows default to NULL, pipeline sets on next run.
-- ===========================================================================

ALTER TABLE sources ADD COLUMN IF NOT EXISTS content_quality        text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS content_quality_reason text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS ai_signal_strength     text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS display_url            text;

CREATE INDEX IF NOT EXISTS idx_sources_content_quality
  ON sources (content_quality)
  WHERE content_quality IS NOT NULL;

-- Verification:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'sources'
--   AND column_name IN ('content_quality','content_quality_reason','ai_signal_strength','display_url')
-- ORDER BY column_name;
-- Expected: 4 rows

COMMIT;


-- ── Audit refactor: source quality, origin tracking, relevance path ───────────
-- See docs/migrations/audit-refactor.sql for detailed comments.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS source_quality_status  text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS source_quality_reasons text[];
ALTER TABLE sources ADD COLUMN IF NOT EXISTS origin_role            text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS primary_origin_url     text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS cited_sources          text[];
ALTER TABLE sources ADD COLUMN IF NOT EXISTS relevance_path         text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS taxonomy_status        text;

CREATE INDEX IF NOT EXISTS idx_sources_source_quality_status ON sources (source_quality_status);
CREATE INDEX IF NOT EXISTS idx_sources_origin_role           ON sources (origin_role);
