/**
 * Web Discovery — Accepted Candidate → Pipeline Source
 *
 * Converts an accepted discovery candidate into a normal pipeline source (via
 * normalizeSource) so it flows through Layer 2/3 exactly like a feed source —
 * while carrying its full discovery provenance forward for persistence and audit.
 *
 * Only accept / accept_with_review candidates should be passed here; archive_only
 * and reject candidates are stored for audit but never become pipeline sources.
 */

import { normalizeSource } from "../ingest/normalizeSource.js";
import { buildDiscoveryMetadata } from "./normalizeCandidate.js";

/**
 * @param {object} candidate  an accepted discovery candidate
 * @returns {object} a normalized pipeline source with web-discovery fields attached
 */
export function candidateToSource(candidate) {
  const now = new Date().toISOString();

  // event_date is the real-world event; published_date is the page date. The
  // pipeline window filter keys off date_published, so we set it to the page
  // date when known, else discovery time (so a fresh discovery is not dropped),
  // and carry the true page/event dates as actuals.
  const pageDate = candidate.published_date || null;

  const base = normalizeSource({
    title: candidate.title || candidate.opened_url,
    url: candidate.opened_url,
    publisher: candidate.publisher || "Unknown",
    author: candidate.author || "",
    date_published: pageDate || now,
    date_published_actual: pageDate,
    date_discovered: now,
    date_confidence: pageDate ? "estimated" : "low",
    source_type: candidate.source_type_hint && candidate.source_type_hint !== "unknown"
      ? candidate.source_type_hint : "unknown",
    // Prefer the full extracted/fetched page body; fall back to the quote so a
    // source is never reduced to an empty body when richer text is available.
    full_text: candidate.page_text || candidate.verbatim_quote || "",
    summary: candidate.summary || candidate.candidate_claim || "",
    trust_tier: candidate.trust_tier_hint || "unknown",
    collection_metadata: {
      connector_name: "Web Discovery",
      retrieval_method: "web_discovery",
      trust_tier: candidate.trust_tier_hint || "unknown",
      discovery_mission: candidate.discovery_mission,
      search_query: candidate.search_query,
      collected_at: now,
      web_discovery: buildDiscoveryMetadata(candidate),
    },
  });

  // Attach top-level discovery fields so Layer 3 archiving (buildSourceRow) can
  // persist them without digging into collection_metadata.
  return {
    ...base,
    source_origin: "web_discovery",
    discovery_mission: candidate.discovery_mission,
    search_query: candidate.search_query,
    opened_url: candidate.opened_url,
    candidate_claim: candidate.candidate_claim,
    verbatim_quote: candidate.verbatim_quote,
    quote_status: candidate.quote_status,
    quote_verified: candidate.quote_verified,
    quote_claim_match_status: candidate.quote_claim_match_status,
    freshness_status: candidate.freshness_status,
    freshness_interpretation: candidate.freshness_interpretation,
    novelty_assessment: candidate.novelty_assessment,
    operationalization_stage: candidate.operationalization_stage,
    early_signal_value: candidate.early_signal_value,
    early_signal_type: candidate.early_signal_type,
    early_signal_qa_status: candidate.early_signal_qa_status,
    corroboration_status: candidate.corroboration_status,
    source_independence_status: candidate.source_independence_status,
    hallucination_risk: candidate.hallucination_risk,
    discovery_route: candidate.route,
    manual_review_required: candidate.manual_review_required || candidate.route === "accept_with_review",
    web_discovery_metadata: buildDiscoveryMetadata(candidate),
    needs_review: candidate.route === "accept_with_review",

    // ── L1C triage enrichments (carried forward for archiving and L3 context) ─
    quote_support:             candidate.quote_support             || null,
    requires_entailment_qa:    candidate.requires_entailment_qa   ?? false,
    freshness_class:           candidate.freshness_class           || null,
    evidence_novelty:          candidate.evidence_novelty          || null,
    defensive_content_type:    candidate.defensive_content_type    || null,
    candidate_route_reasons:   candidate.candidate_route_reasons   || [],
    candidate_usefulness_roles: candidate.candidate_usefulness_roles || [],
    candidate_origin_cluster_id: candidate.candidate_origin_cluster_id || null,
    processing_cache_status:   candidate.processing_cache_status   || "new",
    relevance_path:            candidate.relevance_path            || null,
    origin_role:               candidate.origin_role               || null,
    primary_origin_url:        candidate.primary_origin_url        || null,
    cited_sources:             candidate.cited_sources             || [],
    independence_level:        candidate.independence_level        || null,
  };
}

export function candidatesToSources(candidates = []) {
  return candidates.map(candidateToSource);
}
