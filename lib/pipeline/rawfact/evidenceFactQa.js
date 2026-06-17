/**
 * Evidence Fact QA — derives support classification from LLM judgment fields.
 *
 * ── DESIGN PRINCIPLE ──────────────────────────────────────────────────────────
 * This module was refactored to remove ~20 regex patterns that were making
 * SEMANTIC decisions about claim type, over-interpretation, and support level.
 *
 * OLD APPROACH (removed):
 *   - PREDICTION_PATTERNS regex → classified "prediction" claims
 *   - OPINION_PATTERNS regex → classified "opinion" claims
 *   - OVER_ADOPTION_FACT_PATTERNS regex → detected lab claims presented as real-world
 *   - RESEARCH_SCOPE_QUOTE_PATTERNS regex → detected scope mismatch
 *   - ABSOLUTE_FACT_PATTERNS regex → detected over-statement
 *   - HEDGED_QUOTE_PATTERNS regex → detected hedged quotes
 *   - SPECIFIC_VICTIM_PATTERNS regex → detected attribution claims
 *   - keyNounOverlap threshold → semantic entailment check
 *
 * NEW APPROACH:
 *   Derive from LLM judgment fields set by judgeEvidenceItems.js:
 *     triage_judgment.quote_support  — semantic quote support assessment
 *     triage_judgment.support_level  — claim type classification
 *     triage_judgment.direct_demonstration — was it actually demonstrated?
 *     triage_judgment.observed_use   — real-world adversary use confirmed?
 *     triage_judgment.source_type_fit — does source type match what's claimed?
 *     triage_judgment.limitations[]  — applicable caveats
 *
 * ── WHAT REMAINS DETERMINISTIC ────────────────────────────────────────────────
 *   blocked_uses[] derivation from support_level — pure rules, no semantics
 *   required_caveats[] derivation from limitations[] and support_level — pure rules
 *   corrected_fact_text — uses LLM-judged over_interpreted flag, applies simple substitutions
 */

// ── Blocked uses per support level ───────────────────────────────────────────
// These are deterministic RULES derived from semantic labels, not regex patterns.

const BLOCKED_USES_BY_SUPPORT = {
  // LLM-assigned semantic labels (from triage_judgment.support_level):
  vendor_claim:          ["adoption_support", "trend_input", "real_world_factual", "market_wide"],
  prediction:            ["adoption_support", "trend_input", "real_world_factual", "fact_support", "case_study"],
  opinion:               ["adoption_support", "trend_input", "real_world_factual", "fact_support"],
  unsupported:           ["adoption_support", "trend_input", "real_world_factual", "fact_support", "case_study", "capability_support"],
  research_finding:      ["adoption_support"],
  // Fallback sentinel — no LLM review ran. Block all load-bearing uses.
  // The semantic_review_status system (evidenceTriage.js) also gates this.
  fallback_unreviewed:   ["adoption_support", "trend_input", "real_world_factual", "fact_support", "case_study"],
};

// ── Over-interpretation corrections ──────────────────────────────────────────
// Applied only when LLM judges quote_support="overstates_scope" to produce
// a corrected_fact_text. Simple substitutions — not semantic analysis.

const OVER_INTERPRETATION_REPLACEMENTS = [
  [/\badversaries are (using|deploying|launching|leveraging)\b/gi, "research suggests adversaries may use"],
  [/\battackers are (using|deploying|launching|leveraging)\b/gi,   "research suggests attackers may deploy"],
  [/\bthreat actors are (using|deploying|leveraging)\b/gi,         "research suggests threat actors may leverage"],
  [/\bwidespread adoption\b/gi,          "observed adoption in some contexts"],
  [/\ball (systems|models|organizations)\b/gi, "tested systems"],
  [/\beveryone\b/gi,                     "many"],
  [/\balways\b/gi,                       "frequently"],
  [/\bconfirmed\b/gi,                    "observed"],
];

// ── Fallback sentinel (no LLM judgment) ──────────────────────────────────────
//
// When the LLM evidence judge did NOT run (skipLlm or LLM failure), we cannot
// make semantic claims about support level. The previous approach assigned labels
// like "research_finding", "vendor_claim", "direct_fact" from source_type alone —
// this was deterministic semantic grading (REMOVED 2026-06-17).
//
// The new approach: return "fallback_unreviewed" to signal that the field was not
// semantically judged. Downstream gates treat this as context_only:
//   - semantic_review_status = "fallback_unreviewed" → caps strength at usable
//   - claim permissions gate: fallback_unreviewed → no adoption/trend/strategic
//
// Empty source_quote is still a hard structural fact (no grounding available).
//
// NOTE: inferQuoteSupport is also removed. Mechanical quote_exists check is
// handled by admissibility gate (checkAdmissibility), not here. Semantic
// quote support comes only from triage_judgment.quote_support (LLM field).

const FALLBACK_SUPPORT_LEVEL  = "fallback_unreviewed";
const FALLBACK_QUOTE_SUPPORT  = "not_reviewed";   // sentinel: LLM did not assess

function inferSupportLevel(item) {
  // Empty source_quote: hard structural fact — no quote means nothing to ground claim on
  if (!item.source_quote?.trim()) return "unsupported";
  // LLM did not assess semantic support — cannot infer from source_type alone
  return FALLBACK_SUPPORT_LEVEL;
}

function inferQuoteSupport() {
  // LLM did not assess — return sentinel. Quote_entailment from old quote_verification
  // was token-overlap which is fake precision (removed). Admissibility gate handles
  // mechanical quote presence; semantic support requires triage_judgment.quote_support.
  return FALLBACK_QUOTE_SUPPORT;
}

// ── Required caveats ─────────────────────────────────────────────────────────

function deriveRequiredCaveats(support_level, over_interpreted, item) {
  const caveats = [];
  const lims = item.triage_judgment?.limitations || item.limitations || [];

  if (support_level === "vendor_claim") {
    caveats.push("vendor-reported: independently verify before citing as fact");
  }
  if (support_level === "prediction") {
    caveats.push("forward-looking: not an observed fact");
  }
  if (support_level === "opinion") {
    caveats.push("opinion/analysis: not directly demonstrated");
  }
  if (support_level === "research_finding") {
    caveats.push("research/lab finding: real-world adversary adoption not established");
  }
  if (support_level === "unsupported") {
    caveats.push("unsupported: quote does not support this claim");
  }
  if (support_level === "fallback_unreviewed") {
    caveats.push("evidence not semantically reviewed — LLM judge did not run; load-bearing uses blocked");
  }
  if (over_interpreted) {
    caveats.push("fact text has been hedged to match quote scope — use corrected_fact_text");
  }
  if (item.hype_flag) {
    caveats.push("hype language detected: dramatic wording not anchored in concrete evidence");
  }
  if (lims.includes("lab_only")) {
    caveats.push("lab only: no real-world operational confirmation");
  }
  if (lims.includes("single_source")) {
    caveats.push("single source: corroboration recommended before use in trend/adoption claims");
  }
  if (lims.includes("vendor_self_reported")) {
    caveats.push("vendor self-reported: treat as vendor_claim");
  }

  return [...new Set(caveats)];
}

// ── Main classification function ──────────────────────────────────────────────

/**
 * Classify the support status of an evidence item.
 *
 * Derives from LLM judgment fields (triage_judgment) when available.
 * Falls back to structural inference when LLM didn't run.
 *
 * @param {object} item - Evidence item (must have triage_judgment after judgeEvidenceItems)
 * @returns {{
 *   support_level: string,
 *   quote_entailment: "direct"|"partial"|"weak"|"none",
 *   over_interpreted: boolean,
 *   requires_caveat: boolean,
 *   corrected_fact_text: string,
 *   blocked_uses: string[],
 *   required_caveats: string[],
 * }}
 */
export function classifyFactSupport(item) {
  const j          = item.triage_judgment || {};
  const fact       = item.fact || "";

  // ── Support level: LLM judgment is authoritative ───────────────────────────
  // When the LLM ran (judgeEvidenceItems.js), j.support_level is a semantic label.
  // When the LLM did NOT run, inferSupportLevel returns "fallback_unreviewed" or
  // "unsupported" (for empty quote). This sentinel gates downstream permission gates.
  const support_level = j.support_level || inferSupportLevel(item);

  // ── Quote support: LLM judgment is authoritative ───────────────────────────
  // triage_judgment.quote_support is set by judgeEvidenceItems.js (LLM semantic).
  // Fallback: "not_reviewed" sentinel (LLM did not assess). This is structurally
  // different from "partially_supports" — it means we don't know.
  const quote_support_llm = j.quote_support || inferQuoteSupport();

  // ── quote_entailment: map LLM quote_support → 4-level entailment scale ────
  // Purely mechanical mapping from LLM-assigned label to entailment enum.
  // "not_reviewed" maps to "partial" (conservative: don't block, but don't confirm).
  const QUOTE_SUPPORT_TO_ENTAILMENT = {
    directly_supports:    "direct",
    partially_supports:   "partial",
    does_not_support:     "none",
    overstates_scope:     "partial",  // has some support but overstates it
    not_reviewed:         "partial",  // LLM sentinel: unknown, treat conservatively
  };
  const quote_entailment = QUOTE_SUPPORT_TO_ENTAILMENT[quote_support_llm] ?? "partial";

  // ── Over-interpreted: from LLM judgment ──────────────────────────────────
  // The LLM's quote_support="overstates_scope" replaces the old regex patterns
  // (OVER_ADOPTION_FACT_PATTERNS, ABSOLUTE_FACT_PATTERNS, etc.)
  const over_interpreted = quote_support_llm === "overstates_scope";

  // ── Blocked uses: deterministic rules on semantic labels ─────────────────
  const blocked_uses = [...(BLOCKED_USES_BY_SUPPORT[support_level] || [])];

  // Additional blocks for over-interpreted items
  if (over_interpreted && support_level !== "direct_fact") {
    if (!blocked_uses.includes("fact_support")) {
      blocked_uses.push("fact_support");
    }
  }

  // Quote not found → block all strong uses
  if (quote_support_llm === "does_not_support") {
    for (const use of ["fact_support", "case_study", "capability_support"]) {
      if (!blocked_uses.includes(use)) blocked_uses.push(use);
    }
  }

  // ── Requires caveat ───────────────────────────────────────────────────────
  const requires_caveat = (
    support_level === "vendor_claim" ||
    support_level === "prediction" ||
    support_level === "opinion" ||
    over_interpreted
  );

  // ── Corrected fact text (only when over_interpreted) ─────────────────────
  let corrected_fact_text = fact;
  if (over_interpreted) {
    for (const [pattern, replacement] of OVER_INTERPRETATION_REPLACEMENTS) {
      corrected_fact_text = corrected_fact_text.replace(pattern, replacement);
    }
  }
  if (support_level === "prediction" && !corrected_fact_text.startsWith("[Projected]")) {
    corrected_fact_text = `[Projected] ${corrected_fact_text}`;
  }
  if (support_level === "vendor_claim" && requires_caveat && !corrected_fact_text.includes("(vendor-reported)")) {
    corrected_fact_text = `${corrected_fact_text} (vendor-reported)`;
  }

  const required_caveats = deriveRequiredCaveats(support_level, over_interpreted, item);

  return {
    support_level,
    quote_entailment,
    over_interpreted,
    requires_caveat,
    corrected_fact_text,
    blocked_uses,
    required_caveats,
  };
}

/**
 * Apply fact QA to all evidence items on a source, attaching item.fact_qa.
 *
 * @param {object[]} sources - Sources with evidence_items[]
 * @returns {object[]} Sources with fact_qa attached to each evidence item
 */
export function applyEvidenceFactQa(sources) {
  return sources.map((source) => {
    const items = (source.evidence_items || []);
    if (items.length === 0) return source;

    const newItems = items.map((item) => {
      const fact_qa = classifyFactSupport(item);
      return { ...item, fact_qa };
    });

    return { ...source, evidence_items: newItems };
  });
}
