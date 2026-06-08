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

  // Passed the hard gates. If it isn't a concrete demonstration but is useful for
  // framing, it is context_only rather than proof.
  const isProof = (llm.concrete_claim ?? true) && (llm.direct_demonstration ?? true);
  if (!isProof) {
    return { admissibility: "context_only", hard_fail_reasons: [], context_reason: "useful_for_framing_not_proof" };
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

function derivePermittedUses(source, admissibility, llm = {}) {
  if (admissibility === "failed") return ["not_used"];
  if (admissibility === "context_only") return ["context_only"];

  const perms = permissionsFor(source.source_type);
  // Observed real-world use. An explicit LLM judgement (true OR false) is authoritative
  // and can REVOKE the inherently-observed default — e.g. a threat-intel item that is
  // actually speculation about future actor behaviour gets observed_use=false and so
  // loses adoption_support. Only when the LLM did not judge it (undefined) do we fall
  // back to whether the source type is inherently observed (incident / threat_intel /
  // adversary_adoption_signal).
  const observed = llm.observed_use ?? isInherentlyObserved(source.source_type);
  const uses = [];
  for (const use of perms.can_support) {
    // adoption_support (and other observed-gated uses) require observed real-world use.
    if (USES_REQUIRING_OBSERVED_USE.has(use) && !observed) continue;
    if (requiresObservedUse(source.source_type, use) && !observed) continue;
    uses.push(use);
  }
  if (!uses.includes("context_only")) uses.push("context_only");
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
  const permitted_uses = derivePermittedUses(source, admissibility, llm);
  const evidence_strength = deriveStrength(item, source, admissibility, permitted_uses, limitations, llm);

  const reasoningBits = [];
  if (hard_fail_reasons.length) reasoningBits.push(`admissibility failed: ${hard_fail_reasons.join(", ")}`);
  if (context_reason) reasoningBits.push(context_reason);
  reasoningBits.push(`strength=${evidence_strength}`);
  if (limitations.length) reasoningBits.push(`limitations: ${limitations.join(", ")}`);

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
    observed_use: llm.observed_use ?? isInherentlyObserved(st),
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
