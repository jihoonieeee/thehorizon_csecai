/**
 * Layer 7 — Deck Planner (40–50 slide horizon-scan skeleton)
 *
 * Fully deterministic — no LLM calls. Builds the full horizon-scan deck plan
 * from Layer 6 synthesis outputs.
 *
 * ── DECK STRUCTURE (matches the canonical 47-slide skeleton) ──────────────────
 * Overview (9 slides):
 *   1  Title
 *   2  Scope and Timeframe
 *   3  Methodology
 *   4  Source Coverage
 *   5  Taxonomy and Framework Mapping
 *   6  Overall Threat Landscape
 *   7  Corpus Analytics Overview
 *   8  Cross-Cutting Trends
 *   9  Cross-Cutting Early Signals
 *
 * Per active category (7 slides × N):
 *   Section Divider
 *   Viewpoint
 *   Technique Map
 *   Top Evidence
 *   Case Studies
 *   Analytics
 *   Outlook and Gaps
 *
 * Synthesis (4 slides — offensive analysis only; no defensive/governance content):
 *   Cross-Category Convergence
 *   Maturity and Operationalisation Assessment
 *   Watchlist
 *   Evidence Gaps and Confidence
 *
 * Appendix (4 slides):
 *   Full Evidence Index
 *   Analytics Tables
 *   Taxonomy Reference
 *   Source Bibliography
 *
 * Totals: 10 overview (incl. Executive Overview) + 7N + 4 synthesis + 4 appendix
 *         →  46 for N=4, 39 for N=3, 32 for N=2.
 *
 * ── INPUTS ───────────────────────────────────────────────────────────────────
 * category_analyses[]  — from Layer 6 (qaAllCategoryAnalyses)
 * dossiers[]           — from buildFusedDossiers()
 * feed_sources[]       — all enriched sources
 * aggregates           — from aggregateAnalytics()
 * visualization_specs[] — from generateVisualizationSpecs()
 * presentationPacket   — optional from buildPresentationPacket()
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

// External-evidence chart spec IDs (re-drawn from real online data series),
// optionally filtered to one category. Used to surface field charts on slides.
function externalChartIds(specs, category = null) {
  return (specs || [])
    .filter((v) => v.source === "external_web" && (!category || v.category === category))
    .map((v) => v.visualization_id);
}

function findDossier(dossiers, category) {
  return (dossiers || []).find((d) => d.category === category) || null;
}

function findAnalysis(analyses, category) {
  return (analyses || []).find((a) => a.category === category) || null;
}

// ── Overview slide builders ───────────────────────────────────────────────────

function titleSlide(num) {
  return {
    slide_number: num, slide_type: "title",
    title: "AI Cyber Threat Horizon Scan", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    visualization_ids: [],
    core_message: "A strategic horizon scan of emerging AI cyber threats.",
    speaker_note_intent: "Introduce the briefing: strategic AI-cyber threat horizon scan. Cover reporting period, audience, and scope in 1-2 sentences.",
  };
}

function scopeTimeframeSlide(num, aggregates) {
  return {
    slide_number: num, slide_type: "scope_timeframe",
    title: "Scope and Timeframe", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    aggregates_summary: {
      total_sources: aggregates.total_sources || 0,
      date_range:    aggregates.date_range    || {},
      category_counts: aggregates.category_counts || {},
    },
    visualization_ids: [],
    core_message: "What this horizon scan covers, the reporting window, and the threat categories in scope.",
    speaker_note_intent: "State the reporting window, the four AI threat categories in scope, and what is explicitly out of scope. Keep it to 3-4 sentences.",
  };
}

function methodologySlide(num) {
  return {
    slide_number: num, slide_type: "methodology",
    title: "Methodology", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    visualization_ids: [],
    core_message: "Multi-layer evidence pipeline: ingest, validate, extract rawfacts, compute analytics, synthesise.",
    speaker_note_intent: "Describe the pipeline: source collection (connectors), L3 validation and relevance gating, L5A rawfact evidence extraction, L5B corpus analytics, L6 category analysis. Emphasise that every claim is evidence-grounded with traceable IDs.",
  };
}

function sourceCoverageSlide(num, aggregates, specs) {
  return {
    slide_number: num, slide_type: "source_coverage",
    title: "Source Coverage", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    aggregates_summary: {
      total_sources:      aggregates.total_sources    || 0,
      category_counts:    aggregates.category_counts  || {},
      source_type_counts: aggregates.source_type_counts || {},
      trust_tier_counts:  aggregates.trust_tier_counts  || {},
    },
    visualization_ids: filterVizIds(["source_type_distribution", "category_distribution"], specs),
    core_message: `${aggregates.total_sources || 0} validated sources across ${Object.keys(aggregates.category_counts || {}).length} threat categories.`,
    speaker_note_intent: "Present total source volume, category split, source type mix, and trust tier distribution. Give a sense of evidence quality.",
  };
}

function taxonomyFrameworkSlide(num, aggregates, specs) {
  return {
    slide_number: num, slide_type: "taxonomy_framework",
    title: "Taxonomy and Framework Mapping", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    aggregates_summary: {
      attack_vector_frequency:  aggregates.attack_vector_frequency  || {},
      ai_layer_frequency:       aggregates.ai_layer_frequency       || {},
    },
    visualization_ids: filterVizIds(["prompt_injection_subtype_distribution", "ai_layer_frequency", "attack_vector_frequency"], specs),
    core_message: "How observed threats map to OWASP and MITRE ATLAS/ATT&CK frameworks.",
    speaker_note_intent: "Explain the controlled taxonomy: threat categories, attack vectors, AI system layers, and framework mappings (OWASP LLM Top 10, MITRE ATLAS, MITRE ATT&CK). This anchors the rest of the deck in recognised standards.",
  };
}

function landscapeSlide(num, aggregates, specs) {
  return {
    slide_number: num, slide_type: "landscape",
    title: "Overall Threat Landscape", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    aggregates_summary: {
      category_counts:       aggregates.category_counts || {},
      maturity_distribution: aggregates.maturity_distribution || {},
      total_sources:         aggregates.total_sources || 0,
    },
    visualization_ids: filterVizIds(["domain_distribution", "category_distribution", "primary_threat_tag_distribution", "maturity_distribution"], specs),
    core_message: "The AI-cyber threat landscape distributed across four offensive categories.",
    speaker_note_intent: "Show the overall shape of the corpus: category distribution, threat maturity, and which AI system layers are most exposed.",
  };
}

function corpusAnalyticsSlide(num, aggregates, derivedMetrics, specs) {
  return {
    slide_number: num, slide_type: "corpus_analytics",
    title: "Corpus Analytics Overview", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    aggregates_summary: {
      attack_vector_frequency: aggregates.attack_vector_frequency || {},
      signal_cluster_counts:   aggregates.signal_cluster_counts   || {},
      operational_status_distribution: aggregates.operational_status_distribution || {},
    },
    derived_metrics_summary: derivedMetrics || {},
    visualization_ids: filterVizIds([
      "primary_threat_tag_distribution", "ai_enabled_mapping_distribution",
      "attack_vector_frequency", "operational_status_by_category",
      ...externalChartIds(specs),
    ], specs),
    core_message: "Corpus-level measurement: primary threat tags, AI-enabled mappings, operational status.",
    speaker_note_intent: "Walk through the quantitative picture of the corpus. Reference the derived risk indexes and what they measure. Note explicitly where data is sparse or dominated by unknown classifications.",
  };
}

function crossCuttingTrendsSlide(num, analyses, aggregates, specs) {
  const themes = Object.entries(aggregates.recurring_theme_counts || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, v]) => ({ theme: k, count: v }));
  return {
    slide_number: num, slide_type: "cross_cutting_trends",
    title: "Cross-Cutting Trends", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    recurring_themes: themes,
    aggregates_summary: {
      recurring_theme_counts: aggregates.recurring_theme_counts || {},
      attack_surface_frequency: aggregates.attack_surface_frequency || {},
    },
    visualization_ids: filterVizIds(["agentic_subdomain_distribution", "recurring_theme_heatmap", "attack_surface_heatmap"], specs),
    core_message: "Themes and attack surfaces that recur across multiple threat categories.",
    speaker_note_intent: "Identify the patterns that appear across more than one category — shared attack surfaces, recurring themes. These cross-cutting trends are often more strategically important than any single category.",
  };
}

function crossCuttingSignalsSlide(num, analyses, packet, specs) {
  const signals = packet?.cross_category?.overall_early_signals
    || analyses.flatMap((a) => (a.early_signals || []).filter((s) => s.qa_pass !== false).slice(0, 2)
        .map((s) => ({ ...s, category: a.category })));
  return {
    slide_number: num, slide_type: "cross_cutting_signals",
    title: "Cross-Cutting Early Signals", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    cross_category_insights: (signals || []).slice(0, 4),
    visualization_ids: filterVizIds(["signal_cluster_radar", "signal_cluster_heatmap"], specs),
    core_message: "Emerging signals observed across multiple categories — early, but strategically significant.",
    speaker_note_intent: "Present the top cross-category early signals. For each, explain why it is still early (limited evidence) and the 3-6 month trajectory. Distinguish clearly from confirmed happenings.",
    packet_section: packet?.cross_category || null,
  };
}

function execOverviewSlide(num, analyses, aggregates, specs) {
  const topInsightPerCat = analyses.map((a) => ({
    category:   a.category,
    insight:    (a.top_insights || [])[0]?.insight || a.overview?.slice(0, 100),
    confidence: (a.top_insights || [])[0]?.confidence || a.analysis_confidence,
  })).filter((x) => x.insight);
  return {
    slide_number: num, slide_type: "exec_overview",
    title: "Executive Overview", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    cross_category_insights: topInsightPerCat,
    aggregates_summary: {
      total_sources:      aggregates.total_sources  || 0,
      category_counts:    aggregates.category_counts || {},
      top_attack_vectors: (aggregates.top || {}).attack_vectors?.slice(0, 5) || [],
    },
    visualization_ids: filterVizIds(["monthly_category_timeline", "derived_metrics_overview"], specs),
    core_message: "Key findings, source volume, and the top threat signals this reporting period.",
    speaker_note_intent: "Communicate headline findings to decision-makers. Reference total source volume, category split, and most significant judgment. 3-4 sentences.",
  };
}

// ── Per-category slide builders (7 per category) ──────────────────────────────

function sectionDivider(num, category, analysis) {
  return {
    slide_number: num, slide_type: "section_divider",
    title: CATEGORY_LABELS[category] || category, category,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: analysis,
    visualization_ids: [],
    core_message: analysis?.category_headline || analysis?.overview?.slice(0, 130) || `Analysis of ${CATEGORY_LABELS[category] || category}.`,
    speaker_note_intent: `Transition into the ${CATEGORY_LABELS[category] || category} section. One sentence on what you're about to cover.`,
  };
}

function pickEvidence(dossier, buckets, n) {
  const rf = dossier?.rawfact || {};
  const items = buckets.flatMap((b) => rf[b] || []);
  if (items.length) return items.slice(0, n);
  return (dossier?.rawfact_evidence || []).slice(0, n);
}

function categoryViewpointSlide(num, cat, analysis, dossier, specs) {
  return {
    slide_number: num, slide_type: "category_viewpoint",
    title: `${CATEGORY_LABELS[cat] || cat} — Viewpoint`, category: cat,
    rawfact_evidence: pickEvidence(dossier, ["critical_evidence", "high_evidence"], 3),
    analytics_evidence: dossier?.analytics_evidence || [],
    category_analysis: analysis, packet_section: analysis?.packet_section || analysis,
    visualization_ids: [],
    core_message: analysis?.category_headline || analysis?.overview?.slice(0, 120) || "",
    speaker_note_intent: "State the category headline. Explain what changed this period. Cover the 2-3 biggest happenings that drive this judgment. Focus on trajectory, not description.",
  };
}

function categoryTechniqueMapSlide(num, cat, analysis, dossier, specs) {
  return {
    slide_number: num, slide_type: "category_technique_map",
    title: `${CATEGORY_LABELS[cat] || cat} — Technique Map`, category: cat,
    rawfact_evidence: pickEvidence(dossier, ["case_studies", "critical_evidence"], 3),
    analytics_evidence: dossier?.analytics_evidence || [],
    category_analysis: analysis, packet_section: analysis?.packet_section || analysis,
    // No global corpus chart here — the available analytics specs are corpus-wide,
    // not category-specific, so rendering one would mislabel corpus data as this
    // category's. This slide shows its technique evidence instead. Corpus charts
    // live on the overview/synthesis slides where they are accurate.
    visualization_ids: [],
    core_message: `Dominant attack techniques, exposed AI layers, and framework mappings in ${CATEGORY_LABELS[cat] || cat}.`,
    speaker_note_intent: "Walk through the primary attack vectors and techniques. Reference OWASP/MITRE mappings where applicable. Show which AI layers are most exposed and why.",
  };
}

function categoryTopEvidenceSlide(num, cat, analysis, dossier, specs) {
  const ev = pickEvidence(dossier, ["critical_evidence", "high_evidence", "statistics"], 4);
  return {
    slide_number: num, slide_type: "category_evidence",
    title: `${CATEGORY_LABELS[cat] || cat} — Top Evidence`, category: cat,
    rawfact_evidence: ev,
    analytics_evidence: [],
    category_analysis: analysis, packet_section: analysis?.packet_section || analysis,
    visualization_ids: [],
    core_message: `Strongest verified findings for ${CATEGORY_LABELS[cat] || cat}.`,
    speaker_note_intent: "Present the strongest evidence items. For each, name the source, state the specific fact, and connect it to the category headline.",
  };
}

function categoryCaseStudiesSlide(num, cat, analysis, dossier, specs) {
  const ev = pickEvidence(dossier, ["case_studies", "high_evidence"], 3);
  return {
    slide_number: num, slide_type: "case_studies",
    title: `${CATEGORY_LABELS[cat] || cat} — Case Studies`, category: cat,
    rawfact_evidence: ev,
    analytics_evidence: [],
    category_analysis: analysis, packet_section: analysis?.packet_section || analysis,
    visualization_ids: [],
    core_message: `Concrete incidents and demonstrated capabilities in ${CATEGORY_LABELS[cat] || cat}.`,
    speaker_note_intent: "Walk through 2-3 specific incidents or demonstrated capabilities in depth. Explain the attack chain or what was demonstrated, and why each one matters for defenders.",
  };
}

function categoryAnalyticsSlide(num, cat, analysis, dossier, specs) {
  return {
    slide_number: num, slide_type: "category_analytics",
    title: `${CATEGORY_LABELS[cat] || cat} — Analytics`, category: cat,
    rawfact_evidence: pickEvidence(dossier, ["statistics", "high_evidence"], 3),
    analytics_evidence: dossier?.analytics_evidence || [],
    category_analysis: analysis, packet_section: analysis?.packet_section || analysis,
    // Corpus-wide charts stay on the synthesis slides. Here we surface this
    // category's REAL external-evidence charts (re-drawn from online data series)
    // when available — these ARE category-specific, unlike the corpus charts.
    // The exporter falls back to web-evidence stat cards when no chart is present.
    visualization_ids: filterVizIds(externalChartIds(specs, cat), specs),
    core_message: `Quantitative patterns for ${CATEGORY_LABELS[cat] || cat}: frequency, maturity, and operational status.`,
    speaker_note_intent: "Present the analytics for this category. Reference frequency, maturity, and operational-status distributions. Be honest where the sample is small or dominated by unknowns.",
  };
}

function categoryOutlookGapsSlide(num, cat, analysis, dossier, specs) {
  return {
    slide_number: num, slide_type: "category_outlook_gaps",
    title: `${CATEGORY_LABELS[cat] || cat} — Outlook and Gaps`, category: cat,
    rawfact_evidence: pickEvidence(dossier, ["outlook_signals"], 2),
    analytics_evidence: dossier?.analytics_evidence || [],
    category_analysis: analysis, packet_section: analysis?.packet_section || analysis,
    early_signals: (analysis?.early_signals || []).filter((s) => s.qa_pass !== false),
    outlook_statement: analysis?.outlook,
    evidence_gaps: analysis?.evidence_gaps || [],
    visualization_ids: [],
    core_message: analysis?.outlook?.statement || `${CATEGORY_LABELS[cat] || cat} trajectory over the next 3-6 months.`,
    speaker_note_intent: "Present the 3-6 month outlook and the early signals that could accelerate it. Then state the evidence gaps for this category honestly. Ground forward-looking statements in evidence trajectory.",
  };
}

// Build all 7 slides for one category.
// A single honest "not assessed" slide for a category with no validated evidence —
// replaces the 7 thin/blank slides that would otherwise pad the deck.
function categoryNotAssessedSlide(num, cat, analysis) {
  const note = analysis?.assessment_note
    || "Evidence insufficient this reporting period — category not assessed.";
  return {
    slide_number: num, slide_type: "category_not_assessed",
    title: `${CATEGORY_LABELS[cat] || cat} — Not Assessed`, category: cat,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: analysis,
    assessment_status: "evidence_insufficient",
    visualization_ids: [],
    core_message: note,
    speaker_note_intent: `State plainly that ${CATEGORY_LABELS[cat] || cat} could not be assessed this period due to insufficient validated evidence. Do not speculate. One or two sentences.`,
  };
}

function categoryBlock(startNum, cat, analysis, dossier, specs) {
  let n = startNum;

  // Evidence-gated: a category with no validated evidence is collapsed to a
  // divider + one honest "not assessed" slide instead of 7 empty ones. Keeps the
  // deck tight and defensible rather than padded with blank category slides.
  if (analysis?.assessment_status === "evidence_insufficient") {
    return [
      sectionDivider(n++, cat, analysis),
      categoryNotAssessedSlide(n++, cat, analysis),
    ];
  }

  return [
    sectionDivider(n++, cat, analysis),
    categoryViewpointSlide(n++, cat, analysis, dossier, specs),
    categoryTechniqueMapSlide(n++, cat, analysis, dossier, specs),
    categoryTopEvidenceSlide(n++, cat, analysis, dossier, specs),
    categoryCaseStudiesSlide(n++, cat, analysis, dossier, specs),
    categoryAnalyticsSlide(n++, cat, analysis, dossier, specs),
    categoryOutlookGapsSlide(n++, cat, analysis, dossier, specs),
  ];
}

// ── Synthesis slide builders ──────────────────────────────────────────────────

function crossCategorySlide(num, analyses, aggregates, specs, packet) {
  const cc = packet?.cross_category || {};
  const signals = cc.overall_early_signals
    || analyses.flatMap((a) => (a.early_signals || []).filter((s) => s.qa_pass !== false).slice(0, 2)
        .map((s) => ({ ...s, category: a.category }))).slice(0, 6);
  return {
    slide_number: num, slide_type: "cross_category",
    title: "Cross-Category Convergence", category: "cross_category",
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    cross_category_insights: signals,
    cross_category_patterns: cc.patterns || [],
    overall_biggest_happenings: cc.overall_biggest_happenings || [],
    aggregates_summary: {
      signal_cluster_counts:    aggregates.signal_cluster_counts    || {},
      attack_surface_frequency: aggregates.attack_surface_frequency || {},
      recurring_theme_counts:   aggregates.recurring_theme_counts   || {},
    },
    visualization_ids: filterVizIds(["attack_surface_heatmap", "signal_cluster_radar", "recurring_theme_heatmap", ...externalChartIds(specs)], specs),
    core_message: "AI threats are converging — offensive AI, LLM attacks, and agentic risks compound each other.",
    speaker_note_intent: "Connect the threads across categories. Show where attack surfaces overlap and how threats compound. Name specific overlapping techniques.",
    packet_section: packet?.cross_category || null,
  };
}

function maturityAssessmentSlide(num, analyses, specs) {
  return {
    slide_number: num, slide_type: "maturity_assessment",
    title: "Maturity and Operationalisation Assessment", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    cross_category_insights: analyses.map((a) => ({
      category: a.category, insight: a.outlook?.statement || "", confidence: a.analysis_confidence,
    })).filter((x) => x.insight),
    visualization_ids: filterVizIds(["evidence_validation_distribution", "maturity_distribution", "operational_status_by_category"], specs),
    core_message: "Where each AI threat category sits on the research-to-operational spectrum.",
    speaker_note_intent: "Characterise each category on the spectrum from research to mainstream operational use. Reference derived metrics. Highlight which threats are accelerating toward operational status.",
  };
}

function watchlistSlide(num, analyses, specs) {
  const earlySignals = analyses.flatMap((a) =>
    (a.early_signals || []).filter((s) => s.qa_pass !== false).slice(0, 2)
      .map((s) => ({ ...s, category: a.category }))
  ).slice(0, 6);
  return {
    slide_number: num, slide_type: "watchlist",
    title: "Watchlist", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    cross_category_insights: earlySignals,
    visualization_ids: filterVizIds(["signal_cluster_radar"], specs),
    core_message: "Signals to monitor in the next 30-60 days.",
    speaker_note_intent: "Present the specific signals to watch in the near term. For each, state the trigger that would escalate it and why it is on the watchlist.",
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
    slide_number: num, slide_type: "evidence_gaps_confidence",
    title: "Evidence Gaps and Confidence", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    evidence_gaps: gaps,
    confidence_by_category: confidenceByCat,
    visualization_ids: [],
    core_message: "Where the intelligence picture is incomplete, and the confidence level behind each category.",
    speaker_note_intent: "Be transparent about limitations. State the evidence gaps per category and the confidence level of each analysis. This builds analytical credibility — do not hide uncertainty.",
  };
}

// ── Appendix slide builders ───────────────────────────────────────────────────

function appendixEvidenceIndexSlide(num) {
  return {
    slide_number: num, slide_type: "appendix_evidence_index",
    title: "Appendix: Full Evidence Index", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    visualization_ids: [],
    core_message: "Complete index of evidence items cited in this briefing, with source IDs.",
    speaker_note_intent: "Reference slide — the full evidence index for analysts who want to trace any claim back to its source.",
  };
}

function appendixAnalyticsTablesSlide(num, aggregates) {
  return {
    slide_number: num, slide_type: "appendix_analytics_tables",
    title: "Appendix: Analytics Tables", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    aggregates_summary: {
      attack_vector_frequency: aggregates.attack_vector_frequency || {},
      signal_cluster_counts:   aggregates.signal_cluster_counts   || {},
      maturity_distribution:   aggregates.maturity_distribution   || {},
      source_type_counts:      aggregates.source_type_counts      || {},
    },
    visualization_ids: [],
    core_message: "Full analytics tables: frequency distributions and counts behind the charts.",
    speaker_note_intent: "Reference slide — the raw analytics tables behind the visualizations.",
  };
}

function appendixTaxonomySlide(num) {
  return {
    slide_number: num, slide_type: "appendix_taxonomy",
    title: "Appendix: Taxonomy Reference", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    visualization_ids: [],
    core_message: "The controlled taxonomy: categories, attack vectors, AI layers, and framework mappings.",
    speaker_note_intent: "Reference slide — the full controlled vocabulary used throughout the scan.",
  };
}

function appendixBibliographySlide(num) {
  return {
    slide_number: num, slide_type: "appendix",
    title: "Appendix: Source Bibliography", category: null,
    rawfact_evidence: [], analytics_evidence: [], category_analysis: null,
    visualization_ids: [],
    core_message: "Full source citations with publishers and URLs.",
    speaker_note_intent: "Reference slide — the complete source bibliography.",
  };
}

// ── Presentation-packet category section merge ────────────────────────────────

function attachPacketSection(analysis, catSection) {
  if (!catSection) return analysis;
  return { ...(analysis || {}), packet_section: catSection };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the full 40–50 slide horizon-scan deck plan.
 *
 * @param {object[]} categoryAnalyses
 * @param {object[]} dossiers
 * @param {object[]} feedSources
 * @param {object}   aggregates
 * @param {object[]} visualizationSpecs
 * @param {object}   [presentationPacket]
 * @returns {object[]} Ordered slide plan.
 */
export function planSlides(
  categoryAnalyses, dossiers, feedSources, aggregates, visualizationSpecs,
  presentationPacket = null
) {
  const plan = [];
  let num = 1;
  const specs = visualizationSpecs;
  const derivedMetrics = presentationPacket?.derived_metrics || {};

  const hasPacket = !!(presentationPacket &&
    (presentationPacket.category_sections?.length > 0 || presentationPacket.executive_overview));

  // ── Overview (9 slides) ───────────────────────────────────────────────────
  plan.push(titleSlide(num++));
  plan.push(scopeTimeframeSlide(num++, aggregates));
  plan.push(methodologySlide(num++));
  plan.push(sourceCoverageSlide(num++, aggregates, specs));
  plan.push(taxonomyFrameworkSlide(num++, aggregates, specs));
  plan.push(landscapeSlide(num++, aggregates, specs));
  plan.push(corpusAnalyticsSlide(num++, aggregates, derivedMetrics, specs));
  plan.push(crossCuttingTrendsSlide(num++, categoryAnalyses, aggregates, specs));
  plan.push(crossCuttingSignalsSlide(num++, categoryAnalyses, presentationPacket, specs));

  // Executive overview sits right after the cross-cutting context
  plan.push(execOverviewSlide(num++, categoryAnalyses, aggregates, specs));

  // ── Per-category blocks (7 slides each) ───────────────────────────────────
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

    const block = categoryBlock(num, cat, merged, dossier, specs);
    plan.push(...block);
    num += block.length;
  }

  // ── Synthesis (4 slides — offensive analysis only) ────────────────────────
  plan.push(crossCategorySlide(num++, categoryAnalyses, aggregates, specs, presentationPacket));
  plan.push(maturityAssessmentSlide(num++, categoryAnalyses, specs));
  plan.push(watchlistSlide(num++, categoryAnalyses, specs));
  plan.push(evidenceGapsConfidenceSlide(num++, categoryAnalyses));

  // ── Appendix (4 slides) ───────────────────────────────────────────────────
  plan.push(appendixEvidenceIndexSlide(num++));
  plan.push(appendixAnalyticsTablesSlide(num++, aggregates));
  plan.push(appendixTaxonomySlide(num++));
  plan.push(appendixBibliographySlide(num++));

  return plan;
}
