/**
 * Evidence-Type Vocabulary — single source of truth reconciling the historically
 * divergent evidence_type spellings across the codebase.
 *
 * Three vocabularies grew apart:
 *   - L5A extraction (evidenceExtractionProfiles.ALL_EVIDENCE_TYPES):
 *     incident_event, exploit_chain, attack_method, threat_actor_activity,
 *     research_result, societal_harm, governance_action, defensive_control,
 *     mitigation, infrastructure_dependency, vulnerability_fact, adversary_adoption,
 *     capability_delta, benchmark_result
 *   - slide gates (selectSlideArgumentForm / planSlides):
 *     incident_report, exploit_demonstration, capability_delta, ...
 *   - canonical packet (evidencePacketSchema.EVIDENCE_TYPES):
 *     incident_report, exploit_demonstration, research_finding, ...
 *
 * The drift meant real incidents (incident_event) and exploit chains (exploit_chain)
 * were silently excluded from case studies, diagrams, and timeline argument-forms,
 * and collapsed to background_context in the canonical packet. This module defines
 * equivalence classes so every consumer recognises the same concept regardless of
 * which spelling produced it.
 */

// ── Equivalence classes (every spelling that means the same concept) ───────────

export const INCIDENT_TYPES   = new Set(["incident_event", "incident_report", "incident", "incident_confirmation"]);
export const EXPLOIT_TYPES    = new Set(["exploit_chain", "exploit_demonstration"]);
export const ADOPTION_TYPES   = new Set(["adversary_adoption", "adversary_adoption_signal"]);
export const ACTOR_TYPES      = new Set(["threat_actor_activity"]);
export const CAPABILITY_TYPES = new Set(["capability_delta", "capability_demonstration"]);
export const ATTACK_METHOD_TYPES = new Set(["attack_method"]);
export const VULN_TYPES       = new Set(["vulnerability_fact", "vulnerability_disclosure", "vulnerability"]);

// ── Case-study eligibility (operational / demonstrable, named-entity rich) ─────

export const CASE_STUDY_TYPES = new Set([
  ...INCIDENT_TYPES, ...EXPLOIT_TYPES, ...ADOPTION_TYPES, ...ACTOR_TYPES, ...CAPABILITY_TYPES,
]);

export function isCaseStudyType(t) {
  return CASE_STUDY_TYPES.has(t);
}

/**
 * Deterministic case-study quality rank — operational evidence first.
 * incident > threat-actor activity > adversary adoption > exploit > capability.
 */
export function caseStudyTypeRank(t) {
  if (INCIDENT_TYPES.has(t))   return 5;
  if (ACTOR_TYPES.has(t))      return 4;
  if (ADOPTION_TYPES.has(t))   return 3;
  if (EXPLOIT_TYPES.has(t))    return 2;
  if (CAPABILITY_TYPES.has(t)) return 1;
  return 0;
}

// ── Attack-flow diagram eligibility (multi-step processes) ─────────────────────

export const DIAGRAM_TYPES = new Set([
  ...EXPLOIT_TYPES, ...INCIDENT_TYPES, ...ADOPTION_TYPES, ...ATTACK_METHOD_TYPES,
  ...CAPABILITY_TYPES, ...VULN_TYPES, "attack_surface_signal",
]);

export function isDiagramType(t) {
  return DIAGRAM_TYPES.has(t);
}

// ── Incident-timeline eligibility ─────────────────────────────────────────────

export const TIMELINE_TYPES = new Set([
  ...INCIDENT_TYPES, ...ADOPTION_TYPES, ...EXPLOIT_TYPES, ...ACTOR_TYPES,
]);
