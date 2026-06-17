/**
 * Layer 9 — Pipeline Runner
 *
 * End-to-end orchestrator for the analysis pipeline (Layers 5–8 over a
 * pre-ingested source set):
 *
 *   Step 1  Load sources from Supabase (or accept an explicit array)
 *   Step 2  Layer 5 — Understand: LLM taxonomy + intelligence enrichment;
 *           persist new results back to the sources table
 *   Step 3  Layer 6 — Synthesis: feed scoring + evidence extraction +
 *           analytics aggregation + strategic viewpoint synthesis
 *   Step 4  Layer 7 — Slides: planning + LLM content generation + export
 *   Step 5  Layer 8 — QA: structural, citation, and phrase checks
 *   Step 6  Persist: save deck metadata to Supabase + full JSON to Vercel Blob
 *
 * Designed for use in scripts/ (no Vercel timeout constraint).
 * The API endpoint api/generate-report.js delegates to this runner for
 * smaller source sets where the serverless timeout is not a concern.
 *
 * Input:  options (see runPipeline JSDoc)
 * Output: RunnerResult { source_window, source_count, understand_counts,
 *                        synthesisResult, deckResult, qaResult, stored,
 *                        runner_version }
 */

import { join, resolve }    from "path";
import { mkdir, writeFile }  from "fs/promises";
import { fileURLToPath }     from "url";
import { dirname }           from "path";

import { listSources } from "../../storage/snapshotDatabase.js";
import { understandSources } from "../understand/understandSources.js";
import { classifySources }   from "../classify/classifyCategory.js";
import { runSynthesisLayer } from "../synthesis/synthesisLayer.js";
import { runSlidesLayer }    from "../slides/slidesLayer.js";
import { runQALayer }        from "../qa/qaLayer.js";
import { runFinalExportQa }  from "../qa/finalExportQa.js";
import { persistUnderstandResults } from "../../storage/sourceEnrichmentStore.js";
import { persistAnalysisEvidence }  from "../../storage/sourceAnalysisStore.js";
import { persistTaxonomyArtefacts }  from "../../storage/taxonomyStore.js";
import { persistWebEvidence }        from "../webEvidence/persistWebEvidence.js";
import { saveDeck }          from "../../storage/deckStore.js";
import { logProviderStatus }  from "../../llm/llmRouter.js";
import { buildQaReport, formatQaReportMarkdown } from "../qa/buildQaReport.js";
import {
  buildRunId, writeCheckpoint, writeSourceTraces,
  buildSourceTraces, summariseL4, summariseL6, summariseL7L8, summariseL9,
} from "../debug/checkpointWriter.js";

const __dirname     = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT  = resolve(__dirname, "../../..");

export const RUNNER_VERSION = "runner-v9.0";

// ── Source loader ─────────────────────────────────────────────────────────────

async function loadSourcesFromDB({ windowDays = 90, windowStart = null, windowEnd = null, sourceLimit = 1000 } = {}) {
  const end = windowEnd || new Date().toISOString().slice(0, 10);
  const start = windowStart || (() => {
    const d = new Date(end);
    d.setDate(d.getDate() - windowDays);
    return d.toISOString().slice(0, 10);
  })();

  const sources = await listSources({ start, end, limit: sourceLimit });
  return { sources, window: { start, end } };
}

// ── Main runner ───────────────────────────────────────────────────────────────

/**
 * Run the complete analysis pipeline (Layers 5–8).
 *
 * @param {object}   [opts]
 * @param {object[]} [opts.sources]            Pre-loaded sources; skips DB load when provided.
 * @param {number}   [opts.windowDays=90]      Days of sources to load from DB.
 * @param {string}   [opts.windowStart]        Start date override ("YYYY-MM-DD").
 * @param {string}   [opts.windowEnd]          End date override ("YYYY-MM-DD").
 * @param {number}   [opts.sourceLimit=1000]   Max sources to load from DB.
 * @param {boolean}  [opts.skipLlm=false]      Force deterministic fallbacks in all LLM layers.
 * @param {boolean}  [opts.persistUnderstand=true]  Write Layer 5 results back to sources table.
 * @param {boolean}  [opts.persistDeck=true]   Save deck to decks table + Vercel Blob.
 * @param {boolean}  [opts.detailedNotes=false] Run second-pass speaker notes (Layer 7 step 3).
 * @param {string}   [opts.exportFormat="all"] "markdown" | "json" | "pptx" | "all".
 * @param {string}   [opts.outputPath=null]    Absolute path for PPTX output.
 * @param {string}   [opts.snapshotId=null]    Snapshot ID from the ingest step; links taxonomy
 *                                             artefacts (rawfacts, metrics) to their ingest run.
 * @param {Function} [opts.onProgress]         Called with (step: string, message: string).
 * @param {boolean}  [opts.debugMode=false]    Write per-layer JSON checkpoints to debug/runs/<runId>/.
 * @param {string}   [opts.runId=null]         Override the auto-generated run ID.
 * @returns {Promise<RunnerResult>}
 */
export async function runPipeline(opts = {}) {
  const {
    sources: explicitSources = null,
    windowDays        = 90,
    windowStart       = null,
    windowEnd         = null,
    sourceLimit       = 1000,
    skipLlm           = false,
    persistUnderstand = true,
    persistDeck       = true,
    detailedNotes     = false,
    exportFormat      = "all",
    outputPath        = null,
    snapshotId        = null,
    onProgress        = null,
    debugMode         = false,
    runId:            explicitRunId = null,
  } = opts;

  // Assign a run ID always so it is available in the return value.
  const runId = explicitRunId ?? buildRunId();

  const log = (step, msg) => {
    console.log(`[Layer9/${step}] ${msg}`);
    onProgress?.(step, msg);
  };

  // Helper: write a checkpoint without blocking the pipeline on errors.
  const checkpoint = async (layer, data) => {
    if (!debugMode) return;
    try {
      const path = await writeCheckpoint(runId, layer, data);
      log("debug", `Checkpoint written → ${path}`);
    } catch (err) {
      log("debug", `Warning: could not write ${layer} checkpoint: ${err.message}`);
    }
  };

  // ── Startup: LLM provider diagnostics ────────────────────────────────────
  if (!skipLlm) logProviderStatus();

  // ── Step 1: Load sources ──────────────────────────────────────────────────
  let feedSources;
  let sourceWindow = {};

  if (explicitSources) {
    feedSources  = explicitSources;
    sourceWindow = { start: windowStart, end: windowEnd };
    log("load", `Using ${feedSources.length} provided sources`);
  } else {
    log("load", `Querying DB (window: ${windowDays}d, limit: ${sourceLimit})...`);
    const { sources, window } = await loadSourcesFromDB({ windowDays, windowStart, windowEnd, sourceLimit });
    feedSources  = sources;
    sourceWindow = window;
    log("load", `Loaded ${feedSources.length} sources (${window.start} → ${window.end})`);
  }

  if (feedSources.length === 0) {
    throw new Error("No sources loaded — check the date window or DB connection.");
  }

  // ── Step 2: Layer 5 — Taxonomy ───────────────────────────────────────────
  log("taxonomy", `Tagging ${feedSources.length} sources (skip_llm=${skipLlm})...`);
  const { sources: taxonomised, counts: understandCounts, discarded: taxonomyDiscarded = [] } = await understandSources(
    feedSources,
    { skipLlm }
  );
  log(
    "taxonomy",
    `Done — already_done: ${understandCounts.already_done}, ` +
    `llm: ${understandCounts.llm_processed}, fallback: ${understandCounts.fallback}, ` +
    `validated: ${understandCounts.validated ?? 0}, ` +
    `no_domain: ${understandCounts.no_domain_match ?? 0}, ` +
    `no_tags: ${understandCounts.no_tags_found ?? 0}, ` +
    `discarded: ${understandCounts.discarded ?? 0}`
  );

  // ── Step 3: Layer 6 — Classification ────────────────────────────────────
  log("classify", `Classifying ${taxonomised.length} sources into main categories...`);
  const { sources: classified, counts: classifyCounts } = classifySources(taxonomised);
  log(
    "classify",
    `Done — ${classifyCounts.distribution
      ? Object.entries(classifyCounts.distribution)
          .sort((a, b) => b[1] - a[1])
          .map(([c, n]) => `${c.replace(/_/g, "_").split("_").pop()}: ${n}`)
          .join(", ")
      : "see distribution"}`
  );

  // Only persist when LLM actually ran — fallback results (keyword-only) must not
  // overwrite real LLM intelligence that may already exist in the DB.
  if (persistUnderstand && !skipLlm && understandCounts.llm_processed > 0) {
    log("taxonomy", `Persisting ${understandCounts.llm_processed} LLM enrichments to sources table...`);
    const { updated } = await persistUnderstandResults(classified);
    log("taxonomy", `Persisted ${updated} rows`);
  }

  // ── Debug checkpoint: L4 taxonomy ────────────────────────────────────────
  await checkpoint("L4_taxonomy", summariseL4(classified, understandCounts));
  if (debugMode) {
    try {
      const tracePath = await writeSourceTraces(runId, buildSourceTraces(classified));
      log("debug", `Source traces → ${tracePath}`);
    } catch (err) {
      log("debug", `Warning: could not write source traces: ${err.message}`);
    }
  }

  // ── Step 4: Layer 7 — Synthesis ──────────────────────────────────────────
  log("synthesis", "Running feed scoring + evidence extraction + viewpoint synthesis...");
  const synthesisResult = await runSynthesisLayer(classified, { skipLlm });
  log(
    "synthesis",
    `Done — ${synthesisResult.category_analyses?.length ?? 0} category analyses, ` +
    `${synthesisResult.counts.high_priority} high-priority sources, ` +
    `${synthesisResult.counts.evidence_cards} evidence cards`
  );

  // ── Step 4b: Persist analysis evidence (L3 verdict + L5A rawfacts + L5B analytics) ──
  // Writes the extracted evidence back to the sources table so it is queryable
  // per-source and not recomputed every run. Graceful: no-ops if the migration
  // (docs/migrations/000_schema.sql (section 5)) has not been applied.
  if (persistUnderstand && !skipLlm) {
    const evSources = synthesisResult.feed_sources || [];
    log("persist", `Persisting analysis evidence for ${evSources.length} sources...`);
    try {
      const { updated, persisted_columns } = await persistAnalysisEvidence(evSources);
      log("persist", `Persisted analysis evidence to ${updated} rows` +
        (persisted_columns.length ? ` (columns: ${persisted_columns.length})` : " (no evidence columns present)"));
    } catch (err) {
      log("persist", `Warning: analysis evidence persistence failed: ${err.message}`);
    }

    // Normalized taxonomy tables (rawfacts / analytics_metrics / ai_enabled_mappings /
    // taxonomy_references). Graceful no-op until docs/migrations/000_schema.sql (section 8) is
    // applied and the rawfact/analytics branches surface these artefacts.
    // snapshotId links these rows to the ingest snapshot created in Step 0.
    try {
      const res = await persistTaxonomyArtefacts({
        rawfacts:          synthesisResult.taxonomy_rawfacts    || [],
        metrics:           synthesisResult.taxonomy_metrics     || [],
        aiEnabledMappings: synthesisResult.ai_enabled_mappings  || [],
        visualEvidence:    synthesisResult.visual_evidence      || [],
        snapshotId:        snapshotId || synthesisResult.snapshot_id || null,
      });
      log("persist", `Taxonomy artefacts: rawfacts=${res.rawfacts.written} metrics=${res.metrics.written} ai_mappings=${res.ai_enabled_mappings.written} visual=${res.visual_evidence.written} refs=${res.references.written}`);
    } catch (err) {
      log("persist", `Warning: taxonomy artefact persistence failed: ${err.message}`);
    }

    // Layer 5C web evidence (accepted + rejected + manual_review + failures).
    // Graceful no-op until docs/migrations/000_schema.sql is applied, or when
    // the branch was disabled (synthesisResult.web_evidence is null).
    if (synthesisResult.web_evidence?.enabled) {
      try {
        const we = synthesisResult.web_evidence;
        const res = await persistWebEvidence(we, { snapshotId: snapshotId || synthesisResult.snapshot_id || null });
        log("persist", `Web evidence: items=${res.evidence.written} visuals=${res.visuals.written} failures=${res.failures.written}`);
      } catch (err) {
        log("persist", `Warning: web evidence persistence failed: ${err.message}`);
      }
    }
  }

  // ── Debug checkpoint: L6 synthesis ───────────────────────────────────────
  await checkpoint("L6_synthesis", summariseL6(synthesisResult));

  // ── Step 5: Slides ────────────────────────────────────────────────────────
  log("slides", "Planning and generating slide deck...");
  const deckResult = await runSlidesLayer(synthesisResult, {
    skipLlm,
    detailedNotes,
    exportFormat,
    outputPath,
  });
  log(
    "slides",
    `Done — ${deckResult.slides.length} slides, ` +
    `${deckResult.counts.evidence_callouts_used} evidence callouts used`
  );

  // ── Debug checkpoint: L7/L8 slides ───────────────────────────────────────
  await checkpoint("L7_L8_slides", summariseL7L8(deckResult));

  // ── Step 6: QA ────────────────────────────────────────────────────────────
  log("qa", "Running QA checks...");
  const qaResult   = runQALayer(deckResult, synthesisResult);
  const passLabel  = qaResult.overall_pass
    ? "PASS"
    : `FAIL (${qaResult.summary.errors} errors)`;
  log("qa", `${passLabel} — ${qaResult.summary.warnings} warnings, ${qaResult.summary.infos} infos`);

  // ── Step 6b-pre: L9.2 — Final Citation and Provenance QA ─────────────────
  // Runs before PPTX export. Hard-blocks export when blocked claims are in slides.
  let finalQa = null;
  const analysisPackage = synthesisResult?.analysis_package || null;
  if (analysisPackage) {
    try {
      finalQa = await runFinalExportQa(deckResult.slides || [], analysisPackage);
      if (finalQa.exportBlocked) {
        log("qa", `EXPORT BLOCKED (L9.2): ${finalQa.blocking_issues.map((i) => i.issue).join(", ")}`);
        log("qa", `  Blocked slides: ${finalQa.blocking_issues.map((i) => i.slide_id).join(", ")}`);
        // Still write JSON and QA report; PPTX generation is skipped downstream via flag
      } else {
        log("qa", `L9.2 Final QA: passed — ${finalQa.qa_summary.warning_count} warning(s)`);
      }
    } catch (err) {
      log("qa", `Warning: L9.2 final export QA failed: ${err.message}`);
    }
  }

  // ── Debug checkpoint: L9 QA ──────────────────────────────────────────────
  await checkpoint("L9_qa", summariseL9(qaResult));

  // ── Step 6b: Pipeline QA Report ──────────────────────────────────────────
  // Collects source/evidence/claim/corpus stats across the run into a single
  // human-readable report. Written alongside the deck for every run.
  const allClaims = (synthesisResult.category_analyses || []).flatMap((a) => [
    ...(a.claims || []),
    ...(a.claims_blocked_by_qa || []),
  ]);
  const corpusAudits = (synthesisResult.category_analyses || [])
    .filter((a) => a.corpus_audit)
    .map((a) => ({ category: a.category, ...a.corpus_audit }));

  const pipelineQaReport = buildQaReport({
    run_id:         `pipeline-run-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    sources:        synthesisResult.feed_sources || classified || [],
    evidence_items: synthesisResult.rawfact_evidence || [],
    claims:         allClaims,
    corpus_audits:  corpusAudits,
    slides:         deckResult.slides || [],
  });

  // Write both JSON and Markdown reports to outputs/final/
  try {
    const outDir    = join(PROJECT_ROOT, "outputs", "final");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "slide_qa_report.json"), JSON.stringify(qaResult, null, 2));
    await writeFile(join(outDir, "pipeline_qa_report.json"), JSON.stringify(pipelineQaReport, null, 2));
    await writeFile(join(outDir, "pipeline_qa_report.md"),  formatQaReportMarkdown(pipelineQaReport));
    log("qa", `QA reports saved to outputs/final/`);
  } catch (err) {
    log("qa", `Warning: could not write QA reports to disk: ${err.message}`);
  }

  // ── Step 7: Persist deck ──────────────────────────────────────────────────
  let stored = null;
  if (persistDeck) {
    log("persist", "Saving deck to Supabase + Vercel Blob...");
    stored = await saveDeck({
      synthesisResult,
      deckResult,
      qaResult,
      pipelineQaReport,
      window: sourceWindow,
    });
    log("persist", `Saved as ${stored.deck_id}`);
  }

  return {
    run_id:            runId,
    source_window:     sourceWindow,
    source_count:      feedSources.length,
    understand_counts: understandCounts,
    classify_counts:   classifyCounts,
    synthesisResult,
    deckResult,
    qaResult,
    finalQa,
    pipelineQaReport,
    stored,
    runner_version:    RUNNER_VERSION,
  };
}
