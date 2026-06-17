/**
 * Layer 5a.1 — Evidence Eligibility Assessment
 *
 * Determines whether a source should be extracted for evidence. Fully deterministic.
 *
 * DESIGN PRINCIPLE: this module makes STRUCTURAL gates only — not semantic ones.
 * "Is this a vendor blog?" is a semantic judgment. "Was this source rejected by L3?"
 * is structural. Only structural facts are used here.
 *
 * Semantic quality of evidence (vendor_claim, marketing, prediction) is handled
 * downstream by the LLM evidence judge (judgeEvidenceItems.js → triage_judgment fields)
 * and by the triage gate (evidenceTriage.js → admissibility + permitted_uses).
 *
 * Gates that REMAIN (structural):
 *   - off_topic relevance_tier → do_not_extract
 *   - layer3 reject (unprotected tier) → do_not_extract
 *   - unknown source_type + low trust → do_not_extract
 *
 * Gates that were REMOVED (semantic — moved to LLM):
 *   - marketing_or_prediction detection → was regex-based, downgraded evidence_use
 *   - concreteness_class-based evidence_use downgrades
 *   - vague_commentary → shallow extraction
 *
 * Input:  source object (requires source_type, trust_tier, layer3_status, relevance_tier)
 * Output: source with evidence_eligibility field
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

// ── Concreteness classifier ────────────────────────────────────────────────────
// Classifies source content concreteness from text signals alone.
// Operates on source text/title/metadata — no LLM needed.

const CVE_PATTERN       = /CVE-\d{4}-\d{4,}/i;
const NAMED_ACTOR       = /\b(APT\d+|Lazarus|Sandworm|Fancy Bear|Salt Typhoon|Volt Typhoon|FIN\d+|UNC\d+)\b/i;
const NAMED_AI_MODEL    = /\b(GPT-4|GPT-3\.5|GPT-?4o|Claude[\s-]?\d?|Llama[\s-]?\d|Gemini[\s-]?\d?|Mistral|DeepSeek)\b/i;
const EXPLOIT_PATTERN   = /\b(exploit|PoC|proof.of.concept|payload|attack chain|reproduction steps|working)\b/i;
const METRIC_PATTERN    = /\b\d+(?:\.\d+)?%|\bASR\b|\battack success rate\b|\d+\s*(cases?|samples?|systems?)\b/i;
const DIAGRAM_PATTERN   = /\b(figure|diagram|architecture|table|appendix|listing|chart|workflow|attack.flow)\b/i;
const INCIDENT_WORDS    = /\b(breach\w*|comprom\w+|hack\w*|attack on|victim\w*|ransomware|stolen|exfil\w*|deploy\w+|infect\w+)\b/i;
const MARKETING_WORDS   = /\b(announces?|launches?|now available|our platform|our solution|sign up|free trial|best.in.class|revolutionary)\b/i;
const PREDICTION_WORDS  = /\b(will become|expected to|is projected|may lead to|could enable|future of)\b/i;
const RESEARCH_WORDS    = /\b(we propose|we demonstrate|n=\d|dataset|ablation|methodology|our approach|experiment|evaluation)\b/i;

/**
 * Classify source concreteness from text signals.
 *
 * DEBUG METADATA ONLY — output is attached to the source for observability but
 * does not affect evidence_use or extraction_depth_hint (2026-06-17 refactor).
 * The LLM extraction judge (judgeEvidenceItems.js) now makes semantic quality
 * judgments; this function's results no longer gate what gets extracted.
 *
 * @param {object} source
 * @returns {{ concreteness_class: string }}
 */
export function classifySourceConcreteness(source) {
  const title    = (source.title    || "").toLowerCase();
  const text     = (source.full_text || source.clean_text || source.summary || "").slice(0, 1500);
  const combined = title + " " + text;

  const hasCve      = CVE_PATTERN.test(combined);
  const hasActor    = NAMED_ACTOR.test(combined);
  const hasIncident = INCIDENT_WORDS.test(combined);
  const hasResearch = RESEARCH_WORDS.test(combined);
  const hasMetric   = METRIC_PATTERN.test(combined);
  const hasModel    = NAMED_AI_MODEL.test(combined);

  if ((hasCve || hasActor) && (hasIncident || EXPLOIT_PATTERN.test(combined))) {
    return { concreteness_class: "concrete_operational" };
  }
  if (hasResearch && (hasMetric || hasModel)) {
    return { concreteness_class: "concrete_research" };
  }
  if (hasMetric && (hasCve || hasModel || hasActor)) {
    return { concreteness_class: "concrete_metric" };
  }
  if (DIAGRAM_PATTERN.test(combined) && (hasCve || hasModel || hasIncident || hasActor)) {
    return { concreteness_class: "concrete_visual" };
  }
  if (!hasCve && !hasActor && !hasMetric && !hasModel && !hasIncident) {
    return { concreteness_class: "vague_commentary" };
  }
  return { concreteness_class: "vague_commentary" };
}

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

  // Concreteness is debug metadata only — does not affect evidence_use
  const { concreteness_class } = classifySourceConcreteness(source);

  // Derive evidence_use from source_type (structural, not semantic)
  let evidence_use;
  if (PRIMARY_EVIDENCE_TYPES.has(st)) {
    evidence_use = "primary_evidence";
  } else if (SUPPORTING_EVIDENCE_TYPES.has(st)) {
    evidence_use = "supporting_evidence";
  } else if (CONTEXT_ONLY_TYPES.has(st)) {
    evidence_use = "context_only";
  } else {
    evidence_use = "analytics_only";
  }

  // Low trust tier downgrade (structural — trust tier is a provenance fact, not a
  // semantic quality judgment)
  if (tier === "low") {
    if (evidence_use === "primary_evidence")        evidence_use = "supporting_evidence";
    else if (evidence_use === "supporting_evidence") evidence_use = "context_only";
  }

  // extraction_depth_hint is always "standard" — shallow/deep hints were driven by
  // the removed concreteness classification; the extraction LLM no longer uses them.
  const reason = `source_type=${st} trust_tier=${tier} → ${evidence_use}`;
  return attach(source, evidence_use, reason, st, concreteness_class, "standard");
}

function attach(source, evidence_use, reason, sourceType, concreteness_class = null, extraction_depth_hint = null) {
  const eligible_for_evidence = evidence_use !== "do_not_extract";
  const allowed_evidence_types = SOURCE_TYPE_EVIDENCE_TYPES[sourceType] ?? [];

  return {
    ...source,
    evidence_eligibility: {
      eligible_for_evidence,
      evidence_use,
      reason,
      allowed_evidence_types,
      // Concreteness assessment — used by extraction profiles to set max_items
      concreteness_class:      concreteness_class || null,
      extraction_depth_hint:   extraction_depth_hint || "standard",
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
