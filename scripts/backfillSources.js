/**
 * Historical source backfill script.
 *
 * Runs the ingest pipeline (API connectors only) week by week for a given date
 * range. RSS feeds are excluded — they have no historical depth.
 * Run /api/refresh to pull what is currently in feeds.
 *
 * API connectors with historical date-range support:
 *   arxiv   — arXiv papers (operationally filtered queries)
 *   nvd     — NVD CVEs matching AI/ML keyword list
 *   ghsa    — GitHub Advisory Database: AI/ML package CVEs (LangChain, transformers, gradio…)
 *   cisa_kev — CISA Known Exploited Vulnerabilities (AI-relevant subset)
 *
 * Usage:
 *   node scripts/backfillSources.js [start] [end] [connectors]
 *   node scripts/backfillSources.js 2025-07-01 2026-06-24
 *   node scripts/backfillSources.js 2025-07-01 2026-06-24 arxiv
 *   node scripts/backfillSources.js 2025-07-01 2026-06-24 nvd,ghsa,cisa_kev
 *   node scripts/backfillSources.js --feeds-only   # single RSS pull, no date range needed
 *
 * Connectors: arxiv | nvd | ghsa | cisa_kev | all (default: all)
 * Defaults to Jan 1 of current year → today.
 *
 * --feeds-only: runs a single collectRawSources with all 40 RSS feeds enabled.
 *   RSS feeds return their current items only (no historical depth), so the
 *   date range args are ignored. Use this to add diverse real-world sources.
 */

import "dotenv/config";
import { collectRawSources } from "../lib/pipeline/ingest/collectRawSources.js";
import { saveSnapshotToDatabase } from "../lib/storage/snapshotDatabase.js";

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

function makeWeekWindow(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  return {
    timezone: "Asia/Singapore",
    start_utc: start.toISOString(),
    end_utc: end.toISOString(),
    start_sgt: new Date(start.getTime() + SGT_OFFSET_MS).toISOString(),
    end_sgt: new Date(end.getTime() + SGT_OFFSET_MS).toISOString(),
  };
}

function weekChunks(startArg, endArg) {
  const chunks = [];
  let current = new Date(startArg);
  const final = new Date(endArg);

  while (current < final) {
    const chunkEnd = new Date(Math.min(
      current.getTime() + 7 * 24 * 60 * 60 * 1000,
      final.getTime()
    ));
    chunks.push({
      start: current.toISOString(),
      end: chunkEnd.toISOString(),
      label: `${current.toISOString().slice(0, 10)} → ${chunkEnd.toISOString().slice(0, 10)}`,
    });
    current = chunkEnd;
  }
  return chunks;
}

function pad(n, width = 3) {
  return String(n).padStart(width, " ");
}

// ─────────────────────────────────────────────────────────────────────────────

const FEEDS_ONLY = process.argv.includes("--feeds-only");
const startArg      = process.argv[2] || `${new Date().getFullYear()}-01-01`;
const endArg        = process.argv[3] || new Date().toISOString().slice(0, 10);
const connectorArg  = (process.argv[4] || "all").toLowerCase();
const connectorFilter = connectorArg === "all" ? null : connectorArg.split(",");

// ── Feeds-only mode: single RSS pull, no date-range loop ─────────────────────
if (FEEDS_ONLY) {
  const sep = "═".repeat(60);
  console.log(`\n${sep}`);
  console.log(` Horizon Feed Pull — all 40 RSS feeds (current items only)`);
  console.log(`${sep}\n`);

  try {
    // Use a 30-day window so recent feed items pass the publish-date filter
    const now = new Date();
    const window = makeWeekWindow(
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      now.toISOString(),
    );
    const result = await collectRawSources(window, { includeFeeds: true, connectors: [] });
    const snapshot = {
      generated_at: now.toISOString(),
      period: "feed_pull",
      stage: "feed_only_pull",
      reporting_window: result.reporting_window,
      count: result.sources.length,
      removed_by_publish_date_count: result.removed_by_publish_date_count,
      rejected_count: result.rejected_count,
      discarded_count: result.discarded_count,
      pipeline_counts: result.pipeline_counts,
      sources: result.sources,
      archive: result.archive,
      connector_results: result.connector_results,
    };
    await saveSnapshotToDatabase(snapshot);
    const raw = result.pipeline_counts?.raw || 0;
    console.log(`\n${"-".repeat(60)}`);
    console.log(` Feed pull complete.`);
    console.log(`   Raw sources seen : ${raw}`);
    console.log(`   Sources saved    : ${result.sources.length}`);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

// Normalise start to 06:00 SGT (= 22:00 UTC previous day) for consistency
const startUtc = new Date(`${startArg}T06:00:00+08:00`).toISOString();
const endUtc   = new Date(`${endArg}T23:59:59+08:00`).toISOString();

const chunks = weekChunks(startUtc, endUtc);

const connectorLabel = connectorFilter ? connectorFilter.join("+") : "nvd+arxiv+ghsa+cisa_kev";

console.log(`\n${"═".repeat(60)}`);
console.log(` Horizon Backfill: ${startArg} → ${endArg}`);
console.log(` ${chunks.length} weekly chunks · connectors: ${connectorLabel}`);
console.log(`${"═".repeat(60)}\n`);

let grandTotal = 0;
let grandRaw   = 0;
let errors     = 0;

for (let i = 0; i < chunks.length; i++) {
  const chunk = chunks[i];
  const progress = `[${pad(i + 1)}/${chunks.length}]`;
  process.stdout.write(`${progress} ${chunk.label} … `);

  try {
    const window = makeWeekWindow(chunk.start, chunk.end);

    const result = await collectRawSources(window, {
      includeFeeds: false,                // RSS has no historical depth — skip
      connectors: connectorFilter,        // null = all API connectors
    });

    const snapshot = {
      generated_at: new Date().toISOString(),
      period: "weekly",
      stage: "historical_backfill_api_only",
      reporting_window: result.reporting_window,
      count: result.sources.length,
      removed_by_publish_date_count: result.removed_by_publish_date_count,
      rejected_count: result.rejected_count,
      discarded_count: result.discarded_count,
      pipeline_counts: result.pipeline_counts,
      sources: result.sources,
      archive: result.archive,
      connector_results: result.connector_results,
    };

    await saveSnapshotToDatabase(snapshot);

    const raw = result.pipeline_counts?.raw || 0;
    grandRaw   += raw;
    grandTotal += result.sources.length;

    console.log(`raw=${pad(raw)} → saved=${pad(result.sources.length)}`);

    // Pause between chunks to respect API rate limits (arXiv in particular)
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 20000));
    }
  } catch (err) {
    errors++;
    console.log(`ERROR: ${err.message}`);
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(` Backfill complete.`);
console.log(`   Chunks processed : ${chunks.length - errors} / ${chunks.length}`);
console.log(`   Raw sources seen  : ${grandRaw}`);
console.log(`   Sources saved     : ${grandTotal}`);
if (errors > 0) console.log(`   Errors            : ${errors}`);
console.log(`\n Next steps:`);
console.log(`   1. POST /api/classify-sources?limit=1000  (run 2–3 times for full coverage)`);
console.log(`   2. POST /api/score-sources?limit=1000`);
console.log(`   3. POST /api/generate-report?period=monthly`);
console.log(`${"═".repeat(60)}\n`);
