/**
 * Controlled vocabulary: source types.
 *
 * Each source receives exactly one source_type in Layer 3 (rule-based, with an
 * LLM fallback). Source type is orthogonal to main_category — it describes WHAT
 * KIND of intelligence object the source is (defined by what it can evidentially
 * prove), not what threat category it belongs to.
 *
 * ── 12 types + `unknown` ──────────────────────────────────────────────────────
 * Operational (something real happened / exists):
 *   vulnerability, exploit_disclosure, incident, threat_intelligence,
 *   adversary_adoption_signal
 * Technical evidence (something was demonstrated / measured, usually in a lab):
 *   research_finding, benchmark_evaluation, capability_demonstration,
 *   defensive_capability
 * Contextual / structural (framing — policy, society, and attack-surface change):
 *   governance_signal, societal_harm_signal, attack_surface_signal
 *
 * `attack_surface_signal` replaces the four former vague/abstract "signal" types
 * (ecosystem_signal, infrastructure_dependency_signal, trust_boundary_shift,
 * strategic_signal): a single security-framed genre for a development that
 * materially expands or shifts the AI attack surface.
 */

export const SOURCE_TYPES = {
  // Operational (high urgency — something real happened or exists)
  VULNERABILITY:                   "vulnerability",
  EXPLOIT_DISCLOSURE:              "exploit_disclosure",
  INCIDENT:                        "incident",
  THREAT_INTELLIGENCE:             "threat_intelligence",
  ADVERSARY_ADOPTION_SIGNAL:       "adversary_adoption_signal",

  // Technical evidence (demonstrated / measured)
  RESEARCH_FINDING:                "research_finding",
  BENCHMARK_EVALUATION:            "benchmark_evaluation",
  CAPABILITY_DEMONSTRATION:        "capability_demonstration",
  DEFENSIVE_CAPABILITY:            "defensive_capability",

  // Contextual / structural signals
  GOVERNANCE_SIGNAL:               "governance_signal",
  SOCIETAL_HARM:                   "societal_harm_signal",
  ATTACK_SURFACE_SIGNAL:           "attack_surface_signal",

  // Transitional fallback — Layer 3 LLM call will refine this
  UNKNOWN: "unknown",
};

export const SOURCE_TYPE_LABELS = {
  vulnerability:                      "Vulnerability Disclosure",
  exploit_disclosure:                 "Exploit Disclosure",
  incident:                           "Security Incident",
  threat_intelligence:                "Threat Intelligence",
  adversary_adoption_signal:          "Adversary Adoption Signal",
  research_finding:                   "Research Finding",
  benchmark_evaluation:               "Benchmark / Evaluation",
  capability_demonstration:           "Capability Demonstration",
  defensive_capability:               "Defensive Capability",
  governance_signal:                  "Governance / Policy Signal",
  societal_harm_signal:               "Societal Harm Signal",
  attack_surface_signal:              "AI Attack-Surface Signal",
  unknown:                            "Unknown",
};

// Source types with high operational urgency (operational evidence genres)
export const OPERATIONAL_TYPES = new Set([
  "vulnerability",
  "exploit_disclosure",
  "incident",
  "threat_intelligence",
]);

// Source types relevant for the horizon watch (forward-looking)
export const HORIZON_TYPES = new Set([
  "research_finding",
  "benchmark_evaluation",
  "capability_demonstration",
  "adversary_adoption_signal",
  "attack_surface_signal",
]);

export const ALL_SOURCE_TYPES = [
  "vulnerability",
  "exploit_disclosure",
  "incident",
  "threat_intelligence",
  "adversary_adoption_signal",
  "research_finding",
  "benchmark_evaluation",
  "capability_demonstration",
  "defensive_capability",
  "governance_signal",
  "societal_harm_signal",
  "attack_surface_signal",
  "unknown",
];

// Migration map: old DB / connector values → canonical current values.
// Used at ingest to normalize stale strings. The retired vague types all fold
// into attack_surface_signal (see docs/migrations/000_schema.sql (section 6) for the
// one-time DB remap of existing rows).
export const OLD_SOURCE_TYPE_MAP = {
  policy_regulatory_signal:           "governance_signal",
  governance_organizational_response: "governance_signal",
  adjacent_contextual:                "unknown",
  academic_research:                  "research_finding",

  // Retired vague/abstract types → attack_surface_signal
  ecosystem_signal:                   "attack_surface_signal",
  ecosystem_market_signal:            "attack_surface_signal",
  infrastructure_dependency_signal:   "attack_surface_signal",
  trust_boundary_shift:               "attack_surface_signal",
  strategic_signal:                   "attack_surface_signal",
  strategic_foresight_signal:         "attack_surface_signal",
  tooling_platform_development:       "attack_surface_signal",

  // Connector-emitted legacy types that were never normalised to the canonical
  // vocabulary. Without these, ~500 operational rows (vulnerability_advisory,
  // incident_report, threat_intelligence_report) stay non-canonical and are
  // invisible to OPERATIONAL_TYPES / HORIZON_TYPES gates.
  //
  // IMPORTANT: every mapping here is BUCKET-PRESERVING under
  // corpusComposition.bucketForSourceType (the legacy type and its canonical
  // target land in the same diversity bucket), so normalising does not distort
  // the corpus distribution — it only makes the canonical type real on the row.
  research_paper:                     "research_finding",      // research → research
  vulnerability_advisory:             "vulnerability",         // vulnerability → vulnerability
  incident_report:                    "incident",              // incident → incident
  threat_intelligence_report:         "threat_intelligence",   // threat_intelligence → threat_intelligence
  threat_intel:                       "threat_intelligence",   // threat_intelligence → threat_intelligence
  dataset_or_benchmark:               "benchmark_evaluation",  // research → research
  exploit_poc:                        "exploit_disclosure",    // → vulnerability bucket
  government_advisory:                "governance_signal",     // government → government
  // DELIBERATELY NOT MAPPED (no bucket-preserving canonical target exists):
  //   security_blog, vendor_report, news_article, news → these bucket to
  //   `vendor_advisory`, which has NO canonical member, so any mapping would
  //   shove them into `research` and distort the distribution. They stay legacy
  //   and are resolved per-article by Layer-3 LLM typing.
};
