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
import { buildCorpusComposition, formatCompositionReport } from "./corpusComposition.js";
import { synthesizeAllCategories, synthesizeCrossCategory } from "./synthesizeCategory.js";
import { buildPresentation }       from "./buildPresentation.js";
import { buildDashboardState }     from "./dashboard.js";
import { DOMAINS }                 from "./taxonomy.js";
import { splitByDefensive, classifyDefensiveSources } from "./classifyDefensive.js";
import { qaUnderstandLayer, qaEvidenceLayer, formatLayerQa } from "./layerQa.js";

export const PIPELINE_VERSION = "pipeline-2.0";

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
export async function runPipeline(sources, opts = {}) {
  const {
    skipLlm     = false,
    skipSlides  = false,
    onProgress  = () => {},
    onCheckpoint = async () => {},
    supabase    = null,   // when provided, L5 evidence is cached/persisted per source
  } = opts;

  const t0      = Date.now();
  const run_id  = `v2-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const run_date = new Date().toISOString();

  function log(step, msg) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`  [${step}] ${msg} (+${elapsed}s)\n`);
    onProgress(step, msg);
  }

  log("START", `${sources.length} sources → pipeline (LLM: ${skipLlm ? "off" : "on"})`);

  // ── Step 1: Understand all sources ─────────────────────────────────────────
  log("L2-L4", "Understanding sources (relevance + taxonomy + entities)...");
  const { relevant, discarded, counts: understandCounts } = await understandAllSources(sources, {
    skipLlm,
    supabase,  // enables skip-if-classified and write-back
    concurrency: 5,
    onProgress: (done, total) => process.stdout.write(`    ${done}/${total}\r`),
  });
  process.stdout.write("\n");
  log("L2-L4", `${relevant.length} relevant / ${discarded.length} discarded`);

  // ── Defensive filter + sub-pipeline ────────────────────────────────────────
  // Defensive sources (is_defensive=true) are split off, classified separately,
  // then merged back so they still contribute evidence and corpus stats.
  const { offensive: offensiveSources, defensive: defensiveSources } = splitByDefensive(relevant);
  log("DEFENSIVE", `${defensiveSources.length} defensive / ${offensiveSources.length} offensive`);

  const {
    classified: classifiedDefensive,
    qa_report:  defensiveQa,
    counts:     defensiveCounts,
  } = await classifyDefensiveSources(defensiveSources, { skipLlm, concurrency: 5 });
  if (defensiveCounts.total > 0) {
    log("DEFENSIVE", `${defensiveCounts.qa_pass}/${defensiveCounts.total} QA pass, ${defensiveCounts.enriched} enriched`);
    if (defensiveCounts.qa_fail > 0) {
      log("DEFENSIVE", `⚠ ${defensiveCounts.qa_fail} QA failures — check defensive_qa checkpoint`);
    }
  }

  await onCheckpoint("defensive_qa", {
    run_id,
    counts: defensiveCounts,
    qa_failures: defensiveQa.filter(r => !r.pass).map(r => ({ id: r.source_id, issues: r.issues })),
  });

  // Re-merge: all relevant sources (offensive + enriched defensive) continue downstream
  const allRelevant = [...offensiveSources, ...classifiedDefensive];

  // ── QA checkpoint: L3 understand layer ─────────────────────────────────────
  const qa_understand = qaUnderstandLayer(allRelevant, discarded);
  process.stdout.write(formatLayerQa(qa_understand) + "\n");
  if (!qa_understand.pass) log("QA-L3", `✖ understand-layer QA has failures — see qa_understand checkpoint`);
  await onCheckpoint("qa_understand", { run_id, ...qa_understand });

  await onCheckpoint("understand", {
    run_id,
    total: sources.length,
    relevant: allRelevant.length,
    offensive: offensiveSources.length,
    defensive: defensiveSources.length,
    discarded: discarded.length,
    by_category: understandCounts.by_category,
    discarded_sample: discarded.slice(0, 5).map(s => ({
      id: s.id, title: s.title?.slice(0, 60), reason: s.rejection_reason,
    })),
  });

  // ── Step 2: Extract evidence ────────────────────────────────────────────────
  log("L5", "Extracting evidence items...");
  const { items: evidenceItems, packs, counts: evidenceCounts } = await extractAllEvidence(
    allRelevant,
    ACTIVE_CATEGORIES,
    { skipLlm, supabase, concurrency: 5, onProgress: (done, total) => process.stdout.write(`    ${done}/${total}\r`) },
  );
  process.stdout.write("\n");
  log("L5", `${evidenceCounts.total_extracted} extracted → ${evidenceCounts.after_dedup} after dedup (${evidenceCounts.strong} strong, ${evidenceCounts.usable} usable)`);

  await onCheckpoint("evidence", {
    run_id,
    counts: evidenceCounts,
    pack_sizes: packs.map(p => ({ category: p.category, strong: p.strong.length, usable: p.usable.length, context: p.context.length })),
  });

  // ── QA checkpoint: L5 evidence layer ───────────────────────────────────────
  const qa_evidence = qaEvidenceLayer(evidenceItems, packs);
  process.stdout.write(formatLayerQa(qa_evidence) + "\n");
  if (!qa_evidence.pass) log("QA-L5", `✖ evidence-layer QA has failures — see qa_evidence checkpoint`);
  await onCheckpoint("qa_evidence", { run_id, ...qa_evidence });

  // ── Step 3: Corpus summary ──────────────────────────────────────────────────
  log("CORPUS", "Building corpus summary...");
  const corpus_summary = buildCorpusSummary(allRelevant, sources);
  const evidence_graph = buildEvidenceGraph(allRelevant, evidenceItems);
  log("CORPUS", `${corpus_summary.date_range} | ${ACTIVE_CATEGORIES.map(c => `${c.split("_")[0]}:${corpus_summary.source_count_by_category?.[c]||0}`).join(" ")}`);

  if (corpus_summary.thin_categories.length > 0) {
    log("CORPUS", `⚠ Thin categories: ${corpus_summary.thin_categories.join(", ")} — synthesis confidence capped`);
  }

  // ── Source-composition audit (deterministic) ───────────────────────────────
  // Show the evidence base before trusting the deck. Flags research-dominated
  // or single-publisher runs (see docs/CORPUS_COMPOSITION_AUDIT.md).
  const corpus_composition = buildCorpusComposition(allRelevant);
  process.stdout.write("\n" + formatCompositionReport(corpus_composition) + "\n\n");
  for (const w of corpus_composition.warnings) {
    if (w.severity === "critical") log("COMPOSITION", `✖ ${w.message}`);
  }

  await onCheckpoint("composition", {
    run_id,
    total: corpus_composition.total,
    research_share: corpus_composition.research_share,
    top2_publisher_share: corpus_composition.top2_publisher_share,
    balanced: corpus_composition.balanced,
    distribution: corpus_composition.distribution.map(d => ({
      bucket: d.bucket, count: d.count, pct: d.pct, status: d.status,
    })),
    warnings: corpus_composition.warnings,
  });

  // ── Step 4: Synthesize categories ──────────────────────────────────────────
  log("L6", "Synthesizing category analyses...");
  const category_analyses = await synthesizeAllCategories(packs, allRelevant, corpus_summary, { skipLlm });

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
    relevant_sources:     allRelevant,
    offensive_sources:    offensiveSources,
    defensive_sources:    classifiedDefensive,
    defensive_qa:         defensiveQa,
    defensive_counts:     defensiveCounts,
    discarded_sources:    discarded,
    understand_counts:    understandCounts,

    // Per-layer QA reports
    qa_understand,
    qa_evidence,

    // Evidence step
    evidence_items:       evidenceItems,
    evidence_packs:       packs,
    evidence_counts:      evidenceCounts,

    // Corpus / analytics
    corpus_summary,
    corpus_composition,
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
      sources_relevant:   allRelevant.length,
      sources_offensive:  offensiveSources.length,
      sources_defensive:  classifiedDefensive.length,
      sources_discarded:  discarded.length,
      evidence_items:     evidenceCounts.after_dedup,
      evidence_strong:    evidenceCounts.strong,
      judgments_total:    totalJudgments,
      judgments_approved: approvedJudgments,
      patterns_found:     (cross_category.patterns || []).length,
      slides_generated:   deck?.slides.length || 0,
      qa_understand_pass: qa_understand.pass,
      qa_evidence_pass:   qa_evidence.pass,
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
export async function runPipelineFromDB(supabase, opts = {}) {
  const { days = 30, limit = 200, category } = opts;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let query = supabase
    .from("sources")
    .select("*")
    .gte("date_published", since)
    .neq("validation_status", "reject")   // H7: exclude hard-rejects; v2 re-judges review/null
    .order("date_published", { ascending: false })
    .limit(limit);

  if (category) query = query.eq("main_category", category);

  const { data, error } = await query;
  if (error) throw new Error(`DB load failed: ${error.message}`);
  if (!data?.length) throw new Error("No sources found in the specified window");

  console.log(`  Loaded ${data.length} sources from Supabase (last ${days} days)`);
  return runPipeline(data, opts);
}
