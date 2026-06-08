/**
 * L5B — Analytics Branch Orchestrator
 *
 * Runs all 9 analytics sublayers in sequence. The only optional LLM calls are
 * in Layer 5b.3 (feature extraction for full_analytics sources).
 *
 * ── PIPELINE STEPS ────────────────────────────────────────────────────────────
 * Step 5b.1  — applyAnalyticsEligibility    deterministic gate
 * Step 5b.2  — applyAnalyticsProfiles       deterministic config attach
 * Step 5b.3  — extractAnalyticsFeatures     LLM (full_analytics only) + deterministic fallback
 * Step 5b.4  — normalizeAllAnalyticsFeatures deterministic validation/clamp
 * Step 5b.5  — aggregateAnalytics           deterministic aggregation
 * Step 5b.5b — buildCoverageMatrix          deterministic source-type coverage
 * Step 5b.6  — computeDerivedMetrics        deterministic indexes
 * Step 5b.7  — selectAnalyticsEvidence      deterministic evidence selection
 * Step 5b.8  — generateVisualizationSpecs   deterministic chart specs
 * Step 5b.9  — qaAnalyticsOutputs           deterministic QA checks
 * Step 5b.10 — buildDashboardDataset        deterministic dashboard data
 * Step 5b.11 — buildAnalyticsGraph          deterministic analytics graph
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 * {
 *   analytics_sources,     — sources enriched with analytics_features + analytics_taxonomy
 *   analytics_features,    — extracted and normalised features (array)
 *   aggregates,            — full aggregate groups + backward-compat flat fields
 *   derived_metrics,       — 9 composite indexes
 *   analytics_evidence,    — concise evidence for analysis layer
 *   visualization_specs,   — chart-ready specs
 *   qa_report,             — QA check results
 *   counts,                — summary counts
 *   analytics_version,     — version string
 * }
 */

import { writeFile, mkdir } from "fs/promises";
import { join }             from "path";

import { applyAnalyticsEligibility }       from "./analyticsEligibility.js";
import { applyAnalyticsProfiles }           from "./analyticsProfiles.js";
import { extractAnalyticsFeatures }         from "./extractAnalyticsFeatures.js";
import { normalizeAllAnalyticsFeatures }    from "./normalizeAnalyticsFeatures.js";
import { aggregateAnalytics }              from "./analyticsAggregation.js";
import { buildCoverageMatrix }             from "./buildCoverageMatrix.js";
import { computeDerivedMetrics }            from "./computeDerivedMetrics.js";
import { selectAnalyticsEvidence }          from "./selectAnalyticsEvidence.js";
import { generateVisualizationSpecs, generateExternalEvidenceSpecs } from "./visualizationSpecs.js";
import { qaAnalyticsOutputs }              from "./qaAnalyticsOutputs.js";
import { buildDashboardDataset }           from "./buildDashboardDataset.js";
import { buildAnalyticsGraph }             from "./buildAnalyticsGraph.js";

export const ANALYTICS_VERSION = "source-type-aware-v1";

// ── Debug file saver ──────────────────────────────────────────────────────────

async function saveDebugFiles(saveTo, result) {
  try {
    await mkdir(saveTo, { recursive: true });

    await writeFile(
      join(saveTo, "analytics_features.json"),
      JSON.stringify(
        result.analytics_sources.map((s) => ({
          id:                  s.id,
          title:               s.title,
          source_type:         s.source_type,
          main_category:       s.main_category,
          analytics_eligibility: s.analytics_eligibility,
          analytics_features:  s.analytics_features,
          analytics_taxonomy:  s.analytics_taxonomy,
        })),
        null, 2
      )
    );

    await writeFile(
      join(saveTo, "analytics_aggregates.json"),
      JSON.stringify(result.aggregates, null, 2)
    );

    await writeFile(
      join(saveTo, "analytics_derived_metrics.json"),
      JSON.stringify(result.derived_metrics, null, 2)
    );

    await writeFile(
      join(saveTo, "analytics_visualization_specs.json"),
      JSON.stringify(result.visualization_specs, null, 2)
    );

    await writeFile(
      join(saveTo, "analytics_qa_report.json"),
      JSON.stringify(result.qa_report, null, 2)
    );
  } catch (err) {
    process.stdout.write(`  [L5B-analytics] Warning: could not save debug files: ${err.message}\n`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the full Layer 5b Analytics Branch.
 *
 * @param {object[]} sources - Sources after Layer 3 classification
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]         - Skip all LLM calls (full deterministic mode)
 * @param {number}   [opts.concurrency=5]         - LLM concurrency for feature extraction
 * @param {string}   [opts.saveTo=null]           - Directory for debug JSON output
 * @param {object[]} [opts.externalEvidence=[]]   - External evidence from Layer 5e (evidence search)
 * @returns {Promise<object>} Analytics branch result
 */
export async function runAnalyticsBranch(sources, opts = {}) {
  const {
    skipLlm          = false,
    concurrency      = 5,
    saveTo           = null,
    externalEvidence = [],
  } = opts;

  if (sources.length === 0) {
    return {
      analytics_sources:   [],
      analytics_features:  [],
      aggregates:          { total_sources: 0, taxonomy_done: 0 },
      derived_metrics:     {},
      analytics_evidence:  [],
      visualization_specs: [],
      dashboard_dataset:   { views: {} },
      analytics_graph:     { nodes: [], edges: [], node_count: 0, edge_count: 0 },
      corpus_profile:      { total_sources: 0, eligible_sources: 0, corpus_limitations: ["Empty corpus."] },
      taxonomy_distribution:                     {},
      attack_surface_and_technique_analytics:    {},
      operational_maturity_analytics:            {},
      timeline_and_trend_analytics:              { valid_trend_candidates: [], recurring_patterns: [], burst_clusters: [], insufficient_trend_data: [] },
      evidence_coverage_and_confidence_analytics:{},
      derived_indexes:     [],
      coverage_gaps:       [],
      qa_report:           { passed: true, score: 100, errors: [], warnings: [], checks: [], summary: "Empty corpus." },
      counts:              { total: 0, eligible: 0, categories: {}, source_types: {}, visualizations: 0 },
      analytics_version:   ANALYTICS_VERSION,
    };
  }

  // ── Step 5b.1 — Analytics Eligibility ────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] step 5b.1 Analytics eligibility...\n");
  let tagged = applyAnalyticsEligibility(sources);
  const eligibleCount = tagged.filter((s) => s.analytics_eligibility?.eligible_for_analytics).length;
  process.stdout.write(`    ${eligibleCount}/${sources.length} sources eligible for analytics\n`);

  // ── Step 5b.2 — Analytics Profiles ───────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] step 5b.2 Applying analytics profiles...\n");
  tagged = applyAnalyticsProfiles(tagged);

  // ── Step 5b.3 — Feature Extraction ───────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] step 5b.3 Extracting analytics features...\n");
  tagged = await extractAnalyticsFeatures(tagged, { skipLlm, concurrency });
  const featuresDone = tagged.filter((s) => s.analytics_features).length;
  process.stdout.write(`    ${featuresDone}/${sources.length} sources with analytics_features\n`);

  // ── Step 5b.4 — Normalisation ─────────────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] step 5b.4 Normalising analytics features...\n");
  tagged = normalizeAllAnalyticsFeatures(tagged);

  // ── Step 5b.5 — Aggregation ──────────────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] step 5b.5 Analytics aggregation...\n");
  const aggregates = aggregateAnalytics(tagged);
  process.stdout.write(
    `    categories: ${JSON.stringify(aggregates.category_counts)}  ` +
    `months: ${aggregates.date_range?.months || 0}\n`
  );

  // ── Step 5b.5b — Coverage Matrix ─────────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] step 5b.5b Building source-type coverage matrix...\n");
  const analyticsFeatures = tagged.map((s) => s.analytics_features).filter(Boolean);
  const source_type_coverage_matrix = buildCoverageMatrix(analyticsFeatures);
  aggregates.source_type_coverage_matrix = source_type_coverage_matrix;
  process.stdout.write(
    `    ${source_type_coverage_matrix.matrix.length - 1} source types × 4 domains; ` +
    `${source_type_coverage_matrix.thin_coverage_flags.length} thin-coverage flag(s)\n`
  );

  // ── Step 5b.6 — Derived Metrics ───────────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] step 5b.6 Computing derived metrics...\n");
  const derived_metrics = computeDerivedMetrics(aggregates);
  const highIndexes = Object.entries(derived_metrics)
    .filter(([k, m]) => (m?.label === "high" || m?.label === "very_high") && m?.index_id)
    .map(([k]) => k.replace(/_index$/, ""));
  if (highIndexes.length > 0) {
    process.stdout.write(`    High/very-high indexes: ${highIndexes.join(", ")}\n`);
  }

  // ── Step 5b.7 — Evidence Selection ───────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] step 5b.7 Selecting analytics evidence...\n");
  const analytics_evidence = selectAnalyticsEvidence(aggregates, derived_metrics);
  process.stdout.write(`    ${analytics_evidence.length} analytics evidence items\n`);

  // ── Step 5b.8 — Visualization Specs ──────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] step 5b.8 Generating visualization specs...\n");
  const visualization_specs = generateVisualizationSpecs(aggregates, tagged, derived_metrics);
  const ext_specs = generateExternalEvidenceSpecs(externalEvidence);
  const all_visualization_specs = [...visualization_specs, ...ext_specs];
  process.stdout.write(`    ${all_visualization_specs.length} visualization specs (${ext_specs.length} external)\n`);

  // ── Step 5b.9 — QA ────────────────────────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] step 5b.9 Running analytics QA...\n");
  const qa_report = qaAnalyticsOutputs({
    analytics_sources: tagged,
    aggregates,
    derived_metrics,
    analytics_evidence,
    visualization_specs: all_visualization_specs,
  });
  process.stdout.write(`    QA: ${qa_report.summary}\n`);

  // ── Step 5b.10 — Dashboard Dataset ───────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] step 5b.10 Building dashboard dataset...\n");
  const dashboard_dataset = buildDashboardDataset(aggregates, analytics_evidence, tagged);

  // ── Step 5b.11 — Analytics Graph ─────────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] step 5b.11 Building analytics graph...\n");
  const analytics_graph = buildAnalyticsGraph(
    aggregates, derived_metrics, analytics_evidence, all_visualization_specs, tagged
  );
  process.stdout.write(`    Analytics graph: ${analytics_graph.node_count} nodes, ${analytics_graph.edge_count} edges\n`);

  // ── Collect analytics_features for direct access ──────────────────────────────
  const analytics_features = tagged
    .map((s) => s.analytics_features)
    .filter(Boolean);

  // ── Log external evidence grounding status ────────────────────────────────────
  if (externalEvidence.length > 0) {
    const extByCategory = {};
    for (const ev of externalEvidence) {
      extByCategory[ev.category] = (extByCategory[ev.category] || 0) + 1;
    }
    process.stdout.write(
      `  [L5B-analytics] External evidence grounding: ` +
      Object.entries(extByCategory).map(([c, n]) => `${c.replace("_threats","").replace("_","-")}=${n}`).join(" ") +
      "\n"
    );
  }

  // ── Save debug outputs ────────────────────────────────────────────────────────
  // ── Assemble final result with all 6 spec deliverable groups + new outputs ─────
  const result = {
    component:         "5B_analytics_branch",
    analytics_version: ANALYTICS_VERSION,

    // ── 6 Core Deliverable Groups (spec-aligned names) ────────────────────────

    // Deliverable 1: Corpus Profile
    corpus_profile: {
      ...aggregates.corpus_overview,
      sources_by_publisher:         aggregates.publisher_counts || {},
      sources_by_relevance_tier:    {},  // populated by Layer 3 data if available
      coverage_gaps: [
        ...(source_type_coverage_matrix.thin_coverage_flags || []),
        ...(aggregates.defensive_analytics?.mitigation_gap_signals || []),
      ],
    },

    // Deliverable 2: Taxonomy Distribution
    taxonomy_distribution: {
      ...aggregates.taxonomy_analytics,
      taxonomy_coverage_gaps: aggregates.taxonomy_analytics?.thin_primary_tags || [],
      source_type_by_tag_matrix: {},  // cross-tab populated in aggregation if needed
    },

    // Deliverable 3: Attack Surface and Technique Analytics
    attack_surface_and_technique_analytics: {
      attack_surface_frequency:         aggregates.threat_pattern_analytics?.attack_surface_distribution,
      ai_layer_frequency:               aggregates.threat_pattern_analytics?.ai_layer_distribution,
      attack_vector_frequency:          aggregates.threat_pattern_analytics?.attack_vector_frequency,
      attack_vector_frequency_tracked:  aggregates.threat_pattern_analytics?.attack_vector_frequency_tracked,
      impact_type_frequency:            aggregates.threat_pattern_analytics?.impact_type_frequency,
      tool_or_component_frequency:      aggregates.ecosystem_analytics?.dependency_type_frequency,
      trust_boundary_frequency:         aggregates.trust_boundary_analytics?.trust_boundary_shift_frequency,
      dependency_type_frequency:        aggregates.ecosystem_analytics?.dependency_type_frequency,
      category_by_attack_surface_matrix:aggregates.category_analytics?.per_category
        ? Object.fromEntries(
            Object.entries(aggregates.category_analytics.per_category).map(([cat, d]) => [cat, d.attack_surface_frequency || {}])
          )
        : {},
      category_by_ai_layer_matrix: aggregates.category_analytics?.per_category
        ? Object.fromEntries(
            Object.entries(aggregates.category_analytics.per_category).map(([cat, d]) => [cat, d.ai_layer_frequency || {}])
          )
        : {},
    },

    // Deliverable 4: Operational Maturity Analytics
    operational_maturity_analytics: {
      operational_status_distribution:   aggregates.maturity_analytics?.operational_status_distribution,
      capability_stage_distribution:     aggregates.capability_analytics?.capability_stage_distribution,
      adversary_adoption_stage_distribution: aggregates.adversary_adoption_analytics?.adversary_adoption_distribution,
      category_by_operational_status:    aggregates.maturity_analytics?.category_by_operational_status,
      source_type_by_operational_status: aggregates.source_type_analytics?.source_type_by_maturity,
      research_to_poc_signals:           aggregates.capability_analytics?.research_to_poc_signals,
      poc_to_operational_signals:        aggregates.capability_analytics?.poc_to_operational_signals,
      adoption_stage_by_category:        aggregates.adversary_adoption_analytics?.adversary_adoption_by_domain,
      adoption_stage_by_source_type:     aggregates.adversary_adoption_analytics?.adversary_adoption_by_source_type,
      maturity_caveats:                  aggregates.adversary_adoption_analytics?.adoption_caveats || [],
    },

    // Deliverable 5: Timeline and Trend Analytics
    timeline_and_trend_analytics: {
      monthly_source_counts:        aggregates.timeline_analytics?.monthly_source_timeline,
      monthly_category_counts:      aggregates.timeline_analytics?.monthly_category_timeline,
      monthly_tag_counts:           aggregates.trend_analytics?.monthly_threat_tag_counts,
      monthly_source_type_counts:   aggregates.trend_analytics?.monthly_source_type_counts,
      monthly_operational_status_counts: aggregates.timeline_analytics?.monthly_maturity_timeline,
      monthly_attack_surface_counts:aggregates.timeline_analytics?.monthly_attack_vector_timeline,
      valid_trend_candidates:       aggregates.trend_analytics?.valid_trend_candidates || [],
      recurring_patterns:           aggregates.trend_analytics?.recurring_patterns || [],
      burst_clusters:               aggregates.trend_analytics?.burst_clusters || [],
      insufficient_trend_data:      aggregates.trend_analytics?.insufficient_trend_data || [],
      trend_language_note:          aggregates.trend_analytics?.trend_language_note,
    },

    // Deliverable 6: Evidence Coverage and Confidence Analytics
    evidence_coverage_and_confidence_analytics: {
      source_type_coverage_matrix,
      category_evidence_strength_matrix: source_type_coverage_matrix.coverage_notes || [],
      operational_evidence_by_category:  aggregates.adversary_adoption_analytics?.adversary_adoption_by_domain,
      analytics_confidence_by_category:  Object.fromEntries(
        Object.entries(aggregates.category_analytics?.per_category || {}).map(([cat, d]) => [
          cat,
          d.count < 3 ? "low" : d.count < 10 ? "medium" : "high",
        ])
      ),
      thin_coverage_flags:         source_type_coverage_matrix.thin_coverage_flags || [],
      evidence_gap_summary:        (source_type_coverage_matrix.thin_coverage_flags || [])
        .map((f) => `${f.domain}: ${f.reason}`),
      coverage_gaps: [
        ...(source_type_coverage_matrix.thin_coverage_flags || []),
        ...(aggregates.defensive_analytics?.mitigation_gap_signals || []),
      ],
    },

    // ── Analytics Evidence Pack ───────────────────────────────────────────────
    analytics_evidence,

    // ── Visualization Package ─────────────────────────────────────────────────
    visualization_specs: all_visualization_specs,

    // ── Dashboard Dataset (new) ───────────────────────────────────────────────
    dashboard_dataset,

    // ── Analytics Graph (new) ────────────────────────────────────────────────
    analytics_graph,

    // ── Derived Indexes ───────────────────────────────────────────────────────
    derived_indexes: Object.values(derived_metrics)
      .filter((m) => m?.index_id)
      .filter((v, i, a) => a.findIndex((m) => m.index_id === v.index_id) === i),

    // QA
    qa_report,

    // ── Backward-compat fields (synthesis, analysis, slide layers read these) ─
    corpus_overview:                  aggregates.corpus_overview,        // alias
    source_type_coverage_matrix,                                         // top-level alias
    threat_frequency_analytics:       aggregates.threat_pattern_analytics,
    operationalisation_analytics:     aggregates.maturity_analytics,
    adversary_adoption_analytics:     aggregates.adversary_adoption_analytics,
    capability_pipeline_analytics:    aggregates.capability_analytics,
    defensive_governance_infrastructure: {
      defensive_analytics:     aggregates.defensive_analytics,
      governance_analytics:    aggregates.governance_analytics,
      infrastructure_analytics: {
        dependency_type_frequency:         aggregates.ecosystem_analytics?.dependency_type_frequency,
        infrastructure_dependency_signals: aggregates.ecosystem_analytics?.dependency_type_frequency,
        trust_boundary_shift_signals:      aggregates.trust_boundary_analytics,
      },
    },
    trend_timeline_analytics:         aggregates.trend_analytics,
    coverage_gaps: [
      ...(source_type_coverage_matrix.thin_coverage_flags || []),
      ...(aggregates.defensive_analytics?.mitigation_gap_signals || []),
    ],
    analytics_sources:   tagged,
    analytics_features,
    aggregates,
    derived_metrics,
    external_evidence_count: externalEvidence.length,
    counts: {
      total:           sources.length,
      eligible:        eligibleCount,
      features_done:   featuresDone,
      categories:      aggregates.category_counts,
      source_types:    aggregates.source_type_counts,
      visualizations:  all_visualization_specs.length,
      timeline_events: (aggregates.timeline_events || []).length,
      months:          aggregates.date_range?.months || 0,
    },
  };

  if (saveTo) {
    await saveDebugFiles(saveTo, result);
    process.stdout.write(`    Debug files saved to ${saveTo}\n`);
  }

  return result;
}
