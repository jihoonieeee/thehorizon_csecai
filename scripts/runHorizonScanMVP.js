#!/usr/bin/env node
/**
 * Horizon Scan MVP — end-to-end pipeline runner (Layers 1–8 + persist)
 *
 * Usage:
 *   node scripts/runHorizonScanMVP.js [options]
 *
 * Options:
 *   --ingest              Run Layers 1–3 (collect + clean + validate) before analysis.
 *                         Fetches fresh sources from NVD, arXiv, RSS feeds for the
 *                         given date window and persists them to Supabase before
 *                         running Layers 4–8. Without this flag, sources are loaded
 *                         from the DB only (assumes prior ingestion run).
 *   --no-llm              Force deterministic fallback for all LLM steps
 *   --source-file <path>  Load sources from a JSON file instead of Supabase DB
 *   --days <n>            Source window in days (default: 90)
 *   --start <date>        Source window start date ("YYYY-MM-DD")
 *   --end   <date>        Source window end date   ("YYYY-MM-DD")
 *   --limit <n>           Max sources to load from DB or cap ingest output (default: 1000)
 *   --no-persist          Skip saving deck to Supabase / Vercel Blob
 *   --format <fmt>        Export format: markdown | json | pptx | all (default: all)
 *   --pptx-out <path>     Output path for PPTX
 *   --detailed-notes      Run second-pass speaker notes (extra LLM cost)
 *
 * Full test run (ingest 2025 Q3 → now, 200 sources, everything enabled):
 *   node scripts/runHorizonScanMVP.js --ingest --start 2025-07-01 --end 2026-06-03 --limit 200
 */
import "dotenv/config";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name)    { return args.includes(name); }
function argVal(name)  { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; }

const NO_LLM        = flag("--no-llm");
const NO_PERSIST    = flag("--no-persist");
const DETAILED_NOTES = flag("--detailed-notes");
const RUN_INGEST    = flag("--ingest");
const WEB_DISCOVERY = flag("--web-discovery");  // Layer 1B/1C open-web source discovery
const SOURCE_FILE   = argVal("--source-file");
const DAYS          = parseInt(argVal("--days") || "90", 10);
const DATE_START    = argVal("--start");
const DATE_END      = argVal("--end");
const LIMIT         = parseInt(argVal("--limit") || "1000", 10);
const FORMAT        = argVal("--format") || "all";
const PPTX_OUT      = argVal("--pptx-out") || path.resolve(ROOT, "outputs/final/horizon_scan_deck.pptx");

// ── Helpers ───────────────────────────────────────────────────────────────────

function saveJson(relPath, data) {
  const full = path.resolve(ROOT, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(data, null, 2));
  console.log(`  → Saved ${relPath}`);
}

function saveText(relPath, text) {
  const full = path.resolve(ROOT, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  console.log(`  → Saved ${relPath}`);
}

// ── Imports ───────────────────────────────────────────────────────────────────

import { loadSampleSources }       from "../lib/pipeline/ingest/loadSampleSources.js";
import { runPipeline, RUNNER_VERSION } from "../lib/pipeline/runner/pipelineRunner.js";
import { getTokenUsageSummary }     from "../lib/llm/llmRouter.js";
import { collectRawSources }        from "../lib/pipeline/ingest/collectRawSources.js";
import { saveSnapshotToDatabase }   from "../lib/storage/snapshotDatabase.js";
import { persistDiscoveryResult }   from "../lib/storage/discoveryStore.js";

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const llmMode   = NO_LLM
    ? "mock (--no-llm)"
    : (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY ? "live LLM" : "mock (no keys)");

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║     AI Cyber Threat Horizon Scan — MVP Pipeline      ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");
  console.log(`  Runner:   ${RUNNER_VERSION}`);
  console.log(`  LLM mode: ${llmMode}`);
  console.log(`  Persist:  ${NO_PERSIST ? "disabled (--no-persist)" : "Supabase + Vercel Blob"}`);
  console.log(`  Ingest:   ${RUN_INGEST ? "enabled (--ingest — Layers 1-3 will run first)" : "disabled (loading from DB)"}`);
  if (SOURCE_FILE) console.log(`  Sources:  file (${SOURCE_FILE})`);
  else             console.log(`  Sources:  ${RUN_INGEST ? "ingested fresh" : "DB"} (window: ${DATE_START || `${DAYS}d`} → ${DATE_END || "today"}, limit: ${LIMIT})`);
  console.log(`  Export:   ${FORMAT}`);
  console.log("");

  // ── Step 0: Ingest (Layers 1–3) ──────────────────────────────────────────────
  // When --ingest is set, collect fresh sources from NVD / arXiv / RSS feeds for
  // the given date window, persist them to Supabase, and pass them directly to the
  // analysis pipeline. This makes the command self-contained (no prior backfill needed).
  let explicitSources  = null;
  let ingestSnapshotId = null;  // set when --ingest persists a snapshot; forwarded to runPipeline

  if (RUN_INGEST && !SOURCE_FILE) {
    const ingestWindow = (() => {
      const SGT = 8 * 60 * 60 * 1000;
      if (DATE_START && DATE_END) {
        const start = new Date(`${DATE_START}T00:00:00+08:00`);
        const end   = new Date(`${DATE_END}T23:59:59+08:00`);
        return {
          timezone: "Asia/Singapore",
          start_utc: start.toISOString(),
          end_utc:   end.toISOString(),
          start_sgt: new Date(start.getTime() + SGT).toISOString(),
          end_sgt:   new Date(end.getTime()   + SGT).toISOString(),
        };
      }
      // Fall back to N-day window ending now
      const end   = new Date();
      const start = new Date(end.getTime() - DAYS * 24 * 60 * 60 * 1000);
      return {
        timezone: "Asia/Singapore",
        start_utc: start.toISOString(),
        end_utc:   end.toISOString(),
        start_sgt: new Date(start.getTime() + SGT).toISOString(),
        end_sgt:   new Date(end.getTime()   + SGT).toISOString(),
      };
    })();

    console.log(`[ingest] Collecting sources: ${ingestWindow.start_utc.slice(0, 10)} → ${ingestWindow.end_utc.slice(0, 10)}`);
    if (WEB_DISCOVERY) {
      const { discoveryProviderStatus } = await import("../lib/pipeline/discovery/discoverySearchRouter.js");
      const ps = discoveryProviderStatus();
      console.log(`[ingest] Web discovery (Layer 1B/1C) enabled — providers: tavily=${ps.tavily} serpapi=${ps.serpapi} anthropic=${ps.anthropic}${ps.forced ? ` forced=${ps.forced}` : ""}`);
    }
    const ingestResult = await collectRawSources(ingestWindow, { webDiscovery: WEB_DISCOVERY, skipLlm: NO_LLM });
    const ingestSources = ingestResult.sources.slice(0, LIMIT);
    console.log(
      `  → collected: raw=${ingestResult.pipeline_counts.raw} ` +
      `windowed=${ingestResult.pipeline_counts.within_publish_date_window} ` +
      (WEB_DISCOVERY ? `web_discovered=${ingestResult.pipeline_counts.web_discovery_accepted} ` : "") +
      `deduped=${ingestResult.pipeline_counts.deduped} ` +
      `usable=${ingestResult.pipeline_counts.usable} ` +
      `capped=${ingestSources.length}`
    );
    if (WEB_DISCOVERY && ingestResult.web_discovery) {
      const wd = ingestResult.web_discovery;
      console.log(
        `  → web discovery: accepted=${wd.accepted_count} audit=${wd.audit_count} ` +
        `rejected=${wd.rejected_count} archive_only=${wd.archive_only_count} ` +
        `unsupported_queries=${(wd.unsupported_queries || []).length}`
      );
    }

    // Persist ingested sources to Supabase so they're queryable later
    if (!NO_PERSIST && ingestSources.length > 0) {
      console.log("[ingest] Saving snapshot to Supabase...");
      try {
        const snap = await saveSnapshotToDatabase({
          generated_at:     new Date().toISOString(),
          period:           "horizon_scan_test",
          stage:            "full_ingest_run",
          reporting_window: ingestWindow,
          count:            ingestSources.length,
          removed_by_publish_date_count: ingestResult.removed_by_publish_date_count || 0,
          removed_by_publish_date:       ingestResult.removed_by_publish_date || [],
          rejected_count:                ingestResult.rejected_count || 0,
          rejected_sources:              ingestResult.rejected_sources || [],
          discarded_count:               ingestResult.discarded_count || 0,
          sources:                       ingestSources,
        });
        ingestSnapshotId = snap.snapshot_id;
        console.log(`  → saved snapshot ${snap.snapshot_id}`);
      } catch (err) {
        console.warn(`  → snapshot save failed: ${err.message} — continuing with in-memory sources`);
      }
    }

    // Persist ALL web-discovery candidates (accepted + archive_only + reject) for
    // audit. Graceful no-op until docs/migrations/web-discovery-v1.sql is applied.
    if (!NO_PERSIST && ingestResult.web_discovery?.candidates_total > 0) {
      try {
        const res = await persistDiscoveryResult(ingestResult.web_discovery, { snapshotId: ingestSnapshotId });
        console.log(`  → web discovery candidates persisted: ${res.written} (skipped ${res.skipped})`);
      } catch (err) {
        console.warn(`  → web discovery persist failed: ${err.message}`);
      }
    }

    explicitSources = ingestSources;
  }

  // Load explicit sources from file (if provided, overrides --ingest)
  if (SOURCE_FILE) {
    console.log("[pre] Loading sources from file...");
    const raw = loadSampleSources(SOURCE_FILE);
    explicitSources = raw;
    console.log(`  → ${raw.length} sources loaded from ${SOURCE_FILE}`);
  }

  // Run the pipeline
  const result = await runPipeline({
    sources:          explicitSources,
    windowDays:       DAYS,
    windowStart:      DATE_START,
    windowEnd:        DATE_END,
    sourceLimit:      LIMIT,
    skipLlm:          NO_LLM,
    persistUnderstand: !NO_PERSIST,
    persistDeck:      !NO_PERSIST,
    detailedNotes:    DETAILED_NOTES,
    exportFormat:     FORMAT,
    outputPath:       FORMAT === "pptx" || FORMAT === "all" ? PPTX_OUT : null,
    snapshotId:       ingestSnapshotId,
    onProgress:       (step, msg) => console.log(`  [${step}] ${msg}`),
  });

  const { synthesisResult, deckResult, qaResult, stored, understand_counts } = result;

  // Save debug artifacts
  saveJson("outputs/debug/synthesis.json", synthesisResult);
  saveJson("outputs/debug/deck.json",      deckResult);
  saveJson("outputs/debug/qa_report.json", qaResult);

  // Save final outputs from the export
  if (deckResult.exports?.markdown) {
    saveText("outputs/final/horizon_scan_deck.md",  deckResult.exports.markdown);
  }
  if (deckResult.exports?.speaker_script) {
    saveText("outputs/final/speaker_script.md",     deckResult.exports.speaker_script);
  }
  if (deckResult.exports?.json) {
    saveJson("outputs/final/slide_deck_output.json", deckResult.exports.json);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const qa      = qaResult.summary;

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║                    PIPELINE SUMMARY                  ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  Sources loaded:        ${String(result.source_count).padEnd(28)}║`);
  console.log(`║  Already enriched:      ${String(understand_counts.already_done).padEnd(28)}║`);
  console.log(`║  Newly enriched (LLM):  ${String(understand_counts.llm_processed).padEnd(28)}║`);
  console.log(`║  Must-read sources:     ${String(synthesisResult.counts.high_priority).padEnd(28)}║`);
  console.log(`║  Evidence cards:        ${String(synthesisResult.counts.evidence_cards).padEnd(28)}║`);
  console.log(`║  Category analyses:     ${String(synthesisResult.category_analyses?.length ?? 0).padEnd(28)}║`);
  console.log(`║  Slides generated:      ${String(deckResult.slides.length).padEnd(28)}║`);
  console.log(`║  Evidence callouts:     ${String(deckResult.counts.evidence_callouts_used ?? 0).padEnd(28)}║`);
  console.log(`║  QA overall:            ${String(qaResult.overall_pass ? "PASS" : `FAIL (${qa.errors} errors)`).padEnd(28)}║`);
  console.log(`║  QA warnings:           ${String(qa.warnings).padEnd(28)}║`);
  console.log(`║  Citation coverage:     ${String((qaResult.citation_qa?.coverage_pct ?? "—") + "%").padEnd(28)}║`);
  console.log(`║  Deck ID:               ${String(stored?.deck_id || "(not saved)").padEnd(28)}║`);
  console.log(`║  Elapsed:               ${String(elapsed + "s").padEnd(28)}║`);
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  OUTPUTS:                                            ║");
  console.log("║  outputs/final/horizon_scan_deck.md                 ║");
  console.log("║  outputs/final/speaker_script.md                    ║");
  console.log("║  outputs/final/slide_deck_output.json               ║");
  if (FORMAT === "pptx" || FORMAT === "all") {
    console.log("║  outputs/final/horizon_scan_deck.pptx               ║");
  }
  console.log("╚══════════════════════════════════════════════════════╝");

  if (qa.errors > 0) {
    console.log("\n  QA ERRORS (must fix before distribution):");
    for (const issue of qaResult.summary.all_issues.filter((i) => i.severity === "error")) {
      console.error(`    ✗ [${issue.module}/${issue.check}] ${issue.message}`);
    }
  }

  if (qa.warnings > 0) {
    console.log(`\n  QA WARNINGS (${qa.warnings} — review before distribution):`);
    for (const issue of qaResult.summary.all_issues.filter((i) => i.severity === "warning").slice(0, 10)) {
      console.log(`    ⚠ [${issue.module}/${issue.check}] ${issue.message}`);
    }
    if (qa.warnings > 10) {
      console.log(`    ... and ${qa.warnings - 10} more warnings`);
    }
  }

  // ── Token usage ──────────────────────────────────────────────────────────────
  // Covers every routed LLM call (L4 understand, L5A/L5B extraction, L6 analysis,
  // L7 slides, L8 scripts, QA). Note: the L5A evidence web-search calls go direct
  // to the Anthropic web_search tool and are reported separately by that layer.
  try {
    const tu = getTokenUsageSummary();
    const totalIn  = Object.values(tu.by_task || {}).reduce((n, t) => n + (t.input  || 0), 0);
    const totalOut = Object.values(tu.by_task || {}).reduce((n, t) => n + (t.output || 0), 0);

    console.log("\n╔══════════════════════════════════════════════════════╗");
    console.log("║                    TOKEN USAGE                       ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log("  By task:");
    for (const [task, s] of Object.entries(tu.by_task || {}).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output))) {
      console.log(`    ${task.padEnd(26)} calls=${String(s.calls || 0).padStart(4)}  in=${String(s.input || 0).padStart(8)}  out=${String(s.output || 0).padStart(7)}`);
    }
    console.log("  By provider:");
    for (const [prov, s] of Object.entries(tu.by_provider || {}).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output))) {
      console.log(`    ${prov.padEnd(26)} calls=${String(s.calls || 0).padStart(4)}  in=${String(s.input || 0).padStart(8)}  out=${String(s.output || 0).padStart(7)}`);
    }
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(`  TOTAL (routed): in=${totalIn}  out=${totalOut}  combined=${totalIn + totalOut}`);
    console.log(`  Cache: ${tu.cache?.hits ?? 0} hits / ${tu.cache?.misses ?? 0} misses (${tu.cache?.hit_rate ?? "0%"})`);
    console.log("╚══════════════════════════════════════════════════════╝");
  } catch (err) {
    console.log("  (token usage summary unavailable:", err.message, ")");
  }

  console.log("");
}

main().catch((err) => {
  console.error("\n[FATAL] Pipeline failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
