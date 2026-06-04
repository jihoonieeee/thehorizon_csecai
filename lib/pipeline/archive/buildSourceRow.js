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
  const v = source.validation || {};

  return {
    id:            source.id,
    snapshot_id:   snapshotId,

    // ── Identity ───────────────────────────────────────────────────────────────
    title:         source.title,
    url:           v.final_url || source.url,
    original_url:  source.original_url  || source.url,
    canonical_url: source.canonical_url || source.url,
    final_url:     v.final_url || source.final_url || source.url,
    publisher:     source.publisher,
    author:        source.author || "",

    // ── Dates ─────────────────────────────────────────────────────────────────
    date_published: source.date_published,
    date_published_actual: source.date_published_actual !== undefined
      ? source.date_published_actual
      : source.date_published,
    date_discovered: source.date_discovered || null,
    date_confidence: source.date_confidence || "exact",

    // ── Source typing (Layer 1 initial; Layer 5 LLM may override) ─────────────
    source_type: source.source_type,
    trust_tier:  source.trust_tier || "unknown",
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
    url_safety_status:  v.url_safety_status  || "unknown",
    validation_flags:   v.validation_flags   || [],
    layer2_status:      v.is_valid           ? "valid" : "invalid",

    // Rule-based relevance scores from Layer 2.
    // Layer 5 LLM classification may update ai_specificity_score with a more
    // accurate value, but these provide a fast initial signal.
    ai_relevance_score:   v.ai_relevance_score   ?? null,
    ai_specificity_score: v.ai_specificity_score ?? null,
    relevance_tier:       v.relevance_tier        || null,

    // ── Layer 1 eligibility flags ─────────────────────────────────────────────
    eligible_for_daily_report:      source.eligible_for_daily_report      ?? false,
    eligible_for_weekly_report:     source.eligible_for_weekly_report     ?? false,
    eligible_for_monthly_report:    source.eligible_for_monthly_report    ?? false,
    eligible_for_horizon_scan:      source.eligible_for_horizon_scan      ?? false,
    eligible_for_archive:           source.eligible_for_archive           ?? true,
    eligible_for_trend_analysis:    source.eligible_for_trend_analysis    ?? false,
    eligible_for_reference_context: source.eligible_for_reference_context ?? false,
    needs_review:                   source.needs_review                   ?? false,

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
    taxonomy_validation_status: source.taxonomy_validation_status || null,
    taxonomy_validation_reasons: source.taxonomy_validation_reasons || null,

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
