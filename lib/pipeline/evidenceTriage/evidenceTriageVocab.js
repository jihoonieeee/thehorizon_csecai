/**
 * Evidence Triage — controlled vocabularies (non-numeric model).
 *
 * Replaces 0–100 evidence scoring with constrained categorical states. The chain
 * is: Evidence → Observations → Viewpoints → Claims → deterministic claim_priority.
 * The LLM classifies/interprets/groups/explains; deterministic gates decide
 * final priority. NO arbitrary weights, NO 0–100 scores.
 */

// ── Part 1: evidence triage ───────────────────────────────────────────────────

export const ADMISSIBILITY = ["passed", "failed", "context_only"];
export const VALID_ADMISSIBILITY = new Set(ADMISSIBILITY);

export const EVIDENCE_STRENGTH = ["strong", "usable", "context", "archive"];
export const VALID_EVIDENCE_STRENGTH = new Set(EVIDENCE_STRENGTH);

// Ordinal rank for DETERMINISTIC ORDERING ONLY (not a score, not a priority).
// Used to sort/select evidence by strength without re-introducing a 0–100 score.
// strong > usable > context > archive. NEVER surface this as a number to the model.
export const EVIDENCE_STRENGTH_RANK = { strong: 3, usable: 2, context: 1, archive: 0 };
export function strengthRank(strength) {
  return EVIDENCE_STRENGTH_RANK[strength] ?? 0;
}
// Confidence tiebreak rank for ordering within the same strength bucket.
const CONFIDENCE_RANK = { high: 2, medium: 1, low: 0 };
/**
 * Compare two evidence items for ordering: strength desc, then confidence desc,
 * then signal richness (numbers/entities present) desc. Returns <0 if a ranks first.
 */
export function compareEvidenceByStrength(a, b) {
  const sa = strengthRank(a?.triage_data?.evidence_strength);
  const sb = strengthRank(b?.triage_data?.evidence_strength);
  if (sa !== sb) return sb - sa;
  const ca = CONFIDENCE_RANK[a?.evidence_confidence] ?? 0;
  const cb = CONFIDENCE_RANK[b?.evidence_confidence] ?? 0;
  if (ca !== cb) return cb - ca;
  const ra = ((a?.numbers || []).length > 0 ? 1 : 0) + ((a?.entities || []).length > 0 ? 1 : 0);
  const rb = ((b?.numbers || []).length > 0 ? 1 : 0) + ((b?.entities || []).length > 0 ? 1 : 0);
  return rb - ra;
}

export const PERMITTED_USES = [
  "fact_support", "case_study", "capability_support", "adoption_support",
  "trend_input", "recommendation_input", "outlook_input", "exposure_analysis",
  "context_only", "not_used",
];
export const VALID_PERMITTED_USES = new Set(PERMITTED_USES);

// Uses that require OBSERVED real-world adversary use to be legitimate.
export const USES_REQUIRING_OBSERVED_USE = new Set(["adoption_support"]);
// Uses that cannot, by themselves, support an operational claim.
export const NON_OPERATIONAL_USES = new Set(["context_only", "outlook_input"]);

export const LIMITATIONS = [
  "single_source", "lab_only", "no_operational_observation", "unclear_reproducibility",
  "unclear_scope", "unclear_ai_role", "vendor_self_reported", "uncertain_attribution",
  "narrow_time_window", "duplicate_reporting", "weak_source_type_fit",
  "missing_quantitative_detail", "conflicting_evidence",
  // Source is non-English: the extracted English "fact" is an LLM translation, not a
  // verbatim-grounded English claim — so it cannot anchor a claim without a verified
  // translation. Capped to context_only by the admissibility gate.
  "non_english_source",
];
export const VALID_LIMITATIONS = new Set(LIMITATIONS);

// ── Part 2: observations ──────────────────────────────────────────────────────

export const OBSERVATION_TYPES = [
  "repeated_technique", "repeated_target_surface", "repeated_affected_layer",
  "repeated_actor_behavior", "repeated_capability_result", "repeated_defensive_gap",
  "repeated_governance_pressure", "repeated_dependency_exposure",
  "repeated_trust_boundary_issue", "narrow_exceptional_event",
];
export const VALID_OBSERVATION_TYPES = new Set(OBSERVATION_TYPES);

export const OBSERVATION_SCOPE = [
  "single_event", "repeated_pattern", "capability_marker",
  "exposure_marker", "adoption_marker", "context_marker",
];
export const VALID_OBSERVATION_SCOPE = new Set(OBSERVATION_SCOPE);

export const SIGNAL_TEMPORALITY = ["emerging", "persistent", "recurring", "declining", "isolated"];
export const VALID_SIGNAL_TEMPORALITY = new Set(SIGNAL_TEMPORALITY);

// ── Part 3: viewpoints ────────────────────────────────────────────────────────

export const VIEWPOINT_TYPES = [
  "operational_pattern", "capability_shift", "exposure_shift", "adoption_movement",
  "defensive_gap", "infrastructure_risk", "trust_boundary_risk",
  "governance_pressure", "outlook_signal",
];
export const VALID_VIEWPOINT_TYPES = new Set(VIEWPOINT_TYPES);

export const ANALYTICAL_CHANGE = [
  "capability_increased", "exposure_expanded", "adoption_moved_forward",
  "defensive_assumption_failed", "trust_boundary_shifted", "dependency_risk_increased",
  "governance_pressure_intensified", "no_clear_change",
];
export const VALID_ANALYTICAL_CHANGE = new Set(ANALYTICAL_CHANGE);
// Analytical-change values that are eligible for a critical claim.
export const CRITICAL_ANALYTICAL_CHANGE = new Set(
  ANALYTICAL_CHANGE.filter((c) => c !== "no_clear_change")
);

export const CHANGE_DRIVER = [
  "newly_emerged", "materially_expanded", "operationalized", "scaled",
  "becoming_systemic", "defensive_failure", "governance_acceleration",
  "persistent_unresolved", "not_applicable",
];
export const VALID_CHANGE_DRIVER = new Set(CHANGE_DRIVER);
export const CRITICAL_CHANGE_DRIVER = new Set(
  CHANGE_DRIVER.filter((d) => d !== "not_applicable")
);

export const VIEWPOINT_STRENGTH = ["strong", "moderate", "weak"];
export const VALID_VIEWPOINT_STRENGTH = new Set(VIEWPOINT_STRENGTH);

// ── Part 4/5: claims ──────────────────────────────────────────────────────────

export const CLAIM_TYPES = [
  "category_insight", "trend_claim", "executive_judgment", "recommendation", "outlook",
];
export const VALID_CLAIM_TYPES = new Set(CLAIM_TYPES);

export const EVIDENCE_SUFFICIENCY = ["sufficient", "partial", "insufficient"];
export const VALID_EVIDENCE_SUFFICIENCY = new Set(EVIDENCE_SUFFICIENCY);

export const CLAIM_PRIORITY = ["critical", "high", "medium", "rejected"];
export const VALID_CLAIM_PRIORITY = new Set(CLAIM_PRIORITY);

// Broad-relevance bases (a non-empty subset justifies broad_relevance=true).
export const BROAD_RELEVANCE_BASES = [
  "common_ai_deployment_pattern", "widely_used_infrastructure_layer",
  "multiple_organizations_or_sectors", "reusable_attacker_capability",
  "reusable_defensive_assumption", "ecosystem_wide_workflow", "foundational_trust_model",
];
export const VALID_BROAD_RELEVANCE_BASES = new Set(BROAD_RELEVANCE_BASES);

// Multi-scope dimensions (≥2 distinct → multi_scope_impact=true).
export const MULTI_SCOPE_DIMENSIONS = [
  "actors", "systems", "workflows", "infrastructure_layers",
  "organization_types", "threat_categories", "deployment_environments",
];
export const VALID_MULTI_SCOPE_DIMENSIONS = new Set(MULTI_SCOPE_DIMENSIONS);

// ── Part 7: case studies ──────────────────────────────────────────────────────

export const CASE_STUDY_STRENGTH = ["strong", "usable", "weak"];
export const VALID_CASE_STUDY_STRENGTH = new Set(CASE_STUDY_STRENGTH);

// ── Limitation effects (deterministic blocking rules) ─────────────────────────
// Each effect is a predicate(claim) → true when the limitation BLOCKS that claim.
// `claim` carries: claim_type, analytical_change, broad_relevance_basis[],
// asserts_adoption, asserts_actor_specific, asserts_operational, asserts_ai_significance,
// independent_corroboration (bool), conflict_resolved (bool).

export const LIMITATION_EFFECTS = {
  lab_only:                 (c) => c.asserts_operational || c.analytical_change === "adoption_moved_forward",
  no_operational_observation:(c) => c.asserts_adoption || c.analytical_change === "adoption_moved_forward",
  single_source:            (c) => c.claim_type === "trend_claim" && !c.independent_corroboration,
  unclear_scope:            (c) => (c.broad_relevance_basis || []).includes("ecosystem_wide_workflow"),
  unclear_ai_role:          (c) => c.asserts_ai_significance === true,
  uncertain_attribution:    (c) => c.asserts_actor_specific === true,
  narrow_time_window:       (c) => c.claim_type === "trend_claim",
  conflicting_evidence:     (c) => c.priority_target === "critical" && !c.conflict_resolved,
  // Caveat-only (do NOT hard-block; downstream must add a caveat):
  vendor_self_reported:     () => false,
  missing_quantitative_detail:() => false,
  unclear_reproducibility:  () => false,
  duplicate_reporting:      () => false,   // affects corroboration counting, not a block
  weak_source_type_fit:     () => false,   // affects evidence strength, not claim block
};

// Limitations that only require a caveat downstream (no hard block).
export const CAVEAT_ONLY_LIMITATIONS = new Set([
  "vendor_self_reported", "missing_quantitative_detail",
  "unclear_reproducibility", "duplicate_reporting",
]);
