/**
 * L6-analysis-category-synthesis — Viewpoints-First Category Analysis
 *
 * Replaces the procedural observations → viewpoints → claims chain with a single
 * strong, viewpoints-first synthesis call, followed by deterministic validation.
 *
 * ── PIPELINE ───────────────────────────────────────────────────────────────────
 *   buildCategoryEvidenceDossier(dossier)   compact 5A/5B/5C evidence + id_index
 *     → synthesizeCategory()                ONE Opus call → 7 output groups (cited)
 *     → validateCategoryAnalysis()          resolve ids, trend rules, permission gates
 *     → map to backward-compat shapes (top_insights/biggest_happenings/outlook/…)
 *   Falls back to deterministicAnalysis() when source_count < 2 / no LLM / failure.
 *
 * ── OUTPUT ─────────────────────────────────────────────────────────────────────
 *   Backward-compat: category_headline, overview, biggest_happenings[], top_insights[],
 *     early_signals[], recommendations[], outlook{}, evidence_gaps[], analysis_confidence,
 *     key_source_ids[], analysis_version, llm_used, model_used
 *   New contract (additive): assessment_status, top_trends_or_patterns[], outlook_6_months{},
 *     selected_evidence_by_output[], validation_report{}
 */

import { buildCategoryEvidenceDossier } from "./buildCategoryEvidenceDossier.js";
import { synthesizeCategory }           from "./synthesizeCategory.js";
import { validateCategoryAnalysis }     from "./validateCategoryAnalysis.js";

export const ANALYSIS_VERSION = "analysis-v3.0";

function catLabel(cat) {
  return (cat || "").replace(/_/g, " ").toUpperCase();
}

function originsToType(origins = []) {
  const has5A = origins.includes("5A_rawfact");
  const other = origins.some((o) => o !== "5A_rawfact");
  if (has5A && other) return "mixed";
  if (origins.includes("5B_analytics")) return "analytics";
  if (origins.includes("5C_external")) return "external";
  return "rawfact";
}

// Full index of all resolvable IDs — used by linkAnalysisEvidence (not passed to LLM).
function allowedRawfactIds(dossier) {
  const rf = dossier.rawfact || {};
  const ids = [
    ...(rf.strong_evidence || []),
    ...(rf.usable_evidence || []),
    ...(rf.context_evidence || []),
    ...(rf.case_study_candidates || []),
    ...(rf.statistics || []),
    ...(rf.recommendation_inputs || []),
    ...(rf.outlook_inputs || []),
    ...(rf.exposure_inputs || []),
    ...(dossier.rawfact_evidence || []),
  ].map((i) => i.evidence_id).filter(Boolean);
  return [...new Set(ids)];
}

// ── Derivations (deterministic) ──────────────────────────────────────────────

function deriveHeadline(insights, happenings, category) {
  const best = (insights || []).find((i) => i.confidence === "high") || (insights || [])[0];
  if (best?.insight) return best.insight.replace(/\.$/, "");
  const h = (happenings || [])[0];
  if (h?.happening) return h.happening.replace(/\.$/, "");
  return `${catLabel(category)} — limited evidence this period`;
}

function deriveOverview(happenings, insights, sourceCount, category) {
  const parts = [];
  if ((happenings || []).length) {
    parts.push(`${happenings.length} concrete development${happenings.length > 1 ? "s" : ""} identified in ${catLabel(category).toLowerCase()} across ${sourceCount} sources.`);
  } else {
    parts.push(`${sourceCount} sources reviewed in ${catLabel(category).toLowerCase()}; evidence is limited this period.`);
  }
  const topInsight = (insights || [])[0];
  if (topInsight?.insight) parts.push(topInsight.insight.replace(/\.$/, "") + ".");
  return parts.join(" ");
}

function deriveConfidence(insights) {
  const hi = (insights || []).filter((i) => i.confidence === "high").length;
  if (hi >= 2) return "high";
  if ((insights || []).length >= 1) return "medium";
  return "low";
}

// Normalise outlook into an object regardless of input shape.
export function coerceOutlook(outlook, category) {
  const fallback = {
    statement:               `Continued activity expected in ${catLabel(category).toLowerCase()}.`,
    time_horizon:            "6 months",
    supporting_evidence_ids: [],
    confidence:              "low",
  };
  if (!outlook) return fallback;
  if (typeof outlook === "string") return { ...fallback, statement: outlook };
  if (typeof outlook === "object") {
    const keys = Object.keys(outlook);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      const reassembled = keys.sort((a, b) => a - b).map((k) => outlook[k]).join("");
      return { ...fallback, statement: reassembled };
    }
    return { ...fallback, ...outlook, statement: outlook.statement || fallback.statement };
  }
  return fallback;
}

// ── Deterministic fallback (no LLM) ──────────────────────────────────────────

function deterministicAnalysis(dossier) {
  const { category, source_count } = dossier;
  const rf    = dossier.rawfact || {};
  const fs    = dossier.fusion_summary || {};
  const items = [
    ...(rf.strong_evidence || []),
    ...(rf.usable_evidence || []),
    ...(dossier.rawfact_evidence || []).slice(0, 3),
  ].slice(0, 5);

  const strongSourceCount = (dossier.rawfact_evidence || []).filter((i) => i.rawfact_strength === "strong").length;

  const biggest_happenings = (fs.biggest_happenings || []).slice(0, 2).map((bh) => ({
    happening:               bh.fact || bh.display_label || "Significant activity observed",
    why_it_matters:          "Requires monitoring based on available evidence.",
    supporting_evidence_ids: [bh.evidence_id].filter(Boolean),
    evidence_type:           "rawfact",
    confidence:              "low",
  }));

  const externalInsights = (dossier.rawfact?.external_evidence || [])
    .filter((e) => e && e.metric_value != null && !e.needs_manual_review)
    .slice(0, 2)
    .map((e) => ({
      insight:                 `${e.metric_name || e.title}: ${String(e.metric_value).slice(0, 100)}`.slice(0, 130),
      explanation:             (e.summary || "").slice(0, 200),
      supporting_evidence_ids: [e.evidence_id].filter(Boolean),
      evidence_type:           "analytics",
      confidence:              e.evidence_confidence === "high" ? "high" : "medium",
    }));

  const rawfactInsights = items.slice(0, 3).map((item) => ({
    insight:                 item.fact?.slice(0, 120) || item.display_label || item.title?.slice(0, 80) || "Activity noted.",
    explanation:             item.supporting_text?.slice(0, 200) || "",
    supporting_evidence_ids: [item.evidence_id || `raw_${item.source_id}`].filter(Boolean),
    evidence_type:           "rawfact",
    confidence:              item.evidence_confidence || (item.triage_data?.evidence_strength === "strong" ? "high" : item.triage_data?.evidence_strength === "usable" ? "medium" : "low"),
  })).filter((i) => i.insight && i.insight.length >= 10);

  const top_insights = [...externalInsights, ...rawfactInsights].slice(0, 4);
  const confidence = strongSourceCount >= 4 ? "medium" : source_count >= 10 ? "medium" : "low";

  return {
    category,
    category_headline: deriveHeadline(top_insights, biggest_happenings, category),
    overview:          deriveOverview(biggest_happenings, top_insights, source_count, category),
    biggest_happenings,
    top_insights,
    early_signals:     [],
    recommendations: [{
      recommendation:          "Monitor this category for escalating activity.",
      rationale:               "Evidence volume indicates ongoing activity.",
      supporting_evidence_ids: items.slice(0, 1).map((i) => i.evidence_id || `raw_${i.source_id}`).filter(Boolean),
      priority:                "medium",
    }],
    outlook: coerceOutlook({
      statement:               `Continued activity expected in ${catLabel(category).toLowerCase()}. Monitor for escalation.`,
      supporting_evidence_ids: items.slice(0, 2).map((i) => i.evidence_id || `raw_${i.source_id}`).filter(Boolean),
      confidence:              "low",
    }, category),
    evidence_gaps:       (fs.evidence_gaps || []).slice(0, 3),
    analysis_confidence: confidence,
    assessment_status:   top_insights.length > 0 ? "partial" : "evidence_insufficient",
    key_source_ids:      items.map((i) => i.source_id).filter(Boolean).slice(0, 5),
    analysis_version:    ANALYSIS_VERSION,
    llm_used:            false,
  };
}

// ── Backward-compat mappers (validated contract → legacy shapes) ──────────────

function toLegacy(v, dossier) {
  const top_insights = v.top_insights.map((i) => ({
    insight:                 i.text,
    explanation:             i.why_this_matters || "",
    supporting_evidence_ids: i.supporting_evidence_ids,
    evidence_type:           originsToType(i.evidence_origins),
    confidence:              i.confidence,
    caveat_if_any:           i.caveat_if_any,
    slide_usefulness:        i.slide_usefulness,
    output_type:             "insight",
  }));
  const biggest_happenings = v.top_happenings.map((h) => ({
    happening:               h.text,
    why_it_matters:          h.why_this_matters || "",
    supporting_evidence_ids: h.supporting_evidence_ids,
    evidence_type:           originsToType(h.evidence_origins),
    confidence:              h.confidence,
    caveat_if_any:           h.caveat_if_any,
  }));
  const early_signals = v.early_signals.map((s) => ({
    signal:                  s.text,
    why_early:               s.why_early || "emerging — not yet repeated",
    implication_3_6_months:  s.why_this_matters || "",
    supporting_evidence_ids: s.supporting_evidence_ids,
    confidence:              s.confidence,
    caveat_if_any:           s.caveat_if_any,
  }));
  const recommendations = v.recommendations.map((r) => ({
    recommendation:          r.text,
    rationale:               r.why_this_matters || "",
    supporting_evidence_ids: r.supporting_evidence_ids,
    priority:                r.slide_usefulness || r.confidence || "medium",
  }));
  const outlook = coerceOutlook({
    statement:               v.outlook_6_months.projected_trajectory || v.outlook_6_months.observed_basis,
    observed_basis:          v.outlook_6_months.observed_basis,
    projected_trajectory:    v.outlook_6_months.projected_trajectory,
    reasoning:               v.outlook_6_months.reasoning,
    time_horizon:            "6 months",
    supporting_evidence_ids: v.outlook_6_months.supporting_evidence_ids,
    confidence:              v.outlook_6_months.confidence,
    caveat_if_any:           v.outlook_6_months.caveat_if_any,
  }, dossier.category);

  return { top_insights, biggest_happenings, early_signals, recommendations, outlook };
}

// ── Claim-chain VIEW adapter (validated outputs → claim shape for the slide layer) ──
// The slide planner (planSlides.js) is claim-first: it renders per-category slides
// from `claim_chain_results[cat]`. We adapt the validated viewpoint-first outputs into
// that shape so the NEW outputs drive slides. Claim priority is the ONLY place
// critical/high/medium is (re-)introduced — at the CLAIM level, via a deterministic
// gate over confidence + slide_usefulness (never on evidence).

function claimPriority(confidence, slideUse) {
  if (confidence === "high" && slideUse === "high") return "critical";
  if (confidence === "high" || slideUse === "high") return "high";
  return "medium";
}

function buildClaimChainView(v, compact) {
  // Resolve evidence_id → a full evidence object for the slide bodies.
  const fullById = new Map();
  for (const e of compact.evidence_5A) fullById.set(e.evidence_id, e);
  for (const e of compact.evidence_5B) fullById.set(e.evidence_id, { evidence_id: e.evidence_id, fact: e.finding || e.metric, evidence_type: "analytics", publisher: "analytics" });
  for (const e of compact.evidence_5C) fullById.set(e.evidence_id, { evidence_id: e.evidence_id, fact: e.claim, source_quote: e.quote, publisher: e.publisher, url: e.url, evidence_type: "external" });

  const claims = [];
  const selected_evidence_by_claim = [];
  let seq = 0;
  const add = (text, type, conf, slide, ids, caveat) => {
    if (!text) return;
    const claim_id = `claim_${compact.category}_${++seq}`;
    claims.push({
      claim_id, claim_type: type, claim_priority: claimPriority(conf, slide),
      claim_text: text, supporting_evidence_ids: ids || [], caveat_if_any: caveat || null,
    });
    selected_evidence_by_claim.push({
      claim_id, selected_evidence: (ids || []).map((id) => fullById.get(id)).filter(Boolean),
    });
  };

  for (const i of v.top_insights) add(i.text, "category_insight", i.confidence, i.slide_usefulness, i.supporting_evidence_ids, i.caveat_if_any);
  for (const t of v.top_trends_or_patterns) if (t.pattern_label === "trend") add(t.text, "trend_claim", t.confidence, t.slide_usefulness, t.supporting_evidence_ids, t.caveat_if_any);
  for (const r of v.recommendations) add(r.text, "recommendation", r.confidence, r.slide_usefulness, r.supporting_evidence_ids, r.caveat_if_any);
  add(v.outlook_6_months.projected_trajectory, "outlook", v.outlook_6_months.confidence, "medium", v.outlook_6_months.supporting_evidence_ids, v.outlook_6_months.caveat_if_any);

  const case_studies = v.top_happenings.map((h) => {
    const ev = (h.supporting_evidence_ids || []).map((id) => fullById.get(id)).filter(Boolean)[0];
    return ev ? { ...ev, claim_id: null, why_it_matters: h.why_this_matters } : null;
  }).filter(Boolean);

  return {
    claims,
    selected_evidence_by_claim,
    case_studies,
    viewpoints:   [],
    observations: [],
    claim_chain_counts: {
      claims_critical: claims.filter((c) => c.claim_priority === "critical").length,
      claims_high:     claims.filter((c) => c.claim_priority === "high").length,
      claims_medium:   claims.filter((c) => c.claim_priority === "medium").length,
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the viewpoints-first category synthesis for one fused dossier (Layer 6B).
 *
 * @param {object}   dossier  Fused dossier from buildFusedDossiers().
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @param {Function} [opts.llmFn]  Injectable LLM (for tests).
 * @returns {Promise<object>}
 */
export async function analyzeCategory(dossier, opts = {}) {
  const { skipLlm = false, llmFn } = opts;

  if (dossier.source_count < 2 || skipLlm) {
    return deterministicAnalysis(dossier);
  }

  const cat = dossier.category;
  try {
    const compact = buildCategoryEvidenceDossier(dossier);
    if (compact.allowed_ids.size === 0) {
      return deterministicAnalysis(dossier);
    }

    const raw = await synthesizeCategory(compact, { llmFn });
    if (!raw) {
      process.stdout.write(`  [L6-category] no synthesis output for ${cat} — deterministic fallback\n`);
      return deterministicAnalysis(dossier);
    }

    const v = validateCategoryAnalysis(raw, compact);
    const legacy = toLegacy(v, dossier);
    const claimView = buildClaimChainView(v, compact);
    const analysis_confidence = deriveConfidence(legacy.top_insights);

    process.stdout.write(
      `  [L6-category] ${cat}: ${legacy.top_insights.length} insights, ` +
      `${v.top_trends_or_patterns.length} trends/patterns, ${legacy.biggest_happenings.length} happenings, ` +
      `${legacy.early_signals.length} signals, ${legacy.recommendations.length} recs | ` +
      `status=${v.assessment_status} | removed=${v.validation_report.removed_unsupported} ` +
      `downgraded=${v.validation_report.permission_downgrades} relabel=${v.validation_report.trend_relabels}\n`
    );

    return {
      category:            cat,
      category_headline:   deriveHeadline(legacy.top_insights, legacy.biggest_happenings, cat),
      overview:            deriveOverview(legacy.biggest_happenings, legacy.top_insights, dossier.source_count, cat),
      biggest_happenings:  legacy.biggest_happenings,
      top_insights:        legacy.top_insights,
      early_signals:       legacy.early_signals,
      recommendations:     legacy.recommendations,
      outlook:             legacy.outlook,
      evidence_gaps:       v.evidence_gaps.length ? v.evidence_gaps : (dossier.fusion_summary?.evidence_gaps || []).slice(0, 4),
      analysis_confidence,
      assessment_status:   v.assessment_status,
      key_source_ids:      allowedRawfactIds(dossier).slice(0, 5),
      analysis_version:    ANALYSIS_VERSION,
      llm_used:            true,
      model_used:          raw.model_used || "category_synthesis",

      // New canonical contract (additive — preferred by future consumers)
      top_trends_or_patterns:      v.top_trends_or_patterns,
      outlook_6_months:            v.outlook_6_months,
      selected_evidence_by_output: v.selected_evidence_by_output,
      validation_report:           v.validation_report,

      // Claim-chain VIEW for the (claim-first) slide planner — adapted from the
      // validated outputs so slides render the new analysis. claim_priority lives
      // ONLY here, at the claim level (never on evidence).
      claims:                      claimView.claims,
      selected_evidence_by_claim:  claimView.selected_evidence_by_claim,
      case_studies:                claimView.case_studies,
      viewpoints:                  claimView.viewpoints,
      observations:                claimView.observations,
      claim_chain_counts:          claimView.claim_chain_counts,
    };
  } catch (err) {
    process.stdout.write(`  [L6-category] synthesis failed for ${cat}: ${err.message} — fallback\n`);
    return deterministicAnalysis(dossier);
  }
}
