#!/usr/bin/env node
/**
 * Horizon Scan MVP — end-to-end pipeline runner (Layers 1–8 + persist)
 *
 * Usage:
 *   node scripts/runHorizonScanMVP.js [options]
 *
 * Options:
 *   --no-llm              Force deterministic fallback for all LLM steps
 *   --source-file <path>  Load sources from a JSON file instead of Supabase DB
 *   --days <n>            Source window in days when loading from DB (default: 90)
 *   --start <date>        Source window start date ("YYYY-MM-DD")
 *   --end   <date>        Source window end date   ("YYYY-MM-DD")
 *   --limit <n>           Max sources to load from DB (default: 1000)
 *   --no-persist          Skip saving deck to Supabase / Vercel Blob
 *   --format <fmt>        Export format: markdown | json | pptx | all (default: all)
 *   --pptx-out <path>     Output path for PPTX (required when --format includes pptx)
 *   --detailed-notes      Run second-pass speaker notes (extra LLM cost)
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const llmMode   = NO_LLM
    ? "mock (--no-llm)"
    : (process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY ? "live LLM" : "mock (no keys)");

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║     AI Cyber Threat Horizon Scan — MVP Pipeline      ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");
  console.log(`  Runner:   ${RUNNER_VERSION}`);
  console.log(`  LLM mode: ${llmMode}`);
  console.log(`  Persist:  ${NO_PERSIST ? "disabled (--no-persist)" : "Supabase + Vercel Blob"}`);
  if (SOURCE_FILE) console.log(`  Sources:  file (${SOURCE_FILE})`);
  else             console.log(`  Sources:  DB (window: ${DATE_START || `${DAYS}d`} → ${DATE_END || "today"}, limit: ${LIMIT})`);
  console.log(`  Export:   ${FORMAT}`);
  console.log("");

  // Load explicit sources from file (if provided)
  let explicitSources = null;
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
