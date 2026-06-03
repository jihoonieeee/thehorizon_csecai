/**
 * Layer 5a.2 — Evidence Extraction Profiles
 *
 * Returns per-source-type extraction profiles that guide what evidence items should
 * be extracted, how many, and what to prioritise. Fully deterministic — no LLM calls.
 *
 * Input:  source_type string
 * Output: extraction profile { source_type, allowed_evidence_types, prioritize,
 *         max_items, evidence_strength_boost }
 */

// ── All valid evidence type strings ──────────────────────────────────────────

export const ALL_EVIDENCE_TYPES = [
  "incident_event",
  "vulnerability_fact",
  "exploit_chain",
  "attack_method",
  "threat_actor_activity",
  "adversary_adoption",
  "research_result",
  "capability_delta",
  "benchmark_result",
  "societal_harm",
  "governance_action",
  "defensive_control",
  "ecosystem_shift",
  "infrastructure_dependency",
  "trust_boundary_shift",
  "strategic_signal",
  "statistic",
  "mitigation",
  "timeline_event",
];

// ── Source type → allowed evidence types (CANONICAL — imported by evidenceEligibility.js) ──
// Each source type defines the full set of evidence item types that may be extracted from it.
// Keep this list as the single source of truth; do NOT duplicate it elsewhere.

export const SOURCE_TYPE_EVIDENCE_TYPES = {
  // High-urgency operational types
  incident: [
    "incident_event","attack_method","threat_actor_activity",
    "vulnerability_fact","societal_harm","statistic","timeline_event",
  ],
  vulnerability: [
    "vulnerability_fact","exploit_chain","statistic","mitigation","timeline_event",
  ],
  exploit_disclosure: [
    "exploit_chain","attack_method","vulnerability_fact","capability_delta","mitigation",
  ],
  threat_intelligence: [
    "threat_actor_activity","attack_method","adversary_adoption",
    "capability_delta","statistic","timeline_event",
  ],
  adversary_adoption_signal: [
    "adversary_adoption","threat_actor_activity","attack_method",
    "capability_delta","statistic",
  ],

  // Technical evidence types
  research_finding: [
    "research_result","attack_method","capability_delta",
    "vulnerability_fact","statistic","mitigation",
  ],
  capability_demonstration: [
    "capability_delta","attack_method","benchmark_result","societal_harm","statistic",
  ],
  benchmark_evaluation: [
    "benchmark_result","capability_delta","research_result",
    "attack_method","societal_harm","statistic",
  ],

  // Contextual / structural types
  societal_harm_signal: [
    "societal_harm","incident_event","adversary_adoption","statistic","timeline_event",
  ],
  governance_signal: [
    "governance_action","mitigation","statistic","timeline_event",
  ],
  defensive_capability: [
    "defensive_control","mitigation","benchmark_result","statistic",
  ],
  ecosystem_signal: [
    "ecosystem_shift","infrastructure_dependency","statistic","timeline_event",
  ],
  infrastructure_dependency_signal: [
    "infrastructure_dependency","strategic_signal","ecosystem_shift","statistic",
  ],
  trust_boundary_shift: [
    "trust_boundary_shift","infrastructure_dependency","strategic_signal","statistic",
  ],
  strategic_signal: [
    "strategic_signal","ecosystem_shift","capability_delta","statistic",
  ],
  unknown: [],
};

// ── Profiles ──────────────────────────────────────────────────────────────────

export const EXTRACTION_PROFILES = {
  incident: {
    source_type:             "incident",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.incident,
    prioritize:              ["confirmed impact","victim/sector","attacker method","scale","institutional response"],
    max_items:               5,
    evidence_strength_boost: 5,
  },
  vulnerability: {
    source_type:             "vulnerability",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.vulnerability,
    prioritize:              ["affected system","exploitability","patch status","exploitation status","blast radius"],
    max_items:               5,
    evidence_strength_boost: 5,
  },
  exploit_disclosure: {
    source_type:             "exploit_disclosure",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.exploit_disclosure,
    prioritize:              ["reproducibility","required access","exploit chain depth","public tooling","operational realism"],
    max_items:               5,
    evidence_strength_boost: 5,
  },
  threat_intelligence: {
    source_type:             "threat_intelligence",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.threat_intelligence,
    prioritize:              ["observed TTPs","campaign scope","attribution confidence","active exploitation","sector targeting"],
    max_items:               4,
    evidence_strength_boost: 5,
  },
  adversary_adoption_signal: {
    source_type:             "adversary_adoption_signal",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.adversary_adoption_signal,
    prioritize:              ["who is adopting","what capability","observed evidence","spread trajectory"],
    max_items:               4,
    evidence_strength_boost: 5,
  },
  research_finding: {
    source_type:             "research_finding",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.research_finding,
    prioritize:              ["novelty","reproducibility","systems tested","operationalization likelihood","limitations"],
    max_items:               4,
    evidence_strength_boost: 3,
  },
  capability_demonstration: {
    source_type:             "capability_demonstration",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.capability_demonstration,
    prioritize:              ["autonomy level","operational completeness","reproducibility","attacker applicability"],
    max_items:               3,
    evidence_strength_boost: 3,
  },
  benchmark_evaluation: {
    source_type:             "benchmark_evaluation",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.benchmark_evaluation,
    prioritize:              ["key metric result (ASR/score/rate)","models or systems tested","attack method used","capability ceiling established","trajectory signal (improving/stable/declining)","limitations"],
    max_items:               3,
    evidence_strength_boost: 3,
  },
  societal_harm_signal: {
    source_type:             "societal_harm_signal",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.societal_harm_signal,
    prioritize:              ["harm type","affected population or scale","AI capability that enabled harm","institutional or legal response","spread or repeatability"],
    max_items:               3,
    evidence_strength_boost: 2,
  },
  governance_signal: {
    source_type:             "governance_signal",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.governance_signal,
    prioritize:              ["issuing authority","affected sectors","compliance implications","recommended actions"],
    max_items:               2,
    evidence_strength_boost: 0,
  },
  defensive_capability: {
    source_type:             "defensive_capability",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.defensive_capability,
    prioritize:              ["gap addressed","deployment readiness","effectiveness","limitations"],
    max_items:               2,
    evidence_strength_boost: 0,
  },
  ecosystem_signal: {
    source_type:             "ecosystem_signal",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.ecosystem_signal,
    prioritize:              ["adoption velocity","infrastructure penetration","downstream attack surface growth"],
    max_items:               2,
    evidence_strength_boost: 0,
  },
  infrastructure_dependency_signal: {
    source_type:             "infrastructure_dependency_signal",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.infrastructure_dependency_signal,
    prioritize:              ["dependency type and scope","attack surface created or expanded","criticality to downstream systems","known exploitation risk","concentration risk"],
    max_items:               2,
    evidence_strength_boost: 0,
  },
  trust_boundary_shift: {
    source_type:             "trust_boundary_shift",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.trust_boundary_shift,
    prioritize:              ["trust assumption violated","authority delegation or propagation","human oversight reduction","affected systems or contexts","exploitability window"],
    max_items:               2,
    evidence_strength_boost: 0,
  },
  strategic_signal: {
    source_type:             "strategic_signal",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.strategic_signal,
    prioritize:              ["strategic theme or convergence signal","systemic risk introduced","capability trajectory","horizon relevance (3-12 months)","evidence quality"],
    max_items:               2,
    evidence_strength_boost: 0,
  },
  unknown: {
    source_type:             "unknown",
    allowed_evidence_types:  SOURCE_TYPE_EVIDENCE_TYPES.unknown,
    prioritize:              [],
    max_items:               0,
    evidence_strength_boost: 0,
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the extraction profile for a given source_type.
 * Falls back to the "unknown" profile if not found.
 *
 * @param {string} sourceType
 * @returns {object} extraction profile
 */
export function getExtractionProfile(sourceType) {
  return EXTRACTION_PROFILES[sourceType] ?? EXTRACTION_PROFILES.unknown;
}

/**
 * Attach extraction_profile to every source.
 *
 * @param {object[]} sources
 * @returns {object[]} sources with extraction_profile field added
 */
export function applyExtractionProfiles(sources) {
  return sources.map((source) => ({
    ...source,
    extraction_profile: getExtractionProfile(source.source_type || "unknown"),
  }));
}
