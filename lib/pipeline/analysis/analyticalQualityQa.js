/**
 * Analytical Quality QA — L6.4 judgment quality rating + consumption approval tiers
 *
 * Extracted from validateCategoryAnalysis.js so it can be used standalone,
 * imported by buildDashboardIntelPackage, and tested independently.
 *
 * ── QUALITY TIERS ─────────────────────────────────────────────────────────────
 *   strategic    — change + cause + implication + second-order or monitoring + uncertainty
 *   analytical   — change + cause + implication  (minimum for main output)
 *   descriptive  — says what happened, not why or what it means
 *   summary_only — restates evidence, no mechanism or implication
 *   unsupported  — no cited evidence at all
 *
 * ── CONSUMPTION APPROVAL RULES ────────────────────────────────────────────────
 *   approved_for_dashboard   — strategic or analytical, evidence resolves, caveats present
 *   approved_for_slides      — strategic or analytical (may overlap with dashboard)
 *   approved_for_report      — analytical and above
 *   approved_for_chatbot     — analytical and above, evidence_for not empty
 *   approved_for_appendix    — descriptive (context only, not main panels)
 *   blocked                  — summary_only or unsupported
 */

// Minimum meaningful length for a field: 8 chars filters null/""/placeholder values
// like "N/A", "TBD", "None" while accepting short-but-real content like "LLM synthesis",
// "Arms race", "Cost barrier removed". Raised from an earlier 15, which was too strict
// and was blocking genuine 10-15 char causal mechanisms from research-only corpora.
const TRIVIAL_THRESHOLD = 8;

function isTrivial(text) {
  if (!text || typeof text !== "string") return true;
  const t = text.trim();
  if (t.length < TRIVIAL_THRESHOLD) return true;
  // Reject pure placeholder values regardless of length
  if (/^(n\/a|none|tbd|unknown|unclear|not applicable|not set)$/i.test(t)) return true;
  return false;
}

/**
 * Rate the analytical quality of a single strategic judgment.
 * Purely deterministic — reads field presence, not text semantics.
 *
 * @param {object} judgment
 * @returns {"strategic"|"analytical"|"descriptive"|"summary_only"|"unsupported"}
 */
export function rateJudgmentQuality(judgment) {
  if (!judgment.evidence_for?.length && !judgment.supporting_evidence_ids?.length) {
    return "unsupported";
  }
  const hasChange      = !isTrivial(judgment.what_changed);
  const hasCause       = !isTrivial(judgment.causal_mechanism);
  const hasImplication = !isTrivial(judgment.why_this_matters);
  const hasUncertainty = !isTrivial(judgment.uncertainty) || !isTrivial(judgment.caveat_if_any);
  const hasSecondOrder = (judgment.second_order_implications || []).length > 0;
  const hasMonitoring  = (judgment.monitoring_signals || []).length > 0;

  if (!hasChange && !hasCause) return "summary_only";
  if (!hasCause || !hasImplication) return "descriptive";
  if (hasChange && hasCause && hasImplication) {
    if ((hasSecondOrder || hasMonitoring) && hasUncertainty) return "strategic";
    return "analytical";
  }
  return "descriptive";
}

/**
 * Minimum quality tier required for each consumption channel.
 * Any judgment below this tier is not approved for that channel.
 */
const MINIMUM_FOR = {
  dashboard:  "analytical",
  slides:     "analytical",
  report:     "analytical",
  chatbot:    "analytical",
  appendix:   "descriptive",
};

const QUALITY_RANK = {
  unsupported:  0,
  summary_only: 1,
  descriptive:  2,
  analytical:   3,
  strategic:    4,
};

function meetsMinimum(tier, minimum) {
  return (QUALITY_RANK[tier] ?? 0) >= (QUALITY_RANK[minimum] ?? 0);
}

/**
 * Classify a judgment into consumption approval tiers.
 *
 * @param {object} judgment           Strategic judgment from synthesizeCategory
 * @param {object} [context]          Optional context for additional checks
 * @param {string} [context.ceiling]  Category confidence ceiling
 * @returns {{
 *   quality_tier: string,
 *   quality_reasons: string[],
 *   approved_for_dashboard: boolean,
 *   approved_for_slides: boolean,
 *   approved_for_report: boolean,
 *   approved_for_chatbot: boolean,
 *   approved_for_appendix: boolean,
 *   blocked: boolean,
 *   dashboard_rejection_reason: string | null,
 * }}
 */
export function classifyJudgmentTier(judgment, context = {}) {
  const tier    = rateJudgmentQuality(judgment);
  const reasons = [];

  if (tier === "unsupported")  reasons.push("no cited evidence — judgment cannot be verified");
  if (tier === "summary_only") reasons.push("restates evidence without change/cause/implication");
  if (tier === "descriptive")  reasons.push("describes what happened without explaining mechanism or implication");

  // Check caveats when required by judgment_flags
  const flags  = judgment.judgment_flags || {};
  const caveat = judgment.caveat_if_any || "";
  const needsCaveat = flags.implies_adoption || flags.is_market_wide || flags.is_forward_looking;
  const hasCaveat   = caveat.trim().length > 10;
  if (needsCaveat && !hasCaveat) {
    reasons.push("adoption/market_wide/forward-looking judgment requires a caveat — none found");
  }

  // Check confidence doesn't exceed ceiling
  const ceiling    = context.ceiling || null;
  const CONF_RANK  = { high: 3, medium: 2, low: 1, none: 0 };
  const claimConf  = CONF_RANK[judgment.confidence ?? "low"] ?? 0;
  const ceilConf   = CONF_RANK[ceiling] ?? 99; // if no ceiling, allow any
  if (ceiling && claimConf > ceilConf) {
    reasons.push(`confidence "${judgment.confidence}" exceeds category ceiling "${ceiling}"`);
  }

  // Dashboard needs short_takeaway
  const hasShortTakeaway = (judgment.short_takeaway || "").trim().length >= 5;
  const dashboardReady = meetsMinimum(tier, MINIMUM_FOR.dashboard) &&
    !reasons.length && hasShortTakeaway;

  const dashboard_rejection_reason = !dashboardReady
    ? (!hasShortTakeaway && meetsMinimum(tier, "analytical")
        ? "missing short_takeaway field"
        : reasons[0] || `quality_tier "${tier}" below analytical threshold`)
    : null;

  return {
    quality_tier:              tier,
    quality_reasons:           reasons,
    approved_for_dashboard:    dashboardReady,
    approved_for_slides:       meetsMinimum(tier, MINIMUM_FOR.slides)     && !reasons.some((r) => r.includes("ceiling")),
    approved_for_report:       meetsMinimum(tier, MINIMUM_FOR.report),
    approved_for_chatbot:      meetsMinimum(tier, MINIMUM_FOR.chatbot)    && (judgment.evidence_for || []).length > 0,
    approved_for_appendix:     meetsMinimum(tier, MINIMUM_FOR.appendix)   && !meetsMinimum(tier, "analytical"),
    blocked:                   tier === "unsupported" || tier === "summary_only",
    dashboard_rejection_reason,
  };
}

/**
 * Classify all judgments in a category analysis.
 * Returns the judgments enriched with approval tiers.
 *
 * @param {object[]} judgments
 * @param {string}   [confidenceCeiling]
 * @returns {object[]} enriched judgments
 */
export function classifyAllJudgments(judgments, confidenceCeiling) {
  return (judgments || []).map((j) => ({
    ...j,
    ...classifyJudgmentTier(j, { ceiling: confidenceCeiling }),
  }));
}

export const MINIMUM_QUALITY_FOR_MAIN_OUTPUT = "analytical";
