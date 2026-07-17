/**
 * Web Discovery — Candidate Source Normalization (Layer 1B → 1C)
 *
 * Turns a raw candidate (from the web-search tool) into the canonical candidate
 * object, filling in all DETERMINISTIC gate fields (opened-URL confirmation,
 * quote status, quote–claim match, freshness, AI-threat anchors, entities).
 *
 * Cheap-LLM fields (semantic ai_threat_specificity, novelty_assessment,
 * operationalization_stage, early_signal_type, taxonomy hint) are left at their
 * deterministic floor/defaults here and refined later in triageCandidates.js.
 *
 * The output is NOT yet a pipeline source — it becomes one (via normalizeSource)
 * only after triage routes it to accept.
 */

import { randomUUID } from "crypto";
import {
  VALID_SOURCE_CLASSES, VALID_SOURCE_QUALITY,
} from "../../config/webDiscoveryVocab.js";
import {
  openedUrlConfirmed, classifyQuoteStatus, quoteClaimMatch, quoteSupport,
  assessFreshness, detectAiThreatAnchors, extractEntities,
  normalizeUrlForGrounding, extractOriginCitations, computeCandidateHashes,
} from "./candidateGates.js";

// Map a publisher/domain to a coarse trust tier hint + source quality.
// Deterministic; mirrors the source registry tiers used elsewhere.
const PRIMARY_DOMAINS = ["cisa.gov", "ncsc.gov.uk", "csa.gov.sg", "nist.gov", "anthropic.com", "openai.com", "atlas.mitre.org", "owasp.org", "nvd.nist.gov", "enisa.europa.eu", "cyber.gov.au"];
const HIGH_DOMAINS    = ["arxiv.org", "usenix.org", "ieee.org", "acm.org", "google.com", "microsoft.com", "googleblog.com", "paloaltonetworks.com", "checkpoint.com", "mandiant.com", "crowdstrike.com", "trailofbits.com", "hiddenlayer.com", "wiz.io"];
const MEDIUM_DOMAINS  = ["bleepingcomputer.com", "thehackernews.com", "securityweek.com", "darkreading.com", "therecord.media", "wired.com", "arstechnica.com"];

function hostOf(url = "") {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}

function domainTrust(url) {
  const host = hostOf(url);
  if (PRIMARY_DOMAINS.some((d) => host.endsWith(d))) return { trust_tier_hint: "primary", source_quality: "primary" };
  if (HIGH_DOMAINS.some((d) => host.endsWith(d)))    return { trust_tier_hint: "high",    source_quality: "high" };
  if (MEDIUM_DOMAINS.some((d) => host.endsWith(d)))  return { trust_tier_hint: "medium",  source_quality: "medium" };
  return { trust_tier_hint: "unknown", source_quality: "low" };
}

// Coarse deterministic source-class inference from URL + hints.
function inferSourceClass(url, hint) {
  if (hint && VALID_SOURCE_CLASSES.has(hint)) return hint;
  const host = hostOf(url);
  if (host.endsWith("arxiv.org")) return "research_paper";
  if (host.endsWith("github.com") || host.endsWith("gitlab.com")) return "github_poc";
  if (host.endsWith("nvd.nist.gov") || /\/advisories?\//i.test(url)) return "vulnerability_database";
  if (host.endsWith("huggingface.co") || host.endsWith("paperswithcode.com")) return "benchmark_dataset";
  if (PRIMARY_DOMAINS.some((d) => host.endsWith(d)) && /gov/.test(host)) return "government_advisory";
  if (host.endsWith("owasp.org") || host.endsWith("nist.gov") || host.endsWith("atlas.mitre.org")) return "standards_or_framework";
  if (host.endsWith("usenix.org") || host.endsWith("ieee.org") || host.endsWith("acm.org")) return "conference_paper";
  if (MEDIUM_DOMAINS.some((d) => host.endsWith(d))) return "news_report";
  if (HIGH_DOMAINS.some((d) => host.endsWith(d))) return "vendor_research";
  return "unknown";
}

/**
 * Normalize a raw candidate from the search tool.
 *
 * @param {object} raw       raw candidate fields from the LLM/search step
 * @param {object} ctx       { mission, search_query, search_query_family, groundedUrlSet, now }
 * @returns {object|null}    canonical candidate, or null if structurally unusable
 */
export function normalizeCandidate(raw, ctx = {}) {
  if (!raw || typeof raw !== "object") return null;

  const url = (raw.opened_url || raw.url || "").trim();
  if (!url) return null;

  const title = (raw.title || "").trim();
  const candidate_claim = (raw.candidate_claim || raw.claim || "").trim();
  const verbatim_quote  = (raw.verbatim_quote || raw.quote || "").trim();

  const { mission, search_query, search_query_family, groundedUrlSet, now } = ctx;

  const opened_url_confirmed = openedUrlConfirmed(url, groundedUrlSet);

  const source_class = inferSourceClass(url, raw.source_class || raw.source_class_hint);
  const { trust_tier_hint, source_quality: domainQuality } = domainTrust(url);
  const source_quality = VALID_SOURCE_QUALITY.has(raw.source_quality) ? raw.source_quality : domainQuality;

  const anchorText = `${title} ${candidate_claim} ${verbatim_quote} ${raw.summary || ""}`;
  const { anchors, specificity_floor } = detectAiThreatAnchors(anchorText);

  const quote_status = classifyQuoteStatus({ verbatim_quote, opened_url: url, source_class, fetch_pending: raw.fetch_pending === true });
  const quote_verified = quote_status === "present" && opened_url_confirmed &&
    isQuoteGrounded(verbatim_quote, ctx.groundedQuotes);
  const quote_claim_match_status = quote_status === "present"
    ? quoteClaimMatch(candidate_claim, verbatim_quote)
    : "unverified";
  // Quote support: mechanical location check + co_occurrence hint.
  // quote_support values: "unverified" | "unsupported" | "requires_entailment_qa" | "lexically_matched"
  // requires_entailment_qa=true: LLM must confirm semantic support (triage step).
  // "unsupported" (<0.3 overlap) is the only fast rejection; all other present-quote
  // cases need LLM entailment confirmation.
  const qSupport = quote_status === "present"
    ? quoteSupport(candidate_claim, verbatim_quote)
    : { quote_support: "unverified", requires_entailment_qa: false, co_occurrence_ratio: 0 };

  const freshness = assessFreshness({
    published_date: raw.published_date,
    event_date:     raw.event_date,
    last_updated:   raw.last_updated,
    source_class,
    now,
  });

  // Origin citation extraction (deterministic)
  const originInfo = extractOriginCitations({
    title: (raw.title || "").trim(),
    candidate_claim,
    verbatim_quote,
    summary: (raw.summary || "").trim(),
    publisher: (raw.publisher || "").trim(),
    source_class,
  });

  const entities = extractEntities(anchorText);

  // hallucination_risk: deterministic floor. Not opened → high. Opened but no
  // grounded quote and no anchors → medium. Otherwise low. (LLM may not lower it.)
  let hallucination_risk = "low";
  if (!opened_url_confirmed) hallucination_risk = "high";
  else if (!quote_verified && anchors.length === 0) hallucination_risk = "medium";

  const normalized = {
    // provenance
    source_origin: "web_discovery",
    discovery_mission: mission || null,
    search_query: search_query || null,
    search_query_family: search_query_family || null,
    opened_url: url,
    opened_url_confirmed,
    source_class,
    provider: raw.provider || null,
    fetch_pending: raw.fetch_pending === true,

    // identity
    title,
    publisher: (raw.publisher || hostOf(url) || "Unknown").trim(),
    author: (raw.author || "").trim(),
    published_date: raw.published_date || null,
    event_date: raw.event_date || null,
    last_updated: raw.last_updated || null,

    // claim + evidence
    candidate_claim,
    verbatim_quote,
    quote_status,
    quote_verified,
    quote_claim_match_status,              // legacy: match/partial/mismatch/unverified
    quote_support: qSupport.quote_support, // unverified | unsupported | requires_entailment_qa | lexically_matched
    requires_entailment_qa: qSupport.requires_entailment_qa,
    quote_co_occurrence_ratio: qSupport.co_occurrence_ratio, // informational only — not a semantic verdict
    // Full extracted page body when the provider supplied it (Tavily). Used as
    // full_text downstream so accepted sources carry real text, not just a quote.
    page_text: (raw.page_text || "").trim(),
    summary: (raw.summary || "").trim().slice(0, 600),

    // categorical states — deterministic floors (LLM refines in triage)
    source_type_hint: raw.source_type_hint || "unknown",
    trust_tier_hint,
    source_quality,
    freshness_status:        freshness.freshness_status,
    freshness_class:         freshness.freshness_class,
    freshness_interpretation: freshness.freshness_interpretation,
    age_days:                freshness.age_days,
    ai_threat_specificity:   specificity_floor,   // floor; triage may raise
    ai_threat_anchors:       anchors,
    novelty_assessment:      "unknown",
    operationalization_stage:"unknown",
    corroboration_status:    "single_source",
    source_independence_status: "unknown",
    hallucination_risk,

    // origin + independence (deterministic extraction)
    origin_role:          originInfo.origin_role,
    primary_origin_url:   originInfo.primary_origin_url,
    cited_sources:        originInfo.cited_sources,
    independence_level:   originInfo.independence_level,

    // evidence novelty + defensive content (defaults; refined by LLM triage)
    evidence_novelty:        "unknown",
    defensive_content_type:  "unknown",

    // candidate usefulness (defaults; refined by triage)
    candidate_usefulness_roles: [],

    // relevance path (refined by triage)
    relevance_path: null,

    // early signal — filled by triage after stage/novelty are known
    early_signal_value:     "none",
    early_signal_type:      "none",
    early_signal_reason:    null,
    needs_early_signal_qa:  false,
    early_signal_qa_status: "not_required",

    // dedup — filled by dedupeCandidates
    duplicate_cluster_id:      null,
    candidate_origin_cluster_id: null,  // clusters candidates sharing the same primary origin
    is_cluster_representative: true,
    duplicate_reason:          null,
    original_source_url:       null,
    derivative_sources:        [],

    // routing — filled by triage
    route:                  null,
    route_reason:           null,
    candidate_route_reasons: [],
    rejection_reason:       null,

    // entities + taxonomy hint
    entities,
    taxonomy_hint: null,

    // a stable id for audit storage
    candidate_id: raw.candidate_id || `wd_${randomUUID().slice(0, 12)}`,
  };

  // Compute stable hashes and attach after the main object is built
  const hashes = computeCandidateHashes({
    opened_url:          url,
    verbatim_quote,
    candidate_claim,
    title:               (raw.title || "").trim(),
    primary_origin_url:  originInfo.primary_origin_url,
    original_source_url: null,
  });
  Object.assign(normalized, hashes, {
    processing_cache_status: "new",  // overwritten by dedupeCandidates when seen before
  });

  return normalized;
}

// Check whether a quote appears among the grounded cited_text spans (loose).
function isQuoteGrounded(quote, groundedQuotes) {
  if (!quote || !Array.isArray(groundedQuotes) || groundedQuotes.length === 0) return false;
  const q = quote.toLowerCase().slice(0, 60);
  return groundedQuotes.some((g) => (g || "").toLowerCase().includes(q.slice(0, 30)));
}

/**
 * Build the candidate's web_discovery_metadata bag for archival. Keeps the full
 * search provenance + validation results so rejected candidates remain auditable.
 */
export function buildDiscoveryMetadata(candidate) {
  return {
    // provenance
    discovery_mission:        candidate.discovery_mission,
    search_query:             candidate.search_query,
    search_query_family:      candidate.search_query_family,
    opened_url:               candidate.opened_url,
    opened_url_confirmed:     candidate.opened_url_confirmed,
    source_class:             candidate.source_class,

    // claim + evidence
    candidate_claim:          candidate.candidate_claim,
    verbatim_quote:           candidate.verbatim_quote,
    quote_status:             candidate.quote_status,
    quote_verified:           candidate.quote_verified,
    quote_claim_match_status: candidate.quote_claim_match_status,
    quote_support:            candidate.quote_support,
    requires_entailment_qa:   candidate.requires_entailment_qa,

    // freshness
    freshness_status:         candidate.freshness_status,
    freshness_class:          candidate.freshness_class,
    freshness_interpretation: candidate.freshness_interpretation,
    age_days:                 candidate.age_days,

    // AI-threat signal
    ai_threat_specificity:    candidate.ai_threat_specificity,
    ai_threat_anchors:        candidate.ai_threat_anchors,
    novelty_assessment:       candidate.novelty_assessment,
    operationalization_stage: candidate.operationalization_stage,
    relevance_path:           candidate.relevance_path,

    // early signal
    early_signal_value:       candidate.early_signal_value,
    early_signal_type:        candidate.early_signal_type,
    early_signal_reason:      candidate.early_signal_reason,
    early_signal_qa_status:   candidate.early_signal_qa_status,

    // origin + independence
    origin_role:              candidate.origin_role,
    primary_origin_url:       candidate.primary_origin_url,
    cited_sources:            candidate.cited_sources,
    independence_level:       candidate.independence_level,
    candidate_origin_cluster_id: candidate.candidate_origin_cluster_id,

    // evidence novelty + defensive content
    evidence_novelty:         candidate.evidence_novelty,
    defensive_content_type:   candidate.defensive_content_type,

    // usefulness + routing
    candidate_usefulness_roles: candidate.candidate_usefulness_roles,
    corroboration_status:     candidate.corroboration_status,
    source_independence_status: candidate.source_independence_status,
    hallucination_risk:       candidate.hallucination_risk,

    // dedup
    duplicate_cluster_id:     candidate.duplicate_cluster_id,
    is_cluster_representative: candidate.is_cluster_representative,
    duplicate_reason:         candidate.duplicate_reason,
    original_source_url:      candidate.original_source_url,

    // routing
    route:                    candidate.route,
    route_reason:             candidate.route_reason,
    candidate_route_reasons:  candidate.candidate_route_reasons,
    rejection_reason:         candidate.rejection_reason,

    // caching hashes
    canonical_url_hash:       candidate.canonical_url_hash,
    content_hash:             candidate.content_hash,
    quote_hash:               candidate.quote_hash,
    claim_hash:               candidate.claim_hash,
    primary_origin_hash:      candidate.primary_origin_hash,
    processing_cache_status:  candidate.processing_cache_status,

    // entities + taxonomy
    entities:                 candidate.entities?.all || [],
    taxonomy_hint:            candidate.taxonomy_hint,
  };
}
