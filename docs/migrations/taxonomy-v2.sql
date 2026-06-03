-- taxonomy-v2.sql
-- Normalized persistence for the Validated AI Threat Taxonomy (June 2026).
-- Additive + idempotent (IF NOT EXISTS). taxonomyStore.js degrades gracefully if
-- these tables/columns are absent, so the pipeline runs either way.

-- ── sources: taxonomy + provenance columns ──────────────────────────────────────
ALTER TABLE sources ADD COLUMN IF NOT EXISTS collected_date        timestamptz;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS primary_domain        text;     -- one of the four domains
ALTER TABLE sources ADD COLUMN IF NOT EXISTS primary_threat_tags   jsonb;    -- [{tag,domain,confidence,validation_status,...}]
ALTER TABLE sources ADD COLUMN IF NOT EXISTS secondary_dimensions  jsonb;    -- ["misinformation", ...]
ALTER TABLE sources ADD COLUMN IF NOT EXISTS taxonomy_version      text;

-- ── Framework reference catalogue (seeded from the registry) ────────────────────
-- "references" is a reserved word; use taxonomy_references.
CREATE TABLE IF NOT EXISTS taxonomy_references (
  reference_id   text PRIMARY KEY,
  framework      text NOT NULL,
  framework_item text,
  url            text,
  description    text
);

-- ── Rawfacts (atomic, source-grounded claims with taxonomy) ─────────────────────
CREATE TABLE IF NOT EXISTS rawfacts (
  rawfact_id           text PRIMARY KEY,
  source_id            text REFERENCES sources(id) ON DELETE CASCADE,
  claim                text,
  supporting_quote     text,
  evidence_location    text,
  primary_domain       text,
  primary_threat_tags  jsonb,
  secondary_dimensions jsonb,
  taxonomy_confidence  text,
  validation_status    text,   -- validated | weak | rejected | needs_manual_review
  caveat_if_any        text,
  snapshot_id          text,
  created_at           timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rawfacts_source     ON rawfacts (source_id);
CREATE INDEX IF NOT EXISTS idx_rawfacts_domain     ON rawfacts (primary_domain);
CREATE INDEX IF NOT EXISTS idx_rawfacts_validation ON rawfacts (validation_status);

-- ── Analytics metrics (taxonomy-aware aggregates) ───────────────────────────────
CREATE TABLE IF NOT EXISTS analytics_metrics (
  metric_id          text PRIMARY KEY,
  metric_name        text,
  domain             text,
  primary_threat_tag text,
  parent_tag         text,
  subdomain          text,
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

-- ── Visual evidence (charts/graphs re-drawn from real online data series) ───────
CREATE TABLE IF NOT EXISTS visual_evidence (
  evidence_id          text PRIMARY KEY,
  category             text,
  title                text,
  publisher            text,
  url                  text,
  image_url            text,
  evidence_type        text,
  metric_name          text,
  metric_value         text,
  is_visual            boolean,
  chart_data           jsonb,   -- { chart_kind, categories[], values[], unit }
  evidence_confidence  text,
  needs_manual_review  boolean,
  snapshot_id          text,
  created_at           timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_visual_evidence_category ON visual_evidence (category);
CREATE INDEX IF NOT EXISTS idx_visual_evidence_snapshot ON visual_evidence (snapshot_id);

-- ── AI-enabled paired mappings (operational technique + AI modifier) ────────────
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
