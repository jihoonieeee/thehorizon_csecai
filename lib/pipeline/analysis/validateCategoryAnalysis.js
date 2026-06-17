/**
 * L6 — Deterministic validation of category synthesis output.
 *
 * Handles the new strategic_judgments[] schema from synthesizeCategory.js.
 * The LLM proposes; this module disposes. It:
 *   - resolves every evidence_for/evidence_against ID against the dossier id_index,
 *     drops unresolved IDs, recomputes evidence_origins;
 *   - removes judgments with zero resolved evidence_for;
 *   - enforces adoption / operational / trend language gates;
 *   - applies confidence ceiling from analytical state;
 *   - adds ANALYTICAL QUALITY rating (blocks summary-only outputs);
 *   - validates the 6-month outlook;
 *   - emits validation_report + selected_evidence_by_output.
 *
 * No LLM, no scores. Evidence gate logic reused from prior version, adapted to
 * the new judgment shape (evidence_for[] + evidence_against[] + what_changed +
 * causal_mechanism instead of flat text).
 */

import { checkStatisticalClaims } from "./statisticalClaimQa.js";
import { rateJudgmentQuality, classifyJudgmentTier, MINIMUM_QUALITY_FOR_MAIN_OUTPUT } from "./analyticalQualityQa.js";

const OBSERVED_SOURCE_TYPES = new Set(["incident", "threat_intelligence", "adversary_adoption_signal"]);

// ── Semantic detection patterns — DEBUG-ONLY ─────────────────────────────────
// These patterns are NOT used for load-bearing decisions (2026-06-17 refactor).
// They appear in debug observability: debug_flag_suggestions on validated judgments.
//
// They were formerly used as:
//   1. qaJudgmentFlags — correcting null judgment_flags via regex (REMOVED)
//   2. Legacy fallback — firing when flags absent (REMOVED)
//
// New design: judgment_flags are required. Missing → retry → reject. Gates read
// only from LLM-assigned booleans. Null flag → gate returns false (conservative),
// never triggers regex. These patterns are retained for debug logging only.

const ADOPTION_TERMS    = /\b(adopt(ed|ion|ing)?|in the wild|real[- ]world use|used by (attackers|adversaries|threat actors)|deployed by (attackers|adversaries))\b/i;
const OPERATIONAL_TERMS = /\b(actively exploited|exploited in|attackers? (used|exploited|compromised)|breach(ed)?|ransomware campaign|in production attacks|operational(ly)? (use|deployed))\b/i;
const TREND_HYPE        = /\b(surging|surge|exploding|skyrocket|dominant|widespread|accelerating|rampant|epidemic)\b/i;
const TREND_SCOPE       = /\b(trend|increasingly|growing|rising|on the rise|more (frequent|common)|proliferat|escalating|spik(e|ing)|wave of|year[- ]over[- ]year|month[- ]over[- ]month)\b/i;
const FORWARD_LOOKING_TERMS = /\b(will|would|expected to|projected to|anticipated|forecast|likely to|may increase|could lead)\b/i;
const MARKET_WIDE_TERMS = /\b(widespread|industry[- ]wide|market[- ]wide|all organizations|across the (industry|sector|market))\b/i;

// ── Debug flag suggestions (observability, not decisions) ─────────────────────
// Detects potential mismatches between text and LLM-assigned flags for audit.
// Output goes to debug_flag_suggestions only — never used by validation gates.
// qaJudgmentFlags previously mutated flags; it is now READ-ONLY / debug-only.

function computeDebugFlagSuggestions(judgment) {
  const flags = judgment.judgment_flags;
  if (!flags) return [];

  const allText = [
    judgment.judgment, judgment.what_changed, judgment.causal_mechanism, judgment.why_this_matters,
  ].filter(Boolean).join(" ");

  const suggestions = [];

  // Identify cases where text suggests flag should be true but LLM said false/null.
  // These are debug observations, not corrections.
  if (!flags.implies_adoption && ADOPTION_TERMS.test(allText))
    suggestions.push("text_suggests_implies_adoption (LLM said false/null)");
  if (!flags.implies_operational && OPERATIONAL_TERMS.test(allText))
    suggestions.push("text_suggests_implies_operational (LLM said false/null)");
  if (!flags.implies_trend && TREND_SCOPE.test(allText))
    suggestions.push("text_suggests_implies_trend (LLM said false/null)");
  if (!flags.is_forward_looking && FORWARD_LOOKING_TERMS.test(allText))
    suggestions.push("text_suggests_is_forward_looking (LLM said false/null)");
  if (!flags.is_market_wide && MARKET_WIDE_TERMS.test(allText))
    suggestions.push("text_suggests_is_market_wide (LLM said false/null)");

  return suggestions;
}

// ── Semantic gate helpers — READ FROM LLM FLAGS ONLY ─────────────────────────
// Gates read the LLM-assigned boolean. If flag is null (not set), return false.
// NEVER fire regex as a fallback. Null flag = LLM did not assert this semantic
// property = gate does not fire. This is the conservative, non-inventing path.
//
// Historical note: regex fallback was removed 2026-06-17 to eliminate
// false precision from keyword matching on semantically ambiguous text.

function impliesAdoption(judgment) {
  return judgment.judgment_flags?.implies_adoption === true;
}

function impliesOperational(judgment) {
  return judgment.judgment_flags?.implies_operational === true;
}

function impliesTrend(judgment) {
  return judgment.judgment_flags?.implies_trend === true;
}

function impliesMarketWide(judgment) {
  return judgment.judgment_flags?.is_market_wide === true;
}

const CONF_RANK = { high: 2, medium: 1, low: 0 };
const cap = (conf, max) => (CONF_RANK[conf] ?? 0) > (CONF_RANK[max] ?? 0) ? max : (conf || "low");

function monthOf(date) {
  const m = String(date || "").match(/(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function independentOriginCount(resolved) {
  const origins = new Set();
  for (const r of (resolved || [])) {
    if (r.independence_level === "circular_reporting_risk") continue;
    const key = r.primary_origin_url || r.publisher;
    if (key) origins.add(key);
  }
  return origins.size;
}

// ── Analytical quality rating ─────────────────────────────────────────────────
//
// Rates a strategic judgment on a 5-level scale and blocks those that are
// purely summaries or descriptive restatements of the evidence.
//
// A good judgment MUST include at least:
//   a) a change or tension (what_changed is populated and non-trivial)
//   b) a causal explanation (causal_mechanism is populated and non-trivial)
//   c) a strategic implication (why_this_matters is populated and non-trivial)
//   d) uncertainty or caveat
//   e) supporting evidence
//
// Ratings:
//   summary_only   — just restates evidence; no mechanism or implication
//   descriptive    — says what happened but not why or what it means
//   analytical     — has change + cause + implication
//   strategic      — has all of the above + second_order_implications or monitoring_signals
//   unsupported    — no cited evidence at all

// rateJudgmentQuality and classifyJudgmentTier are imported from analyticalQualityQa.js
// They are re-exported here for backward compatibility with existing test imports.
export { rateJudgmentQuality };

const QUALITY_RANK = { unsupported: 0, summary_only: 1, descriptive: 2, analytical: 3, strategic: 4 };

function qualityPassesGate(rating) {
  return (QUALITY_RANK[rating] ?? 0) >= (QUALITY_RANK[MINIMUM_QUALITY_FOR_MAIN_OUTPUT] ?? 0);
}

// ── Evidence resolution and gating ───────────────────────────────────────────

function resolveIds(ids, idIndex) {
  const resolvedIds = [];
  const resolved    = [];
  const unresolved  = [];
  for (const id of (ids || [])) {
    const meta = idIndex.get(id);
    if (meta) { resolvedIds.push(id); resolved.push(meta); }
    else unresolved.push(id);
  }
  return { resolvedIds, resolved, unresolved };
}

// Normalize judgment_flags: preserve explicit booleans, use null for unset fields.
// null means "LLM did not set this field" → the gate functions fall back to regex.
// false means "LLM explicitly said false" → the gate respects that decision.
// This preserves the regex fallback for fields the LLM omitted while still allowing
// the LLM's explicit false to override regex detection (e.g. suppress false positives).
function normalizeJudgmentFlags(flags) {
  if (!flags) {
    // LLM omitted judgment_flags entirely — all fields are unset (null → regex fallback)
    return {
      implies_adoption:    null,
      implies_operational: null,
      implies_trend:       null,
      is_forward_looking:  null,
      is_market_wide:      null,
      is_lab_only:         null,
    };
  }
  return {
    implies_adoption:    flags.implies_adoption    ?? null,
    implies_operational: flags.implies_operational ?? null,
    implies_trend:       flags.implies_trend       ?? null,
    is_forward_looking:  flags.is_forward_looking  ?? null,
    is_market_wide:      flags.is_market_wide      ?? null,
    is_lab_only:         flags.is_lab_only         ?? null,
  };
}

function resolveAndGateJudgment(judgment, idIndex, report, blockedClaimTypes, allowedStrengthCeiling) {
  const { resolvedIds: forIds, resolved: forResolved, unresolved: forUnresolved } =
    resolveIds(judgment.evidence_for, idIndex);
  const { resolvedIds: againstIds, resolved: againstResolved } =
    resolveIds(judgment.evidence_against, idIndex);

  report.unresolved_ids.push(...forUnresolved);

  // A judgment with no resolved supporting evidence is removed
  if (forResolved.length === 0) return null;

  const allResolved = [...forResolved, ...againstResolved];
  const origins     = [...new Set(allResolved.map((r) => r.origin))];
  let confidence    = judgment.confidence || "low";
  const caveats     = [];
  if (judgment.caveat_if_any) caveats.push(judgment.caveat_if_any);

  // Normalize judgment_flags — preserves explicit booleans, fills null for unset
  const normalizedFlags = normalizeJudgmentFlags(judgment.judgment_flags);

  // Debug: compute regex-based suggestions for observability (NOT used for decisions)
  const debugSuggestions = computeDebugFlagSuggestions({ ...judgment, judgment_flags: normalizedFlags });
  if (debugSuggestions.length > 0) {
    report.flags_debug_suggestions = (report.flags_debug_suggestions || 0) + debugSuggestions.length;
  }

  // Gates use only LLM-assigned flags. Null flag → gate does not fire (conservative).
  // Regex patterns are NOT used as fallback for any gate (removed 2026-06-17).
  const j = { ...judgment, judgment_flags: normalizedFlags };

  const hasObserved = forResolved.some((r) =>
    OBSERVED_SOURCE_TYPES.has(r.source_type) ||
    (r.origin === "5C_external" && r.observed_use === true)
  );
  const r5A = forResolved.filter((r) => r.origin === "5A_rawfact");
  const allContext5A = r5A.length > 0 && r5A.every((r) => r.evidence_strength === "context");

  // Gate 1 — adoption: only fires when LLM explicitly set implies_adoption=true
  if (impliesAdoption(j) && !hasObserved) {
    confidence = cap(confidence, "low");
    caveats.push("adoption not backed by observed-use evidence (incident / threat-intel / adoption signal)");
    report.permission_downgrades++;
  }
  // Gate 2 — operational: only fires when LLM explicitly set implies_operational=true
  if (impliesOperational(j) && allContext5A && !hasObserved) {
    confidence = cap(confidence, "low");
    caveats.push("operational claim supported only by context-level evidence");
    report.permission_downgrades++;
  }
  // Gate 2.5 — corpus-audit blocked claims: reads from LLM flags only
  if (blockedClaimTypes?.size > 0) {
    const impliesBlocked =
      (blockedClaimTypes.has("adoption")          && impliesAdoption(j)) ||
      (blockedClaimTypes.has("real_world_factual") && impliesOperational(j)) ||
      (blockedClaimTypes.has("market_wide")        && impliesMarketWide(j)) ||
      (blockedClaimTypes.has("trend_over_time")    && impliesTrend(j));
    if (impliesBlocked) {
      confidence = cap(confidence, "low");
      caveats.push("implied claim type is blocked by corpus audit — confidence capped to low");
      report.blocked_by_corpus_audit = (report.blocked_by_corpus_audit || 0) + 1;
    }
  }
  // Gate 2.6 — analytical state confidence ceiling
  if (allowedStrengthCeiling) {
    const ceilingConf = allowedStrengthCeiling === "none" ? "low" : allowedStrengthCeiling;
    if ((CONF_RANK[confidence] ?? 0) > (CONF_RANK[ceilingConf] ?? 0)) {
      confidence = ceilingConf;
      caveats.push(`confidence capped by analytical state ceiling (${allowedStrengthCeiling})`);
      report.permission_downgrades++;
    }
  }
  // Gate 3 — single-origin, single-item → cannot be high confidence
  if (forResolved.length === 1 && confidence === "high") {
    confidence = "medium";
    report.permission_downgrades++;
  }
  // Gate 4 — trend: only fires when LLM explicitly set implies_trend=true
  if (impliesTrend(j)) {
    const independentOrigins = independentOriginCount(forResolved);
    const months     = new Set(forResolved.map((r) => monthOf(r.date)).filter(Boolean));
    const trendOk    = forResolved.length >= 3 && independentOrigins >= 2 && months.size >= 2;
    if (!trendOk) {
      confidence = cap(confidence, "medium");
      caveats.push("trend-scope claim not supported by ≥3 items across ≥2 independent sources and ≥2 months");
      report.permission_downgrades++;
    }
  }

  // Analytical quality gate
  const quality = rateJudgmentQuality(judgment);
  if (!qualityPassesGate(quality)) {
    report.analytical_quality_blocked = (report.analytical_quality_blocked || 0) + 1;
    process.stdout.write(
      `  [L6.4-validate] BLOCKED judgment (quality=${quality}): "${(judgment.judgment || "").slice(0, 80)}"\n`
    );
    return null; // blocked — does not reach slides
  }

  // Note: TREND_HYPE regex pattern is retained above for debug logging only.
  // It is NOT used here to add caveats — that was deterministic semantic grading.

  // Attach consumption approval tiers so downstream consumers (dashboard, slides,
  // chatbot) know immediately whether this judgment is approved for their channel.
  const approvals = classifyJudgmentTier(
    { ...judgment, confidence, caveat_if_any: caveats.length ? caveats.join("; ") : null },
    { ceiling: allowedStrengthCeiling }
  );

  return {
    ...judgment,
    // Persist normalized flags (explicit booleans from LLM; null for unset)
    judgment_flags:              normalizedFlags,
    // Debug-only: regex-based suggestions that differ from LLM flags (never used as decisions)
    _debug_flag_suggestions:     debugSuggestions.length ? debugSuggestions : undefined,
    evidence_for:     forIds,
    evidence_against: againstIds,
    supporting_evidence_ids: [...new Set([...forIds, ...againstIds])],
    evidence_origins: origins,
    confidence,
    caveat_if_any:       caveats.length ? [...new Set(caveats)].join("; ") : null,
    analytical_quality:  quality,
    // Consumption approval flags — set here, consumed by buildDashboardIntelPackage + slides
    approved_for_dashboard:  approvals.approved_for_dashboard,
    approved_for_slides:     approvals.approved_for_slides,
    approved_for_report:     approvals.approved_for_report,
    approved_for_chatbot:    approvals.approved_for_chatbot,
    approved_for_appendix:   approvals.approved_for_appendix,
    dashboard_rejection_reason: approvals.dashboard_rejection_reason,
  };
}

// Certainty language not allowed in projections
const CERTAINTY_PATTERN = /\b(will certainly|is confirmed|definitively|without doubt|guaranteed|absolutely certain|100% certain)\b/gi;
const FORWARD_LOOKING_PATTERN = /\b(may|could|is likely|suggests|might|potentially|is expected|projected|anticipated|probable)\b/i;
const FUTURE_TENSE_IN_BASIS = /\b(will|would|is expected to|anticipated to|projected to)\b/i;

function validateOutlook(outlook, idIndex, report) {
  const o = outlook || {};
  const ids = (o.supporting_evidence_ids || []).filter((id) => idIndex.has(id));
  const origins = [...new Set(ids.map((id) => idIndex.get(id).origin))];
  let confidence = o.confidence || "low";
  const caveats = [];
  if (o.caveat_if_any) caveats.push(o.caveat_if_any);

  let observed_basis = o.observed_basis || "";
  if (FUTURE_TENSE_IN_BASIS.test(observed_basis)) {
    caveats.push("observed_basis must describe what has been observed, not what will happen");
    confidence = cap(confidence, "medium");
  }
  if (!observed_basis || !String(observed_basis).trim()) {
    caveats.push("outlook lacks an explicit observed basis");
    confidence = cap(confidence, "low");
  }
  let projected_trajectory = o.projected_trajectory || "";
  if (projected_trajectory && !FORWARD_LOOKING_PATTERN.test(projected_trajectory)) {
    caveats.push("projected_trajectory should use hedged language (may, could, is likely)");
    confidence = cap(confidence, "medium");
  }
  function removeCertainty(text) {
    if (!text) return text;
    return text.replace(CERTAINTY_PATTERN, (match) => {
      report.certainty_removed = (report.certainty_removed || 0) + 1;
      return "[CERTAINTY REMOVED — outlook must be hedged]";
    });
  }
  observed_basis       = removeCertainty(observed_basis);
  projected_trajectory = removeCertainty(projected_trajectory);

  if (confidence === "high" && origins.length < 2) confidence = "medium";
  if (ids.length === 0) confidence = "low";

  const allResearching = ids.length > 0 && ids.every((id) => {
    const ev = idIndex.get(id);
    return ev && (ev.origin === "5B_analytics" ||
      ev.source_type === "research_finding" ||
      ev.intent_class === "vendor_marketing");
  });
  if (confidence === "high" && allResearching) {
    confidence = "medium";
    caveats.push("outlook confidence reduced: all supporting evidence is research or analytics only");
  }

  return {
    observed_basis,
    projected_trajectory,
    reasoning:               o.reasoning || "",
    time_horizon:            "6 months",
    supporting_evidence_ids: ids,
    evidence_origins:        origins,
    confidence,
    caveat_if_any:           caveats.length ? [...new Set(caveats)].join("; ") : null,
  };
}

function applyCeiling(judgments, ceiling, report) {
  if (!ceiling) return judgments;
  const max = ceiling === "none" ? "low" : ceiling;
  return (judgments || []).map((j) => {
    if ((CONF_RANK[j.confidence] ?? 0) > (CONF_RANK[max] ?? 0)) {
      report.permission_downgrades++;
      return {
        ...j,
        confidence: max,
        caveat_if_any: [j.caveat_if_any, `confidence capped to category ceiling (${ceiling})`]
          .filter(Boolean).join("; "),
      };
    }
    return j;
  });
}

/**
 * Validate a raw category-synthesis result (new strategic_judgments schema).
 *
 * @param {object} raw           Parsed output of synthesizeCategory()
 * @param {object} compactDossier Output of buildCategoryEvidenceDossier() (has id_index)
 * @returns {object} validated contract with strategic_judgments[], assessment_status, etc.
 */
export function validateCategoryAnalysis(raw, compactDossier) {
  const idIndex            = compactDossier.id_index;
  const ceiling            = compactDossier.analytical_state?.confidence_ceiling || null;
  const blockedClaimTypes  = new Set(compactDossier.corpus_audit?.blocked_claim_types || []);
  const allowedStrengthCeiling = ceiling;
  const report = {
    removed_unsupported: 0, permission_downgrades: 0, unresolved_ids: [],
    blocked_by_corpus_audit: 0, certainty_removed: 0, stat_qa_flags: 0,
    analytical_quality_blocked: 0, trend_relabels: 0,
    unmatched_candidate_claims_downgraded: 0,
    flags_debug_suggestions: 0,  // debug-only: regex suggestions that differ from LLM flags
  };

  // Validate each strategic judgment
  const rawJudgments = Array.isArray(raw.strategic_judgments) ? raw.strategic_judgments : [];
  const validatedRaw = rawJudgments.map((j) => {
    const gated = resolveAndGateJudgment(j, idIndex, report, blockedClaimTypes, allowedStrengthCeiling);
    if (!gated) { report.removed_unsupported++; return null; }
    return gated;
  }).filter(Boolean);

  const strategic_judgments = applyCeiling(validatedRaw, ceiling, report).slice(0, 5);

  // Outlook validation (same as before)
  const outlook_6_months = validateOutlook(raw.outlook_6_months, idIndex, report);
  if (ceiling) {
    const max = ceiling === "none" ? "low" : ceiling;
    if ((CONF_RANK[outlook_6_months.confidence] ?? 0) > (CONF_RANK[max] ?? 0)) {
      outlook_6_months.confidence = max;
    }
  }

  const evidence_gaps = Array.isArray(raw.evidence_gaps) ? raw.evidence_gaps.slice(0, 5) : [];

  // Statistical QA pass on all judgment text
  const allTextItems = strategic_judgments.map((j) => ({
    claim_text: [j.judgment, j.what_changed, j.causal_mechanism, j.why_this_matters].filter(Boolean).join(" "),
    supporting_evidence_ids: j.supporting_evidence_ids,
  }));
  const allIdIndexItems = [...idIndex.values()];
  const { flagged: statFlagged } = checkStatisticalClaims(allTextItems, allIdIndexItems);
  report.stat_qa_flags = statFlagged.length;

  // assessment_status
  const highConf = strategic_judgments.filter((j) => j.confidence === "high").length;
  const anyValid = strategic_judgments.length > 0;
  const assessment_status = highConf >= 1 ? "assessed"
    : anyValid ? "partial" : "evidence_insufficient";

  // selected_evidence_by_output — traceability for downstream consumers
  const selected_evidence_by_output = strategic_judgments.map((j) => ({
    output_id:        j.judgment_id || null,
    output_type:      j.judgment_type,
    evidence_ids:     j.supporting_evidence_ids,
    evidence_origins: j.evidence_origins,
    analytical_quality: j.analytical_quality,
  }));
  if (outlook_6_months.supporting_evidence_ids.length) {
    selected_evidence_by_output.push({
      output_id: "outlook", output_type: "outlook",
      evidence_ids: outlook_6_months.supporting_evidence_ids,
      evidence_origins: outlook_6_months.evidence_origins,
    });
  }

  return {
    category: compactDossier.category,
    assessment_status,
    strategic_judgments,
    outlook_6_months,
    evidence_gaps,
    selected_evidence_by_output,
    validation_report: report,
  };
}
