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

import { understandAllSources }    from "./understand/understandSource.js";
import { extractAllEvidence }      from "./extraction/extractEvidence.js";
import { buildCorpusSummary, buildEvidenceGraph } from "./analysis/corpusSummary.js";
import { buildCorpusComposition, formatCompositionReport } from "./analysis/corpusComposition.js";
import { synthesizeAllCategories, synthesizeCrossCategory } from "./analysis/synthesizeCategory.js";
import { buildPresentation }       from "./slides/buildPresentation.js";
import { buildDashboardState }     from "./dashboard.js";
import { DOMAINS }                 from "./understand/taxonomy.js";
import { splitByDefensive, classifyDefensiveSources } from "./understand/classifyDefensive.js";
import { qaUnderstandLayer, qaEvidenceLayer, formatLayerQa } from "./layerQa.js";
import { qaClassificationLLM, formatClassificationQa } from "./understand/qaClassification.js";
// ── New strategic intelligence layers ────────────────────────────────────────
import { extractAllPatterns }      from "./analysis/extractPatterns.js";
import { generateAllDevelopments } from "./analysis/generateDevelopments.js";
import { generateAllInsights }     from "./analysis/generateInsights.js";
import { selectAllCaseStudies }    from "./analysis/selectCaseStudies.js";
import { generateAllOutlooks }     from "./analysis/generateOutlook.js";
import { planSlideDeck }           from "./slides/planSlides.js";

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

  // ── QA checkpoint: L3 understand layer (deterministic) ─────────────────────
  const qa_understand = qaUnderstandLayer(allRelevant, discarded);
  process.stdout.write(formatLayerQa(qa_understand) + "\n");
  if (!qa_understand.pass) log("QA-L3", `✖ understand-layer QA has failures — see qa_understand checkpoint`);
  await onCheckpoint("qa_understand", { run_id, ...qa_understand });

  // ── QA checkpoint: LLM classification verifier (auto-fixing) ───────────────
  // Samples 15% of classified sources, cross-checks with a second LLM call,
  // and immediately re-runs + fixes any disagreements (high/medium confidence).
  const qaMode = allRelevant.length <= 200 ? "full" : "sampled";
  const qaN    = qaMode === "full" ? allRelevant.length : Math.min(30, Math.ceil(allRelevant.length * 0.15));
  log("QA-L3-LLM", `Verifying classifications [${qaMode}] (${qaN}/${allRelevant.length} sources)…`);
  const { sources: qaFixedSources, report: qa_classification } = await qaClassificationLLM(allRelevant, {
    skipLlm,
    full: qaMode === "full",
    concurrency: 3,
    supabase,
    onProgress: (done, total) => process.stdout.write(`    ${done}/${total}\r`),
  });
  process.stdout.write("\n");
  process.stdout.write(formatClassificationQa(qa_classification));
  if (qa_classification.fixed > 0) {
    log("QA-L3-LLM", `Auto-fixed ${qa_classification.fixed} misclassification(s)`);
  }
  await onCheckpoint("qa_classification", { run_id, ...qa_classification });

  // Use the QA-fixed source list from here on
  const allRelevantQA = qaFixedSources;

  await onCheckpoint("understand", {
    run_id,
    total: sources.length,
    relevant: allRelevantQA.length,
    relevant_pre_qa: allRelevant.length,
    qa_fixed: qa_classification.fixed,
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
    allRelevantQA,
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
  const corpus_summary = buildCorpusSummary(allRelevantQA, sources);
  const evidence_graph = buildEvidenceGraph(allRelevantQA, evidenceItems);
  log("CORPUS", `${corpus_summary.date_range} | ${ACTIVE_CATEGORIES.map(c => `${c.split("_")[0]}:${corpus_summary.source_count_by_category?.[c]||0}`).join(" ")}`);

  if (corpus_summary.thin_categories.length > 0) {
    log("CORPUS", `⚠ Thin categories: ${corpus_summary.thin_categories.join(", ")} — synthesis confidence capped`);
  }

  // ── Source-composition audit (deterministic) ───────────────────────────────
  // Show the evidence base before trusting the deck. Flags research-dominated
  // or single-publisher runs (see docs/CORPUS_COMPOSITION_AUDIT.md).
  const corpus_composition = buildCorpusComposition(allRelevantQA);
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
  const category_analyses = await synthesizeAllCategories(packs, allRelevantQA, corpus_summary, { skipLlm });

  const totalJudgments   = category_analyses.reduce((n, ca) => n + (ca.judgments || []).length, 0);
  const approvedJudgments = category_analyses.reduce((n, ca) => n + (ca.approved_judgment_count || 0), 0);
  log("L6", `${totalJudgments} judgments generated, ${approvedJudgments} approved`);

  // ── Step 4.1: Pattern extraction (L5.5) ────────────────────────────────────
  log("L5.5", "Extracting evidence patterns...");
  const packsMap = Object.fromEntries(
    packs.map(p => [p.category, p])
  );
  const evidence_index = Object.fromEntries((evidenceItems || []).map(ei => [ei.evidence_id, ei]));
  const patterns = await extractAllPatterns(packsMap, evidence_index, { skipLlm });

  // ── Step 4.2: Development generation (L6.1) ────────────────────────────────
  log("L6.1", "Generating developments...");
  const all_developments = await generateAllDevelopments(packsMap, patterns, corpus_summary, { skipLlm }, category_analyses);
  const totalDevelopments = Object.values(all_developments.byCategory).flat().length;
  log("L6.1", `${totalDevelopments} developments, ${(all_developments.overall || []).length} overall`);

  // ── Step 4.3: Insight generation (L6.2) ────────────────────────────────────
  log("L6.2", "Generating insights...");
  const all_insights = await generateAllInsights(all_developments, evidenceItems, { skipLlm }, category_analyses);
  const totalInsights = Object.values(all_insights.byCategory).flat().length;
  log("L6.2", `${totalInsights} insights, ${(all_insights.overall || []).length} overall`);

  // ── Step 4.4: Case study selection (L6.3) ──────────────────────────────────
  log("L6.3", "Selecting case studies...");
  const case_studies = await selectAllCaseStudies(packsMap, evidence_index, { skipLlm });

  // ── Step 4.5: Cross-category synthesis (enhanced L6.4) ─────────────────────
  log("L6", "Running cross-category synthesis...");
  const cross_category = await synthesizeCrossCategory(category_analyses, { skipLlm }, all_developments, all_insights);
  log("L6", `${(cross_category.patterns || []).length} cross-category patterns identified`);

  // ── Step 4.6: Outlook generation (L6.5) ────────────────────────────────────
  log("L6.5", "Generating outlooks...");
  const all_outlooks = await generateAllOutlooks(all_developments, all_insights, category_analyses, evidenceItems, { skipLlm });

  await onCheckpoint("synthesis", {
    run_id,
    total_judgments:    totalJudgments,
    approved_judgments: approvedJudgments,
    total_developments: totalDevelopments,
    total_insights:     totalInsights,
    cross_cat_patterns: (cross_category.patterns || []).length,
    case_studies_selected: Object.values(case_studies).filter(Boolean).length,
    category_summary:   category_analyses.map(ca => ({
      category:         ca.category,
      status:           ca.assessment_status,
      approved:         ca.approved_judgment_count || 0,
      blocked:          ca.blocked_judgment_count || 0,
    })),
  });

  await onCheckpoint("developments",  { run_id, total: totalDevelopments,   byCategory: Object.fromEntries(Object.entries(all_developments.byCategory).map(([k, v]) => [k, v.length])) });
  await onCheckpoint("insights",      { run_id, total: totalInsights,        byCategory: Object.fromEntries(Object.entries(all_insights.byCategory).map(([k, v]) => [k, v.length])) });
  await onCheckpoint("case_studies",  { run_id, selected: Object.values(case_studies).filter(Boolean).map(cs => ({ category: cs.category, named_entity: cs.named_entity })) });
  await onCheckpoint("outlooks",      { run_id, generated: Object.values(all_outlooks.byCategory).filter(Boolean).length });

  // ── Step 4.7: Slide planning (L7.0) ─────────────────────────────────────────
  let slide_plan = null;
  if (!skipSlides) {
    log("L7.0", "Planning slide deck...");
    slide_plan = await planSlideDeck(all_developments, all_insights, case_studies, all_outlooks, cross_category, corpus_summary, { skipLlm });
    log("L7.0", `${(slide_plan?.slides || []).length} slides planned`);
    await onCheckpoint("slide_plan", { run_id, total_slides: slide_plan?.total_slides, deck_narrative: slide_plan?.deck_narrative?.slice(0, 120) });
  }

  // ── Build dashboard state ───────────────────────────────────────────────────
  const runResult = {
    run_id,
    run_date,
    category_analyses,
    evidence_items:    evidenceItems,
    corpus_summary,
    cross_category,
    all_developments,
    all_insights,
    case_studies,
    all_outlooks,
    slide_plan,
  };
  const dashboard_state = buildDashboardState(runResult);

  // ── Step 5: Build presentation (optional) ──────────────────────────────────
  let deck = null;
  if (!skipSlides) {
    log("L7-L8", "Building presentation deck...");
    // Pass starred source URLs + importance tiers so evidence sorting in
    // buildPresentation can prioritise starred/realized evidence without an
    // extra DB round-trip (allRelevantQA already carries these from the DB row).
    const starredSourceUrls  = allRelevantQA.filter(s => s.starred).map(s => s.url).filter(Boolean);
    const importanceTierByUrl = Object.fromEntries(
      allRelevantQA
        .filter(s => s.url && s.intelligence?.importance?.tier)
        .map(s => [s.url, s.intelligence.importance.tier])
    );
    deck = await buildPresentation(category_analyses, cross_category, evidenceItems, {
      skipLlm,
      corpusSummary:    corpus_summary,
      allOutlooks:      all_outlooks,
      starredSourceUrls,
      importanceTierByUrl,
      // Pass preselected case studies so buildPresentation uses walkthrough-backed
      // candidates (with attack_stages[]) rather than re-running caseStudyPlanFor().
      caseStudies:      case_studies,
    }, slide_plan);
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
    relevant_sources:     allRelevantQA,
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

    // Strategic intelligence layers (new)
    patterns:          patterns,
    all_developments:  all_developments,
    all_insights:      all_insights,
    case_studies:      case_studies,
    all_outlooks:      all_outlooks,
    slide_plan:        slide_plan,

    // Dashboard
    dashboard_state,

    // Presentation
    deck,

    // Summary
    counts: {
      sources_input:         sources.length,
      sources_relevant:      allRelevantQA.length,
      sources_offensive:     offensiveSources.length,
      sources_defensive:     classifiedDefensive.length,
      sources_discarded:     discarded.length,
      evidence_items:        evidenceCounts.after_dedup,
      evidence_strong:       evidenceCounts.strong,
      judgments_total:       totalJudgments,
      judgments_approved:    approvedJudgments,
      developments_total:    totalDevelopments,
      insights_total:        totalInsights,
      case_studies_selected: Object.values(case_studies).filter(Boolean).length,
      patterns_found:        (cross_category.patterns || []).length,
      slides_planned:        slide_plan?.total_slides || 0,
      slides_generated:      deck?.slides.length || 0,
      qa_understand_pass:    qa_understand.pass,
      qa_evidence_pass:      qa_evidence.pass,
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
// Per-category source caps for slide generation, by importance label.
// Total per category: up to 20+15+5 = 40 sources, strongly weighted toward
// confirmed incidents and demonstrated exploits.
const CAP = { critical: 20, important: 15, supporting: 5 };

const OFFENSIVE_CATS = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

/**
 * Fetch sources for one category, tiered by reading_value.
 * Priority order: essential → recommended → analyst.
 * Starred sources are always included (up to 10 extra, deduped).
 * Falls back to ai_specificity_score >= 30 if reading_value not yet populated.
 */
async function fetchCategorySources(supabase, cat, since) {
  const base = supabase
    .from("sources")
    .select("*")
    .eq("main_category", cat)
    .eq("validation_status", "pass")
    .not("needs_review", "is", true)   // exclude only flagged (true); keep NULL/false
    .gte("date_published", since)
    .order("date_published", { ascending: false });

  // Fetch each reading_value tier and starred in parallel
  const [essentialRes, recommendedRes, analystRes, starredRes] = await Promise.all([
    base.eq("reading_value", "essential").limit(CAP.critical),
    base.eq("reading_value", "recommended").limit(CAP.important),
    base.eq("reading_value", "analyst").limit(CAP.supporting),
    base.eq("starred", true).limit(10),
  ]);

  const seen = new Set();
  const sources = [];

  for (const res of [essentialRes, recommendedRes, analystRes, starredRes]) {
    if (res.error) continue;
    for (const s of res.data || []) {
      if (!seen.has(s.id)) { seen.add(s.id); sources.push(s); }
    }
  }

  // Fallback: reading_value not yet backfilled — use ai_specificity_score.
  if (sources.length === 0) {
    const { data, error } = await base.gte("ai_specificity_score", 30).limit(40);
    if (error) throw new Error(`DB fallback load failed for ${cat}: ${error.message}`);
    return data || [];
  }

  return sources;
}

export async function runPipelineFromDB(supabase, opts = {}) {
  const { days = 30, limit = 200, category } = opts;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (!category) {
    const perCatSources = await Promise.all(
      OFFENSIVE_CATS.map(cat => fetchCategorySources(supabase, cat, since))
    );
    const data = perCatSources.flat();
    if (!data.length) throw new Error("No classified sources found in the specified window");

    const byRv = { essential: 0, recommended: 0, analyst: 0, background: 0, unlabelled: 0 };
    for (const s of data) {
      const rv = s.reading_value;
      if (rv in byRv) byRv[rv]++; else byRv.unlabelled++;
    }
    console.log(
      `  Loaded ${data.length} sources (last ${days}d) — ` +
      `essential:${byRv.essential} recommended:${byRv.recommended} ` +
      `analyst:${byRv.analyst} unlabelled:${byRv.unlabelled}`
    );
    // Pass supabase so understandAllSources uses fromDbRow (no re-classification)
    return runPipeline(data, { ...opts, supabase });
  }

  // Single-category path (used by --category flag)
  const sources = await fetchCategorySources(supabase, category, since);
  if (!sources.length) throw new Error("No sources found in the specified window");
  console.log(`  Loaded ${sources.length} sources from Supabase (last ${days} days, category: ${category})`);
  return runPipeline(sources, { ...opts, supabase });
}
