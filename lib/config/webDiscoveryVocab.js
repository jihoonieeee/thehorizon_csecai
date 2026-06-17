/**
 * Web Discovery — Controlled Vocabularies (Layer 1B/1C)
 *
 * These are the categorical evidence states used by the web-discovery branch.
 * The design principle is: NO arbitrary numeric scoring. Every judgement is a
 * named categorical state with an explicit decision rule (see candidateGates.js
 * and earlySignal.js). Numbers appear only where they are purely mechanical
 * (e.g. day counts for freshness) and are always explained.
 *
 * Every Set here is the single source of truth for what values are legal in the
 * candidate object, the DB columns, and the analytics aggregations.
 */

// ── Discovery missions ──────────────────────────────────────────────────────
// Explicit, controlled mission IDs. Each maps to a search intent (see
// discoveryMissions.js for the query families and source-class targets).

export const DISCOVERY_MISSIONS = [
  "fresh_attack_modes",
  "new_actor_adoption",
  "new_vulnerability_or_exploit",
  "new_agentic_attack_surface",
  "new_tool_or_mcp_abuse",
  "new_ai_enabled_cybercrime",
  "new_benchmark_or_dataset",
  "new_incident_or_case_study",
  "new_defensive_bypass",
  "new_statistics_or_trend_data",
  "new_ai_supply_chain_compromise",
  "new_vector_rag_weakness",
];
export const VALID_DISCOVERY_MISSIONS = new Set(DISCOVERY_MISSIONS);

// ── Source classes ──────────────────────────────────────────────────────────
// What KIND of source a candidate is. Used for source-class quotas so that news
// summaries do not dominate the discovered corpus.

export const SOURCE_CLASSES = [
  "research_paper",
  "vendor_research",
  "government_advisory",
  "vulnerability_database",
  "github_poc",
  "incident_writeup",
  "benchmark_dataset",
  "technical_blog",
  "conference_paper",
  "standards_or_framework",
  "news_report",
  "unknown",
];
export const VALID_SOURCE_CLASSES = new Set(SOURCE_CLASSES);

// Per-mission per-source-class caps. Keeps news from dominating; favours
// primary/technical material. `default` applies to any class not listed.
export const SOURCE_CLASS_CAPS = {
  news_report:           2,
  vendor_research:       3,
  research_paper:        3,
  government_advisory:   2,
  vulnerability_database:2,
  github_poc:            2,
  benchmark_dataset:     2,
  technical_blog:        3,
  incident_writeup:      3,
  conference_paper:      2,
  standards_or_framework:2,
  unknown:               1,
  default:               2,
};

// ── Categorical evidence states ─────────────────────────────────────────────

export const AI_THREAT_SPECIFICITY = ["none", "weak", "moderate", "strong"];
export const VALID_AI_THREAT_SPECIFICITY = new Set(AI_THREAT_SPECIFICITY);

export const NOVELTY_ASSESSMENT = ["known", "variation", "emerging", "genuinely_new", "unknown"];
export const VALID_NOVELTY_ASSESSMENT = new Set(NOVELTY_ASSESSMENT);

// Maturity ladder — ordered from least to most operationalised. The order is
// significant: earlySignal.js indexes into it.
export const OPERATIONALIZATION_STAGE = [
  "conceptual",
  "lab_validated",
  "reproducible_poc",
  "tool_available",
  "actor_observed",
  "confirmed_operational_use",
  "unknown",
];
export const VALID_OPERATIONALIZATION_STAGE = new Set(OPERATIONALIZATION_STAGE);

export const EARLY_SIGNAL_VALUE = ["none", "weak", "moderate", "strong"];
export const VALID_EARLY_SIGNAL_VALUE = new Set(EARLY_SIGNAL_VALUE);

export const EARLY_SIGNAL_TYPE = [
  "new_attack_mode",
  "new_actor_adoption",
  "new_attack_surface",
  "new_tool_abuse",
  "new_exploit_path",
  "new_defensive_bypass",
  "operationalization_step",
  "scale_shift",
  "convergence",
  "none",
];
export const VALID_EARLY_SIGNAL_TYPE = new Set(EARLY_SIGNAL_TYPE);

export const FRESHNESS_STATUS = ["fresh", "current", "stale", "historical", "unknown"];
export const VALID_FRESHNESS_STATUS = new Set(FRESHNESS_STATUS);

// How to read freshness when the publication date and the underlying event date
// diverge (a fresh article about an old event is not an early signal).
export const FRESHNESS_INTERPRETATION = [
  "fresh_event",
  "fresh_publication_old_event",
  "updated_old_report",
  "historical_context",
  "unknown",
];
export const VALID_FRESHNESS_INTERPRETATION = new Set(FRESHNESS_INTERPRETATION);

export const SOURCE_INDEPENDENCE_STATUS = ["original", "syndicated", "derivative", "unknown"];
export const VALID_SOURCE_INDEPENDENCE_STATUS = new Set(SOURCE_INDEPENDENCE_STATUS);

export const CORROBORATION_STATUS = ["none", "single_source", "independent_sources", "primary_source"];
export const VALID_CORROBORATION_STATUS = new Set(CORROBORATION_STATUS);

export const HALLUCINATION_RISK = ["low", "medium", "high"];
export const VALID_HALLUCINATION_RISK = new Set(HALLUCINATION_RISK);

export const SOURCE_QUALITY = ["low", "medium", "high", "primary"];
export const VALID_SOURCE_QUALITY = new Set(SOURCE_QUALITY);

// Quote availability before Layer 2 cleaning. `missing_preclean` is NOT a
// rejection — some useful sources (PDFs, repos) need cleaning before a quote can
// be extracted. The quote requirement is enforced later for evidence/early-signal use.
export const QUOTE_STATUS = ["present", "missing_preclean", "missing"];
export const VALID_QUOTE_STATUS = new Set(QUOTE_STATUS);

export const QUOTE_CLAIM_MATCH_STATUS = ["match", "partial", "mismatch", "unverified"];
export const VALID_QUOTE_CLAIM_MATCH_STATUS = new Set(QUOTE_CLAIM_MATCH_STATUS);

// quote_support replaces the legacy match/partial/mismatch naming.
// Deterministic token overlap sets the floor; LLM entailment QA may upgrade/downgrade.
// requires_entailment_qa=true is set when the result is "unverified" or "partially_supported"
// so Layer 5 evidence QA can run a proper entailment check later.
export const QUOTE_SUPPORT = ["supported", "partially_supported", "unsupported", "unverified"];
export const VALID_QUOTE_SUPPORT = new Set(QUOTE_SUPPORT);

// freshness_class is the semantic interpretation of age + source type.
// historical_foundational sources (NIST, MITRE, OWASP) must not be discarded for age.
export const FRESHNESS_CLASS = [
  "fresh",                   // ≤ 30 days
  "current",                 // 31–120 days
  "stale_but_relevant",      // 121–365 days, adds new evidence
  "historical_foundational", // > 365 days, standards/framework/authoritative
  "historical_context",      // > 365 days, older technical analysis still cited
  "historical_stale",        // > 365 days, no new evidence, replaceable
  "unknown_date",            // no date available
];
export const VALID_FRESHNESS_CLASS = new Set(FRESHNESS_CLASS);

// origin_role: what role does this source play in the information chain?
export const ORIGIN_ROLE = [
  "primary_origin",       // first/authoritative source of the finding
  "secondary_reporting",  // news/blog reporting on a primary source
  "tertiary_commentary",  // commentary citing secondary reporting
  "unknown_origin",       // cannot determine
];
export const VALID_ORIGIN_ROLE = new Set(ORIGIN_ROLE);

// independence_level: how independent is this source from the claim's subject?
export const INDEPENDENCE_LEVEL = [
  "independent",
  "vendor_interested",       // vendor reporting on their own product/finding
  "self_reported",           // subject reporting on itself
  "circular_reporting_risk", // multiple sources all cite the same single origin
  "unknown",
];
export const VALID_INDEPENDENCE_LEVEL = new Set(INDEPENDENCE_LEVEL);

// evidence_novelty: what kind of NEW information does this candidate contribute?
export const EVIDENCE_NOVELTY = [
  "new_fact",              // new specific fact not previously seen
  "new_case_study",        // new incident or concrete exploitation case
  "new_adoption_signal",   // new evidence of adversary/tool adoption
  "new_actor",             // new threat actor identified
  "new_attack_path",       // new attack vector or technique variant
  "new_vulnerability",     // new CVE / disclosed vulnerability
  "new_metric",            // new quantitative data point (requires stats QA before chart use)
  "duplicate_fact",        // same fact already in the corpus
  "duplicate_reporting",   // another report of an already-known event
  "context_only",          // background/framing, not a new evidenced fact
  "unknown",
];
export const VALID_EVIDENCE_NOVELTY = new Set(EVIDENCE_NOVELTY);

// defensive_content_type: is this about defense, offense, or both?
// "defensive_with_offensive_findings" is critical — many detection papers describe attacks.
export const DEFENSIVE_CONTENT_TYPE = [
  "defensive_only",                       // pure mitigation / response / detection methodology
  "defensive_with_offensive_findings",    // defense paper that includes concrete attack findings
  "threat_finding_with_defensive_context",// primary threat finding with defensive notes
  "not_defensive",                        // purely offensive / threat-side
  "unknown",
];
export const VALID_DEFENSIVE_CONTENT_TYPE = new Set(DEFENSIVE_CONTENT_TYPE);

// candidate_usefulness_roles: what downstream pipeline roles can this candidate serve?
export const CANDIDATE_USEFULNESS_ROLES = [
  "primary_evidence_candidate",
  "supporting_evidence_candidate",
  "context_only",
  "analytics_only",
  "case_study_candidate",
  "adoption_signal_candidate",
  "trend_input_candidate",
  "recommendation_input_candidate",
  "outlook_input_candidate",
  "visual_reference_candidate",
  "archive_only",
];
export const VALID_CANDIDATE_USEFULNESS_ROLES = new Set(CANDIDATE_USEFULNESS_ROLES);

// relevance_path: how was AI-threat relevance determined?
export const RELEVANCE_PATH = ["known_signal", "novelty_signal", "both", "none"];
export const VALID_RELEVANCE_PATH = new Set(RELEVANCE_PATH);

// processing_cache_status: should expensive downstream work be re-run?
export const PROCESSING_CACHE_STATUS = [
  "new",                  // first time seeing this candidate
  "seen_same_content",    // same canonical_url_hash + content_hash → skip reprocessing
  "seen_same_origin",     // different URL, same primary_origin_hash → likely duplicate
  "content_changed",      // same URL but content_hash changed → reprocess
  "reprocess_required",   // pipeline_version changed, must reprocess
  "skip_reprocess",       // explicitly marked do-not-reprocess
];
export const VALID_PROCESSING_CACHE_STATUS = new Set(PROCESSING_CACHE_STATUS);

// Candidate routing — separate from early-signal promotion. Richer than accept/reject.
// context_only is between archive_only and accept_with_review.
// accept_evidence_candidate is the normal acceptance path.
// accept_high_priority is reserved for novel/operational candidates from primary sources.
export const DISCOVERY_ROUTES = [
  "accept_high_priority",    // novel + primary source + strong signal
  "accept_evidence_candidate", // passes all gates, ready for evidence extraction
  "accept_with_review",      // useful but needs human/LLM review
  "context_only",            // real but only useful as context, not primary evidence
  "archive_only",            // relevant but not for this pipeline run
  "reject",                  // not useful
];
export const VALID_DISCOVERY_ROUTES = new Set(DISCOVERY_ROUTES);

// Routes whose candidates proceed into the normal Layer 2/3 pipeline.
// context_only also proceeds but with a context extraction profile.
// archive_only and reject are stored for audit only.
export const ROUTES_INTO_PIPELINE = new Set([
  "accept_high_priority",
  "accept_evidence_candidate",
  "accept_with_review",
  "context_only",
]);

export const EARLY_SIGNAL_QA_STATUS = ["not_required", "pending", "confirmed", "downgraded", "rejected"];
export const VALID_EARLY_SIGNAL_QA_STATUS = new Set(EARLY_SIGNAL_QA_STATUS);

// AI-threat anchors — at least one concrete anchor is required for a candidate
// to clear the AI-threat specificity gate. Buzzword-only material has none.
export const AI_THREAT_ANCHORS = [
  "specific_attack_method",
  "specific_model_or_system",
  "specific_tool_affected",
  "specific_actor_or_campaign",
  "specific_exploit_or_vulnerability",
  "specific_benchmark_or_result",
  "specific_incident",
  "specific_new_capability",
  "specific_defensive_bypass",
  "specific_ai_enabled_role",
];
export const VALID_AI_THREAT_ANCHORS = new Set(AI_THREAT_ANCHORS);

// ── Default mission → early-signal type ─────────────────────────────────────
// When the LLM does not supply an early_signal_type but the evidence supports a
// non-none early_signal_value, we derive a sensible default from the mission so
// that early_signal_value is never emitted without a type.

export const MISSION_DEFAULT_SIGNAL_TYPE = {
  fresh_attack_modes:            "new_attack_mode",
  new_actor_adoption:            "new_actor_adoption",
  new_vulnerability_or_exploit:  "new_exploit_path",
  new_agentic_attack_surface:    "new_attack_surface",
  new_tool_or_mcp_abuse:         "new_tool_abuse",
  new_ai_enabled_cybercrime:     "new_actor_adoption",
  new_benchmark_or_dataset:      "operationalization_step",
  new_incident_or_case_study:    "new_actor_adoption",
  new_defensive_bypass:          "new_defensive_bypass",
  new_statistics_or_trend_data:  "scale_shift",
  new_ai_supply_chain_compromise:"new_attack_surface",
  new_vector_rag_weakness:       "new_attack_surface",
};

// ── Negative filters ────────────────────────────────────────────────────────
// Low-value content signals. A candidate is not rejected for matching these
// alone, but matches downrank it and (combined with weak specificity) push it to
// archive_only or reject. These are matched against title + claim + publisher.

export const NEGATIVE_CONTENT_PATTERNS = [
  "sponsored", "press release", "advertisement", "advertorial",
  "thought leadership", "ai transformation", "digital transformation",
  "buyer's guide", "buying guide", "top 10 vendors", "magic quadrant",
  "webinar registration", "sign up for", "download our", "request a demo",
  "generic ai trends", "future of ai", "ai revolution",
];

// Publisher/domain fragments that are usually SEO/marketing aggregators rather
// than primary technical sources. Downranked, not auto-rejected.
export const LOW_VALUE_DOMAIN_FRAGMENTS = [
  "prnewswire", "businesswire", "globenewswire", "marketwatch",
  "medium.com/@", "linkedin.com/pulse",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isValidMission(m) { return VALID_DISCOVERY_MISSIONS.has(m); }
export function sourceClassCap(sourceClass) {
  return SOURCE_CLASS_CAPS[sourceClass] ?? SOURCE_CLASS_CAPS.default;
}
export function defaultSignalType(mission) {
  return MISSION_DEFAULT_SIGNAL_TYPE[mission] || "new_attack_mode";
}