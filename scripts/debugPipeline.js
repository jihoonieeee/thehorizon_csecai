#!/usr/bin/env node
/**
 * scripts/debugPipeline.js — Pipeline debug CLI
 *
 * Sub-commands:
 *   --list                   List all run IDs found in debug/runs/
 *   --summary  <run-id>      Print the run summary Markdown to stdout
 *   --reports  <run-id>      Generate all layer Markdown reports into
 *                            debug/runs/<run-id>/reports/
 *
 * Usage:
 *   node scripts/debugPipeline.js --list
 *   node scripts/debugPipeline.js --summary pipeline-run-2026-06-15-10-00-00
 *   node scripts/debugPipeline.js --reports pipeline-run-2026-06-15-10-00-00
 *
 * Equivalent npm shortcuts (after package.json is updated):
 *   npm run debug:list
 *   npm run debug:summary  pipeline-run-2026-06-15-10-00-00
 *   npm run debug:reports  pipeline-run-2026-06-15-10-00-00
 */

import { join, resolve }              from "path";
import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { fileURLToPath }              from "url";
import { dirname }                    from "path";

import {
  reportL4,
  reportL6,
  reportL7,
  reportL8,
  reportRunSummary,
} from "../lib/pipeline/debug/markdownReporter.js";

const __filename   = fileURLToPath(import.meta.url);
const __dirname    = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");
const DEBUG_ROOT   = join(PROJECT_ROOT, "debug");
const RUNS_DIR     = join(DEBUG_ROOT, "runs");

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Load a checkpoint JSON for the given run and layer.
 * Returns null (with a warning) if the file does not exist.
 *
 * @param {string} runId
 * @param {string} layer  e.g. "L4_taxonomy"
 * @returns {Promise<object|null>}
 */
async function loadCheckpoint(runId, layer) {
  const path = join(RUNS_DIR, runId, "checkpoints", `${layer}.json`);
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.warn(`  [warn] Checkpoint not found: ${path}`);
      return null;
    }
    throw err;
  }
}

/**
 * Write a Markdown report file, creating parent directories as needed.
 *
 * @param {string} filePath
 * @param {string} content
 */
async function writeReport(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  console.log(`  Written → ${filePath}`);
}

// ── Sub-commands ───────────────────────────────────────────────────────────────

/**
 * --list: Print all run IDs found in debug/runs/, newest first.
 */
async function cmdList() {
  let entries;
  try {
    entries = await readdir(RUNS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No debug runs found (debug/runs/ does not exist yet).");
      return;
    }
    throw err;
  }

  const runIds = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse(); // newest timestamp first

  if (runIds.length === 0) {
    console.log("No debug runs found in debug/runs/.");
    return;
  }

  console.log(`Found ${runIds.length} debug run(s):\n`);
  for (const id of runIds) {
    // Try to read an L4 checkpoint to show a quick summary
    const ckPath = join(RUNS_DIR, id, "checkpoints", "L4_taxonomy.json");
    let extra = "";
    try {
      const raw = JSON.parse(await readFile(ckPath, "utf8"));
      extra = ` | ${raw.total_sources ?? "?"} sources`;
    } catch {
      // no checkpoint — show nothing extra
    }
    console.log(`  ${id}${extra}`);
  }
}

/**
 * --summary <run-id>: Print the run summary report to stdout.
 *
 * @param {string} runId
 */
async function cmdSummary(runId) {
  if (!runId) {
    console.error("Usage: node scripts/debugPipeline.js --summary <run-id>");
    process.exit(1);
  }

  console.log(`\nLoading checkpoints for run: ${runId}\n`);

  const l4   = await loadCheckpoint(runId, "L4_taxonomy");
  const l6   = await loadCheckpoint(runId, "L6_synthesis");
  const l7l8 = await loadCheckpoint(runId, "L7_L8_slides");
  const l9   = await loadCheckpoint(runId, "L9_qa");

  const summary = reportRunSummary({
    run_id:    runId,
    timestamp: l4?.timestamp ?? l6?.timestamp ?? new Date().toISOString(),
    l4:        l4  ?? {},
    l6:        l6  ?? {},
    l7l8:      l7l8 ?? {},
    l9:        l9  ?? {},
  });

  console.log(summary);
}

/**
 * --reports <run-id>: Write all layer Markdown reports to debug/runs/<run-id>/reports/.
 *
 * @param {string} runId
 */
async function cmdReports(runId) {
  if (!runId) {
    console.error("Usage: node scripts/debugPipeline.js --reports <run-id>");
    process.exit(1);
  }

  const reportsDir = join(RUNS_DIR, runId, "reports");
  console.log(`\nGenerating reports for run: ${runId}`);
  console.log(`Output directory: ${reportsDir}\n`);

  // ── L4 ──
  const l4 = await loadCheckpoint(runId, "L4_taxonomy");
  if (l4) {
    await writeReport(join(reportsDir, "l4_taxonomy.md"), reportL4(l4));
  }

  // ── L6 ──
  const l6 = await loadCheckpoint(runId, "L6_synthesis");
  if (l6) {
    await writeReport(join(reportsDir, "l6_synthesis.md"), reportL6(l6));
  }

  // ── L7 (slide planning) ──
  const l7l8 = await loadCheckpoint(runId, "L7_L8_slides");
  if (l7l8) {
    await writeReport(join(reportsDir, "l7_slide_plan.md"),    reportL7(l7l8));
    await writeReport(join(reportsDir, "l8_slide_content.md"), reportL8(l7l8));
  }

  // ── Run summary ──
  const summaryMd = reportRunSummary({
    run_id:    runId,
    timestamp: l4?.timestamp ?? l6?.timestamp ?? new Date().toISOString(),
    l4:        l4   ?? {},
    l6:        l6   ?? {},
    l7l8:      l7l8 ?? {},
    l9:        (await loadCheckpoint(runId, "L9_qa")) ?? {},
  });
  await writeReport(join(reportsDir, "run_summary.md"), summaryMd);

  console.log(`\nDone. Open ${reportsDir}/run_summary.md to start.`);
}

// ── Entry point ────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const command = args[0];
const arg1    = args[1];

switch (command) {
  case "--list":
    await cmdList();
    break;

  case "--summary":
    await cmdSummary(arg1);
    break;

  case "--reports":
    await cmdReports(arg1);
    break;

  default:
    console.log(`
Pipeline Debug CLI — The Horizon

Usage:
  node scripts/debugPipeline.js --list
  node scripts/debugPipeline.js --summary  <run-id>
  node scripts/debugPipeline.js --reports  <run-id>

Or with npm shortcuts:
  npm run debug:list
  npm run debug:summary  -- <run-id>
  npm run debug:reports  -- <run-id>

Enable debug mode by passing debugMode: true to runPipeline():
  const result = await runPipeline({ debugMode: true, ... });
  console.log("Run ID:", result.run_id);
`);
    process.exit(1);
}
