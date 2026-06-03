/**
 * L6 — Analysis + Synthesis Orchestrator
 *
 * Top-level orchestrator for the intelligence-production pipeline.
 * Contains no direct LLM calls — all LLM calls are delegated to branch
 * orchestrators and synthesis sublayers.
 *
 * ── PIPELINE ──────────────────────────────────────────────────────────────────
 * L5A  Rawfacts branch     → evidence_items, evidence_packs
 * L5A  Evidence search     → external_evidence (Anthropic-first)
 * L5B  Analytics branch    → aggregates, derived_metrics, viz_specs
 * L6   Evidence fusion     → fused_dossiers (rawfact + analytics combined)
 * L6   Category analysis   → category_analyses (Anthropic → Gemini Pro)
 * L6   Cross-category      → cross_category_synthesis (Anthropic → Gemini Pro)
 * L6   Presentation packet → presentation_packet (deterministic)
 *
 * ── EVIDENCE FLOW ─────────────────────────────────────────────────────────────
 *   rawfact  → what happened / what was demonstrated (concrete, verifiable)
 *   analytics → what patterns appear across the corpus (frequencies, trends)
 *   analysis  → what those facts and patterns mean
 *   slides   → communication layer consuming presentation_packet
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 * {
 *   feed_sources, rawfact, analytics,
 *   fused_dossiers, category_analyses, cross_category_synthesis, presentation_packet,
 *   evidence_inventory, category_evidence_summary, unsupported_claims, manual_review_items,
 *   counts, qa_report, synthesis_version
 *
 *   // backward compat:
 *   evidence_packs, dossiers, viewpoints: []
 * }
 */

import { runRawfactBranch }   from "../rawfact/runRawfactBranch.js";
import { runAnalyticsBranch } from "../analytics/runAnalyticsBranch.js";
import { buildTaxonomyMetricRows } from "../analytics/analyticsAggregation.js";
import { runAnalysisLayer }   from "../analysis/runAnalysisLayer.js";
import {
  runEvidenceSearchLayer,
  attachExternalEvidenceToPacks,
  attachEvidenceReferencesToSpecs,
  buildExternalEvidenceVizSpecs,
  collectUnsupportedClaims,
} from "../evidence/evidenceSearchLayer.js";
import { runCrossCategorySynthesis }  from "./runCrossCategorySynthesis.js";
import { matchVisualizationsToAnalysis } from "./matchVisualizationsToInsights.js";
import { buildPresentationPacket }    from "./buildPresentationPacket.js";

export const SYNTHESIS_VERSION = "synthesis-v8.0";

/**
 * Run the full Layer 6 synthesis pipeline.
 *
 * @param {object[]} sources - Layer-4-enriched sources.
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @returns {Promise<SynthesisResult>}
 */
export async function runSynthesisLayer(sources, opts = {}) {
  const { skipLlm = false } = opts;

  if (sources.length === 0) {
    return {
      feed_sources:           [],
      rawfact:                {},
      analytics:              { aggregates: {}, visualization_specs: [], analytics_references: [] },
      fused_dossiers:         [],
      category_analyses:      [],
      cross_category_synthesis: {},
      presentation_packet:    {},
      evidence_packs:         [],
      dossiers:               [],
      evidence_inventory:     [],
      category_evidence_summary: {},
      unsupported_claims:     [],
      manual_review_items:    [],
      viewpoints:             [],
      counts: { total_sources: 0 },
      synthesis_version: SYNTHESIS_VERSION,
    };
  }

  // ── L5A — Rawfacts branch ────────────────────────────────────────────────
  process.stdout.write("  [L5A-rawfacts] branch starting...\n");
  const {
    rawfact_sources:  withClusters,
    evidence_packs:   rawfactEvidencePacks,
    taxonomy_rawfacts,
    ai_enabled_mappings,
    counts:           rawfactCounts,
  } = await runRawfactBranch(sources, { skipLlm });
  process.stdout.write(
    `    must_read=${rawfactCounts.must_read} high=${rawfactCounts.high} ` +
    `items=${rawfactCounts.evidence_items_total} packs=${rawfactCounts.evidence_packs} ` +
    `clusters=${rawfactCounts.clusters}\n`
  );

  // ── L5A — Evidence search (Anthropic-first, once per category) ────────────
  process.stdout.write("  [L5A-evidence-search] starting (Anthropic/Gemini-Pro)...\n");
  const evidenceSearchResult = await runEvidenceSearchLayer(
    withClusters, rawfactEvidencePacks, { skipLlm }
  );
  const externalEvidence = evidenceSearchResult.external_evidence;
  const enrichedPacks    = attachExternalEvidenceToPacks(rawfactEvidencePacks, externalEvidence);

  // ── L5B — Analytics branch ───────────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] branch starting...\n");
  const analyticsResult = await runAnalyticsBranch(
    withClusters, { skipLlm, externalEvidence }
  );
  const {
    analytics_sources:  withAnalytics,
    aggregates,
    derived_metrics,
    analytics_evidence,
    visualization_specs: rawVizSpecs,
    counts:             analyticsCounts,
  } = analyticsResult;
  process.stdout.write(
    `    categories=${JSON.stringify(analyticsCounts.categories)}  ` +
    `visualizations=${analyticsCounts.visualizations}\n`
  );

  // Enrich corpus viz specs with external evidence references, then append the
  // charts re-drawn from web-evidence data series (real online charts/graphs).
  const externalVizSpecs = buildExternalEvidenceVizSpecs(externalEvidence);
  const visualization_specs = [
    ...attachEvidenceReferencesToSpecs(rawVizSpecs, externalEvidence),
    ...externalVizSpecs,
  ];
  process.stdout.write(`    external-evidence charts: ${externalVizSpecs.length}\n`);

  // ── L6 — Analysis + Synthesis (dossier fusion → category analysis → QA) ──
  process.stdout.write("  [L6-analysis-synthesis] fused dossiers → category analysis → viz matching → QA...\n");
  const { category_analyses, dossiers, analysis_summary, qa_report } =
    await runAnalysisLayer(withAnalytics, aggregates, {
      skipLlm,
      evidencePacks:     enrichedPacks,
      analytics_evidence,
      derived_metrics,
      vizSpecs:          visualization_specs,
      analyticsResult:   { ...analyticsResult, visualization_specs },
      externalEvidence,
    });
  process.stdout.write(
    `    ${analysis_summary.total_categories} categories, ` +
    `${analysis_summary.total_insights} insights, ` +
    `${analysis_summary.total_happenings || 0} happenings, ` +
    `${analysis_summary.total_early_signals} early signals\n`
  );

  // ── L6 — Cross-category synthesis ────────────────────────────────────────
  process.stdout.write("  [L6-analysis-cross-category] cross-category synthesis...\n");
  const cross_category_synthesis = await runCrossCategorySynthesis(
    category_analyses, derived_metrics, visualization_specs, { skipLlm }
  );

  // Apply viz matching to cross-category synthesis
  const matchedCross = matchVisualizationsToAnalysis(cross_category_synthesis, visualization_specs);

  // ── L6 — Presentation packet (deterministic) ─────────────────────────────
  process.stdout.write("  [L6-analysis-presentation-packet] building packet...\n");
  const presentation_packet = buildPresentationPacket({
    categoryAnalyses:       category_analyses,
    crossCategorySynthesis: matchedCross,
    fusedDossiers:          dossiers,
    derivedMetrics:         derived_metrics,
    vizSpecs:               visualization_specs,
    feedSources:            withAnalytics,
  });

  // ── Post-synthesis: collect unsupported claims ────────────────────────────
  const unsupported_claims = collectUnsupportedClaims(enrichedPacks, externalEvidence);

  // ── Counts ────────────────────────────────────────────────────────────────
  const highPriority  = rawfactCounts.must_read + rawfactCounts.high;
  const evidenceCards = rawfactCounts.evidence_cards;

  return {
    feed_sources:   withAnalytics,

    // Rawfact branch outputs
    rawfact: {
      evidence_packs: enrichedPacks,
      counts:         rawfactCounts,
    },

    // Analytics branch outputs
    analytics: {
      aggregates,
      derived_metrics,
      analytics_evidence,
      visualization_specs,
      analytics_references: externalEvidence.filter((e) => e.evidence_confidence !== "low"),
    },

    // Analysis layer outputs
    fused_dossiers:          dossiers,
    category_analyses,
    cross_category_synthesis: matchedCross,
    presentation_packet,

    // Normalized taxonomy artefacts (for taxonomyStore persistence)
    taxonomy_rawfacts:         taxonomy_rawfacts || [],
    ai_enabled_mappings:       ai_enabled_mappings || [],
    taxonomy_metrics:          buildTaxonomyMetricRows(aggregates),
    visual_evidence:           externalEvidence.filter((e) => e && (e.is_visual || e.chart_data)),

    // External evidence (Layer 5e)
    evidence_inventory:        externalEvidence,
    category_evidence_summary: evidenceSearchResult.evidence_by_category,
    unsupported_claims,
    manual_review_items:       evidenceSearchResult.manual_review_items,

    // Backward compatibility
    evidence_packs: enrichedPacks,   // old field name
    dossiers,                        // old field name, still used by planSlides
    viewpoints: [],                  // always empty; kept for slide layer backward compat

    counts: {
      total_sources:       sources.length,
      high_priority:       highPriority,
      evidence_cards:      evidenceCards,
      evidence_packs:      enrichedPacks.length,
      evidence_items:      rawfactCounts.evidence_items_total,
      critical_evidence:   rawfactCounts.critical_items || 0,
      analytics_evidence:  (analytics_evidence || []).length,
      visualizations:      visualization_specs.length,
      category_analyses:   category_analyses.length,
      insights:            analysis_summary.total_insights,
      happenings:          analysis_summary.total_happenings || 0,
      early_signals:       analysis_summary.total_early_signals,
      recommendations:     analysis_summary.total_recommendations || 0,
      clusters:            rawfactCounts.multi_source_clusters,
      external_evidence:   externalEvidence.length,
      unsupported_claims:  unsupported_claims.length,
      manual_review_items: evidenceSearchResult.manual_review_items.length,
      viewpoints:          0,
      rawfact:             rawfactCounts,
      analysis_summary,
      qa_errors:           qa_report.total_removed_insights || 0,
      qa_warnings:         qa_report.categories_downgraded  || 0,
    },

    qa_report,
    synthesis_version: SYNTHESIS_VERSION,
  };
}
