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
//
// DESIGN PRINCIPLE: Deterministic code handles mechanics. LLMs handle meaning.
//
// The following regex patterns were REMOVED in the semantic refactor:
//
//   GENERIC_OPENER = /^(ai|ml|llm|attackers?)\s+(can|may|will|are)\b/i
//     → This was a semantic check ("is this a generic statement?")
//     → Now handled by LLM judgment: triage_judgment.concrete_claim=false
//
//   MARKETING = /\b(best-in-class|industry-leading|revolutionary)\b/i
//     → This was a semantic check ("is this marketing language?")
//     → Now handled by LLM judgment: triage_judgment.source_type_fit=false
//       or triage_judgment.support_level="vendor_claim"
//
//   SPECULATION = /\b(may|might|could|possibly)\s+[a-z]|.../i
//     → This was a semantic check ("is this unsupported speculation?")
//     → Now handled by LLM judgment: triage_judgment.direct_demonstration=false
//       + triage_judgment.support_level="prediction"
//
// These checks are now made by the LLM in judgeEvidenceItems.js and enforced
// via the LLM judgment fields below — not via regex pattern matching.
//
// The fallback path (when LLM hasn't run) still uses deterministic inference
// from concrete signals (entities, numbers, evidence_type) — not language regex.

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
  // MECHANICAL check only: minimum length requirement
  // REMOVED: GENERIC_OPENER regex check ("AI can be used to..." patterns)
  // Semantic specificity (is this generic?) is now judged by the LLM:
  //   triage_judgment.concrete_claim=false → item becomes context_only, not failed
  if (fact.length < 25) return false;
  return true;
}

// A source detected as non-English: the extracted English fact is an LLM translation,
// not a verbatim-grounded English claim. Without a verified translation it must not
// anchor a claim. Reads either the validity verdict or the carried filter flag.
function isNonEnglishSource(source) {
  return source?.detected_language === "non_english" ||
    (source?.filter_flags || []).includes("possible_non_english");
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
 * Run the admissibility gate.
 *
 * MECHANICAL checks (always run, no LLM):
 *   - Source is traceable (has URL or source_id)
 *   - Quote is present (quote_verification.quote_exists)
 *   - Fact is atomic (not compound)
 *   - Fact is specific (not too short)
 *   - Source-type fit (from LLM: triage_judgment.source_type_fit)
 *
 * SEMANTIC checks (use LLM judgment fields, never regex):
 *   - Quote support (from LLM: triage_judgment.quote_support replaces old token-overlap)
 *   - Generic/marketing/speculation (from LLM: concrete_claim, direct_demonstration,
 *     support_level) — NOT from GENERIC_OPENER / MARKETING / SPECULATION regex
 *
 * When LLM judgment is absent, falls back to structural inference (concrete entities,
 * numbers, evidence_type). This is a conservative fallback — it does NOT use regex
 * to simulate semantic meaning.
 *
 * @returns {{ admissibility, hard_fail_reasons[], context_reason }}
 */
export function checkAdmissibility(item, source, llm = {}) {
  const reasons = [];
  const fact = (item.fact || item.claim || "").trim();

  // ── MECHANICAL hard-fail checks ───────────────────────────────────────────
  if (!isTraceable(source)) reasons.push("no_traceable_source");
  if (!hasQuoteAnchor(item)) reasons.push("no_verified_quote_or_anchor");
  if (!isAtomic(item)) reasons.push("not_atomic");
  if (!isSpecific(item)) reasons.push("generic_or_too_short");

  // ── LLM-based source-type fit check ──────────────────────────────────────
  // Source-type mismatch: LLM judgment is authoritative.
  // REMOVED: MARKETING regex — the LLM catches marketing via source_type_fit=false
  // or support_level="vendor_claim"
  if (llm.source_type_fit === false) reasons.push("source_type_mismatch");

  // ── LLM-based support level check ────────────────────────────────────────
  // REMOVED: SPECULATION regex and GENERIC_OPENER regex
  // If the LLM explicitly says "unsupported" support level → hard fail
  if (llm.support_level === "unsupported") {
    reasons.push("llm_judged_unsupported");
  }

  if (reasons.length > 0) {
    return { admissibility: "failed", hard_fail_reasons: reasons, context_reason: null };
  }

  // ── Quote support gate (SEMANTIC — uses LLM judgment, not token overlap) ──
  // triage_judgment.quote_support is set by judgeEvidenceItems.js (LLM call).
  // REPLACES: quote_verification.quote_entailment (which was a token-overlap heuristic).
  //
  // Fallback: if judgment ran but quote_support missing, check mechanical existence.
  const qv  = item.quote_verification;
  const qSupport = llm.quote_support;  // from triage_judgment (LLM semantic)

  // Hard fail: LLM explicitly says quote does not support the fact
  if (qSupport === "does_not_support") {
    return { admissibility: "failed", hard_fail_reasons: ["llm_quote_does_not_support_fact"], context_reason: null };
  }

  // Backward compat: mechanical existence check (quote_verification.quote_exists)
  // This is the ONLY thing quote_verification still sets — presence, not entailment.
  if (qv && !qv.quote_exists) {
    return { admissibility: "failed", hard_fail_reasons: ["quote_not_found_in_source"], context_reason: null };
  }

  // Downgrade to context_only when:
  //   - LLM says quote overstates scope (fact claims more than quote supports)
  //   - LLM says quote only partially supports the fact
  const quoteOverreach = qSupport === "overstates_scope" || qSupport === "partially_supports";

  // Legacy path: if judgment didn't run and old quote_verification had entailment
  // fields set, honor them for backward compat (old items in DB).
  const legacyOverreach = !qSupport && !!qv &&
    (qv.claim_preservation === "overstated" || qv.quote_entailment === "partially_supported");
  const legacyFail = !qSupport && !!qv &&
    (qv.quote_entailment === "unsupported" || qv.claim_preservation === "changed_meaning");
  if (legacyFail) {
    return { admissibility: "failed", hard_fail_reasons: ["quote_does_not_entail_fact_legacy"], context_reason: null };
  }
  const effectiveOverreach = quoteOverreach || legacyOverreach;

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
  // Non-English source: the English fact is a translation, not English-quote-grounded.
  // Cap at context_only — it may provide framing/citation but cannot anchor a claim
  // until a verified translation exists.
  const nonEnglish = isNonEnglishSource(source);

  // Hype-flag gate: if the item's own text is dramatic language with no concrete
  // anchor (concreteness_level="low" + hype_flag=true from normalization) AND the
  // LLM judge says concrete_claim=false, cap at context_only. A vendor blog
  // screaming "unprecedented threats" is framing, not proof.
  const hypedNoAnchor = item.hype_flag === true &&
    item.concreteness_level === "low" &&
    llm.concrete_claim === false;

  const isProof = concrete && directDemo;
  if (!isProof || effectiveOverreach || nonEnglish || hypedNoAnchor) {
    return {
      admissibility: "context_only",
      hard_fail_reasons: [],
      context_reason: nonEnglish ? "non_english_source_translation"
        : effectiveOverreach ? "quote_overstates_or_partially_supports_fact"
        : hypedNoAnchor ? "hype_language_without_concrete_anchor"
        : "useful_for_framing_not_proof",
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

  if (isNonEnglishSource(source)) set.add("non_english_source");

  // Low-concreteness items cannot contribute to trend claims — only context/framing.
  // This is enforced on the permitted_uses side below, but the limitation tag helps
  // downstream consumers explain WHY the item is framing-only.
  if (item.concreteness_level === "low") set.add("low_concreteness");

  return [...set];
}

// ── Permitted uses (deterministic, bounded by source-type permissions) ────────

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

  // Low-concreteness items cannot contribute to trend claims. Remove trend_input
  // from permitted uses so the trend gate cannot count them.
  if (item.concreteness_level === "low") {
    const filtered = uses.filter((u) => u !== "trend_input");
    return filtered.length ? filtered : ["context_only"];
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

// ── applyHypeCap REMOVED (2026-06-17) ────────────────────────────────────────
// Hype-flag strength capping was arbitrary deterministic semantic grading:
//   hype_flag=true + concreteness_level="low"  → cap strong→usable
//   source_credibility_signal="vendor_marketing" → cap strong→usable
//
// This created fake precision. A vendor blog with a named CVE and measured ASR
// was automatically penalized by regex-derived hype counts.
//
// The semantic_review_status system (Item 3) now handles non-inherent unreviewed
// items conservatively. Actual strength for reviewed items comes from the LLM
// judge (triage_judgment.direct_demonstration + triage_judgment.concrete_claim).
//
// hype_flag remains on items as debug metadata only (used in slide QA
// for the evidence-driven hype warning), but cannot cap evidence_strength.
//
// WEAK_CREDIBILITY_SIGNALS also removed. Source credibility is LLM-assessed
// via triage_judgment.source_type_fit and triage_judgment.support_level.

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

// ── Item 3: semantic_review_status ───────────────────────────────────────────
// Classifies how much semantic judgment has been applied to an evidence item.
//
//   reviewed            — LLM judgment ran and provided quote_support + support_level
//   fallback_unreviewed — LLM skipped; deterministic inference used (conservative)
//   review_required     — structural signals suggest load-bearing potential but no
//                         LLM judgment; flag for prioritized focused review (item 4)
//
// STRENGTH CAP (all non-reviewed items):
//   - evidence_strength capped at usable (cannot be strong without LLM review)
//   - Exception: inherently-observed types (incident, threat_intelligence, adversary_adoption_signal)
//     retain their full permission set because they ARE observed-use by definition
//
// PERMISSIONS:
//   - Inherently-observed types (incident/threat_intel/adversary_adoption): keep all
//   - fallback_unreviewed non-high-impact types: strip adoption_support + trend_input
//     (too speculative to assert without semantic review)
//
// HIGH-IMPACT detection (sets review_required):
//   Source types that can ground adoption/trend/strategic claims if reviewed:
//     incident, threat_intelligence, adversary_adoption_signal, exploit_disclosure

const HIGH_IMPACT_TYPES = new Set([
  "incident", "threat_intelligence", "adversary_adoption_signal", "exploit_disclosure",
]);

function deriveSemanticReviewStatus(item, source, llm) {
  const hasLlmJudgment = llm && (
    typeof llm.quote_support === "string" ||
    typeof llm.support_level === "string" ||
    typeof llm.direct_demonstration === "boolean"
  );
  if (hasLlmJudgment) return "reviewed";

  const st = source.source_type || "unknown";
  if (HIGH_IMPACT_TYPES.has(st)) return "review_required";
  return "fallback_unreviewed";
}

// Uses that fallback_unreviewed NON-inherent types cannot claim
// (too speculative without semantic review to verify the quote supports it)
const UNREVIEWED_BLOCKED_USES = new Set(["adoption_support", "trend_input"]);

function applySemanticReviewCap(admissibility, permitted_uses, evidence_strength, reviewStatus, sourceType) {
  if (reviewStatus === "reviewed") return { admissibility, permitted_uses, evidence_strength };

  // Inherently-observed types (incident, threat_intel, adversary_adoption_signal) have
  // structural certainty — they report real events by definition. These retain both their
  // strength and permissions without LLM review, because the source TYPE itself provides
  // the semantic guarantee that non-observed types require LLM judgment to establish.
  // review_required = "flag for item 4 focused review" but does NOT cap them here.
  const isInherent = HIGH_IMPACT_TYPES.has(sourceType);
  if (isInherent) {
    return { admissibility, permitted_uses, evidence_strength };
  }

  // Non-inherent + fallback_unreviewed: two interventions
  //   1. Strength cap: cannot be strong without LLM semantic review
  //   2. Strip load-bearing uses that require semantic verification (adoption/trend)
  const cappedStrength = evidence_strength === "strong" ? "usable" : evidence_strength;
  const cappedUses = permitted_uses
    .filter((u) => !UNREVIEWED_BLOCKED_USES.has(u));
  if (!cappedUses.includes("context_only")) cappedUses.push("context_only");

  return {
    admissibility,
    permitted_uses: [...new Set(cappedUses)],
    evidence_strength: cappedStrength,
  };
}

/**
 * Triage one evidence item. `llm` carries optional semantic judgements.
 */
export function triageEvidenceItem(item, source, llm = {}) {
  const st = source.source_type || "unknown";
  const { admissibility, hard_fail_reasons, context_reason } = checkAdmissibility(item, source, llm);
  const limitations = admissibility === "failed" ? [] : deriveLimitations(item, source, llm);
  const permitted_uses = derivePermittedUses(item, source, admissibility, llm);
  const base_strength = deriveStrength(item, source, admissibility, permitted_uses, limitations, llm);

  // Item 3: semantic_review_status and load-bearing cap for unreviewed items
  const semantic_review_status = deriveSemanticReviewStatus(item, source, llm);
  const { permitted_uses: final_uses, evidence_strength } = applySemanticReviewCap(
    admissibility, permitted_uses, base_strength, semantic_review_status, st
  );

  // Record cap reason when non-inherent items were capped from strong→usable
  const isInherentSource = HIGH_IMPACT_TYPES.has(st);
  if (!isInherentSource && semantic_review_status !== "reviewed" && base_strength === "strong") {
    limitations.push("semantic_review_required_for_strong");
  }

  const reasoningBits = [];
  if (hard_fail_reasons.length) reasoningBits.push(`admissibility failed: ${hard_fail_reasons.join(", ")}`);
  if (context_reason) reasoningBits.push(context_reason);
  reasoningBits.push(`strength=${evidence_strength}`);
  if (semantic_review_status !== "reviewed") reasoningBits.push(`review_status=${semantic_review_status}`);
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
    permitted_uses: final_uses,
    limitations,
    observed_use: resolveObserved(item, source, llm),
    semantic_review_status,   // Item 3: reviewed | fallback_unreviewed | review_required
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
