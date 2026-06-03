/**
 * L5B — Analytics Branch Orchestrator
 *
 * Runs all 9 analytics sublayers in sequence. The only optional LLM calls are
 * in Layer 5b.3 (feature extraction for full_analytics sources).
 *
 * ── PIPELINE STEPS ────────────────────────────────────────────────────────────
 * Step 5b.1 — applyAnalyticsEligibility    deterministic gate
 * Step 5b.2 — applyAnalyticsProfiles       deterministic config attach
 * Step 5b.3 — extractAnalyticsFeatures     LLM (full_analytics only) + deterministic fallback
 * Step 5b.4 — normalizeAllAnalyticsFeatures deterministic validation/clamp
 * Step 5b.5 — aggregateAnalytics           deterministic aggregation
 * Step 5b.6 — computeDerivedMetrics        deterministic indexes
 * Step 5b.7 — selectAnalyticsEvidence      deterministic evidence selection
 * Step 5b.8 — generateVisualizationSpecs   deterministic chart specs
 * Step 5b.9 — qaAnalyticsOutputs           deterministic QA checks
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
import { aggregateAnalytics }               from "./analyticsAggregation.js";
import { computeDerivedMetrics }            from "./computeDerivedMetrics.js";
import { selectAnalyticsEvidence }          from "./selectAnalyticsEvidence.js";
import { generateVisualizationSpecs, generateExternalEvidenceSpecs } from "./visualizationSpecs.js";
import { qaAnalyticsOutputs }              from "./qaAnalyticsOutputs.js";

export const ANALYTICS_VERSION = "analytics-v2.0";

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

  // ── Step 5b.6 — Derived Metrics ───────────────────────────────────────────────
  process.stdout.write("  [L5B-analytics] step 5b.6 Computing derived metrics...\n");
  const derived_metrics = computeDerivedMetrics(aggregates);
  const highIndexes = Object.entries(derived_metrics)
    .filter(([, m]) => m.label === "high" || m.label === "very_high")
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
  const result = {
    analytics_sources:   tagged,
    analytics_features,
    aggregates,
    derived_metrics,
    analytics_evidence,
    visualization_specs: all_visualization_specs,
    qa_report,
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
    analytics_version: ANALYTICS_VERSION,
  };

  if (saveTo) {
    await saveDebugFiles(saveTo, result);
    process.stdout.write(`    Debug files saved to ${saveTo}\n`);
  }

  return result;
}
