/**
 * L6 Orchestrator — runAnalysis()
 *
 * Runs the full L6 analysis pipeline for all four offensive categories in parallel:
 *   Step 1  selectSourcesForCategory()  — pick top sources by signal score
 *   Step 2  buildDossier()              — package sources into LLM-readable text
 *   Step 3  analyzeCategory()           — one Sonnet/Opus call → insights + citations
 *   Step 4  qaInsights()               — deterministic quality gate
 *
 * Returns CategoryAnalysis[] — one per category. Each holds:
 *   category, assessment_status, selected_source_ids, insights[], coverage_gaps[]
 *
 * If supabase is provided, results are upserted to the category_insights table.
 */

import { selectSourcesForCategory } from "./selectSources.js";
import { buildDossier }             from "./buildDossier.js";
import { analyzeCategory }          from "./analyzeCategory.js";
import { qaInsights }               from "./qaInsights.js";
import { generateExplanations }     from "./generateExplanations.js";
import { qaExplanations }           from "./qaExplanations.js";

const ACTIVE_CATEGORIES = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

// ── DB persistence ────────────────────────────────────────────────────────────

/**
 * Upsert CategoryAnalysis[] to the category_insights table.
 * Keyed by (window_key, category) — overwrites if --force or first run.
 *
 * @param {object}   supabase
 * @param {object}   windowInfo  - { type, key, label, date_from, date_to }
 * @param {object[]} analyses
 * @param {object}   [runMeta]   - Optional metadata to store (model, latency, etc.)
 */
export async function persistAnalysis(supabase, windowInfo, analyses, runMeta = null) {
  if (!supabase) return;

  const rows = analyses.map(ca => ({
    window_type:         windowInfo.type,
    window_key:          windowInfo.key,
    window_label:        windowInfo.label,
    date_from:           windowInfo.date_from,
    date_to:             windowInfo.date_to,
    category:            ca.category,
    assessment_status:   ca.assessment_status,
    source_count:        ca.selected_source_ids.length,
    selected_source_ids: ca.selected_source_ids,
    insights:            ca.insights,
    coverage_gaps:       ca.coverage_gaps,
    run_metadata:        runMeta,
  }));

  const { error } = await supabase
    .from("category_insights")
    .upsert(rows, { onConflict: "window_key,category" });

  if (error) throw new Error(`category_insights upsert failed: ${error.message}`);
}

// ── Per-category runner ───────────────────────────────────────────────────────

async function runCategoryAnalysis(category, sources, evidenceItems, corpusSummary, windowInfo, opts) {
  const t0 = Date.now();

  // Step 1: Select sources (deterministic pre-filter + optional LLM semantic selection)
  const { selected, stats, llm_selected } = await selectSourcesForCategory(
    sources, category, windowInfo, opts
  );
  process.stdout.write(
    `  [L6] ${category}: ${stats.total} sources selected` +
    ` (from ${stats.candidates_seen} candidates, ${llm_selected ? "LLM-curated" : "deterministic"})\n`
  );

  if (selected.length === 0) {
    return {
      category,
      assessment_status: "thin",
      selected_source_ids: [],
      insights: [],
      coverage_gaps: [`No qualifying sources found for ${category} in this window`],
      qa_report: { total: 0, approved: 0, blocked: 0 },
      latency_ms: Date.now() - t0,
    };
  }

  // Step 2: Build dossier
  const { dossier_text, source_index } = buildDossier(
    category, selected, evidenceItems, corpusSummary
  );

  // Step 3: LLM analysis
  const raw = await analyzeCategory(
    category, dossier_text, source_index, evidenceItems, windowInfo, opts
  );

  // Step 4: QA gate — deterministic checks + fact-checks against source metadata
  // Build a source map so qaInsights can do quote fuzzy-match and maturity validation
  const sourceMap = Object.fromEntries(selected.map(s => [s.id, s]));
  const { insights, qa_report } = qaInsights(raw.insights || [], sourceMap);

  const approved = insights.filter(i => !i.blocked);
  const factIssues = insights.flatMap(i => (i.qa_issues || []).filter(q =>
    q.startsWith("quote_not_in_source") || q.startsWith("maturity_") || q.startsWith("title_cve")
  ));
  process.stdout.write(
    `  [L6] ${category}: ${insights.length} insights, ${approved.length} approved` +
    (qa_report.blocked > 0 ? `, ${qa_report.blocked} blocked` : "") +
    (factIssues.length > 0 ? `, ${factIssues.length} fact-check flag(s)` : "") +
    `\n`
  );

  return {
    category,
    assessment_status: raw.assessment_status === "error" ? "error"
      : approved.length > 0 ? "assessed" : "thin",
    selected_source_ids: selected.map(s => s.id),
    insights,
    coverage_gaps: raw.coverage_gaps || [],
    qa_report,
    latency_ms: Date.now() - t0,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run L6 analysis for all four categories.
 *
 * @param {object[]} sources        - Relevant, classified sources for the window
 * @param {object[]} evidenceItems  - L5 evidence items (for quote lookup + evidence_item_ids)
 * @param {object}   corpusSummary  - From buildCorpusSummary()
 * @param {object}   windowInfo     - { type, key, label, date_from, date_to }
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm]
 * @param {object}   [opts.supabase] - If provided, results are persisted
 * @param {boolean}  [opts.force]    - If true, overwrite existing rows
 * @returns {Promise<object[]>}      CategoryAnalysis[]
 */
export async function runAnalysis(sources, evidenceItems, corpusSummary, windowInfo, opts = {}) {
  const { supabase = null, force = false } = opts;

  // Skip categories that already have a row unless --force
  let skipCategories = new Set();
  if (supabase && !force) {
    const { data } = await supabase
      .from("category_insights")
      .select("category")
      .eq("window_key", windowInfo.key);
    if (data?.length) {
      skipCategories = new Set(data.map(r => r.category));
      if (skipCategories.size > 0) {
        process.stdout.write(`  [L6] Skipping ${skipCategories.size} already-computed categories (use --force to overwrite)\n`);
      }
    }
  }

  const rawAnalyses = await Promise.all(
    ACTIVE_CATEGORIES.map(cat => {
      if (skipCategories.has(cat)) {
        process.stdout.write(`  [L6] ${cat}: skipped (exists)\n`);
        return Promise.resolve({
          category: cat,
          assessment_status: "skipped",
          selected_source_ids: [],
          insights: [],
          coverage_gaps: [],
          qa_report: { total: 0, approved: 0, blocked: 0 },
        });
      }
      return runCategoryAnalysis(cat, sources, evidenceItems, corpusSummary, windowInfo, opts);
    })
  );

  // Generate point-form explanations for all approved insights (parallel Haiku calls)
  const withExplanations = await generateExplanations(rawAnalyses, evidenceItems, windowInfo, opts);

  // QA: verify explanation points are grounded in cited source quotes
  // Removes UNSUPPORTED points; flags deterministic issues (word count, etc.)
  const analyses = await qaExplanations(withExplanations, opts);

  // Persist (only non-skipped rows)
  const toPersist = analyses.filter(ca => ca.assessment_status !== "skipped");
  if (toPersist.length > 0) {
    try {
      await persistAnalysis(supabase, windowInfo, toPersist);
    } catch (err) {
      process.stdout.write(`  [L6] WARNING: DB persist failed: ${err.message}\n`);
    }
  }

  return analyses;
}
