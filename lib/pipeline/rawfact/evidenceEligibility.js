/**
 * Layer 5a.1 — Evidence Eligibility Assessment
 *
 * Determines whether a source should be used for evidence extraction and in what
 * capacity. Fully deterministic — no LLM calls.
 *
 * Input:  source object (requires source_type, trust_tier, layer3_status,
 *         relevance_tier, main_category)
 * Output: source with evidence_eligibility field:
 *         { eligible_for_evidence, evidence_use, reason, allowed_evidence_types }
 */

import { SOURCE_TYPE_EVIDENCE_TYPES } from "./evidenceExtractionProfiles.js";

// ── Source type → evidence use defaults ──────────────────────────────────────

const PRIMARY_EVIDENCE_TYPES = new Set([
  "incident",
  "vulnerability",
  "exploit_disclosure",
  "threat_intelligence",
  "adversary_adoption_signal",
]);

const SUPPORTING_EVIDENCE_TYPES = new Set([
  "research_finding",
  "capability_demonstration",
  "benchmark_evaluation",
  "societal_harm_signal",
]);

const CONTEXT_ONLY_TYPES = new Set([
  "defensive_capability",
  "governance_signal",
  "attack_surface_signal",
]);

// SOURCE_TYPE_EVIDENCE_TYPES imported from evidenceExtractionProfiles.js (canonical source)

const HIGH_TRUST_TIERS = new Set(["primary", "high", "curated"]);
const PROTECTED_TIERS   = new Set(["primary", "curated"]);

// ── Core eligibility logic ────────────────────────────────────────────────────

/**
 * Assess evidence eligibility for a single source.
 *
 * @param {object} source
 * @returns {object} source with evidence_eligibility field added
 */
export function assessEvidenceEligibility(source) {
  const st      = source.source_type  || "unknown";
  const tier    = source.trust_tier   || "unknown";
  const layer3  = source.layer3_status;
  const relTier = source.relevance_tier;
  const mainCat = source.main_category;

  // Hard discard: off-topic relevance (L3 already judged this source as having no AI-threat focus)
  if (relTier === "off_topic") {
    return attach(source, "do_not_extract", "relevance_tier is off_topic", st);
  }

  // Hard discard: layer3 reject unless protected trust tier
  if (layer3 === "reject" && !PROTECTED_TIERS.has(tier)) {
    return attach(source, "do_not_extract", "layer3_status=reject and tier not protected", st);
  }

  // Unknown type with no trust → do not extract
  if (st === "unknown" && !HIGH_TRUST_TIERS.has(tier)) {
    return attach(source, "do_not_extract", "source_type=unknown and trust_tier not high+", st);
  }

  // Unknown type but high trust and valid category → analytics only
  if (st === "unknown" && HIGH_TRUST_TIERS.has(tier) && mainCat !== "unclear_or_adjacent") {
    return attach(source, "analytics_only", "source_type=unknown but trust high+ and valid category", st);
  }

  // Derive base evidence_use from source_type
  let evidence_use;
  if (PRIMARY_EVIDENCE_TYPES.has(st)) {
    evidence_use = "primary_evidence";
  } else if (SUPPORTING_EVIDENCE_TYPES.has(st)) {
    evidence_use = "supporting_evidence";
  } else if (CONTEXT_ONLY_TYPES.has(st)) {
    evidence_use = "context_only";
  } else {
    // Catch-all for unmapped types
    evidence_use = "analytics_only";
  }

  // Low trust tier downgrade
  if (tier === "low") {
    if (evidence_use === "primary_evidence")   evidence_use = "supporting_evidence";
    else if (evidence_use === "supporting_evidence") evidence_use = "context_only";
  }

  const reason = `source_type=${st} trust_tier=${tier} → ${evidence_use}`;
  return attach(source, evidence_use, reason, st);
}

function attach(source, evidence_use, reason, sourceType) {
  const eligible_for_evidence = evidence_use !== "do_not_extract";
  const allowed_evidence_types = SOURCE_TYPE_EVIDENCE_TYPES[sourceType] ?? [];

  return {
    ...source,
    evidence_eligibility: {
      eligible_for_evidence,
      evidence_use,
      reason,
      allowed_evidence_types,
    },
  };
}

/**
 * Apply evidence eligibility assessment to all sources.
 *
 * @param {object[]} sources
 * @returns {object[]} sources with evidence_eligibility field added
 */
export function applyEvidenceEligibility(sources) {
  return sources.map(assessEvidenceEligibility);
}
