/**
 * Layer 7 — Deck Planner (claim-first, dynamic horizon-scan skeleton)
 *
 * Fully deterministic — no LLM calls. Builds the full horizon-scan deck plan
 * from claim chain results (preferred) + category analyses + dossiers.
 *
 * ── ARCHITECTURE ──────────────────────────────────────────────────────────────
 * Slides are ANCHORED TO CLAIMS. Analytical slides must carry:
 *   claim_id, claim_priority, claim_type, claim_text,
 *   supporting_viewpoint_ids, supporting_observation_ids, supporting_evidence_ids
 *
 * The LLM rendering layer (generateSlideContent) uses only these fields +
 * pre-selected supporting evidence — never raw evidence dumps.
 *
 * ── DECK STRUCTURE (dynamic) ─────────────────────────────────────────────────
 * A. Opening / Context (5 slides):
 *   1  Title
 *   2  Scope and Methodology
 *   3  Source Coverage and Evidence Confidence
 *   4  Taxonomy Reference
 *   5  Executive Summary
 *
 * B. Executive Synthesis (2–4 slides, when critical claims exist):
 *   Top Critical Claims
 *   Threat Landscape by Claim Priority
 *   Key Evidence Confidence / Gaps
 *
 * C. Category Sections (dynamic per category):
 *   critical claims  → full section (divider, critical_claim, evidence_support,
 *                       case_study?, analytics_pattern?, outlook_6month?, recommendation?)
 *   high claims only → compact section (divider, category_viewpoint, evidence_support,
 *                       outlook_6month or recommendation)
 *   medium only      → evidence-limited (divider, evidence_gap, gaps slide)
 *   no/insufficient  → not-assessed (divider, category_not_assessed)
 *
 * D. Cross-Category Synthesis (4 slides):
 *   Cross-Category Convergence
 *   6-Month Overall Outlook
 *   Watchlist
 *   Evidence Gaps and Confidence
 *
 * E. Appendix (4 slides):
 *   Evidence Index
 *   Analytics Tables
 *   Taxonomy Reference
 *   Source Bibliography
 *
 * Slide count range: 25–45 based on evidence strength.
 *
 * ── FALLBACK ────────────────────────────────────────────────────────────────
 * When claimChainResults is empty (skipLlm run / no claim data),
 * categoryBlock() falls back to analysis-based 7-per-category planning.
 * All structural sections are always included.
 */

export const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

const ANALYSIS_CATEGORY_ORDER = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function filterVizIds(ids, specs) {
  const avail = new Set((specs || []).map((v) => v.visualization_id));
  return ids.filter((id) => avail.has(id));
}

function externalChartIds(specs, category = null) {
  return (specs || [])
    .filter((v) => v.source === "external_web" && (!category || v.category === category))
    .map((v) => v.visualization_id);
}

function findDossier(dossiers, category) {
  return (dossiers || []).find((d) => d.category === category) || null;
}

/**
 * Build Layer 7 evidence_callout objects from 5C external evidence in a category dossier.
 * Rules: no weak sources, no manual_review items, no headline use without claim link.
 *
 * @param {object} dossier          - Category dossier (may contain external_evidence[])
 * @param {object} [claim]          - The linked claim (optional; required for claim-linked callouts)
 * @param {number} [maxCallouts=3]
 * @returns {{ evidence_callouts, visual_callouts }}
 */
function buildExternalCallouts(dossier, claim = null, maxCallouts = 3) {
  const extEvidence = dossier?.external_evidence || [];
  const extVisuals  = dossier?.external_visuals  || [];

  // Filter to usable items
  const usable = extEvidence.filter((e) =>
    !e.needs_manual_review &&
    e.source_quality !== "weak" &&
    e.confidence !== "low" &&
    e.opened_url !== false
  );

  // If a claim is provided, prefer evidence that supports compatible claim types
  const claimType = claim?.claim_type || null;
  let selected = claimType
    ? usable.filter((e) => (e.supports_claim_types || []).includes(claimType))
    : usable;
  if (selected.length === 0) selected = usable;

  const evidence_callouts = selected.slice(0, maxCallouts).map((e) => ({
    evidence_origin:       "5C_external",
    external_evidence_id:  e.external_evidence_id || e.evidence_id,
    evidence_type:         e.evidence_type,
    key_fact:              e.finding || e.summary || "",
    publisher:             e.publisher || "",
    url:                   e.url || "",
    source_quote:          e.source_quote || e.exact_quote || "",
    source_date:           e.source_date || null,
    freshness_status:      e.freshness_status || "unknown",
    source_quality:        e.source_quality || "mixed",
    confidence:            e.confidence || e.evidence_confidence || "low",
    caveat_if_any:         e.caveat_if_any || null,
    linked_5a_evidence_ids: e.linked_5a_evidence_ids || [],
    linked_5b_analytics_evidence_ids: e.linked_5b_analytics_evidence_ids || [],
    permitted_uses:        e.permitted_uses || [],
  }));

  const visual_callouts = extVisuals
    .filter((v) => v.slide_usable && !v.needs_manual_review)
    .slice(0, 2)
    .map((v) => v.slide_visual_callout || {
      visualization_id:      `vis_${v.visual_evidence_id}`,
      external_evidence_id:  v.visual_evidence_id,
      visual_url:            v.visual_url || null,
      source_url:            v.source_url,
      caption:               v.caption || v.what_the_visual_shows || "",
      usage_rights_status:   v.usage_rights_status || "unknown",
      slide_usable:          v.slide_usable && !v.needs_manual_review,
      manual_review_required: v.needs_manual_review || false,
    });

  return { evidence_callouts, visual_callouts };
}

function findAnalysis(analyses, category) {
  return (analyses || []).find((a) => a.category === category) || null;
}

// Build a map from claim_id → selected_evidence[] for fast lookup
function buildEvidenceByClaimMap(chainResult) {
  return Object.fromEntries(
    (chainResult?.selected_evidence_by_claim || []).map((s) => [s.claim_id, s.selected_evidence || []])
  );
}

// Build a map from viewpoint_id → viewpoint object
function buildViewpointMap(chainResult) {
  return Object.fromEntries(
    (chainResult?.viewpoints || []).map((v) => [v.viewpoint_id, v])
  );
}

// Resolve viewpoint and observation objects for a claim
function resolveChainSupport(claim, chainResult) {
  const vpMap  = buildViewpointMap(chainResult);
  const obsArr = chainResult?.observations || [];
  const obsMap = Object.fromEntries(obsArr.map((o) => [o.observation_id, o]));

  const viewpoints = (claim.supporting_viewpoint_ids || [])
    .map((id) => vpMap[id]).filter(Boolean);
  const observations = (claim.supporting_observation_ids || [])
    .map((id) => obsMap[id]).filter(Boolean);
  return { viewpoints, observations };
}

// Build _plan metadata for QA
function buildPlan(claim, evidenceIds, confidence) {
  return {
    rawfact_evidence_ids:           evidenceIds || [],
    claim_ids:                      claim ? [claim.claim_id] : [],
    claim_priority:                 claim?.claim_priority || null,
    claim_type:                     claim?.claim_type    || null,
    category_analysis_confidence:   confidence || null,
    all_context_only:               false,
  };
}

// ── Section A: Opening / Context slide builders ───────────────────────────────

function titleSlide(num) {
  return {
    slide_id:       `slide_${String(num).padStart(3, "0")}`,
    slide_number:   num,
    slide_type:     "title",
    section:        "A",
    title:          "AI Cyber Threat Horizon Scan",
    category:       null,
    claim_id:       null,
    visualization_ids: [],
    core_message:   "A strategic horizon scan of emerging AI cyber threats.",
    speaker_note_intent: "Introduce the briefing: strategic AI-cyber threat horizon scan. Cover reporting period, audience, and scope in 1-2 sentences.",
    assessment_status: "structural",
  };
}

function scopeMethodologySlide(num, aggregates) {
  return {
    slide_id:       `slide_${String(num).padStart(3, "0")}`,
    slide_number:   num,
    slide_type:     "scope_methodology",
    section:        "A",
    title:          "Scope and Methodology",
    category:       null,
    claim_id:       null,
    aggregates_summary: {
      total_sources: aggregates.total_sources || 0,
      date_range:    aggregates.date_range    || {},
      category_counts: aggregates.category_counts || {},
    },
    visualization_ids: [],
    core_message:   "What this horizon scan covers, the reporting window, source collection pipeline, and threat categories in scope.",
    speaker_note_intent: "State the reporting window, the four AI threat categories in scope, and the evidence pipeline layers. Cover what is explicitly out of scope. Keep it to 3-4 sentences.",
    assessment_status: "structural",
  };
}

function sourceCoverageSlide(num, aggregates, specs) {
  return {
    slide_id:       `slide_${String(num).padStart(3, "0")}`,
    slide_number:   num,
    slide_type:     "source_coverage",
    section:        "A",
    title:          "Source Coverage and Evidence Confidence",
    category:       null,
    claim_id:       null,
    aggregates_summary: {
      total_sources:      aggregates.total_sources    || 0,
      category_counts:    aggregates.category_counts  || {},
      source_type_counts: aggregates.source_type_counts || {},
      trust_tier_counts:  aggregates.trust_tier_counts  || {},
    },
    visualization_ids: filterVizIds(["source_type_distribution", "category_distribution"], specs),
    core_message:   `${aggregates.total_sources || 0} validated sources across ${Object.keys(aggregates.category_counts || {}).length} threat categories.`,
    speaker_note_intent: "Present total source volume, category split, source type mix, and trust tier distribution. State evidence confidence levels honestly.",
    assessment_status: "structural",
  };
}

function taxonomyReferenceSlide(num, aggregates, specs) {
  return {
    slide_id:       `slide_${String(num).padStart(3, "0")}`,
    slide_number:   num,
    slide_type:     "taxonomy_reference",
    section:        "A",
    title:          "Taxonomy Reference",
    category:       null,
    claim_id:       null,
    aggregates_summary: {
      attack_vector_frequency:  aggregates.attack_vector_frequency  || {},
      ai_layer_frequency:       aggregates.ai_layer_frequency       || {},
    },
    visualization_ids: filterVizIds(["prompt_injection_subtype_distribution", "ai_layer_frequency", "attack_vector_frequency"], specs),
    core_message:   "How observed threats map to OWASP and MITRE ATLAS/ATT&CK frameworks.",
    speaker_note_intent: "Explain the controlled taxonomy: threat categories, attack vectors, AI system layers, and framework mappings (OWASP LLM Top 10, MITRE ATLAS, MITRE ATT&CK). This anchors the rest of the deck in recognised standards.",
    assessment_status: "structural",
  };
}

function executiveSummarySlide(num, analyses, aggregates, specs, allCriticalClaims) {
  const topClaimsPerCat = analyses.map((a) => ({
    category:   a.category,
    insight:    (a.top_insights || [])[0]?.insight || a.overview?.slice(0, 100),
    confidence: (a.top_insights || [])[0]?.confidence || a.analysis_confidence,
  })).filter((x) => x.insight);

  return {
    slide_id:       `slide_${String(num).padStart(3, "0")}`,
    slide_number:   num,
    slide_type:     "executive_summary",
    section:        "A",
    title:          "Executive Summary",
    category:       null,
    claim_id:       null,
    cross_category_insights: topClaimsPerCat,
    critical_claims_summary: allCriticalClaims.slice(0, 4).map((c) => ({
      category:       c._category,
      claim_id:       c.claim_id,
      claim_priority: c.claim_priority,
      claim_text:     c.claim_text,
      claim_type:     c.claim_type,
    })),
    aggregates_summary: {
      total_sources:      aggregates.total_sources  || 0,
      category_counts:    aggregates.category_counts || {},
      top_attack_vectors: (aggregates.top || {}).attack_vectors?.slice(0, 5) || [],
    },
    visualization_ids: filterVizIds(["monthly_category_timeline", "derived_metrics_overview"], specs),
    core_message:   "Key findings, prioritised claims, and the top threat signals this reporting period.",
    speaker_note_intent: "Communicate headline findings to decision-makers. Reference total source volume, category split, and most significant critical claims. 3-4 sentences.",
    assessment_status: "structural",
  };
}

// ── Section B: Executive Synthesis slide builders ────────────────────────────

function topCriticalClaimsSlide(num, allCriticalClaims) {
  return {
    slide_id:         `slide_${String(num).padStart(3, "0")}`,
    slide_number:     num,
    slide_type:       "critical_claim",
    section:          "B",
    title:            "Top Critical Claims",
    category:         null,
    claim_id:         allCriticalClaims[0]?.claim_id || null,
    claim_priority:   "critical",
    claim_type:       allCriticalClaims[0]?.claim_type || null,
    claim_text:       allCriticalClaims[0]?.claim_text || null,
    critical_claims:  allCriticalClaims.slice(0, 4).map((c) => ({
      category:          c._category,
      claim_id:          c.claim_id,
      claim_priority:    c.claim_priority,
      claim_type:        c.claim_type,
      claim_text:        c.claim_text,
      caveat_if_any:     c.caveat_if_any || null,
    })),
    supporting_viewpoint_ids:   allCriticalClaims.flatMap((c) => c.supporting_viewpoint_ids || []).slice(0, 6),
    supporting_observation_ids: allCriticalClaims.flatMap((c) => c.supporting_observation_ids || []).slice(0, 6),
    supporting_evidence_ids:    allCriticalClaims.flatMap((c) => c.supporting_evidence_ids || []).slice(0, 8),
    supporting_evidence:        [],
    visualization_ids:          [],
    caveats:          null,
    core_message:     "The highest-priority analytical judgments across all threat categories this reporting period.",
    speaker_note_intent: "Present the critical claims cross-category. State why each is critical — what major analytical change it represents. Distinguish from high claims.",
    assessment_status: "assessed",
    _plan: {
      rawfact_evidence_ids: allCriticalClaims.flatMap((c) => c.supporting_evidence_ids || []).slice(0, 8),
      claim_ids:            allCriticalClaims.map((c) => c.claim_id),
      claim_priority:       "critical",
      claim_type:           "multi_category",
    },
  };
}

function threatLandscapeByPrioritySlide(num, categoryAnalyses, claimChainResults, aggregates, specs) {
  const landscapeByCategory = ANALYSIS_CATEGORY_ORDER.map((cat) => {
    const chainResult = claimChainResults[cat] || {};
    const claims = (chainResult.claims || []).filter((c) => c.claim_priority !== "rejected");
    const critical = claims.filter((c) => c.claim_priority === "critical").length;
    const high     = claims.filter((c) => c.claim_priority === "high").length;
    const medium   = claims.filter((c) => c.claim_priority === "medium").length;
    return { category: cat, critical, high, medium, total: claims.length };
  });

  return {
    slide_id:       `slide_${String(num).padStart(3, "0")}`,
    slide_number:   num,
    slide_type:     "landscape",
    section:        "B",
    title:          "Threat Landscape by Claim Priority",
    category:       null,
    claim_id:       null,
    landscape_by_category: landscapeByCategory,
    aggregates_summary: {
      category_counts:       aggregates.category_counts || {},
      maturity_distribution: aggregates.maturity_distribution || {},
      total_sources:         aggregates.total_sources || 0,
    },
    visualization_ids: filterVizIds(["domain_distribution", "category_distribution", "maturity_distribution"], specs),
    core_message:   "Claim priority distribution across four offensive AI threat categories.",
    speaker_note_intent: "Show where the strongest intelligence picture sits. Reference critical vs high vs medium claim counts. Note where evidence is thin.",
    assessment_status: "structural",
    _plan: { rawfact_evidence_ids: [], claim_ids: [], claim_priority: null, claim_type: null },
  };
}

// ── Section C: Per-category slide builders ────────────────────────────────────

function sectionDivider(num, category, analysis) {
  return {
    slide_id:        `slide_${String(num).padStart(3, "0")}`,
    slide_number:    num,
    slide_type:      "section_divider",
    section:         "C",
    title:           CATEGORY_LABELS[category] || category,
    category,
    claim_id:        null,
    visualization_ids: [],
    core_message:    analysis?.category_headline || analysis?.overview?.slice(0, 130) || `Analysis of ${CATEGORY_LABELS[category] || category}.`,
    speaker_note_intent: `Transition into the ${CATEGORY_LABELS[category] || category} section. One sentence on what you're about to cover.`,
    assessment_status: "structural",
    category_analysis: analysis,
  };
}

function categoryNotAssessedSlide(num, cat, analysis) {
  return {
    slide_id:        `slide_${String(num).padStart(3, "0")}`,
    slide_number:    num,
    slide_type:      "category_not_assessed",
    section:         "C",
    title:           `${CATEGORY_LABELS[cat] || cat} — Not Assessed`,
    category:        cat,
    claim_id:        null,
    visualization_ids: [],
    core_message:    analysis?.assessment_note || "Evidence insufficient this reporting period — category not assessed.",
    speaker_note_intent: `State plainly that ${CATEGORY_LABELS[cat] || cat} could not be assessed this period due to insufficient validated evidence. Do not speculate.`,
    assessment_status: "evidence_insufficient",
    category_analysis: analysis,
    _plan: { rawfact_evidence_ids: [], claim_ids: [], claim_priority: null, claim_type: null },
  };
}

function criticalClaimSlide(num, cat, claim, selectedEvidence, chainResult, analysis, specs) {
  const { viewpoints, observations } = resolveChainSupport(claim, chainResult);
  return {
    slide_id:           `slide_${String(num).padStart(3, "0")}`,
    slide_number:       num,
    slide_type:         "critical_claim",
    section:            "C",
    title:              `${CATEGORY_LABELS[cat] || cat} — ${claim.claim_type === "trend_claim" ? "Trend" : "Critical Finding"}`,
    category:           cat,
    claim_id:           claim.claim_id,
    claim_priority:     claim.claim_priority,
    claim_type:         claim.claim_type,
    claim_text:         claim.claim_text,
    supporting_viewpoint_ids:   claim.supporting_viewpoint_ids || [],
    supporting_observation_ids: claim.supporting_observation_ids || [],
    supporting_evidence_ids:    claim.supporting_evidence_ids || [],
    supporting_viewpoints:      viewpoints,
    supporting_observations:    observations,
    supporting_evidence:        selectedEvidence.slice(0, 3),
    caveats:            claim.caveat_if_any || null,
    visualization_ids:  filterVizIds(externalChartIds(specs, cat), specs),
    core_message:       claim.claim_text,
    speaker_note_intent: `Explain why this is a critical finding: ${claim.analytical_change || "analytical change"}. Cover the strongest evidence and what it means for defenders.`,
    assessment_status:  "assessed",
    category_analysis:  analysis,
    _plan: buildPlan(claim, selectedEvidence.map((e) => e.evidence_id), analysis?.analysis_confidence),
  };
}

function evidenceSupportSlide(num, cat, claim, selectedEvidence, analysis, specs, dossier = null) {
  const { evidence_callouts, visual_callouts } = buildExternalCallouts(dossier, claim, 3);
  return {
    slide_id:           `slide_${String(num).padStart(3, "0")}`,
    slide_number:       num,
    slide_type:         "evidence_support",
    section:            "C",
    title:              `${CATEGORY_LABELS[cat] || cat} — Supporting Evidence`,
    category:           cat,
    claim_id:           claim.claim_id,
    claim_priority:     claim.claim_priority,
    claim_type:         claim.claim_type,
    claim_text:         claim.claim_text,
    supporting_viewpoint_ids:   claim.supporting_viewpoint_ids || [],
    supporting_observation_ids: claim.supporting_observation_ids || [],
    supporting_evidence_ids:    claim.supporting_evidence_ids || [],
    supporting_evidence:        selectedEvidence.slice(0, 4),
    // 5C external evidence callouts (Layer 7 spec)
    external_evidence_callouts: evidence_callouts,
    external_visual_callouts:   visual_callouts,
    caveats:            claim.caveat_if_any || null,
    visualization_ids:  [],
    core_message:       `Evidence supporting: ${claim.claim_text}`,
    speaker_note_intent: `Present the strongest evidence items for this claim. For each, name the source, state the specific fact, and connect it to the claim. If external evidence is present, cite the source and layer (5C external).`,
    assessment_status:  "assessed",
    category_analysis:  analysis,
    _plan: buildPlan(claim, selectedEvidence.map((e) => e.evidence_id), analysis?.analysis_confidence),
  };
}

function caseStudySlide(num, cat, caseStudy, claim, analysis, specs) {
  return {
    slide_id:           `slide_${String(num).padStart(3, "0")}`,
    slide_number:       num,
    slide_type:         "case_study",
    section:            "C",
    title:              `${CATEGORY_LABELS[cat] || cat} — Case Study`,
    category:           cat,
    claim_id:           claim.claim_id,
    claim_priority:     claim.claim_priority,
    claim_type:         claim.claim_type,
    claim_text:         claim.claim_text,
    supporting_viewpoint_ids:   claim.supporting_viewpoint_ids || [],
    supporting_observation_ids: claim.supporting_observation_ids || [],
    supporting_evidence_ids:    [caseStudy.evidence_id],
    supporting_evidence:        [caseStudy],
    caveats:            claim.caveat_if_any || null,
    visualization_ids:  [],
    core_message:       `Concrete case illustrating: ${claim.claim_text}`,
    speaker_note_intent: `Walk through this specific incident or demonstrated capability in depth. Explain the attack chain or what was demonstrated. Explain why this case illustrates the broader claim.`,
    assessment_status:  "assessed",
    category_analysis:  analysis,
    _plan: buildPlan(claim, [caseStudy.evidence_id], analysis?.analysis_confidence),
  };
}

function analyticsPatternSlide(num, cat, claim, dossier, analysis, specs) {
  return {
    slide_id:         `slide_${String(num).padStart(3, "0")}`,
    slide_number:     num,
    slide_type:       "analytics_pattern",
    section:          "C",
    title:            `${CATEGORY_LABELS[cat] || cat} — Analytics and Patterns`,
    category:         cat,
    claim_id:         claim.claim_id,
    claim_priority:   claim.claim_priority,
    claim_type:       claim.claim_type,
    claim_text:       claim.claim_text,
    supporting_viewpoint_ids:   claim.supporting_viewpoint_ids || [],
    supporting_observation_ids: claim.supporting_observation_ids || [],
    supporting_evidence_ids:    claim.supporting_evidence_ids || [],
    supporting_evidence:        [],
    analytics_evidence:         dossier?.analytics_evidence || [],
    caveats:          claim.caveat_if_any || null,
    visualization_ids: filterVizIds(externalChartIds(specs, cat), specs),
    core_message:     `Quantitative patterns for ${CATEGORY_LABELS[cat] || cat}: frequency, maturity, and operational status.`,
    speaker_note_intent: "Present the analytics for this category. Reference frequency, maturity, and operational-status distributions. Be honest where the sample is small or dominated by unknowns. Do NOT make trend claims without comparison data.",
    assessment_status: "assessed",
    category_analysis: analysis,
    _plan: buildPlan(claim, [], analysis?.analysis_confidence),
  };
}

function trendClaimSlide(num, cat, claim, selectedEvidence, chainResult, analysis, specs) {
  const { viewpoints } = resolveChainSupport(claim, chainResult);
  return {
    slide_id:           `slide_${String(num).padStart(3, "0")}`,
    slide_number:       num,
    slide_type:         "trend_claim",
    section:            "C",
    title:              `${CATEGORY_LABELS[cat] || cat} — Validated Trend`,
    category:           cat,
    claim_id:           claim.claim_id,
    claim_priority:     claim.claim_priority,
    claim_type:         "trend_claim",
    claim_text:         claim.claim_text,
    supporting_viewpoint_ids:   claim.supporting_viewpoint_ids || [],
    supporting_observation_ids: claim.supporting_observation_ids || [],
    supporting_evidence_ids:    claim.supporting_evidence_ids || [],
    supporting_viewpoints:      viewpoints,
    supporting_evidence:        selectedEvidence.slice(0, 4),
    caveats:            claim.caveat_if_any || null,
    visualization_ids:  filterVizIds(externalChartIds(specs, cat), specs),
    core_message:       claim.claim_text,
    speaker_note_intent: `Present this validated trend. Explain the evidence basis: ≥3 items, ≥2 time windows, ≥2 independent publishers. Use hedged language: "the evidence suggests a trend" not "the trend is".`,
    assessment_status:  "assessed",
    category_analysis:  analysis,
    _plan: buildPlan(claim, selectedEvidence.map((e) => e.evidence_id), analysis?.analysis_confidence),
  };
}

function outlook6MonthSlide(num, cat, claim, selectedEvidence, chainResult, analysis) {
  // Use claim if available, else fall back to analysis outlook
  const outlookClaim = claim;
  const analysisOutlook = analysis?.outlook;
  const coreMessage = outlookClaim?.claim_text
    || analysisOutlook?.statement
    || `${CATEGORY_LABELS[cat] || cat} trajectory over the next 6 months.`;

  return {
    slide_id:           `slide_${String(num).padStart(3, "0")}`,
    slide_number:       num,
    slide_type:         "outlook_6month",
    section:            "C",
    title:              `${CATEGORY_LABELS[cat] || cat} — 6-Month Outlook`,
    category:           cat,
    claim_id:           outlookClaim?.claim_id || null,
    claim_priority:     outlookClaim?.claim_priority || "medium",
    claim_type:         "outlook",
    claim_text:         outlookClaim?.claim_text || null,
    // Outlook-specific fields
    outlook_horizon:    "6_months",
    observed_basis:     null,   // to be filled by content generator from evidence
    projected_trajectory: null, // to be filled by content generator
    outlook_confidence: outlookClaim?.evidence_sufficiency === "sufficient" ? "high" :
                        outlookClaim ? "medium" : "low",
    supporting_viewpoint_ids:   outlookClaim?.supporting_viewpoint_ids || [],
    supporting_observation_ids: outlookClaim?.supporting_observation_ids || [],
    supporting_evidence_ids:    outlookClaim?.supporting_evidence_ids || [],
    supporting_evidence:        selectedEvidence.slice(0, 3),
    early_signals:              (analysis?.early_signals || []).filter((s) => s.qa_pass !== false).slice(0, 2),
    caveats:            outlookClaim?.caveat_if_any || analysisOutlook?.caveat_if_any || null,
    visualization_ids:  [],
    core_message:       coreMessage,
    speaker_note_intent: `Present 6-month outlook. MUST separate: (1) what has been observed (evidence-backed), (2) projected trajectory (phrased as projection not fact), (3) confidence level and caveat. Ground all projections in evidence trajectory.`,
    assessment_status:  "assessed",
    category_analysis:  analysis,
    _plan: buildPlan(outlookClaim, selectedEvidence.map((e) => e.evidence_id), analysis?.analysis_confidence),
  };
}

function recommendationSlide(num, cat, claim, selectedEvidence, analysis) {
  return {
    slide_id:           `slide_${String(num).padStart(3, "0")}`,
    slide_number:       num,
    slide_type:         "recommendation",
    section:            "C",
    title:              `${CATEGORY_LABELS[cat] || cat} — Defensive Priority`,
    category:           cat,
    claim_id:           claim.claim_id,
    claim_priority:     claim.claim_priority,
    claim_type:         "recommendation",
    claim_text:         claim.claim_text,
    supporting_viewpoint_ids:   claim.supporting_viewpoint_ids || [],
    supporting_observation_ids: claim.supporting_observation_ids || [],
    supporting_evidence_ids:    claim.supporting_evidence_ids || [],
    supporting_evidence:        selectedEvidence.slice(0, 3),
    caveats:            claim.caveat_if_any || null,
    visualization_ids:  [],
    core_message:       claim.claim_text,
    speaker_note_intent: `State the defensive priority as an actionable recommendation. Use action verbs (Deploy, Monitor, Require). Cite the evidence or control gap that motivates this action.`,
    assessment_status:  "assessed",
    category_analysis:  analysis,
    _plan: buildPlan(claim, selectedEvidence.map((e) => e.evidence_id), analysis?.analysis_confidence),
  };
}

function evidenceGapSlide(num, cat, mediumClaims, analysis) {
  const gaps = analysis?.evidence_gaps || [];
  return {
    slide_id:       `slide_${String(num).padStart(3, "0")}`,
    slide_number:   num,
    slide_type:     "evidence_gap",
    section:        "C",
    title:          `${CATEGORY_LABELS[cat] || cat} — Evidence Gaps`,
    category:       cat,
    claim_id:       mediumClaims[0]?.claim_id || null,
    claim_priority: mediumClaims[0]?.claim_priority || "medium",
    claim_type:     mediumClaims[0]?.claim_type || null,
    claim_text:     mediumClaims[0]?.claim_text || null,
    evidence_gaps:  gaps.slice(0, 4),
    supporting_evidence_ids: mediumClaims.flatMap((c) => c.supporting_evidence_ids || []).slice(0, 4),
    supporting_evidence: [],
    caveats:        "Evidence limited — claims are medium-confidence only.",
    visualization_ids: [],
    core_message:   `${CATEGORY_LABELS[cat] || cat}: evidence base is limited. State what can and cannot be concluded.`,
    speaker_note_intent: `Explicitly state what cannot be concluded due to limited evidence. Name the gaps. Distinguish from a confirmed absence of threat.`,
    assessment_status: "assessed",
    category_analysis: analysis,
    _plan: {
      rawfact_evidence_ids: mediumClaims.flatMap((c) => c.supporting_evidence_ids || []).slice(0, 4),
      claim_ids:            mediumClaims.map((c) => c.claim_id),
      claim_priority:       "medium",
      claim_type:           mediumClaims[0]?.claim_type || null,
    },
  };
}

// ── Claim-first category block ────────────────────────────────────────────────

function buildClaimFirstCategoryBlock(startNum, cat, analysis, dossier, specs, chainResult) {
  const slides = [];
  let n = startNum;

  const activeClaims = (chainResult?.claims || []).filter((c) => c.claim_priority !== "rejected");
  const criticalClaims = activeClaims.filter((c) => c.claim_priority === "critical");
  const highClaims     = activeClaims.filter((c) => c.claim_priority === "high");
  const mediumClaims   = activeClaims.filter((c) => c.claim_priority === "medium");
  const outlookClaims  = activeClaims.filter((c) => c.claim_type === "outlook");
  const trendClaims    = activeClaims.filter((c) => c.claim_type === "trend_claim");
  const recoClaims     = activeClaims.filter((c) => c.claim_type === "recommendation");

  const evidenceByClaim = buildEvidenceByClaimMap(chainResult);

  // No evidence / insufficient → not assessed
  if (analysis?.assessment_status === "evidence_insufficient" || activeClaims.length === 0) {
    slides.push(sectionDivider(n++, cat, analysis));
    slides.push(categoryNotAssessedSlide(n++, cat, analysis));
    return slides;
  }

  slides.push(sectionDivider(n++, cat, analysis));

  if (criticalClaims.length > 0) {
    // ── Critical section ──
    for (const claim of criticalClaims.slice(0, 2)) {
      const ev = evidenceByClaim[claim.claim_id] || [];

      if (claim.claim_type === "trend_claim") {
        slides.push(trendClaimSlide(n++, cat, claim, ev, chainResult, analysis, specs));
      } else {
        slides.push(criticalClaimSlide(n++, cat, claim, ev, chainResult, analysis, specs));
      }
      // Evidence support slide for this critical claim (if evidence is available)
      if (ev.length > 0) {
        slides.push(evidenceSupportSlide(n++, cat, claim, ev, analysis, specs, dossier));
      }
    }

    // Case study slide — first case study linked to any critical claim
    const caseStudy = (chainResult?.case_studies || []).find((cs) =>
      criticalClaims.some(
        (c) => cs.claim_id === c.claim_id ||
               (c.supporting_evidence_ids || []).includes(cs.evidence_id)
      )
    );
    if (caseStudy && criticalClaims[0]) {
      slides.push(caseStudySlide(n++, cat, caseStudy, criticalClaims[0], analysis, specs));
    }

    // Analytics pattern slide (if analytics data exists)
    if ((dossier?.analytics_evidence || []).length > 0 || (dossier?.analytics?.analytics_evidence || []).length > 0) {
      slides.push(analyticsPatternSlide(n++, cat, criticalClaims[0], dossier, analysis, specs));
    }

    // Trend slide (if a separate validated trend_claim exists)
    if (trendClaims.length > 0 && !criticalClaims.some((c) => c.claim_type === "trend_claim")) {
      const tc = trendClaims[0];
      slides.push(trendClaimSlide(n++, cat, tc, evidenceByClaim[tc.claim_id] || [], chainResult, analysis, specs));
    }

    // 6-month outlook
    const outlookClaim = outlookClaims[0] || null;
    const outlookEv = outlookClaim ? (evidenceByClaim[outlookClaim.claim_id] || []) : [];
    slides.push(outlook6MonthSlide(n++, cat, outlookClaim, outlookEv, chainResult, analysis));

    // Recommendation
    const reco = recoClaims[0] || null;
    if (reco) {
      slides.push(recommendationSlide(n++, cat, reco, evidenceByClaim[reco.claim_id] || [], analysis));
    }

  } else if (highClaims.length > 0) {
    // ── High-claims compact section ──
    const mainClaim = highClaims[0];
    const ev = evidenceByClaim[mainClaim.claim_id] || [];

    if (mainClaim.claim_type === "trend_claim") {
      slides.push(trendClaimSlide(n++, cat, mainClaim, ev, chainResult, analysis, specs));
    } else {
      slides.push(criticalClaimSlide(n++, cat, mainClaim, ev, chainResult, analysis, specs));
    }
    if (ev.length > 0) {
      slides.push(evidenceSupportSlide(n++, cat, mainClaim, ev, analysis, specs));
    }

    // Outlook or recommendation (one or the other)
    const outlookClaim = outlookClaims[0] || null;
    const reco = recoClaims[0] || null;
    if (outlookClaim || analysis?.outlook?.statement) {
      const outlookEv = outlookClaim ? (evidenceByClaim[outlookClaim.claim_id] || []) : [];
      slides.push(outlook6MonthSlide(n++, cat, outlookClaim, outlookEv, chainResult, analysis));
    } else if (reco) {
      slides.push(recommendationSlide(n++, cat, reco, evidenceByClaim[reco.claim_id] || [], analysis));
    }

  } else {
    // ── Medium claims only — evidence-limited assessment ──
    slides.push(evidenceGapSlide(n++, cat, mediumClaims, analysis));
    // A second gap slide if multiple gaps exist
    if ((analysis?.evidence_gaps || []).length >= 3) {
      const gapSlide2 = {
        ...categoryNotAssessedSlide(n, cat, analysis),
        slide_id:    `slide_${String(n).padStart(3, "0")}`,
        slide_number: n,
        slide_type:  "evidence_gap",
        core_message: `${CATEGORY_LABELS[cat] || cat}: medium signals exist but do not yet support a high-priority claim.`,
        assessment_status: "assessed",
      };
      n++;
      slides.push(gapSlide2);
    }
  }

  return slides;
}

// ── Analysis-based fallback category block (7 slides) ─────────────────────────
// Used when claimChainResults is unavailable for this category.

function pickEvidence(dossier, buckets, n) {
  const rf = dossier?.rawfact || {};
  const items = buckets.flatMap((b) => rf[b] || []);
  if (items.length) return items.slice(0, n);
  return (dossier?.rawfact_evidence || []).slice(0, n);
}

function attachPacketSection(analysis, catSection) {
  if (!catSection) return analysis;
  return { ...(analysis || {}), packet_section: catSection };
}

function legacyCategoryViewpoint(num, cat, analysis, dossier, specs) {
  const topClaim = (analysis?.top_insights || []).find((i) => i.qa_pass !== false);
  return {
    slide_id:       `slide_${String(num).padStart(3, "0")}`,
    slide_number:   num,
    slide_type:     "category_viewpoint",
    section:        "C",
    title:          `${CATEGORY_LABELS[cat] || cat} — Viewpoint`,
    category:       cat,
    claim_id:       null,
    rawfact_evidence: pickEvidence(dossier, ["strong_evidence", "usable_evidence"], 3),
    analytics_evidence: dossier?.analytics_evidence || [],
    category_analysis: analysis,
    packet_section: analysis?.packet_section || analysis,
    visualization_ids: [],
    core_message:   analysis?.category_headline || analysis?.overview?.slice(0, 120) || "",
    speaker_note_intent: "State the category headline. Explain what changed this period. Cover the 2-3 biggest happenings that drive this judgment. Focus on trajectory, not description.",
    assessment_status: "assessed",
    _plan: {
      rawfact_evidence_ids: pickEvidence(dossier, ["strong_evidence", "usable_evidence"], 3).map((e) => e.evidence_id),
      claim_ids: [],
      category_analysis_confidence: analysis?.analysis_confidence,
    },
  };
}

function legacyCategoryBlock(startNum, cat, analysis, dossier, specs) {
  let n = startNum;
  if (analysis?.assessment_status === "evidence_insufficient") {
    return [
      sectionDivider(n++, cat, analysis),
      categoryNotAssessedSlide(n++, cat, analysis),
    ];
  }

  const make = (slideType, titleSuffix, buckets, analytics, coreMsg, intent) => {
    const ev = pickEvidence(dossier, buckets, 4);
    return {
      slide_id:       `slide_${String(n).padStart(3, "0")}`,
      slide_number:   n++,
      slide_type:     slideType,
      section:        "C",
      title:          `${CATEGORY_LABELS[cat] || cat} — ${titleSuffix}`,
      category:       cat,
      claim_id:       null,
      rawfact_evidence: ev,
      analytics_evidence: analytics ? dossier?.analytics_evidence || [] : [],
      category_analysis: analysis,
      packet_section: analysis?.packet_section || analysis,
      visualization_ids: [],
      core_message:   coreMsg,
      speaker_note_intent: intent,
      assessment_status: "assessed",
      _plan: {
        rawfact_evidence_ids: ev.map((e) => e.evidence_id),
        claim_ids: [],
        category_analysis_confidence: analysis?.analysis_confidence,
      },
    };
  };

  return [
    sectionDivider(n++, cat, analysis),
    legacyCategoryViewpoint(n - 1, cat, analysis, dossier, specs),
    make("category_technique_map",   "Technique Map",   ["case_study_candidates", "strong_evidence"], false, `Dominant attack techniques in ${CATEGORY_LABELS[cat] || cat}.`, "Walk through primary attack vectors and techniques."),
    make("evidence_support",         "Top Evidence",    ["strong_evidence", "usable_evidence", "statistics"], false, `Strongest verified findings for ${CATEGORY_LABELS[cat] || cat}.`, "Present the strongest evidence items."),
    make("case_study",               "Case Studies",    ["case_study_candidates", "usable_evidence"], false, `Concrete incidents and capabilities in ${CATEGORY_LABELS[cat] || cat}.`, "Walk through 2-3 specific incidents or demonstrated capabilities."),
    make("analytics_pattern",        "Analytics",       ["statistics", "usable_evidence"], true, `Quantitative patterns for ${CATEGORY_LABELS[cat] || cat}.`, "Present the analytics. Reference frequency, maturity, operational-status distributions."),
    {
      slide_id:       `slide_${String(n).padStart(3, "0")}`,
      slide_number:   n++,
      slide_type:     "outlook_6month",
      section:        "C",
      title:          `${CATEGORY_LABELS[cat] || cat} — Outlook and Gaps`,
      category:       cat,
      claim_id:       null,
      rawfact_evidence: pickEvidence(dossier, ["outlook_inputs"], 2),
      analytics_evidence: dossier?.analytics_evidence || [],
      category_analysis: analysis,
      packet_section: analysis?.packet_section || analysis,
      early_signals:  (analysis?.early_signals || []).filter((s) => s.qa_pass !== false),
      outlook_horizon: "6_months",
      outlook_confidence: analysis?.analysis_confidence === "high" ? "medium" : "low",
      evidence_gaps:  analysis?.evidence_gaps || [],
      visualization_ids: [],
      core_message:   analysis?.outlook?.statement || `${CATEGORY_LABELS[cat] || cat} trajectory over the next 6 months.`,
      speaker_note_intent: "Present the 6-month outlook and the early signals. Separate observed evidence from projected trajectory. State evidence gaps honestly.",
      assessment_status: "assessed",
      _plan: {
        rawfact_evidence_ids: pickEvidence(dossier, ["outlook_inputs"], 2).map((e) => e.evidence_id),
        claim_ids: [], category_analysis_confidence: analysis?.analysis_confidence,
      },
    },
  ];
}

// ── Section D: Cross-Category Synthesis slide builders ───────────────────────

function crossCategorySynthesisSlide(num, analyses, aggregates, specs, packet) {
  const cc = packet?.cross_category || {};
  const patterns = cc.patterns || [];
  const happenings = cc.overall_biggest_happenings || [];
  return {
    slide_id:        `slide_${String(num).padStart(3, "0")}`,
    slide_number:    num,
    slide_type:      "cross_category_synthesis",
    section:         "D",
    title:           "Cross-Category Convergence",
    category:        "cross_category",
    claim_id:        null,
    cross_category_patterns: patterns,
    overall_biggest_happenings: happenings,
    aggregates_summary: {
      signal_cluster_counts:    aggregates.signal_cluster_counts    || {},
      attack_surface_frequency: aggregates.attack_surface_frequency || {},
      recurring_theme_counts:   aggregates.recurring_theme_counts   || {},
    },
    visualization_ids: filterVizIds(["attack_surface_heatmap", "signal_cluster_radar", "recurring_theme_heatmap", ...externalChartIds(specs)], specs),
    core_message:    "AI threats are converging — offensive AI, LLM attacks, and agentic risks compound each other.",
    speaker_note_intent: "Connect the threads across categories. Show where attack surfaces overlap and how threats compound. Name specific overlapping techniques.",
    assessment_status: "structural",
    packet_section:  packet?.cross_category || null,
    _plan: { rawfact_evidence_ids: [], claim_ids: [], claim_priority: null },
  };
}

function overallOutlookSlide(num, analyses, claimChainResults, specs) {
  const allOutlookClaims = ANALYSIS_CATEGORY_ORDER.flatMap((cat) => {
    const chain = claimChainResults[cat] || {};
    return (chain.claims || [])
      .filter((c) => c.claim_type === "outlook" && c.claim_priority !== "rejected")
      .map((c) => ({ ...c, _category: cat }));
  }).slice(0, 4);

  return {
    slide_id:        `slide_${String(num).padStart(3, "0")}`,
    slide_number:    num,
    slide_type:      "outlook_6month",
    section:         "D",
    title:           "6-Month Overall Outlook",
    category:        null,
    claim_id:        allOutlookClaims[0]?.claim_id || null,
    claim_priority:  allOutlookClaims[0]?.claim_priority || null,
    claim_type:      "outlook",
    claim_text:      allOutlookClaims[0]?.claim_text || null,
    outlook_horizon: "6_months",
    outlook_confidence: allOutlookClaims.some((c) => c.claim_priority === "critical") ? "high" : "medium",
    category_outlooks: analyses.map((a) => ({
      category:    a.category,
      statement:   a.outlook?.statement || "",
      confidence:  a.analysis_confidence,
    })).filter((o) => o.statement),
    all_outlook_claims: allOutlookClaims,
    visualization_ids: [],
    caveats:         null,
    core_message:    "Projected AI threat landscape over the next 6 months, grounded in observed evidence trajectory.",
    speaker_note_intent: "Present the overall 6-month outlook. MUST separate observed basis (what happened) from projected trajectory (what may happen). State confidence level. End with concrete monitoring priorities.",
    assessment_status: "structural",
    _plan: { rawfact_evidence_ids: [], claim_ids: allOutlookClaims.map((c) => c.claim_id), claim_priority: null },
  };
}

function watchlistSlide(num, analyses, claimChainResults, specs) {
  const earlySignals = analyses.flatMap((a) =>
    (a.early_signals || []).filter((s) => s.qa_pass !== false).slice(0, 2)
      .map((s) => ({ ...s, category: a.category }))
  ).slice(0, 6);

  return {
    slide_id:        `slide_${String(num).padStart(3, "0")}`,
    slide_number:    num,
    slide_type:      "watchlist",
    section:         "D",
    title:           "Watchlist",
    category:        null,
    claim_id:        null,
    cross_category_insights: earlySignals,
    visualization_ids: filterVizIds(["signal_cluster_radar"], specs),
    core_message:    "Emerging signals to monitor in the next 30-60 days.",
    speaker_note_intent: "Present the specific signals to watch in the near term. For each, state the trigger that would escalate it. Do NOT present weak signals as confirmed trends.",
    assessment_status: "structural",
    _plan: { rawfact_evidence_ids: [], claim_ids: [], claim_priority: null },
  };
}

function evidenceGapsConfidenceSlide(num, analyses) {
  const gaps = analyses.flatMap((a) =>
    (a.evidence_gaps || []).slice(0, 2).map((g) => ({ category: a.category, gap: g }))
  ).slice(0, 8);
  const confidenceByCat = analyses.map((a) => ({
    category: a.category, confidence: a.analysis_confidence, llm_used: a.llm_used,
  }));
  return {
    slide_id:        `slide_${String(num).padStart(3, "0")}`,
    slide_number:    num,
    slide_type:      "evidence_gap",
    section:         "D",
    title:           "Evidence Gaps and Confidence",
    category:        null,
    claim_id:        null,
    evidence_gaps:   gaps,
    confidence_by_category: confidenceByCat,
    visualization_ids: [],
    core_message:    "Where the intelligence picture is incomplete, and the confidence level behind each category.",
    speaker_note_intent: "Be transparent about limitations. State the evidence gaps per category and the confidence level of each analysis. Build analytical credibility — do not hide uncertainty.",
    assessment_status: "structural",
    _plan: { rawfact_evidence_ids: [], claim_ids: [], claim_priority: null },
  };
}

// ── Section E: Appendix slide builders ───────────────────────────────────────

function appendixEvidenceIndexSlide(num) {
  return {
    slide_id:    `slide_${String(num).padStart(3, "0")}`,
    slide_number: num, slide_type: "appendix_evidence_index", section: "E",
    title:       "Appendix: Full Evidence Index", category: null, claim_id: null,
    visualization_ids: [],
    core_message: "Complete index of evidence items cited in this briefing, with source IDs.",
    speaker_note_intent: "Reference slide — the full evidence index for analysts who want to trace any claim back to its source.",
    assessment_status: "structural",
  };
}

function appendixAnalyticsTablesSlide(num, aggregates) {
  return {
    slide_id:    `slide_${String(num).padStart(3, "0")}`,
    slide_number: num, slide_type: "appendix_analytics_tables", section: "E",
    title:       "Appendix: Analytics Tables", category: null, claim_id: null,
    aggregates_summary: {
      attack_vector_frequency: aggregates.attack_vector_frequency || {},
      signal_cluster_counts:   aggregates.signal_cluster_counts   || {},
      maturity_distribution:   aggregates.maturity_distribution   || {},
      source_type_counts:      aggregates.source_type_counts      || {},
    },
    visualization_ids: [],
    core_message: "Full analytics tables: frequency distributions and counts behind the charts.",
    speaker_note_intent: "Reference slide — the raw analytics tables behind the visualizations.",
    assessment_status: "structural",
  };
}

function appendixTaxonomySlide(num) {
  return {
    slide_id:    `slide_${String(num).padStart(3, "0")}`,
    slide_number: num, slide_type: "appendix_taxonomy", section: "E",
    title:       "Appendix: Taxonomy Reference", category: null, claim_id: null,
    visualization_ids: [],
    core_message: "The controlled taxonomy: categories, attack vectors, AI layers, and framework mappings.",
    speaker_note_intent: "Reference slide — the full controlled vocabulary used throughout the scan.",
    assessment_status: "structural",
  };
}

function appendixBibliographySlide(num) {
  return {
    slide_id:    `slide_${String(num).padStart(3, "0")}`,
    slide_number: num, slide_type: "appendix", section: "E",
    title:       "Appendix: Source Bibliography", category: null, claim_id: null,
    visualization_ids: [],
    core_message: "Full source citations with publishers and URLs.",
    speaker_note_intent: "Reference slide — the complete source bibliography.",
    assessment_status: "structural",
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the full claim-first horizon-scan deck plan.
 *
 * @param {object[]} categoryAnalyses    - From Layer 6 (qaAllCategoryAnalyses)
 * @param {object[]} dossiers            - From buildFusedDossiers()
 * @param {object[]} feedSources         - All enriched sources
 * @param {object}   aggregates          - From aggregateAnalytics()
 * @param {object[]} visualizationSpecs  - From generateVisualizationSpecs()
 * @param {object}   [presentationPacket]
 * @param {object}   [claimChainResults] - Keyed by category — from runClaimChainAllCategories()
 * @returns {object[]} Ordered slide plan.
 */
export function planSlides(
  categoryAnalyses, dossiers, feedSources, aggregates, visualizationSpecs,
  presentationPacket = null, claimChainResults = {}
) {
  const plan = [];
  let num = 1;
  const specs = visualizationSpecs;

  const hasPacket = !!(presentationPacket &&
    (presentationPacket.category_sections?.length > 0 || presentationPacket.executive_overview));

  // ── Collect all critical claims across categories (for executive synthesis) ─
  const allCriticalClaims = ANALYSIS_CATEGORY_ORDER.flatMap((cat) => {
    const chain = claimChainResults[cat] || {};
    return (chain.claims || [])
      .filter((c) => c.claim_priority === "critical")
      .map((c) => ({ ...c, _category: cat }));
  });

  // ── Section A: Opening / Context ──────────────────────────────────────────
  plan.push(titleSlide(num++));
  plan.push(scopeMethodologySlide(num++, aggregates));
  plan.push(sourceCoverageSlide(num++, aggregates, specs));
  plan.push(taxonomyReferenceSlide(num++, aggregates, specs));
  plan.push(executiveSummarySlide(num++, categoryAnalyses, aggregates, specs, allCriticalClaims));

  // ── Section B: Executive Synthesis (conditional on critical claims) ────────
  if (allCriticalClaims.length > 0) {
    plan.push(topCriticalClaimsSlide(num++, allCriticalClaims));
    plan.push(threatLandscapeByPrioritySlide(num++, categoryAnalyses, claimChainResults, aggregates, specs));
  }

  // ── Section C: Per-category blocks ────────────────────────────────────────
  const activeCats = ANALYSIS_CATEGORY_ORDER.filter((cat) =>
    categoryAnalyses.some((a) => a.category === cat)
  );

  for (const cat of activeCats) {
    const analysis   = findAnalysis(categoryAnalyses, cat);
    const dossier    = findDossier(dossiers, cat);
    const catSection = hasPacket
      ? (presentationPacket.category_sections || []).find((s) => s.category === cat)
      : null;
    const merged = attachPacketSection(analysis, catSection);
    const chainResult = claimChainResults[cat] || null;

    let block;
    if (chainResult?.claims?.length > 0) {
      block = buildClaimFirstCategoryBlock(num, cat, merged, dossier, specs, chainResult);
    } else {
      block = legacyCategoryBlock(num, cat, merged, dossier, specs);
    }
    plan.push(...block);
    num += block.length;
  }

  // ── Section D: Cross-Category Synthesis ───────────────────────────────────
  plan.push(crossCategorySynthesisSlide(num++, categoryAnalyses, aggregates, specs, presentationPacket));
  plan.push(overallOutlookSlide(num++, categoryAnalyses, claimChainResults, specs));
  plan.push(watchlistSlide(num++, categoryAnalyses, claimChainResults, specs));
  plan.push(evidenceGapsConfidenceSlide(num++, categoryAnalyses));

  // ── Section E: Appendix ───────────────────────────────────────────────────
  plan.push(appendixEvidenceIndexSlide(num++));
  plan.push(appendixAnalyticsTablesSlide(num++, aggregates));
  plan.push(appendixTaxonomySlide(num++));
  plan.push(appendixBibliographySlide(num++));

  return plan;
}
