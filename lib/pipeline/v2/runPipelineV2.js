/**
 * v2 — Pipeline Orchestrator
 *
 * Runs the simplified 5-step pipeline:
 *
 *   Step 1  understandAllSources()    merged L3+L4 — one LLM call per source
 *   Step 2  extractAllEvidence()      simplified L5 — one LLM call per eligible source
 *   Step 3  buildCorpusSummary()      analytics — DB-query-level aggregation, no LLM
 *   Step 4  synthesizeAllCategories() simplified L6 — one Opus/Sonnet call per category
 *   Step 5  buildPresentation()       simplified L7+L8 — LLM-planned deck
 *
 * Each step saves a checkpoint (JSON) and logs counts. The orchestrator is
 * deliberately thin — no pre-analysis, no intermediate representations,
 * no score computation between steps.
 *
 * Options:
 *   skipLlm   — deterministic mode (stubs for all LLM calls)
 *   skipSlides — stop after synthesis (no deck generation)
 *   onProgress — callback(step, message)
 */

import { understandAllSources }    from "./understandSource.js";
import { extractAllEvidence }      from "./extractEvidence.js";
import { buildCorpusSummary, buildEvidenceGraph } from "./corpusSummary.js";
import { synthesizeAllCategories, synthesizeCrossCategory } from "./synthesizeCategory.js";
import { buildPresentation }       from "./buildPresentation.js";
import { buildDashboardState }     from "./dashboard.js";
import { DOMAINS }                 from "./taxonomy.js";

export const PIPELINE_VERSION = "pipeline-v2.0";

const ACTIVE_CATEGORIES = DOMAINS.filter(d => d !== "unclear_or_adjacent");

/**
 * Run the full v2 pipeline on a set of raw sources.
 *
 * @param {object[]} sources  - Raw sources from connectors / DB
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @param {boolean}  [opts.skipSlides=false]
 * @param {Function} [opts.onProgress]    - (step, message) => void
 * @param {Function} [opts.onCheckpoint]  - (layer, data) => Promise<void>
 * @returns {Promise<PipelineV2Result>}
 */
export async function runPipelineV2(sources, opts = {}) {
  const {
    skipLlm     = false,
    skipSlides  = false,
    onProgress  = () => {},
    onCheckpoint = async () => {},
  } = opts;

  const t0      = Date.now();
  const run_id  = `v2-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const run_date = new Date().toISOString();

  function log(step, msg) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`  [${step}] ${msg} (+${elapsed}s)\n`);
    onProgress(step, msg);
  }

  log("START", `${sources.length} sources → pipeline-v2 (LLM: ${skipLlm ? "off" : "on"})`);

  // ── Step 1: Understand all sources ─────────────────────────────────────────
  log("L2-L4", "Understanding sources (relevance + taxonomy + entities)...");
  const { relevant, discarded, counts: understandCounts } = await understandAllSources(sources, {
    skipLlm,
    concurrency: 5,
    onProgress: (done, total) => process.stdout.write(`    ${done}/${total}\r`),
  });
  process.stdout.write("\n");
  log("L2-L4", `${relevant.length} relevant / ${discarded.length} discarded`);

  await onCheckpoint("understand", {
    run_id,
    total: sources.length,
    relevant: relevant.length,
    discarded: discarded.length,
    by_category: understandCounts.by_category,
    discarded_sample: discarded.slice(0, 5).map(s => ({
      id: s.id, title: s.title?.slice(0, 60), reason: s.rejection_reason,
    })),
  });

  // ── Step 2: Extract evidence ────────────────────────────────────────────────
  log("L5", "Extracting evidence items...");
  const { items: evidenceItems, packs, counts: evidenceCounts } = await extractAllEvidence(
    relevant,
    ACTIVE_CATEGORIES,
    { skipLlm, concurrency: 5, onProgress: (done, total) => process.stdout.write(`    ${done}/${total}\r`) },
  );
  process.stdout.write("\n");
  log("L5", `${evidenceCounts.total_extracted} extracted → ${evidenceCounts.after_dedup} after dedup (${evidenceCounts.strong} strong, ${evidenceCounts.usable} usable)`);

  await onCheckpoint("evidence", {
    run_id,
    counts: evidenceCounts,
    pack_sizes: packs.map(p => ({ category: p.category, strong: p.strong.length, usable: p.usable.length, context: p.context.length })),
  });

  // ── Step 3: Corpus summary ──────────────────────────────────────────────────
  log("CORPUS", "Building corpus summary...");
  const corpus_summary = buildCorpusSummary(relevant, sources);
  const evidence_graph = buildEvidenceGraph(relevant, evidenceItems);
  log("CORPUS", `${corpus_summary.date_range} | ${ACTIVE_CATEGORIES.map(c => `${c.split("_")[0]}:${corpus_summary.source_count_by_category?.[c]||0}`).join(" ")}`);

  if (corpus_summary.thin_categories.length > 0) {
    log("CORPUS", `⚠ Thin categories: ${corpus_summary.thin_categories.join(", ")} — synthesis confidence capped`);
  }

  // ── Step 4: Synthesize categories ──────────────────────────────────────────
  log("L6", "Synthesizing category analyses...");
  const category_analyses = await synthesizeAllCategories(packs, relevant, corpus_summary, { skipLlm });

  const totalJudgments   = category_analyses.reduce((n, ca) => n + (ca.judgments || []).length, 0);
  const approvedJudgments = category_analyses.reduce((n, ca) => n + (ca.approved_judgment_count || 0), 0);
  log("L6", `${totalJudgments} judgments generated, ${approvedJudgments} approved`);

  log("L6", "Running cross-category synthesis...");
  const cross_category = await synthesizeCrossCategory(category_analyses, { skipLlm });
  log("L6", `${(cross_category.patterns || []).length} cross-category patterns identified`);

  await onCheckpoint("synthesis", {
    run_id,
    total_judgments:    totalJudgments,
    approved_judgments: approvedJudgments,
    cross_cat_patterns: (cross_category.patterns || []).length,
    category_summary:   category_analyses.map(ca => ({
      category:         ca.category,
      status:           ca.assessment_status,
      approved:         ca.approved_judgment_count || 0,
      blocked:          ca.blocked_judgment_count || 0,
    })),
  });

  // ── Build dashboard state ───────────────────────────────────────────────────
  const runResult = {
    run_id,
    run_date,
    category_analyses,
    evidence_items: evidenceItems,
    corpus_summary,
    cross_category,
  };
  const dashboard_state = buildDashboardState(runResult);

  // ── Step 5: Build presentation (optional) ──────────────────────────────────
  let deck = null;
  if (!skipSlides) {
    log("L7-L8", "Building presentation deck...");
    deck = await buildPresentation(category_analyses, cross_category, evidenceItems, { skipLlm, corpusSummary: corpus_summary });
    log("L7-L8", `${deck.slides.length} slides generated, ${deck.traceability_issues.length} traceability issues`);

    await onCheckpoint("presentation", {
      run_id,
      slides_generated:    deck.slides.length,
      traceability_issues: deck.traceability_issues.length,
      evidence_callouts:   deck.counts.evidence_callouts,
    });
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log("DONE", `Pipeline complete in ${elapsed}s`);

  return {
    run_id,
    run_date,
    pipeline_version: PIPELINE_VERSION,

    // Understand step
    all_sources:          sources,
    relevant_sources:     relevant,
    discarded_sources:    discarded,
    understand_counts:    understandCounts,

    // Evidence step
    evidence_items:       evidenceItems,
    evidence_packs:       packs,
    evidence_counts:      evidenceCounts,

    // Corpus / analytics
    corpus_summary,
    evidence_graph,

    // Synthesis
    category_analyses,
    cross_category,

    // Dashboard
    dashboard_state,

    // Presentation
    deck,

    // Summary
    counts: {
      sources_input:      sources.length,
      sources_relevant:   relevant.length,
      sources_discarded:  discarded.length,
      evidence_items:     evidenceCounts.after_dedup,
      evidence_strong:    evidenceCounts.strong,
      judgments_total:    totalJudgments,
      judgments_approved: approvedJudgments,
      patterns_found:     (cross_category.patterns || []).length,
      slides_generated:   deck?.slides.length || 0,
    },
    elapsed_seconds: parseFloat(elapsed),
  };
}

// ── Convenience: run from a Supabase query ────────────────────────────────────

/**
 * Load sources from Supabase and run the pipeline.
 * Handles the common case: "run v2 pipeline on recent sources."
 *
 * @param {object} supabase    - Supabase client
 * @param {object} [opts]
 * @param {number} [opts.days=30]         - Lookback window in days
 * @param {number} [opts.limit=200]       - Max sources to load
 * @param {string} [opts.category]        - Filter by category
 * @param {boolean}[opts.skipLlm=false]
 * @param {boolean}[opts.skipSlides=false]
 * @returns {Promise<PipelineV2Result>}
 */
export async function runPipelineV2FromDB(supabase, opts = {}) {
  const { days = 30, limit = 200, category } = opts;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let query = supabase
    .from("sources")
    .select("*")
    .gte("date_published", since)
    .order("date_published", { ascending: false })
    .limit(limit);

  if (category) query = query.eq("main_category", category);

  const { data, error } = await query;
  if (error) throw new Error(`DB load failed: ${error.message}`);
  if (!data?.length) throw new Error("No sources found in the specified window");

  console.log(`  Loaded ${data.length} sources from Supabase (last ${days} days)`);
  return runPipelineV2(data, opts);
}
