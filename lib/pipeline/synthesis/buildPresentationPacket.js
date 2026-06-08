/**
 * Layer 6.6 — Presentation Planning Packet
 *
 * Converts the full synthesis output into a clean, self-contained packet
 * that the slides layer consumes. The slides layer should prefer this
 * packet over raw branch internals.
 *
 * The packet makes the following contracts explicit:
 *   - What the executive overview should contain
 *   - What each category section has to work with
 *   - What cross-category content is available
 *   - What goes in the appendix
 *
 * No LLM calls — fully deterministic.
 */

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

function pickTopEvidence(pack, limit = 5) {
  if (!pack) return [];
  return [
    ...(pack.strong_evidence || []),
    ...(pack.usable_evidence || []),
  ].slice(0, limit).map((item) => ({
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

// ── Public API ────────────────────────────────────────────────────────────────

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
 * @returns {object} Presentation packet ready for the slides layer
 */
export function buildPresentationPacket({
  categoryAnalyses = [],
  crossCategorySynthesis = {},
  fusedDossiers = [],
  derivedMetrics = {},
  vizSpecs = [],
  feedSources = [],
}) {
  const dossierMap = new Map(fusedDossiers.map((d) => [d.category, d]));

  const executive_overview = buildExecutiveOverview(
    crossCategorySynthesis, categoryAnalyses, derivedMetrics, vizSpecs
  );

  const category_sections = categoryAnalyses
    .map((analysis) => buildCategorySection(analysis, dossierMap.get(analysis.category) || null, vizSpecs))
    .filter(Boolean);

  const cross_category = buildCrossCategorySection(crossCategorySynthesis, vizSpecs);

  const cited_sources  = buildCitedSources(categoryAnalyses, feedSources);
  const evidence_index = buildEvidenceIndex(fusedDossiers);
  const viz_index      = buildVizIndex(vizSpecs);

  return {
    executive_overview,
    category_sections,
    cross_category,
    appendix: {
      cited_sources,
      evidence_index,
      visualization_index: viz_index,
    },
  };
}
