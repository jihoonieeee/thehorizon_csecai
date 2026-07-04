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

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
const pad2 = (n) => String(n).padStart(2, "0");

/**
 * Infer a real publication/event date for a discovery candidate, so the source
 * lands in the correct reporting window instead of defaulting to "today".
 * Tries, in order: explicit candidate dates → ISO date in title/text → a
 * YYYY/MM[/DD] segment in the URL path → a "Month YYYY" mention. Returns an
 * ISO date string (YYYY-MM-DD) or null when nothing reliable is found.
 */
export function inferCandidateDate(candidate) {
  const url = candidate.opened_url || "";

  // 1. An explicit publish/event date from the provider is most authoritative.
  //    last_updated is a MODIFICATION time, not a publish date, so it is only a
  //    weak last-resort fallback (below), never preferred over structural signals.
  const explicit = candidate.published_date || candidate.event_date;
  if (explicit) return explicit;

  // 2. YYYY/MM[/DD] segment in the URL path (common on news/blog permalinks).
  //    This is the article's own canonical date and is preferred over any date
  //    that merely appears in the body text (which may be a referenced incident
  //    date, a "last updated" line, or an unrelated date).
  let m = url.match(/\/(20\d{2})\/(\d{1,2})(?:\/(\d{1,2}))?(?:\/|$|\?)/);
  if (m && +m[2] <= 12) return `${m[1]}-${pad2(m[2])}-${pad2(m[3] || 1)}`;

  // 3. ISO date in the title/first 400 chars of body.
  const hay = `${candidate.title || ""}  ${(candidate.page_text || candidate.summary || "").slice(0, 400)}`;
  m = hay.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // 4. "Month YYYY" (e.g. "March 2026", "Mar. 2026") in title/body.
  m = hay.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d{2})\b/i);
  if (m) return `${m[2]}-${pad2(MONTHS[m[1].slice(0, 3).toLowerCase()])}-01`;

  // 5. Weak last resort: a provider-supplied modification time, better than
  //    defaulting to collection time. The caller marks this "estimated"/"low".
  if (candidate.last_updated) return candidate.last_updated;

  return null;
}

/**
 * @param {object} candidate  an accepted discovery candidate
 * @returns {object} a normalized pipeline source with web-discovery fields attached
 */
export function candidateToSource(candidate) {
  const now = new Date().toISOString();

  // The window filter keys off date_published. Priority:
  //   html_date (exact HTML metadata or LLM text scan) → inferCandidateDate
  //   (URL pattern / ISO in title+body / Month YYYY) → fallback to now.
  // date_confidence tracks how authoritative the date is:
  //   "exact"     — from machine-readable HTML metadata (article:published_time etc.)
  //   "inferred"  — LLM found an explicit date mention in the text
  //   "estimated" — URL pattern or ISO date heuristic
  //   "low"       — no date signal at all; date_published defaults to collection time
  let pageDate;
  let dateConfidence;
  if (candidate.html_date) {
    pageDate       = candidate.html_date;
    dateConfidence = candidate.html_date_confidence || "exact";
  } else {
    pageDate       = inferCandidateDate(candidate);
    dateConfidence = pageDate ? "estimated" : "low";
  }

  const base = normalizeSource({
    title: candidate.title || candidate.opened_url,
    url: candidate.opened_url,
    publisher: candidate.publisher || "Unknown",
    author: candidate.author || "",
    date_published: pageDate || now,
    date_published_actual: pageDate,
    date_discovered: now,
    date_confidence: dateConfidence,
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
    html_date_source: candidate.html_date_source || null,
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
