-- web-evidence-v1.sql
-- Layer 5C Web Evidence Branch persistence.
--   web_evidence_items     — text evidence (accepted + rejected + manual_review)
--   web_visual_evidence    — visual evidence (accepted + rejected + manual_review)
--   web_evidence_failures  — search/open/screenshot failures (audit)
-- Safe to re-run (IF NOT EXISTS). Apply after web-discovery-v1.sql.

CREATE TABLE IF NOT EXISTS web_evidence_items (
  web_evidence_id            TEXT PRIMARY KEY,
  snapshot_id                TEXT,
  category                   TEXT,
  discovery_mission          TEXT,
  evidence_label             TEXT,
  evidence_depth             TEXT,
  analysis_usefulness        TEXT,
  why_this_is_useful         TEXT,
  concrete_claim             TEXT,
  operational_details        JSONB,
  walkthrough_status         TEXT,
  source_url                 TEXT,
  opened_url_confirmed       BOOLEAN,
  publisher                  TEXT,
  title                      TEXT,
  published_date             TEXT,
  verbatim_quotes            JSONB,
  taxonomy_context           JSONB,
  source_lineage             JSONB,
  confidence                 TEXT,
  validation_status          TEXT,
  validation_violations      JSONB,
  qa_status                  TEXT,
  selection_reason           TEXT,
  duplicate_cluster_id       TEXT,
  is_cluster_representative   BOOLEAN,
  duplicate_reason           TEXT,
  manual_review_required      BOOLEAN,
  rejection_reason           TEXT,
  created_at                 TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS web_visual_evidence (
  visual_evidence_id         TEXT PRIMARY KEY,
  snapshot_id                TEXT,
  category                   TEXT,
  visual_label               TEXT,
  visual_kind                TEXT,
  source_url                 TEXT,
  visual_url                 TEXT,
  local_image_path           TEXT,
  screenshot_path            TEXT,
  full_page_screenshot_path  TEXT,
  cropped_visual_path        TEXT,
  crop_method                TEXT,
  capture_method             TEXT,
  page_number                INTEGER,
  caption_or_nearby_text     TEXT,
  what_it_shows              TEXT,
  why_it_is_relevant         TEXT,
  supports_evidence_ids      JSONB,
  visual_claim               TEXT,
  image_hash                 TEXT,
  taxonomy_context           JSONB,
  visual_quality             JSONB,
  usage                      JSONB,
  visual_usefulness          JSONB,
  slide_suitability          JSONB,
  table_data                 JSONB,
  validation_status          TEXT,
  qa_status                  TEXT,
  duplicate_cluster_id       TEXT,
  is_cluster_representative   BOOLEAN,
  duplicate_reason           TEXT,
  manual_review_required      BOOLEAN,
  rejection_reason           TEXT,
  created_at                 TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS web_evidence_failures (
  failure_id                 TEXT PRIMARY KEY,
  snapshot_id                TEXT,
  provider                   TEXT,
  query                      TEXT,
  failed_url                 TEXT,
  failure_reason             TEXT,
  retry_attempted            BOOLEAN,
  fallback_used              TEXT,
  created_at                 TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wei_category    ON web_evidence_items (category);
CREATE INDEX IF NOT EXISTS idx_wei_depth       ON web_evidence_items (evidence_depth);
CREATE INDEX IF NOT EXISTS idx_wei_snapshot    ON web_evidence_items (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_wei_cluster     ON web_evidence_items (duplicate_cluster_id);
CREATE INDEX IF NOT EXISTS idx_wve_category    ON web_visual_evidence (category);
CREATE INDEX IF NOT EXISTS idx_wve_snapshot    ON web_visual_evidence (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_wve_cluster     ON web_visual_evidence (duplicate_cluster_id);
CREATE INDEX IF NOT EXISTS idx_wef_snapshot    ON web_evidence_failures (snapshot_id);

COMMENT ON TABLE web_evidence_items IS 'Layer 5C web evidence (accepted + rejected + manual_review) for analysis + audit.';
COMMENT ON TABLE web_visual_evidence IS 'Layer 5C visual evidence with usefulness + slide-suitability decisions.';
