/**
 * Layer 3 — Source Row Builder
 *
 * Maps a validated source (with Layer 2 `.validation` attached) to a
 * Supabase `sources` row.
 *
 * Ownership rules:
 *   - Layer 3 writes identity, content, provenance, validity, and eligibility fields.
 *   - Classification-owned fields (main_category, layer3_status, intelligence, etc.)
 *     are intentionally absent — they are set by later layers and must never be
 *     overwritten by a re-archive run.
 */

export const ARCHIVE_VERSION = "archive-v3.0";

export function buildSourceRow(source, snapshotId) {
  // validateAndTypeSource returns URL fields directly on the source object —
  // they are never nested under source.validation. Fall back to source.url
  // only when URL resolution has not run yet (e.g. skipLlm=true paths).
  const resolvedUrl   = source.final_url   || source.url;
  const urlSafety     = source.url_safety_status || "unknown";
  const urlReachable  = source.url_reachable ?? null;

  return {
    id:            source.id,
    snapshot_id:   snapshotId,

    // ── Identity ───────────────────────────────────────────────────────────────
    title:         source.title,
    url:           resolvedUrl,
    original_url:  source.original_url  || source.url,
    canonical_url: source.canonical_url || source.url,
    final_url:     resolvedUrl,
    display_url:   source.display_url   || resolvedUrl,
    publisher:     source.publisher,
    author:        source.author || "",

    // ── Dates ─────────────────────────────────────────────────────────────────
    date_published: source.date_published,
    date_published_actual: source.date_published_actual !== undefined
      ? source.date_published_actual
      : source.date_published,
    date_discovered: source.date_discovered || null,
    date_confidence: source.date_confidence || "exact",

    // ── Source typing ─────────────────────────────────────────────────────────
    source_type: source.source_type,
    trust_tier:  source.trust_tier || "unknown",

    // ── Source context & reliability annotation (Layer 3.4) ───────────────────
    publisher_class:        source.publisher_class        || null,
    evidence_role:          source.evidence_role          || null,
    independence_level:     source.independence_level     || null,
    verification_status:    source.verification_status    || null,
    evidence_strength_hint: source.evidence_strength_hint || null,
    reliability_notes:      source.reliability_notes      || [],
    is_curated:  source.is_curated  ?? false,
    curated_metadata: source.curated_metadata || null,

    // ── Content ───────────────────────────────────────────────────────────────
    full_text:  source.full_text  || "",
    summary:    source.summary    || "",
    raw_text:   source.raw_text   || source.full_text || "",
    clean_text: source.clean_text || source.full_text || "",
    raw_html:   source.raw_html   || "",

    extracted_code_blocks: source.extracted_code_blocks || [],
    extracted_iocs:        source.extracted_iocs        || {},
    cleaning_version:      source.cleaning_version      || null,

    // ── Hashes ────────────────────────────────────────────────────────────────
    content_hash:    source.content_hash    || null,
    clean_text_hash: source.clean_text_hash || null,

    // ── Layer 1 initial tags ──────────────────────────────────────────────────
    tags: source.tags || [],

    // ── Layer 2 validity outputs ──────────────────────────────────────────────
    url_safety_status:  urlSafety,
    url_reachable:      urlReachable,
    validation_flags:   source.filter_flags  || [],
    layer2_status:      source.is_valid      ? "valid" : "invalid",

    // Rule-based relevance scores from Layer 2/3 (set directly on source by validateAndTypeSource).
    ai_relevance_score:   source.ai_relevance_score   ?? null,
    ai_specificity_score: source.ai_specificity_score ?? null,
    relevance_tier:       source.relevance_tier        || null,

    // ── Layer 1 eligibility flags ─────────────────────────────────────────────
    eligible_for_weekly_report:     source.eligible_for_weekly_report     ?? false,
    eligible_for_monthly_report:    source.eligible_for_monthly_report    ?? false,
    eligible_for_quarterly_report:  source.eligible_for_quarterly_report  ?? false,
    eligible_for_horizon_scan:      source.eligible_for_horizon_scan      ?? false,
    eligible_for_archive:           source.eligible_for_archive           ?? true,
    eligible_for_trend_analysis:    source.eligible_for_trend_analysis    ?? false,
    eligible_for_reference_context: source.eligible_for_reference_context ?? false,
    needs_review:                   source.needs_review                   ?? false,

    // Immutable period-label keys — derived from date_published at ingest time.
    // Use these to query sources for any past period without re-running flags.
    report_period_week:    source.report_period_week    ?? null,
    report_period_month:   source.report_period_month   ?? null,
    report_period_quarter: source.report_period_quarter ?? null,

    // ── Web-discovery provenance (set by Layer 1B/1C; null for feed sources) ──
    source_origin:              source.source_origin || "fixed_feed",
    discovery_mission:          source.discovery_mission || null,
    search_query:               source.search_query || null,
    opened_url:                 source.opened_url || null,
    candidate_claim:            source.candidate_claim || null,
    verbatim_quote:             source.verbatim_quote || null,
    quote_status:               source.quote_status || null,
    quote_verified:             source.quote_verified ?? null,
    quote_claim_match_status:   source.quote_claim_match_status || null,
    freshness_status:           source.freshness_status || null,
    freshness_interpretation:   source.freshness_interpretation || null,
    novelty_assessment:         source.novelty_assessment || null,
    operationalization_stage:   source.operationalization_stage || null,
    early_signal_value:         source.early_signal_value || null,
    early_signal_type:          source.early_signal_type || null,
    early_signal_qa_status:     source.early_signal_qa_status || null,
    corroboration_status:       source.corroboration_status || null,
    source_independence_status: source.source_independence_status || null,
    hallucination_risk:         source.hallucination_risk || null,
    discovery_route:            source.discovery_route || null,
    web_discovery_metadata:     source.web_discovery_metadata || null,

    // ── Taxonomy v9 fields (set by Layer 4; preserved on re-archive) ─────────
    primary_domain:   source.primary_domain   || null,
    primary_tags:     source.primary_tags     || null,
    sub_techniques:   source.sub_techniques   || null,
    ai_enabled:       source.ai_enabled       ?? false,
    ai_enabled_roles: source.ai_enabled_roles || null,
    ai_capabilities:  source.ai_capabilities  || null,
    automation_level: source.automation_level || null,
    autonomy_level:   source.autonomy_level   || null,
    taxonomy_version: source.taxonomy_version || null,
    taxonomy_validation_status:  source.taxonomy_validation_status  || null,
    taxonomy_validation_reasons: source.taxonomy_validation_reasons || null,

    // ── Source quality + origin tracking (audit refactor) ────────────────────
    source_quality_status:  source.source_quality_status  || null,
    source_quality_reasons: source.source_quality_reasons || null,
    origin_role:            source.origin_role            || null,
    independence_level:     source.independence_level     || null,
    primary_origin_url:     source.primary_origin_url     || null,
    cited_sources:          source.cited_sources          || null,
    relevance_path:         source.relevance_path         || null,
    taxonomy_status:        source.taxonomy_validation_status || source.taxonomy_status || null,

    // ── Web-discovery triage fields (L1C; set on web-origin sources) ─────────
    freshness_class:          source.freshness_class          || null,
    quote_support:            source.quote_support            || null,
    requires_entailment_qa:   source.requires_entailment_qa  ?? null,
    evidence_novelty:         source.evidence_novelty         || null,
    defensive_content_type:   source.defensive_content_type   || null,
    candidate_route_reasons:  source.candidate_route_reasons  || null,
    candidate_usefulness_roles: source.candidate_usefulness_roles || null,
    candidate_origin_cluster_id: source.candidate_origin_cluster_id || null,

    // ── Evidence potential + source routing (v1.3) ───────────────────────────
    evidence_potential:      source.evidence_potential      || null,
    source_usefulness_roles: source.source_usefulness_roles || null,
    source_route:            source.source_route            || null,
    route_reason_codes:      source.route_reason_codes      || null,
    source_content_status:   source.source_content_status   || null,
    processing_cache_status: source.processing_cache_status || null,

    // ── Version stamps ────────────────────────────────────────────────────────
    archive_version: ARCHIVE_VERSION,
  };
}

export function buildSnapshotRecord(source, snapshotId, capturedAt) {
  return {
    source_id:    source.id,
    snapshot_id:  snapshotId,
    captured_at:  capturedAt,
    content_hash: source.content_hash,
    clean_text_hash: source.clean_text_hash || null,

    raw_text:   source.raw_text   || source.full_text || "",
    clean_text: source.clean_text || source.full_text || "",
    raw_html:   source.raw_html   || "",

    cleaning_version:      source.cleaning_version      || null,
    extracted_code_blocks: source.extracted_code_blocks || [],
    extracted_iocs:        source.extracted_iocs        || {},
  };
}
