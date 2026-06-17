/**
 * L6 — Analysis + Synthesis Orchestrator
 *
 * Top-level orchestrator for the intelligence-production pipeline.
 * Contains no direct LLM calls — all LLM calls are delegated to branch
 * orchestrators and synthesis sublayers.
 *
 * ── PIPELINE ──────────────────────────────────────────────────────────────────
 * L5A  Rawfacts branch     → evidence_items, evidence_packs
 * L5E  Authoritative Stat Lookup → external_evidence (Anthropic web_search, once per category, corroborates with hard numbers)
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
  webEvidenceToExternalEvidence,
  attachExternalEvidenceToPacks,
  attachEvidenceReferencesToSpecs,
  buildExternalVisualSpecsForSlides,
  collectUnsupportedClaims,
} from "./externalEvidence.js";
import { runCrossCategorySynthesis }  from "./runCrossCategorySynthesis.js";
import { buildRunCorpusAudit, applyCorpusCapToCrossCategory } from "../analysis/runCorpusAudit.js";
import { matchVisualizationsToAnalysis } from "./matchVisualizationsToInsights.js";
import { buildPresentationPacket }    from "./buildPresentationPacket.js";
import { buildAnalysisPackage }       from "../analysis/buildAnalysisPackage.js";
import { runWebEvidenceBranch }       from "../webEvidence/runWebEvidenceBranch.js";
import { getWebEvidenceConfig }       from "../webEvidence/webEvidenceConfig.js";

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
    `    strong=${rawfactCounts.strong_items} usable=${rawfactCounts.usable_items} ` +
    `items=${rawfactCounts.evidence_items_total} packs=${rawfactCounts.evidence_packs} ` +
    `clusters=${rawfactCounts.clusters}\n`
  );

  // ── L5B — Analytics branch ───────────────────────────────────────────────
  // External evidence is produced by 5C (below), which is gap-driven off 5A+5B,
  // so analytics runs first with no external evidence input.
  process.stdout.write("  [L5B-analytics] branch starting...\n");
  const analyticsResult = await runAnalyticsBranch(
    withClusters, { skipLlm, externalEvidence: [] }
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

  // ── L5C — Web Evidence (the single external-evidence branch) ───────────────
  // Auto-enables when a search-provider key is configured. Gap-driven off the RAW
  // rawfact packs + analytics; it also covers the authoritative-statistics role
  // formerly handled by Layer 5E. Empty/no-op when disabled — never blocks.
  let webEvidence = null;
  const webEvidenceConfig = getWebEvidenceConfig();
  if (webEvidenceConfig.enabled) {
    process.stdout.write("  [L5C-web-evidence] starting (gap-driven external evidence + visuals + stats)...\n");
    try {
      const seedEntities = [...new Set(
        withAnalytics.flatMap((s) => (s.understanding?.key_entities || []))
      )].filter(Boolean).slice(0, 20);
      webEvidence = await runWebEvidenceBranch({
        evidencePacks:   rawfactEvidencePacks,
        analyticsResult,
        seedEntities,
        opts: { config: webEvidenceConfig, skipLlm },
      });
      process.stdout.write(
        `    evidence=${webEvidence.counts?.evidence_selected ?? 0}/${webEvidence.counts?.evidence_total ?? 0} ` +
        `visuals(auto-slide)=${webEvidence.counts?.visuals_auto_slide ?? 0} ` +
        `failures=${webEvidence.counts?.failures ?? 0}\n`
      );
    } catch (err) {
      process.stdout.write(`    web evidence branch failed: ${err.message} — continuing without it\n`);
      webEvidence = null;
    }
  }

  // Adapt 5C output into the externalEvidence shape the downstream consumers expect.
  const {
    external_evidence:        externalEvidence,
    external_visual_evidence: externalVisualEvidence,
    evidence_by_category:     externalEvidenceByCategory,
    manual_review_items:      externalManualReviewItems,
  } = webEvidenceToExternalEvidence(webEvidence);

  // Enrich rawfact packs with external evidence; assemble viz specs (corpus specs
  // with external references + real external figures — no synthetic redraw path).
  const enrichedPacks = attachExternalEvidenceToPacks(
    rawfactEvidencePacks, externalEvidence, externalVisualEvidence,
  );
  const externalVisualSpecs = buildExternalVisualSpecsForSlides(externalVisualEvidence);
  const visualization_specs = [
    ...attachEvidenceReferencesToSpecs(rawVizSpecs, externalEvidence),
    ...externalVisualSpecs,
  ];
  process.stdout.write(
    `    external evidence: ${externalEvidence.length} text, ${externalVisualEvidence.length} visual; ` +
    `external-visual specs: ${externalVisualSpecs.length}\n`,
  );

  // ── L6 — Analysis + Synthesis (dossier fusion → category analysis → QA) ──
  process.stdout.write("  [L6-analysis-synthesis] fused dossiers → category analysis → viz matching → QA...\n");
  const { category_analyses, dossiers, analytical_state, analysis_summary, qa_report } =
    await runAnalysisLayer(withAnalytics, aggregates, {
      skipLlm,
      evidencePacks:     enrichedPacks,
      analytics_evidence,
      derived_metrics,
      vizSpecs:          visualization_specs,
      analyticsResult:   { ...analyticsResult, visualization_specs },
      externalEvidence,
      visualEvidence:    externalVisualEvidence,
      webEvidence,
    });
  process.stdout.write(
    `    ${analysis_summary.total_categories} categories, ` +
    `${analysis_summary.total_insights} insights, ` +
    `${analysis_summary.total_happenings || 0} happenings, ` +
    `${analysis_summary.total_early_signals} early signals\n`
  );

  // ── L6-claim-chain results (single source of truth) ──────────────────────
  // The claim chain runs ONCE, inside analyzeCategory (Layer 6). We surface its
  // per-category output here for the slide layer, rather than re-running it.
  // Categories that fell back to deterministic analysis carry no claims and are
  // simply omitted — the slide planner then uses its analysis-based fallback.
  const claim_chain_results = {};
  for (const a of category_analyses || []) {
    if ((a.claims?.length || 0) > 0 || (a.observations?.length || 0) > 0) {
      claim_chain_results[a.category] = {
        claims:                     a.claims || [],
        observations:               a.observations || [],
        viewpoints:                 a.viewpoints || [],
        case_studies:               a.case_studies || [],
        selected_evidence_by_claim: a.selected_evidence_by_claim || [],
        slide_headlines:            a.slide_headlines || [],
        counts:                     a.claim_chain_counts || {},
      };
    }
  }
  {
    const totalCritical = Object.values(claim_chain_results).reduce((n, r) => n + (r.counts?.claims_critical || 0), 0);
    const totalHigh     = Object.values(claim_chain_results).reduce((n, r) => n + (r.counts?.claims_high    || 0), 0);
    process.stdout.write(
      `  [L6-claim-chain] ${Object.keys(claim_chain_results).length} categories with claims — ` +
      `critical=${totalCritical} high=${totalHigh}\n`
    );
  }

  // ── Run-level corpus representativeness audit (P0-2) ─────────────────────
  // Gates how confident the whole-run synthesis is allowed to be: a skewed
  // (keyword-shaped, feed-dominated, research-heavy, single-publisher) corpus
  // cannot support confident cross-category / executive judgments, however well
  // each individual claim is grounded.
  const run_corpus_audit = buildRunCorpusAudit(withAnalytics);
  process.stdout.write(
    `  [L6-run-corpus-audit] corpus_confidence=${run_corpus_audit.corpus_confidence}` +
    (run_corpus_audit.flags.length ? ` flags=${run_corpus_audit.flags.join(",")}` : "") + "\n"
  );

  // ── L6.7 — Cross-category synthesis — uses only approved claims ─────────
  // Strip blocked claims and L6-internal fields before passing to cross-category
  // so the synthesis LLM cannot reference claims that failed QA.
  process.stdout.write("  [L6-analysis-cross-category] cross-category synthesis...\n");
  const analysesForCrossCategory = (category_analyses || []).map((a) => ({
    ...a,
    claims:           a.claims || [],   // approved only — blocked_by_qa excluded by analyzeCategory
    // Explicitly exclude raw dossier internals from the cross-category context
    rawfact:          undefined,
    rawfact_evidence: undefined,
    evidence_pack:    undefined,
  }));
  const cross_category_synthesis = await runCrossCategorySynthesis(
    analysesForCrossCategory, derived_metrics, visualization_specs, {
      skipLlm,
      crossCategoryState: analytical_state?.cross_category_state || null,
    }
  );

  // Cap the synthesis confidence at the corpus ceiling, then viz-match.
  const cappedCross  = applyCorpusCapToCrossCategory(cross_category_synthesis, run_corpus_audit);
  const matchedCross = matchVisualizationsToAnalysis(cappedCross, visualization_specs);

  // ── L6 — Presentation packet (deterministic) ─────────────────────────────
  // NOTE: buildPresentationPacket is documented as "L6.9" in this file but is
  // consumed by slidesLayer.js (Layer 7). It is left here for backward
  // compatibility with the slides layer — the canonical L6 output for L7 is
  // analysis_package (L6.8, assembled below after cross-category synthesis).
  process.stdout.write("  [L6-analysis-presentation-packet] building packet...\n");
  const presentation_packet = buildPresentationPacket({
    categoryAnalyses:       category_analyses,
    crossCategorySynthesis: matchedCross,
    fusedDossiers:          dossiers,
    derivedMetrics:         derived_metrics,
    vizSpecs:               visualization_specs,
    feedSources:            withAnalytics,
    runCorpusAudit:         run_corpus_audit,
  });

  // ── L6.8 — Analysis Package (final L6 output, consumed by L7) ─────────────
  // Assembled AFTER L6.7 (cross-category synthesis) so it contains the complete
  // cross_category_synthesis with only approved claims.
  // This is the single object Layer 7 should receive from Layer 6.
  // Layer 7 must not read raw dossiers, synthesis internals, or unvalidated outputs.
  process.stdout.write("  [L6.8-analysis-package] assembling final L6 analysis_package...\n");
  const analysis_package = buildAnalysisPackage({
    categoryAnalyses:       category_analyses,
    crossCategorySynthesis: matchedCross,
    fusedDossiers:          dossiers,
    evidencePackets:        enrichedPacks,
    sources:                withAnalytics,
    visualizationSpecs:     visualization_specs,
    qaReport:               qa_report,
  });
  process.stdout.write(
    `    analysis_package: ${analysis_package.approved_claims.length} approved claims, ` +
    `${analysis_package.blocked_claims.length} blocked, ` +
    `evidence_registry=${analysis_package.evidence_registry.size} entries\n`
  );

  // ── Post-synthesis: collect unsupported claims ────────────────────────────
  const unsupported_claims = collectUnsupportedClaims(enrichedPacks, externalEvidence);

  // ── Counts ────────────────────────────────────────────────────────────────
  const highPriority  = (rawfactCounts.sources_strong || 0) + (rawfactCounts.sources_usable || 0);
  const evidenceCards = rawfactCounts.sources_with_evidence;

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
    run_corpus_audit,
    presentation_packet,
    analysis_package,         // L6.8 — canonical L6→L7 contract

    // Normalized taxonomy artefacts (for taxonomyStore persistence)
    taxonomy_rawfacts:         taxonomy_rawfacts || [],
    ai_enabled_mappings:       ai_enabled_mappings || [],
    taxonomy_metrics:          buildTaxonomyMetricRows(aggregates),
    // External visual evidence objects (real figures from Layer 5C)
    visual_evidence:           externalVisualEvidence,

    // External evidence (Layer 5C — single external-evidence branch)
    evidence_inventory:        externalEvidence,
    category_evidence_summary: externalEvidenceByCategory,
    unsupported_claims,
    manual_review_items:       externalManualReviewItems,

    // Web evidence branch (Layer 5C) — full result for persistence + slide assets
    web_evidence:              webEvidence,

    // Claim chain results (L5A-claim-chain) — keyed by category
    claim_chain_results,

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
      strong_evidence:     rawfactCounts.strong_items || 0,
      analytics_evidence:  (analytics_evidence || []).length,
      visualizations:      visualization_specs.length,
      category_analyses:   category_analyses.length,
      insights:            analysis_summary.total_insights,
      happenings:          analysis_summary.total_happenings || 0,
      early_signals:       analysis_summary.total_early_signals,
      recommendations:     analysis_summary.total_recommendations || 0,
      clusters:            rawfactCounts.multi_source_clusters,
      external_evidence:   externalEvidence.length,
      web_evidence:        webEvidence?.counts?.evidence_selected ?? 0,
      web_visual_assets:   webEvidence?.slide_assets?.auto_slide_candidates?.length ?? 0,
      unsupported_claims:  unsupported_claims.length,
      claim_chain:         Object.fromEntries(
        Object.entries(claim_chain_results || {}).map(([cat, r]) => [cat, r.counts || {}])
      ),
      manual_review_items: (externalManualReviewItems || []).length,
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
