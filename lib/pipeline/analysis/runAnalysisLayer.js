/**
 * L6 — Analysis + Synthesis Layer Orchestrator
 *
 * Orchestrates all analysis sublayers. No direct LLM calls — delegated to
 * analyzeCategory.js, qaCategoryAnalysis.js, and runCrossCategorySynthesis.js.
 *
 * ── PIPELINE STEPS ────────────────────────────────────────────────────────────
 * L6-dossier-fusion:      buildFusedDossiers   — combine L5A + L5B into rich dossiers
 * L6-category-synthesis:  analyzeAllCategories — LLM per category (Anthropic → Gemini Pro)
 * L6-viz-matching:        matchVisualizationsToAllAnalyses — attach viz IDs
 * L6-evidence-linking:    linkAnalysisEvidence  — resolve ev_*, raw_*, agg_*, metric_* IDs
 * L6-qa:                  qaAllCategoryAnalyses — deterministic + optional LLM fact-check
 *
 * Version: analysis-v2.0
 */

import { writeFile, mkdir } from "fs/promises";
import { join }             from "path";

import { TAXONOMY as TAXONOMY_REGISTRY_CACHE } from "../../config/taxonomyRegistry.js";
import { buildFusedDossiers }              from "../synthesis/buildFusedDossiers.js";
import { buildAnalyticalState }            from "./buildAnalyticalState.js";
import { analyzeAllCategories }            from "./analyzeAllCategories.js";
import { matchVisualizationsToAllAnalyses } from "../synthesis/matchVisualizationsToInsights.js";
import { linkAnalysisEvidence }            from "./linkAnalysisEvidence.js";
import { qaAllCategoryAnalyses }           from "./qaCategoryAnalysis.js";

export const ANALYSIS_VERSION = "analysis-v2.0";

// ── Taxonomy enrichment + evidence gating ──────────────────────────────────────
// Stamps each category analysis (and its insights/happenings) with the validated
// taxonomy and an assessment_status. A category with no validated evidence is
// marked evidence_insufficient so synthesis/slides say "category not assessed"
// instead of fabricating taxonomy claims.

export function enrichCategoryTaxonomy(analyses, sources) {
  return analyses.map((a) => {
    const cat = a.category;
    const catSources = sources.filter((s) => s.main_category === cat);

    const validatedCounts = {};
    const secondary = new Set();
    let validatedCount = 0;
    let weakCount = 0;

    for (const s of catSources) {
      // v9: use primary_tags with fallback to primary_threat_tags
      const tagList = Array.isArray(s.understanding?.primary_tags)
        ? s.understanding.primary_tags
        : (s.understanding?.primary_threat_tags || []);
      for (const t of tagList) {
        const tDomain = t.domain || TAXONOMY_REGISTRY_CACHE?.[t.tag]?.domain;
        if (tDomain && tDomain !== cat) continue;
        if (t.validation_status === "validated") {
          validatedCounts[t.tag] = (validatedCounts[t.tag] || 0) + 1;
          validatedCount++;
        } else if (t.validation_status === "weak") {
          weakCount++;
        }
      }
      for (const d of s.understanding?.secondary_dimensions || []) {
        secondary.add(typeof d === "string" ? d : d?.tag);
      }
    }

    const primary_threat_tags = Object.entries(validatedCounts)
      .sort((x, y) => y[1] - x[1]).map(([tag]) => tag).slice(0, 8);
    const secondary_dimensions = [...secondary];
    const evidence_origin = validatedCount > 0 ? "validated_evidence"
      : weakCount > 0 ? "weak_evidence" : "no_evidence";
    const assessment_status = validatedCount > 0 ? "assessed" : "evidence_insufficient";

    const stamp = (item) => ({
      ...item,
      primary_domain:       cat,
      primary_threat_tags,
      secondary_dimensions,
      evidence_origin,
      caveat_if_any: item.caveat_if_any
        || (assessment_status === "evidence_insufficient"
          ? "evidence insufficient — signal weak"
          : item.confidence === "low" ? "low-confidence insight" : null),
    });

    return {
      ...a,
      taxonomy: {
        primary_domain: cat,
        primary_threat_tags,
        secondary_dimensions,
        evidence_origin,
        assessment_status,
        validated_evidence_count: validatedCount,
        weak_evidence_count: weakCount,
      },
      assessment_status,
      assessment_note: assessment_status === "evidence_insufficient"
        ? "Evidence insufficient — category not assessed; signal weak."
        : null,
      top_insights:       (a.top_insights || []).map(stamp),
      biggest_happenings: (a.biggest_happenings || []).map(stamp),
    };
  });
}

// ── Summary builders ───────────────────────────────────────────────────────────

function buildAnalysisSummary(categoryAnalyses) {
  return {
    total_categories:     categoryAnalyses.length,
    total_insights:       categoryAnalyses.reduce((n, a) => n + (a.top_insights || []).length, 0),
    total_early_signals:  categoryAnalyses.reduce((n, a) => n + (a.early_signals || []).filter((s) => s.qa_pass !== false).length, 0),
    total_happenings:     categoryAnalyses.reduce((n, a) => n + (a.biggest_happenings || []).length, 0),
    total_recommendations:categoryAnalyses.reduce((n, a) => n + (a.recommendations || []).length, 0),
    llm_used_count:       categoryAnalyses.filter((a) => a.llm_used).length,
  };
}

function buildQaRollup(categoryAnalyses) {
  const rollup = {
    total_removed_insights:   0,
    total_retained_insights:  0,
    total_removed_happenings: 0,
    categories_downgraded:    0,
    per_category:             {},
  };

  for (const a of categoryAnalyses) {
    const qa = a.qa_report;
    if (!qa) continue;
    rollup.total_removed_insights   += qa.removed_insight_count || 0;
    rollup.total_retained_insights  += qa.retained_insight_count || 0;
    rollup.total_removed_happenings += qa.removed_happening_count || 0;
    if (qa.adjusted_confidence !== qa.original_confidence) rollup.categories_downgraded++;
    rollup.per_category[a.category] = {
      retained_insights:  qa.retained_insight_count,
      removed_insights:   qa.removed_insight_count,
      retained_happenings: qa.retained_happening_count,
      removed_happenings:  qa.removed_happening_count,
      llm_qa_run:         qa.llm_qa_run,
    };
  }

  return rollup;
}

// ── Debug file saver ──────────────────────────────────────────────────────────

async function saveDebugFiles(saveTo, dossiers, rawAnalyses, linkedAnalyses, qaAnalyses) {
  try {
    await mkdir(saveTo, { recursive: true });
    await writeFile(join(saveTo, "analysis_dossiers.json"),        JSON.stringify(dossiers,       null, 2));
    await writeFile(join(saveTo, "analysis_raw_llm_output.json"),  JSON.stringify(rawAnalyses,    null, 2));
    await writeFile(join(saveTo, "analysis_linked.json"),          JSON.stringify(linkedAnalyses, null, 2));
    await writeFile(join(saveTo, "analysis_qa_output.json"),       JSON.stringify(qaAnalyses,     null, 2));
  } catch (err) {
    process.stdout.write(`  [L6-analysis-synthesis] warning: could not save debug files: ${err.message}\n`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the full Layer 8 analysis pipeline.
 *
 * @param {object[]} sources      - Sources enriched through rawfact + analytics branches
 * @param {object}   aggregates   - Output of aggregateAnalytics() from Layer 5b
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @param {boolean}  [opts.skipLlmQa=true]
 * @param {string}   [opts.saveTo=null]
 * @param {object[]} [opts.evidencePacks=[]]
 * @param {object[]} [opts.analytics_evidence=[]]
 * @param {object}   [opts.derived_metrics={}]
 * @param {object[]} [opts.vizSpecs=[]]              - Visualization specs for viz matching
 * @param {object}   [opts.analyticsResult=null]     - Full analytics branch result
 * @param {object[]} [opts.externalEvidence=[]]
 * @returns {Promise<object>}
 */
export async function runAnalysisLayer(sources, aggregates, opts = {}) {
  const {
    skipLlm           = false,
    skipLlmQa         = true,
    saveTo            = null,
    evidencePacks     = [],
    analytics_evidence = [],
    derived_metrics   = {},
    vizSpecs          = [],
    analyticsResult   = null,
    externalEvidence  = [],
    visualEvidence    = [],
    webEvidence       = null,
  } = opts;

  if (sources.length === 0) {
    return {
      category_analyses: [],
      dossiers:          [],
      analysis_summary:  { total_categories: 0, total_insights: 0, total_early_signals: 0 },
      qa_report:         { total_removed_insights: 0, total_retained_insights: 0 },
      analysis_version:  ANALYSIS_VERSION,
    };
  }

  // Merge analyticsResult fields if provided (preferred over individual opts)
  const effectiveAggregates      = analyticsResult?.aggregates       || aggregates;
  const effectiveDerivedMetrics  = analyticsResult?.derived_metrics  || derived_metrics;
  const effectiveVizSpecs        = analyticsResult?.visualization_specs || vizSpecs;
  const effectiveAnalyticsEv     = analyticsResult?.analytics_evidence || analytics_evidence;

  // ── Layer 8A — Build fused dossiers ────────────────────────────────────────
  process.stdout.write("  [L6-analysis-dossier-fusion] Building fused evidence dossiers (rawfact + analytics)...\n");
  const dossiers = buildFusedDossiers(
    sources, evidencePacks,
    {
      aggregates:          effectiveAggregates,
      derived_metrics:     effectiveDerivedMetrics,
      analytics_evidence:  effectiveAnalyticsEv,
      visualization_specs: effectiveVizSpecs,
    },
    { externalEvidence, webEvidence }
  );
  process.stdout.write(
    `    ${dossiers.length} active categories: ` +
    dossiers.map((d) => `${d.category}(${d.source_count} sources, ` +
      `${(d.rawfact?.strong_evidence?.length || 0)} critical items)`).join(", ") + "\n"
  );

  // ── Layer 6A — Analytical State Construction (deterministic) ──────────────
  process.stdout.write("  [L6A-analytical-state] Building analytical state (deterministic)...\n");
  const analyticalState = buildAnalyticalState(
    dossiers,
    analyticsResult || { aggregates: effectiveAggregates, derived_metrics: effectiveDerivedMetrics },
    opts.externalEvidence || [],
    opts.visualEvidence   || [],
  );

  // ── Layer 8B — Category analysis (LLM, with analytical state) ─────────────
  process.stdout.write(`  [L6-analysis-category-synthesis] running (skipLlm=${skipLlm})...\n`);
  const rawAnalyses = await analyzeAllCategories(dossiers, { skipLlm, analyticalState });
  const llmUsed = rawAnalyses.filter((a) => a.llm_used).length;
  process.stdout.write(`    ${rawAnalyses.length} analyses complete (${llmUsed} used LLM)\n`);

  // ── Visualization matching ─────────────────────────────────────────────────
  const withViz = matchVisualizationsToAllAnalyses(rawAnalyses, effectiveVizSpecs);

  // ── Layer 8C — Evidence linking ─────────────────────────────────────────────
  process.stdout.write("  [L6-analysis-evidence-linking] Linking evidence IDs to full citation objects...\n");
  const linkedAnalyses = linkAnalysisEvidence(withViz, dossiers);
  const totalCitations = linkedAnalyses.reduce((n, a) => n + (a.citations || []).length, 0);
  process.stdout.write(`    ${totalCitations} total citations resolved\n`);

  // ── Layer 8D — QA ───────────────────────────────────────────────────────────
  process.stdout.write(`  [L6-analysis-qa] QA pass (skipLlmQa=${skipLlmQa})...\n`);
  const qaAnalyses    = await qaAllCategoryAnalyses(linkedAnalyses, { skipLlmQa });
  const removedTotal  = qaAnalyses.reduce((n, a) => n + (a.qa_report?.removed_insight_count || 0), 0);
  const retainedTotal = qaAnalyses.reduce((n, a) => n + (a.qa_report?.retained_insight_count || 0), 0);
  process.stdout.write(`    QA complete: ${retainedTotal} insights retained, ${removedTotal} removed\n`);

  // ── Taxonomy enrichment + evidence gating (deterministic) ──────────────────
  const enrichedAnalyses = enrichCategoryTaxonomy(qaAnalyses, sources);
  const assessedCount = enrichedAnalyses.filter((a) => a.assessment_status === "assessed").length;
  process.stdout.write(`    Taxonomy gating: ${assessedCount}/${enrichedAnalyses.length} categories assessed (rest evidence_insufficient)\n`);

  // ── Build outputs ────────────────────────────────────────────────────────────
  const analysis_summary = buildAnalysisSummary(enrichedAnalyses);
  const qa_report        = buildQaRollup(enrichedAnalyses);

  if (saveTo) {
    await saveDebugFiles(saveTo, dossiers, rawAnalyses, linkedAnalyses, enrichedAnalyses);
    process.stdout.write(`    Debug files saved to ${saveTo}\n`);
  }

  return {
    category_analyses: enrichedAnalyses,
    dossiers,
    analytical_state:  analyticalState,  // L6A output — available for downstream use
    analysis_summary,
    qa_report,
    analysis_version: ANALYSIS_VERSION,
  };
}
