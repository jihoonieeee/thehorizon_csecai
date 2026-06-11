/**
 * Evidence Triage (Part 1) — admissibility + strength + permitted uses + limitations.
 *
 * The LLM may judge semantic fields (source_type_fit, direct_demonstration,
 * concrete_claim, limitations, observed_use). Deterministic logic ENFORCES every
 * constraint: admissibility gates, source-type permission bounds, the
 * observed-use rule, and the categorical strength assignment. No numeric scores.
 *
 * Output per item: {
 *   evidence_id, source_id, source_type, admissibility, source_type_fit,
 *   direct_demonstration, concrete_claim, evidence_strength, permitted_uses[],
 *   limitations[], reasoning
 * }
 */

import {
  VALID_LIMITATIONS, USES_REQUIRING_OBSERVED_USE,
} from "./evidenceTriageVocab.js";
import {
  permissionsFor, canBeStrong, requiresObservedUse, isInherentlyObserved,
} from "../../config/sourceTypeClaimPermissions.js";

// ── Deterministic admissibility signals ───────────────────────────────────────

const GENERIC_OPENER = /^(ai|ml|llm|attackers?|defenders?)\s+(can|may|will|are)\b/i;
const MARKETING = /\b(best[ -]in[ -]class|industry[ -]leading|state[ -]of[ -]the[ -]art|revolutionar|game[ -]changer|world[ -]class)\b/i;
const SPECULATION = /\b(may|might|could|possibly|potentially)\s+[a-z]|in the future|is expected to|is likely to/i;

function isTraceable(source) {
  return !!(source && (source.url || source.source_id || source.id));
}
function hasQuoteAnchor(item) {
  const q = (item.source_quote || item.supporting_quote || "").trim();
  return q.length >= 12 || item.quote_verified === true;
}
function isAtomic(item) {
  return item.is_atomic !== false;
}
function isSpecific(item) {
  const fact = (item.fact || item.claim || "").trim();
  if (fact.length < 25) return false;
  if (GENERIC_OPENER.test(fact) && fact.length < 70) return false;
  return true;
}

// Does the item itself carry an observed-use signal (named actor/entity, or an
// observation verb)? Used as a floor so that — when the LLM judgment is ABSENT
// (no-LLM / skipped) — we do not auto-grant real-world observed status to an
// inherently-observed source type that has no actual observed content.
const OBSERVED_PHRASE = /\b(observed|seen|detected|confirmed|attributed|reported(ly)?|deploy(ed|ing)?|in the wild|used by|adopt(ed|ing)?|leverag(ed|ing)|compromised|breached)\b/i;
function hasObservedSignal(item) {
  if ((item.entities || []).length > 0) return true;
  return OBSERVED_PHRASE.test(item.fact || item.claim || "");
}
// Resolve observed-use: an explicit LLM judgment (true/false) is authoritative;
// without it, an inherently-observed source type still requires an observed signal.
function resolveObserved(item, source, llm) {
  if (typeof llm.observed_use === "boolean") return llm.observed_use;
  return isInherentlyObserved(source.source_type) && hasObservedSignal(item);
}

/**
 * Run the deterministic admissibility gate.
 * @returns {{ admissibility, hard_fail_reasons[], context_reason }}
 */
export function checkAdmissibility(item, source, llm = {}) {
  const reasons = [];
  const fact = (item.fact || item.claim || "").trim();

  if (!isTraceable(source)) reasons.push("no_traceable_source");
  if (!hasQuoteAnchor(item)) reasons.push("no_verified_quote_or_anchor");
  if (!isAtomic(item)) reasons.push("not_atomic");
  if (!isSpecific(item)) reasons.push("generic_or_too_short");
  if (MARKETING.test(fact)) reasons.push("marketing_language");
  // Speculation is only a hard fail when there is no concrete demonstration to anchor it.
  if (SPECULATION.test(fact) && llm.direct_demonstration !== true && !(item.numbers || []).length) {
    reasons.push("unsupported_speculation");
  }
  // Source-type mismatch (LLM judgement; default true unless explicitly false).
  if (llm.source_type_fit === false) reasons.push("source_type_mismatch");

  if (reasons.length > 0) {
    return { admissibility: "failed", hard_fail_reasons: reasons, context_reason: null };
  }

  // Quote-entailment floor (L5A quote verification, when present on the item).
  // The deterministic quote check (extractEvidenceItems → applyQuoteVerification)
  // decides whether the source_quote actually SUPPORTS the fact — not merely that
  // a quote exists. A fact whose quote does not entail it (or changes its meaning)
  // can never be admissible; an overstated / only-partially-supported fact is
  // capped at context_only. This floor can only DOWNGRADE, never upgrade.
  const qv = item.quote_verification;
  if (qv && (qv.quote_entailment === "unsupported" || qv.claim_preservation === "changed_meaning")) {
    return { admissibility: "failed", hard_fail_reasons: ["quote_does_not_entail_fact"], context_reason: null };
  }
  const quoteOverreach = !!qv &&
    (qv.claim_preservation === "overstated" || qv.quote_entailment === "partially_supported");

  // Passed the hard gates. If it isn't a concrete demonstration but is useful for
  // framing, it is context_only rather than proof. An overstated / partially
  // supported quote is likewise capped at context_only.
  //
  // No-judgment path: when the LLM judge did NOT run (no-LLM / skipped / partial),
  // do NOT default to proof. Fall back to DETERMINISTIC inference — proof requires a
  // concrete anchor (named entity or number) and a demonstrable evidence type. This
  // stops an un-judged generic fact from being treated as a directly-demonstrated,
  // concrete claim simply because no judge contradicted it.
  const concrete = typeof llm.concrete_claim === "boolean"
    ? llm.concrete_claim : inferConcreteClaim(item);
  const directDemo = typeof llm.direct_demonstration === "boolean"
    ? llm.direct_demonstration : inferDirectDemonstration(item);
  const isProof = concrete && directDemo;
  if (!isProof || quoteOverreach) {
    return {
      admissibility: "context_only",
      hard_fail_reasons: [],
      context_reason: quoteOverreach ? "quote_overstates_or_partially_supports_fact" : "useful_for_framing_not_proof",
    };
  }
  return { admissibility: "passed", hard_fail_reasons: [], context_reason: null };
}

// ── Limitations (LLM-supplied + deterministic additions) ──────────────────────

function deriveLimitations(item, source, llm = {}) {
  const set = new Set((llm.limitations || []).filter((l) => VALID_LIMITATIONS.has(l)));

  const isMultiSource = item.evidence_cluster?.is_multi_source === true;
  if (!isMultiSource) set.add("single_source");

  const isRep = item.evidence_cluster?.is_representative !== false;
  if (!isRep) set.add("duplicate_reporting");

  if (llm.source_type_fit === false) set.add("weak_source_type_fit");

  const st = source.source_type;
  const hasNumbers = (item.numbers || []).length > 0 || /\d+%|\$[\d,.]+/.test(item.fact || "");
  if ((st === "benchmark_evaluation") && !hasNumbers) set.add("missing_quantitative_detail");

  if (item.evidence_confidence === "low" && !isMultiSource) set.add("no_operational_observation");

  return [...set];
}

// ── Permitted uses (deterministic, bounded by source-type permissions) ────────

// Emerging-but-unmapped threats (novel techniques with no taxonomy fit) are
// preserved as evidence but may only provide framing — they cannot anchor broad
// trend or adoption claims until corroborated and mapped to a taxonomy tag.
const EMERGING_ALLOWED_USES = new Set([
  "context_only", "case_study", "outlook_input", "recommendation_input",
]);

function derivePermittedUses(item, source, admissibility, llm = {}) {
  if (admissibility === "failed") return ["not_used"];
  if (admissibility === "context_only") return ["context_only"];

  const perms = permissionsFor(source.source_type);
  // Observed real-world use. An explicit LLM judgement (true OR false) is authoritative
  // and can REVOKE the inherently-observed default — e.g. a threat-intel item that is
  // actually speculation about future actor behaviour gets observed_use=false and so
  // loses adoption_support. When the LLM did NOT judge it (no-LLM / skipped), an
  // inherently-observed source type STILL needs an observed signal in the item itself
  // (named actor or observation verb) before it is treated as observed (5A.4).
  const observed = resolveObserved(item, source, llm);
  const uses = [];
  for (const use of perms.can_support) {
    // adoption_support (and other observed-gated uses) require observed real-world use.
    if (USES_REQUIRING_OBSERVED_USE.has(use) && !observed) continue;
    if (requiresObservedUse(source.source_type, use) && !observed) continue;
    uses.push(use);
  }
  if (!uses.includes("context_only")) uses.push("context_only");

  // Emerging/unmapped restriction: keep only framing-level uses.
  if (source.taxonomy_validation_status === "emerging_unmapped") {
    const restricted = uses.filter((u) => EMERGING_ALLOWED_USES.has(u));
    if (!restricted.includes("context_only")) restricted.push("context_only");
    return restricted;
  }

  return uses.length ? uses : ["context_only"];
}

// ── Strength (Part 1.3) ───────────────────────────────────────────────────────

function deriveStrength(item, source, admissibility, permittedUses, limitations, llm = {}) {
  if (admissibility === "failed") return "archive";
  if (admissibility === "context_only") return "context";

  const operationalUses = permittedUses.filter((u) => u !== "context_only" && u !== "not_used");
  if (operationalUses.length === 0) return "context";

  const directDemo = llm.direct_demonstration ?? inferDirectDemonstration(item);
  const concrete   = llm.concrete_claim ?? inferConcreteClaim(item);
  const permissionClear = canBeStrong(source.source_type) && llm.source_type_fit !== false;
  const blockingForStrength = limitations.includes("weak_source_type_fit") ||
    limitations.includes("conflicting_evidence");

  if (permissionClear && directDemo && concrete && !blockingForStrength) {
    return "strong";
  }
  return "usable";
}

// ── Significance axis (separate from reliability) ─────────────────────────────
//
// Reliability (evidence_strength) answers "how trustworthy?". These answer "how much
// does it MATTER?" — so selection/criticality can prefer a pivotal-but-usable signal
// over a routine-but-strong fact. Deterministic, no scores.

// uniqueness ∈ { sole_support, corroborated, duplicative }
function deriveUniqueness(item) {
  const isRep   = item.evidence_cluster?.is_representative !== false;
  const isMulti = item.evidence_cluster?.is_multi_source === true;
  if (!isRep) return "duplicative";
  if (isMulti) return "corroborated";
  return "sole_support";
}

// materiality ∈ { novel, escalating, confirming, redundant }
function deriveMateriality(item, source, llm, uniqueness) {
  if (uniqueness === "duplicative") return "redundant";
  const novel =
    source.taxonomy_validation_status === "emerging_unmapped" ||
    source.relevance_path === "novelty_signal" ||
    item.rawfact_taxonomy?.novelty === "novel" ||
    item.rawfact_taxonomy?.novelty === "new_technique";
  if (novel) return "novel";
  const et = item.evidence_type || "";
  if (et === "capability_delta") return "escalating";
  if (et === "adversary_adoption" && llm.observed_use === true) return "escalating";
  return "confirming";
}

function inferDirectDemonstration(item) {
  const t = item.evidence_type || "";
  return ["incident_event", "exploit_chain", "attack_method", "vulnerability_fact",
    "benchmark_result", "capability_delta", "threat_actor_activity", "adversary_adoption"].includes(t);
}
function inferConcreteClaim(item) {
  const hasNumbers = (item.numbers || []).length > 0 || /\d+%|\$[\d,.]+/.test(item.fact || "");
  const hasEntities = (item.entities || []).length > 0;
  return hasNumbers || hasEntities;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Triage one evidence item. `llm` carries optional semantic judgements.
 */
export function triageEvidenceItem(item, source, llm = {}) {
  const st = source.source_type || "unknown";
  const { admissibility, hard_fail_reasons, context_reason } = checkAdmissibility(item, source, llm);
  const limitations = admissibility === "failed" ? [] : deriveLimitations(item, source, llm);
  const permitted_uses = derivePermittedUses(item, source, admissibility, llm);
  const evidence_strength = deriveStrength(item, source, admissibility, permitted_uses, limitations, llm);

  const reasoningBits = [];
  if (hard_fail_reasons.length) reasoningBits.push(`admissibility failed: ${hard_fail_reasons.join(", ")}`);
  if (context_reason) reasoningBits.push(context_reason);
  reasoningBits.push(`strength=${evidence_strength}`);
  if (limitations.length) reasoningBits.push(`limitations: ${limitations.join(", ")}`);

  const uniqueness  = deriveUniqueness(item);
  const materiality = deriveMateriality(item, source, llm, uniqueness);

  return {
    evidence_id: item.evidence_id || item.id || null,
    source_id: source.id || item.source_id || null,
    source_type: st,
    admissibility,
    source_type_fit: llm.source_type_fit ?? (st !== "unknown"),
    direct_demonstration: llm.direct_demonstration ?? inferDirectDemonstration(item),
    concrete_claim: llm.concrete_claim ?? inferConcreteClaim(item),
    evidence_strength,
    permitted_uses,
    limitations,
    observed_use: resolveObserved(item, source, llm),
    // Significance axis — separate from reliability (evidence_strength).
    uniqueness,
    materiality,
    reasoning: llm.reasoning || reasoningBits.join("; "),
  };
}

/**
 * Triage a batch. `llmByEvidenceId` optionally maps evidence_id → semantic fields.
 */
export function triageEvidenceItems(items, source, llmByEvidenceId = {}) {
  return (items || []).map((it) => triageEvidenceItem(it, source, llmByEvidenceId[it.evidence_id] || {}));
}

/** Map categorical evidence_strength → legacy band (for downstream compatibility). */
export function strengthToLegacyBand(strength) {
  switch (strength) {
    case "strong":  return "high";          // strong evidence ITEMS never get critical (claims do)
    case "usable":  return "medium";
    case "context": return "low";
    default:        return "archive_only";
  }
}
