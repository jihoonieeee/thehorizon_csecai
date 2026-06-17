-- Migration 003: Evidence potential, source routing, and content status
-- Part of validation-v1.3 Layer 3 redesign.
-- Adds pre-extraction intelligence quality fields to the sources table.

-- evidence_potential: pre-extraction estimate of how useful this source will be
ALTER TABLE sources ADD COLUMN IF NOT EXISTS evidence_potential text;
COMMENT ON COLUMN sources.evidence_potential IS
  'Pre-extraction estimate: primary_evidence_candidate | supporting_evidence_candidate | context_only | analytics_only | archive_only';

-- source_usefulness_roles: which downstream pipeline roles this source can serve
ALTER TABLE sources ADD COLUMN IF NOT EXISTS source_usefulness_roles text[];
COMMENT ON COLUMN sources.source_usefulness_roles IS
  'Array: factual_claim_support | trend_support | adoption_support | case_study_support | recommendation_input | outlook_input | chart_input | context_only';

-- source_route: richer replacement for downstream_route
ALTER TABLE sources ADD COLUMN IF NOT EXISTS source_route text;
COMMENT ON COLUMN sources.source_route IS
  'layer4_evidence | layer4_context | layer4_review | analytics_only | archive | discard';

-- route_reason_codes: machine-readable codes explaining the routing decision
ALTER TABLE sources ADD COLUMN IF NOT EXISTS route_reason_codes text[];
COMMENT ON COLUMN sources.route_reason_codes IS
  'Array of reason codes explaining why this source was routed as it was';

-- source_content_status: how much usable content was actually fetched
ALTER TABLE sources ADD COLUMN IF NOT EXISTS source_content_status text;
COMMENT ON COLUMN sources.source_content_status IS
  'fetched_full_text | fetched_summary | thin_structured | paywall_stub | pdf_pending | repo_pending | unavailable';

-- processing_cache_status: whether this source needs reprocessing
ALTER TABLE sources ADD COLUMN IF NOT EXISTS processing_cache_status text;
COMMENT ON COLUMN sources.processing_cache_status IS
  'fresh | cached | reprocess_needed | no_hash';

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_sources_evidence_potential    ON sources (evidence_potential);
CREATE INDEX IF NOT EXISTS idx_sources_source_route          ON sources (source_route);
CREATE INDEX IF NOT EXISTS idx_sources_source_content_status ON sources (source_content_status);
