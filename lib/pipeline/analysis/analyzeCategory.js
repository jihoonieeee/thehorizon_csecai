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

import { buildCategoryEvidenceDossier }   from "./buildCategoryEvidenceDossier.js";
import { synthesizeCategory, synthesizeLandscape } from "./synthesizeCategory.js";
import { validateCategoryAnalysis }     from "./validateCategoryAnalysis.js";
import { buildCorpusAudit }             from "./corpusAudit.js";
import { qaAllClaims }                  from "./claimQa.js";

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

// ── Backward-compat mappers (strategic_judgments → legacy shapes) ─────────────
//
// The cross-category synthesis and non-claim slide types read legacy fields
// (top_insights, biggest_happenings, etc.). We derive them from strategic_judgments
// so we don't need to maintain two separate code paths through the pipeline.

function toLegacy(v, dossier) {
  const judgments = v.strategic_judgments || [];

  // top_insights: substantive analytical judgments (not early_signal or monitoring_required)
  const analyticalJudgments = judgments.filter((j) =>
    j.judgment_type !== "early_signal" && j.judgment_type !== "monitoring_required"
  );
  const top_insights = analyticalJudgments.slice(0, 3).map((j) => ({
    insight:                 j.judgment,
    explanation:             [j.causal_mechanism, j.why_this_matters].filter(Boolean).join(" "),
    supporting_evidence_ids: j.supporting_evidence_ids,
    evidence_type:           originsToType(j.evidence_origins),
    confidence:              j.confidence,
    caveat_if_any:           j.caveat_if_any,
    slide_usefulness:        j.slide_usefulness || "medium",
    output_type:             "insight",
    // Pass through reasoning chain for downstream consumers (slides)
    reasoning_chain: {
      what_changed:              j.what_changed,
      causal_mechanism:          j.causal_mechanism,
      why_this_matters:          j.why_this_matters,
      second_order_implications: j.second_order_implications || [],
      affected_stakeholders:     j.affected_stakeholders || [],
      uncertainty:               j.uncertainty,
      monitoring_signals:        j.monitoring_signals || [],
      recommended_actions:       j.recommended_actions || [],
    },
    evidence_against_ids: j.evidence_against || [],
    analytical_quality:   j.analytical_quality,
  }));

  // biggest_happenings: judgments where what_changed describes a concrete event
  // Prefer operational_shift, adversary_adoption, capability_change types
  const happeningTypes = new Set(["operational_shift", "adversary_adoption", "capability_change", "technique_evolution"]);
  const happeningCandidates = judgments.filter((j) => happeningTypes.has(j.judgment_type) && j.what_changed);
  const biggest_happenings = happeningCandidates.slice(0, 3).map((j) => ({
    happening:               j.what_changed || j.judgment,
    why_it_matters:          j.why_this_matters || "",
    supporting_evidence_ids: j.supporting_evidence_ids,
    evidence_type:           originsToType(j.evidence_origins),
    confidence:              j.confidence,
    caveat_if_any:           j.caveat_if_any,
  }));

  // early_signals: monitoring_required / early_signal types, or low confidence judgments
  const earlySignalJudgments = judgments.filter((j) =>
    j.judgment_type === "early_signal" || j.judgment_type === "monitoring_required" || j.confidence === "low"
  );
  const early_signals = earlySignalJudgments.slice(0, 3).map((j) => ({
    signal:                  j.judgment,
    why_early:               j.uncertainty || "emerging — not yet confirmed",
    implication_3_6_months:  j.why_this_matters || (j.second_order_implications || [])[0] || "",
    supporting_evidence_ids: j.supporting_evidence_ids,
    confidence:              j.confidence,
    caveat_if_any:           j.caveat_if_any,
  }));

  // recommendations: collect unique recommended_actions across all judgments
  const seenRecs = new Set();
  const recommendations = [];
  for (const j of judgments) {
    for (const action of (j.recommended_actions || [])) {
      if (!seenRecs.has(action) && recommendations.length < 3) {
        seenRecs.add(action);
        recommendations.push({
          recommendation:          action,
          rationale:               j.why_this_matters || "",
          supporting_evidence_ids: j.supporting_evidence_ids,
          priority:                j.slide_usefulness || j.confidence || "medium",
        });
      }
    }
  }

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

// ── Claim-chain VIEW adapter (strategic_judgments → claim shape for slides) ────
//
// The slide planner (planSlides.js) is claim-first: it renders per-category slides
// from `claim_chain_results[cat]`. Each claim now carries a full reasoning_chain
// (what_changed, causal_mechanism, why_this_matters, evidence_for/against,
// second_order_implications, uncertainty, monitoring_signals) so the slide layer
// can write from the ARGUMENT rather than just bulletising the claim text.
//
// Claim priority is the ONLY place critical/high/medium is introduced — determined
// deterministically from confidence + slide_usefulness. A claim whose resolved
// evidence is ALL context / analytics / external is capped at medium.

function claimPriority(confidence, slideUse) {
  if (confidence === "high" && slideUse === "high") return "critical";
  if (confidence === "high" || slideUse === "high") return "high";
  return "medium";
}

// Map judgment_type → claim_type for slide planner compatibility
function judgmentTypeToClaimType(jtype) {
  if (jtype === "adversary_adoption") return "category_insight";
  if (jtype === "capability_change")  return "category_insight";
  if (jtype === "operational_shift")  return "category_insight";
  if (jtype === "risk_elevation")     return "category_insight";
  if (jtype === "technique_evolution")return "category_insight";
  if (jtype === "ecosystem_change")   return "category_insight";
  if (jtype === "early_signal")       return "category_insight";
  if (jtype === "monitoring_required")return "recommendation";
  return "category_insight";
}

function buildClaimChainView(v, compact) {
  // Resolve evidence_id → full evidence object for slide body building
  const fullById = new Map();
  for (const e of compact.evidence_5A) fullById.set(e.evidence_id, e);
  for (const e of compact.evidence_5B) fullById.set(e.evidence_id, {
    evidence_id: e.evidence_id, fact: e.finding || e.metric, evidence_type: "analytics", publisher: "analytics",
  });
  for (const e of compact.evidence_5C) fullById.set(e.evidence_id, {
    evidence_id: e.evidence_id, fact: e.claim, source_quote: e.quote,
    publisher: e.publisher, url: e.url, evidence_type: "external",
  });

  const claims = [];
  const selected_evidence_by_claim = [];
  let seq = 0;

  // Convert each validated strategic judgment into a claim
  for (const j of (v.strategic_judgments || [])) {
    if (!j.judgment) continue;

    const forEvidence     = (j.evidence_for || []).map((id) => fullById.get(id)).filter(Boolean);
    const againstEvidence = (j.evidence_against || []).map((id) => fullById.get(id)).filter(Boolean);
    const allResolved     = [...forEvidence, ...againstEvidence];

    // Evidence quality floor: all context/analytics/external → cap at medium
    const hasStrongUsable = forEvidence.some(
      (e) => e.evidence_strength === "strong" || e.evidence_strength === "usable"
    );
    let priority = claimPriority(j.confidence, j.slide_usefulness || "medium");
    let finalCaveat = j.caveat_if_any || null;
    if (!hasStrongUsable && (priority === "critical" || priority === "high")) {
      priority = "medium";
      finalCaveat = [finalCaveat, "backed only by context-level / corpus / external evidence"]
        .filter(Boolean).join("; ");
    }

    const claim_id = `claim_${compact.category}_${++seq}`;

    claims.push({
      claim_id,
      claim_type:           judgmentTypeToClaimType(j.judgment_type),
      // Preserved so claimQa.normalizeClaimType() can use structural routing
      // instead of re-scanning claim_text with keyword regex.
      source_judgment_type: j.judgment_type || null,
      judgment_flags:       j.judgment_flags || null,
      secondary_attributes: j.secondary_attributes || [],
      claim_priority: priority,
      claim_text:     j.judgment,
      supporting_evidence_ids: j.supporting_evidence_ids,
      caveat_if_any:  finalCaveat,
      // ── Reasoning chain — drives argument-led slide writing ──────────────
      reasoning_chain: {
        what_changed:              j.what_changed || null,
        causal_mechanism:          j.causal_mechanism || null,
        why_this_matters:          j.why_this_matters || null,
        second_order_implications: j.second_order_implications || [],
        affected_stakeholders:     j.affected_stakeholders || [],
        uncertainty:               j.uncertainty || null,
        monitoring_signals:        j.monitoring_signals || [],
        recommended_actions:       j.recommended_actions || [],
        evidence_against_ids:      j.evidence_against || [],
        analytical_quality:        j.analytical_quality,
      },
    });
    selected_evidence_by_claim.push({
      claim_id,
      selected_evidence: forEvidence,
      counter_evidence:  againstEvidence,
    });
  }

  // Outlook as a claim
  const ol = v.outlook_6_months || {};
  if (ol.projected_trajectory) {
    const olEvidence = (ol.supporting_evidence_ids || []).map((id) => fullById.get(id)).filter(Boolean);
    const claim_id = `claim_${compact.category}_${++seq}`;
    claims.push({
      claim_id,
      claim_type:     "outlook",
      claim_priority: "medium",
      claim_text:     ol.projected_trajectory,
      supporting_evidence_ids: ol.supporting_evidence_ids || [],
      caveat_if_any:  ol.caveat_if_any || null,
      reasoning_chain: {
        what_changed:              ol.observed_basis || null,
        causal_mechanism:          ol.reasoning || null,
        why_this_matters:          ol.projected_trajectory || null,
        second_order_implications: [],
        affected_stakeholders:     [],
        uncertainty:               ol.caveat_if_any || null,
        monitoring_signals:        [],
        recommended_actions:       [],
        evidence_against_ids:      [],
        analytical_quality:        "analytical",
      },
    });
    selected_evidence_by_claim.push({ claim_id, selected_evidence: olEvidence, counter_evidence: [] });
  }

  // Recommendations from strategic judgments
  const seenRecs = new Set();
  for (const j of (v.strategic_judgments || [])) {
    for (const action of (j.recommended_actions || [])) {
      if (!seenRecs.has(action) && claims.filter((c) => c.claim_type === "recommendation").length < 2) {
        seenRecs.add(action);
        const recEvidence = (j.supporting_evidence_ids || []).map((id) => fullById.get(id)).filter(Boolean);
        const claim_id = `claim_${compact.category}_${++seq}`;
        claims.push({
          claim_id,
          claim_type:     "recommendation",
          claim_priority: "medium",
          claim_text:     action,
          supporting_evidence_ids: j.supporting_evidence_ids,
          caveat_if_any:  null,
          reasoning_chain: {
            what_changed: null, causal_mechanism: j.why_this_matters || null,
            why_this_matters: j.why_this_matters || null,
            second_order_implications: [], affected_stakeholders: [],
            uncertainty: j.uncertainty || null, monitoring_signals: [], recommended_actions: [],
            evidence_against_ids: [], analytical_quality: "analytical",
          },
        });
        selected_evidence_by_claim.push({ claim_id, selected_evidence: recEvidence, counter_evidence: [] });
      }
    }
  }

  // Case studies from biggest_happenings (derived from strategic judgments in toLegacy)
  const happeningTypes = new Set(["operational_shift", "adversary_adoption", "capability_change", "technique_evolution"]);
  const case_studies = (v.strategic_judgments || [])
    .filter((j) => happeningTypes.has(j.judgment_type) && j.what_changed)
    .slice(0, 3)
    .map((j) => {
      const ev = (j.evidence_for || []).map((id) => fullById.get(id)).filter(Boolean)[0];
      return ev ? { ...ev, claim_id: null, why_it_matters: j.why_this_matters } : null;
    })
    .filter(Boolean);

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
  const { skipLlm = false, llmFn, categoryState = null } = opts;

  if (dossier.source_count < 2 || skipLlm) {
    return deterministicAnalysis(dossier);
  }

  const cat = dossier.category;
  try {
    // ── Corpus audit: runs before synthesis so limitations gate what the LLM claims ──
    const categorySources = dossier.sources || dossier.rawfact_evidence?.map((e) => ({
      source_type: e.source_type, publisher: e.publisher, publisher_class: e.publisher_class,
      trust_tier: e.trust_tier, independence_level: e.independence_level,
      date_published: e.date, origin_role: e.origin_role,
    })) || [];
    const corpus_audit = buildCorpusAudit(categorySources, cat);

    if (corpus_audit.analysis_allowed === "insufficient") {
      process.stdout.write(`  [L6-category] ${cat}: corpus insufficient (${corpus_audit.evidence_gap_flags.join(", ")}) — deterministic fallback\n`);
      const fallback = deterministicAnalysis(dossier);
      return { ...fallback, corpus_audit };
    }

    const compact = buildCategoryEvidenceDossier(dossier);
    if (compact.allowed_ids.size === 0) {
      return { ...deterministicAnalysis(dossier), corpus_audit };
    }

    // Pass corpus audit limitations to the synthesis prompt via compact dossier
    compact.corpus_audit = corpus_audit;

    // Pass the evidence signal map so the synthesis LLM knows what the evidence
    // shows (signals) and what it cannot support (blocked claim types + ceiling).
    // The LLM forms its own strategic judgments — no pre-structured candidates.
    if (categoryState) {
      compact.analytical_state = {
        confidence_ceiling:    categoryState.evidence_strength?.confidence_ceiling || "low",
        ceiling_reason:        categoryState.evidence_strength?.ceiling_reason || "",
        ceiling_evidence_ids:  categoryState.evidence_strength?.ceiling_evidence_ids || [],
        blocked_claim_types:   categoryState.blocked_claim_opportunities || [],
        evidence_signals: {
          dominant_patterns: (categoryState.dominant_threat_patterns || []).slice(0, 4).map((p) => ({
            pattern_name:           p.pattern_name,
            source_count:           p.source_count,
            confidence:             p.confidence,
            supporting_evidence_ids:(p.supporting_evidence_ids || []).slice(0, 3),
            caveat_if_any:          p.caveat_if_any,
          })),
          has_operational_sources:  categoryState.evidence_strength?.has_operational_sources ?? false,
          has_adversary_adoption:   (categoryState.adversary_adoption_signals || []).length > 0,
          trend_direction:          (categoryState.trend_signals || [])[0]?.direction || null,
          trend_caveat:             (categoryState.trend_signals || [])[0]?.caveat_if_any || null,
          coverage_gaps:            (categoryState.coverage_gaps || []).slice(0, 3),
        },
      };
    }

    // ── Pass 1: Landscape overview (Sonnet, cheap) ────────────────────────────
    // Surveys ALL evidence for a broad picture of the category before strategic
    // analysis. The landscape object is injected into the Opus prompt as context,
    // giving Opus a macro view before it forms specific judgments.
    const landscape = await synthesizeLandscape(compact, { llmFn });

    // ── Pass 2: Strategic analysis (Opus) ─────────────────────────────────────
    const raw = await synthesizeCategory(compact, { llmFn, landscape });
    if (!raw) {
      process.stdout.write(`  [L6-category] no synthesis output for ${cat} — deterministic fallback\n`);
      return { ...deterministicAnalysis(dossier), corpus_audit };
    }

    const v = validateCategoryAnalysis(raw, compact);
    // Pass the analytical_state fields the claim-view needs
    const legacy = toLegacy(v, dossier);
    const claimView = buildClaimChainView(v, compact);

    // ── Claim QA: gate EACH claim against ITS OWN supporting evidence ─────────
    // buildClaimChainView already resolved every claim's supporting_evidence_ids to
    // full evidence objects (selected_evidence_by_claim). QA must use that per-claim
    // set — not the category-wide pool — so the trend/factual/adoption gates measure
    // the claim's actual support, not how much evidence the category happens to hold.
    const claimEvidenceById = new Map(
      (claimView.selected_evidence_by_claim || []).map((x) => [x.claim_id, x.selected_evidence || []])
    );
    const categoryPool = [
      ...(dossier.rawfact?.strong_evidence || []),
      ...(dossier.rawfact?.usable_evidence || []),
      ...(dossier.rawfact?.context_evidence || []),
      ...(dossier.rawfact_evidence || []),
    ];
    const resolveClaimEvidence = (claim) => {
      const own = claimEvidenceById.get(claim.claim_id);
      return (own && own.length) ? own : categoryPool;
    };
    const { passing: passedClaims, blocked: blockedClaims } =
      qaAllClaims(claimView.claims, resolveClaimEvidence, corpus_audit);

    if (blockedClaims.length > 0) {
      process.stdout.write(
        `  [L6-category] ${cat}: claim QA blocked ${blockedClaims.length} claim(s): ` +
        blockedClaims.map((c) => `${c.claim_type}(${c.blocking_reasons?.join(",")})`).join("; ") + "\n"
      );
    }

    // Replace claims with QA-passing set; keep blocked list for QA report
    claimView.claims              = passedClaims;
    claimView.claims_blocked_by_qa = blockedClaims;
    claimView.claim_chain_counts  = {
      claims_critical: passedClaims.filter((c) => c.claim_priority === "critical").length,
      claims_high:     passedClaims.filter((c) => c.claim_priority === "high").length,
      claims_medium:   passedClaims.filter((c) => c.claim_priority === "medium").length,
      claims_blocked:  blockedClaims.length,
    };

    const analysis_confidence = deriveConfidence(legacy.top_insights);

    const qualityCounts = (v.strategic_judgments || []).reduce((acc, j) => {
      acc[j.analytical_quality || "?"] = (acc[j.analytical_quality || "?"] || 0) + 1;
      return acc;
    }, {});
    process.stdout.write(
      `  [L6-category] ${cat}: ${(v.strategic_judgments || []).length} judgments ` +
      `(${Object.entries(qualityCounts).map(([k, n]) => `${k}:${n}`).join(" ")}) | ` +
      `${legacy.top_insights.length} insights, ${legacy.biggest_happenings.length} happenings, ` +
      `${legacy.early_signals.length} signals, ${legacy.recommendations.length} recs | ` +
      `status=${v.assessment_status} | removed=${v.validation_report.removed_unsupported} ` +
      `quality_blocked=${v.validation_report.analytical_quality_blocked || 0} ` +
      `downgraded=${v.validation_report.permission_downgrades}\n`
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

      // New canonical contract — strategic judgment outputs
      strategic_judgments:         v.strategic_judgments,
      top_trends_or_patterns:      [], // derived from strategic_judgments by downstream consumers
      outlook_6_months:            v.outlook_6_months,
      selected_evidence_by_output: v.selected_evidence_by_output,
      validation_report:           v.validation_report,

      // Claim-chain VIEW for the (claim-first) slide planner — adapted from the
      // validated outputs so slides render the new analysis. claim_priority lives
      // ONLY here, at the claim level (never on evidence).
      claims:                      claimView.claims,
      claims_blocked_by_qa:        claimView.claims_blocked_by_qa,
      selected_evidence_by_claim:  claimView.selected_evidence_by_claim,
      case_studies:                claimView.case_studies,
      viewpoints:                  claimView.viewpoints,
      observations:                claimView.observations,
      claim_chain_counts:          claimView.claim_chain_counts,

      // Corpus audit for QA report and slide generation
      corpus_audit,
    };
  } catch (err) {
    process.stdout.write(`  [L6-category] synthesis failed for ${cat}: ${err.message} — fallback\n`);
    return deterministicAnalysis(dossier);
  }
}
