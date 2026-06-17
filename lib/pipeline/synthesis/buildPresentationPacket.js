/**
 * Layer 6.9 — Presentation Planning Packet
 *
 * ADAPTER ROLE: This module converts Layer 6 synthesis outputs into a
 * presentation-ready packet for the slides layer. It reads from:
 *   - categoryAnalyses (validated L6.3/L6.4 outputs, QA'd by L6.7)
 *   - fusedDossiers (L6.1 canonical evidence)
 *   - claimChainResults (L6 claim views keyed by category)
 *   - vizSpecs (L5B/L5C visualization specs)
 *
 * It does NOT re-analyse. It does NOT modify claim priority. It is a
 * formatting/packaging step only.
 *
 * ── SKIPPED CATEGORIES (run-cap stubs) ─────────────────────────────────────
 * Category analyses with assessment_status === "not_synthesized_due_to_run_cap"
 * are excluded from full category_sections[]. They appear instead in
 * skipped_category_sections[] with a minimal stub so slide planners can
 * render a "category not processed" page rather than silently omitting a
 * threat area from the deck.
 *
 * ── v2 ADDITIONS ─────────────────────────────────────────────────────────────
 * v2 added claim-level planning fields:
 *   - claims[] across all categories
 *   - selected_evidence_by_claim[]
 *   - candidate_visuals_by_claim[]
 *   - selected_visual_by_claim[]
 *   - argument_form_by_claim[]
 *   - slide_usefulness_scores[]
 *   - evidence_gap_summary[]
 *   - visualization_index at top level (previously only in appendix)
 *   - evidence_index at top level
 *
 * No LLM calls — fully deterministic.
 */

import {
  selectSlideArgumentForm,
  classifyVisualSupportRelationship,
  scoreVisualForClaim,
  scoreClaimSlideUsefulness,
} from "../slides/selectSlideArgumentForm.js";

const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function filterViz(ids, availableIds) {
  const avail = new Set(availableIds || []);
  return (ids || []).filter((id) => avail.has(id));
}

// Quality-fit ordering for category key_evidence: prefer independent, primary-origin,
// concrete (named entities / numbers) items over merely strong-by-bucket items, so the
// overview surfaces credible evidence rather than the first item in the bucket.
function evidenceFitScore(i) {
  let s = 0;
  if (i.origin_role === "primary_origin") s += 2;
  const indep = i.independence_level;
  if (indep === "independent") s += 2;
  else if (indep === "vendor_interested" || indep === "self_reported" || indep === "circular_reporting_risk") s -= 1;
  if ((i.entities || []).length) s += 1;
  if ((i.numbers || []).length) s += 1;
  return s;
}

function pickTopEvidence(pack, limit = 5) {
  if (!pack) return [];
  return [
    ...(pack.strong_evidence || []),
    ...(pack.usable_evidence || []),
  ]
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => (evidenceFitScore(b.item) - evidenceFitScore(a.item)) || (a.idx - b.idx))
    .map(({ item }) => item)
    .slice(0, limit).map((item) => ({
    evidence_id:   item.evidence_id,
    source_title:  item.source_title || "",
    publisher:     item.publisher || "",
    url:           item.url || "",
    display_label: item.display_label || item.fact?.slice(0, 80) || "",
    evidence_type: item.evidence_type,
    confidence:    item.evidence_confidence,
  }));
}

function buildCitedSources(categoryAnalyses, feedSources) {
  const citedIds = new Set();
  for (const a of categoryAnalyses || []) {
    for (const ins of (a.top_insights || [])) {
      (ins.supporting_evidence_ids || []).forEach((id) => citedIds.add(id));
    }
    for (const h of (a.biggest_happenings || [])) {
      (h.supporting_evidence_ids || []).forEach((id) => citedIds.add(id));
    }
    (a.key_source_ids || []).forEach((id) => citedIds.add(id));
  }

  const sourceMap = new Map((feedSources || []).map((s) => [s.id, s]));
  const cited = [];

  for (const id of citedIds) {
    // Raw evidence IDs are raw_<source_id> — extract source_id
    const sourceId = id.startsWith("raw_") ? id.slice(4) : id;
    const source   = sourceMap.get(sourceId);
    if (source) {
      cited.push({
        source_id:  source.id,
        title:      source.title,
        url:        source.url,
        publisher:  source.publisher,
        date:       (source.date_published || "").slice(0, 10),
        source_type: source.source_type,
        trust_tier: source.trust_tier,
      });
    }
  }

  return cited;
}

function buildEvidenceIndex(fusedDossiers) {
  const index = {};
  for (const d of fusedDossiers || []) {
    const rf = d.rawfact || {};
    const allItems = [
      ...(rf.strong_evidence || []),
      ...(rf.usable_evidence || []),
      ...(rf.case_study_candidates || []),
      ...(rf.statistics || []),
    ];
    for (const item of allItems) {
      if (item.evidence_id) {
        index[item.evidence_id] = {
          evidence_id:  item.evidence_id,
          source_title: item.source_title || "",
          publisher:    item.publisher || "",
          url:          item.url || "",
          evidence_type: item.evidence_type,
          category:     d.category,
        };
      }
    }
    // Also index legacy raw_* items
    for (const item of (d.rawfact_evidence || [])) {
      if (item.evidence_id) {
        index[item.evidence_id] = {
          evidence_id:  item.evidence_id,
          source_title: item.title || "",
          publisher:    item.publisher || "",
          url:          item.url || "",
          evidence_type: "rawfact",
          category:     d.category,
        };
      }
    }
  }
  return index;
}

function buildVizIndex(vizSpecs) {
  const index = {};
  for (const spec of vizSpecs || []) {
    index[spec.visualization_id] = {
      visualization_id: spec.visualization_id,
      chart_type:       spec.chart_type,
      title:            spec.title,
    };
  }
  return index;
}

// ── Executive overview ─────────────────────────────────────────────────────────

function buildExecutiveOverview(crossCategorySynthesis, categoryAnalyses, derivedMetrics, vizSpecs) {
  const cc         = crossCategorySynthesis || {};
  const availViz   = (vizSpecs || []).map((s) => s.visualization_id);
  const execSummary = cc.executive_summary || {};

  const topInsightPerCat = (categoryAnalyses || []).map((a) => ({
    category:   a.category,
    label:      CATEGORY_LABELS[a.category] || a.category,
    headline:   a.category_headline || (a.top_insights || [])[0]?.insight || a.overview?.slice(0, 100) || "",
    confidence: a.analysis_confidence,
  })).filter((x) => x.headline);

  const highIndexes = Object.entries(derivedMetrics || {})
    .filter(([, m]) => m?.label === "high" || m?.label === "very_high")
    .map(([name, m]) => ({ name, value: m.value, label: m.label }));

  return {
    headline:            execSummary.headline || "AI threat activity spans multiple categories this reporting period.",
    key_judgments:       execSummary.key_judgments || [],
    category_headlines:  topInsightPerCat,
    high_risk_indexes:   highIndexes,
    recommended_visualizations: filterViz(
      ["monthly_category_timeline", "category_distribution", "derived_metrics_overview", "source_type_distribution"],
      availViz
    ),
  };
}

// ── Category sections ─────────────────────────────────────────────────────────

function buildCategorySection(analysis, fusedDossier, vizSpecs) {
  if (!analysis) return null;

  const availViz  = (vizSpecs || []).map((s) => s.visualization_id);
  const pack      = fusedDossier?.evidence_pack || null;
  const topEv     = pickTopEvidence(pack, 5);

  // Gather all recommended viz IDs from insights + outlook + signals
  const recommendedVizSet = new Set();
  for (const ins of (analysis.top_insights || [])) {
    (ins.recommended_visualization_ids || []).forEach((id) => recommendedVizSet.add(id));
  }
  for (const sig of (analysis.early_signals || [])) {
    (sig.recommended_visualization_ids || []).forEach((id) => recommendedVizSet.add(id));
  }
  if (analysis.outlook?.recommended_visualization_ids) {
    analysis.outlook.recommended_visualization_ids.forEach((id) => recommendedVizSet.add(id));
  }

  const analyticsEvidence = (fusedDossier?.analytics?.analytics_evidence || []).slice(0, 3);

  return {
    category:               analysis.category,
    label:                  CATEGORY_LABELS[analysis.category] || analysis.category,
    headline:               analysis.category_headline || "",
    overview:               analysis.overview || "",
    biggest_happenings:     analysis.biggest_happenings || [],
    top_insights:           analysis.top_insights || [],
    early_signals:          (analysis.early_signals || []).filter((s) => s.qa_pass !== false),
    recommendations:        analysis.recommendations || [],
    outlook:                analysis.outlook || null,
    evidence_gaps:          analysis.evidence_gaps || [],
    analysis_confidence:    analysis.analysis_confidence,

    key_evidence:           topEv,
    analytics_evidence:     analyticsEvidence,
    recommended_visualizations: filterViz([...recommendedVizSet], availViz),
  };
}

// ── Cross-category section ─────────────────────────────────────────────────────

function buildCrossCategorySection(crossCategorySynthesis, vizSpecs) {
  const cc       = crossCategorySynthesis || {};
  const availViz = (vizSpecs || []).map((s) => s.visualization_id);

  const allRecommendedViz = new Set();
  for (const p of (cc.cross_category_patterns || [])) {
    (p.recommended_visualization_ids || []).forEach((id) => allRecommendedViz.add(id));
  }
  if (cc.strategic_outlook?.recommended_visualization_ids) {
    cc.strategic_outlook.recommended_visualization_ids.forEach((id) => allRecommendedViz.add(id));
  }

  return {
    patterns:                 cc.cross_category_patterns || [],
    overall_biggest_happenings: cc.overall_biggest_happenings || [],
    overall_early_signals:    cc.overall_early_signals || [],
    strategic_outlook:        cc.strategic_outlook || null,
    recommended_visualizations: filterViz(
      [...allRecommendedViz, "signal_cluster_radar", "attack_surface_heatmap", "signal_cluster_heatmap"],
      availViz
    ),
  };
}

// ── Visual scoring by claim ────────────────────────────────────────────────────

/**
 * Build candidate_visuals_by_claim, selected_visual_by_claim, argument_form_by_claim,
 * and slide_usefulness_scores for all non-rejected claims.
 *
 * @param {object}   claimChainResults  - keyed by category from runClaimChainAllCategories()
 * @param {object[]} fusedDossiers      - fused dossiers (for analytics packets per category)
 * @param {object[]} vizSpecs           - visualization specs (L5B/L5C)
 * @returns {{ candidateVisualsByClaim, selectedVisualByClaim, argumentFormByClaim, slideUsefulnessScores }}
 */
function buildVisualsByClaim(claimChainResults = {}, fusedDossiers = [], vizSpecs = []) {
  // Build a map from category → analytics packets
  const analyticsMap = {};
  for (const d of fusedDossiers) {
    analyticsMap[d.category] = d.analytics?.analytics_evidence || [];
  }

  // Build a map from claim_id → selected evidence from chain results
  const selectedEvidenceMap = {};
  for (const chainResult of Object.values(claimChainResults)) {
    for (const sel of (chainResult?.selected_evidence_by_claim || [])) {
      selectedEvidenceMap[sel.claim_id] = sel.selected_evidence || [];
    }
  }

  const candidateVisualsByClaim = [];
  const selectedVisualByClaim   = [];
  const argumentFormByClaim     = [];
  const slideUsefulnessScores   = [];

  for (const [cat, chainResult] of Object.entries(claimChainResults)) {
    const analyticsPackets = analyticsMap[cat] || [];

    for (const claim of (chainResult?.claims || [])) {
      if (claim.claim_priority === "rejected") continue;

      const claimWithCat = { ...claim, category: cat };
      const evidence      = selectedEvidenceMap[claim.claim_id] || [];

      // Select argument form
      const argForm = selectSlideArgumentForm(claimWithCat, evidence, analyticsPackets, vizSpecs);

      // Score all candidate visuals
      const scored = (vizSpecs || []).map((viz) => {
        const rel   = classifyVisualSupportRelationship(viz, claimWithCat, argForm);
        const score = scoreVisualForClaim(viz, claimWithCat, argForm, rel);
        return { ...score, vizSpec: viz };
      }).filter((s) => s.overall_visual_slide_score > 0)
        .sort((a, b) => b.overall_visual_slide_score - a.overall_visual_slide_score);

      // Best direct_support visual (or null)
      const bestDirect = scored.find((s) => s.visual_support_relationship === "direct_support") || null;

      // Slide usefulness scoring
      const usefulnessScore = scoreClaimSlideUsefulness(claimWithCat, evidence, analyticsPackets, vizSpecs);

      candidateVisualsByClaim.push({
        claim_id:          claim.claim_id,
        argument_form:     argForm,
        candidate_visuals: scored.slice(0, 5).map(({ vizSpec: _v, ...s }) => s),
      });

      selectedVisualByClaim.push({
        claim_id:         claim.claim_id,
        argument_form:    argForm,
        selected_visual:  bestDirect ? {
          visualization_id:            bestDirect.visualization_id,
          visual_support_relationship: bestDirect.visual_support_relationship,
          overall_visual_slide_score:  bestDirect.overall_visual_slide_score,
          chart_type:                  bestDirect.vizSpec?.chart_type || null,
          title:                       bestDirect.vizSpec?.title || null,
        } : null,
      });

      argumentFormByClaim.push({
        claim_id:     claim.claim_id,
        argument_form: argForm,
        category:     cat,
      });

      slideUsefulnessScores.push(usefulnessScore);
    }
  }

  return { candidateVisualsByClaim, selectedVisualByClaim, argumentFormByClaim, slideUsefulnessScores };
}

// ── Public API ────────────────────────────────────────────────────────────────

// ── Claim-level planning helpers ──────────────────────────────────────────────

/**
 * Collect all non-rejected claims across all categories from claim chain results.
 * Annotates each claim with its category.
 */
function collectAllClaims(claimChainResults = {}) {
  const claims = [];
  for (const [cat, chainResult] of Object.entries(claimChainResults)) {
    for (const claim of (chainResult?.claims || [])) {
      if (claim.claim_priority !== "rejected") {
        claims.push({ ...claim, category: cat });
      }
    }
  }
  return claims;
}

/**
 * Build selected_evidence_by_claim[] from claim chain results.
 */
function collectSelectedEvidenceByClaim(claimChainResults = {}) {
  const result = [];
  for (const chainResult of Object.values(claimChainResults)) {
    for (const sel of (chainResult?.selected_evidence_by_claim || [])) {
      result.push(sel);
    }
  }
  return result;
}

/**
 * Build evidence_gap_summary[] from category analyses.
 */
function buildEvidenceGapSummary(categoryAnalyses) {
  return (categoryAnalyses || []).flatMap((a) =>
    (a.evidence_gaps || []).map((g) => ({
      category:    a.category,
      gap:         typeof g === "string" ? g : (g.gap || g.description || ""),
      confidence:  a.analysis_confidence,
    }))
  ).filter((g) => g.gap);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build the presentation packet from synthesis outputs.
 *
 * @param {object}   opts
 * @param {object[]} opts.categoryAnalyses         - QA'd category analyses
 * @param {object}   opts.crossCategorySynthesis   - Cross-category synthesis output
 * @param {object[]} opts.fusedDossiers            - Fused dossiers with evidence
 * @param {object}   opts.derivedMetrics           - Derived metric indexes
 * @param {object[]} opts.vizSpecs                 - Visualization specs
 * @param {object[]} opts.feedSources              - All enriched sources
 * @param {object}   [opts.claimChainResults]      - Keyed by category from runClaimChainAllCategories()
 * @returns {object} Presentation packet ready for the slides layer
 */
export function buildPresentationPacket({
  categoryAnalyses = [],
  crossCategorySynthesis = {},
  fusedDossiers = [],
  derivedMetrics = {},
  vizSpecs = [],
  feedSources = [],
  claimChainResults = {},
  runCorpusAudit = null,
}) {
  const dossierMap = new Map(fusedDossiers.map((d) => [d.category, d]));

  // Separate run-cap stubs from fully-synthesized categories
  const synthesizedAnalyses = (categoryAnalyses || []).filter(
    (a) => a.assessment_status !== "not_synthesized_due_to_run_cap"
  );
  const skippedAnalyses = (categoryAnalyses || []).filter(
    (a) => a.assessment_status === "not_synthesized_due_to_run_cap"
  );

  const executive_overview = buildExecutiveOverview(
    crossCategorySynthesis, synthesizedAnalyses, derivedMetrics, vizSpecs
  );

  const category_sections = synthesizedAnalyses
    .map((analysis) => buildCategorySection(analysis, dossierMap.get(analysis.category) || null, vizSpecs))
    .filter(Boolean);

  // Skipped categories — minimal stubs so slide planners know they exist
  const skipped_category_sections = skippedAnalyses.map((a) => ({
    category:            a.category,
    label:               CATEGORY_LABELS[a.category] || a.category,
    assessment_status:   "not_synthesized_due_to_run_cap",
    assessment_status_reason: a.assessment_status_reason || "not processed due to synthesis run cap",
    skipped:             true,
  }));

  const cross_category = buildCrossCategorySection(crossCategorySynthesis, vizSpecs);

  const cited_sources  = buildCitedSources(categoryAnalyses, feedSources);
  const evidence_index = buildEvidenceIndex(fusedDossiers);
  const viz_index      = buildVizIndex(vizSpecs);

  // Claim-level planning fields (v2) — use only synthesized analyses' claims
  const claims                   = collectAllClaims(claimChainResults);
  const selected_evidence_by_claim = collectSelectedEvidenceByClaim(claimChainResults);
  const evidence_gap_summary     = buildEvidenceGapSummary(synthesizedAnalyses);

  // Visual scoring: computed here using argument-form selection
  const {
    candidateVisualsByClaim,
    selectedVisualByClaim,
    argumentFormByClaim,
    slideUsefulnessScores,
  } = buildVisualsByClaim(claimChainResults, fusedDossiers, vizSpecs);

  return {
    executive_overview,
    category_sections,
    skipped_category_sections,
    cross_category,

    // Run-level corpus representativeness (P0-2) — rendered on the scope/methodology
    // slide so the corpus's bias and the resulting confidence ceiling are stated.
    run_corpus_audit:    runCorpusAudit,
    corpus_confidence:   runCorpusAudit?.corpus_confidence || null,
    scope_limitations:   runCorpusAudit?.limitations || [],

    // Claim-level planning (consumed by planSlides / generateSlideContent)
    claims,
    selected_evidence_by_claim,
    candidate_visuals_by_claim:  candidateVisualsByClaim,
    selected_visual_by_claim:    selectedVisualByClaim,
    argument_form_by_claim:      argumentFormByClaim,
    slide_usefulness_scores:     slideUsefulnessScores,
    evidence_gap_summary,

    // Indexes available at top level (not just in appendix)
    visualization_index: viz_index,
    evidence_index,

    appendix: {
      cited_sources,
      evidence_index,
      visualization_index: viz_index,
    },
  };
}
