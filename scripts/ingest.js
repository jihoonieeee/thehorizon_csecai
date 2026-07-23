#!/usr/bin/env node
/**
 * ingest.js — L1–L3: collect sources from connectors and save to DB.
 *
 * Runs all configured connectors (arXiv, RSS feeds, CISA KEV, GHSA, NVD)
 * over a rolling date window, normalises and validates each source, and
 * persists the snapshot to Supabase. Duplicate URLs are silently upserted.
 *
 * Usage:
 *   node scripts/ingest.js [--days N]
 *
 * Options:
 *   --days N   Lookback window in days (default 3; max 30).
 */

import "dotenv/config";
import { createClient }     from "@supabase/supabase-js";
import { collectRawSources } from "../lib/pipeline/ingest/collectRawSources.js";
import { saveSnapshotToDatabase } from "../lib/storage/snapshotDatabase.js";
import {
  startIngestionRun,
  finishIngestionRun,
  failIngestionRun,
} from "../lib/storage/ingestionRunStore.js";
import { flushCostBuffer } from "../lib/llm/usagePersistence.js";

const args   = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DAYS   = Math.min(parseInt(getArg("--days", "3"), 10), 30);

createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY); // validate env early

const period = DAYS <= 1 ? "daily" : DAYS <= 7 ? "weekly" : "monthly";
const now    = new Date();
const end    = new Date(now); end.setUTCHours(23, 59, 59, 999);
const start  = new Date(end.getTime() - DAYS * 24 * 60 * 60 * 1000);
const window = {
  timezone:  "Asia/Singapore",
  start_utc: start.toISOString(),
  end_utc:   end.toISOString(),
  start_sgt: new Date(start.getTime() + 8 * 60 * 60 * 1000).toISOString(),
  end_sgt:   new Date(end.getTime()   + 8 * 60 * 60 * 1000).toISOString(),
};

console.log(`\n${"═".repeat(60)}`);
console.log(`  L1–L3 Ingest — ${new Date().toISOString().slice(0, 16)} UTC`);
console.log(`  Window: ${window.start_sgt.slice(0, 16)} → ${window.end_sgt.slice(0, 16)} SGT  (${DAYS}d / ${period})`);
console.log(`${"═".repeat(60)}\n`);

let runId;
try {
  runId = await startIngestionRun();
  const result = await collectRawSources(window, { enrichArxivFullText: true });

  const snapshot = {
    generated_at:                new Date().toISOString(),
    period,
    stage:                       `ingest_${DAYS}d`,
    reporting_window:            result.reporting_window,
    count:                       result.sources.length,
    rejected_count:              result.rejected_count,
    rejected_sources:            result.rejected_sources,
    discarded_count:             result.discarded_count,
    discarded_by_validity:       result.discarded_by_validity,
    discarded_by_relevance_count: result.discarded_by_relevance_count,
    discarded_by_relevance:      result.discarded_by_relevance,
    validation_stats:            result.validation_stats,
    pipeline_counts:             result.pipeline_counts,
    sources:                     result.sources,
    archive:                     result.archive,
    connector_results:           result.connector_results,
  };

  await saveSnapshotToDatabase(snapshot);
  await finishIngestionRun(runId, snapshot);

  const connectorSummary = (result.connector_results || [])
    .map(r => `${r.name}:${r.count ?? 0}`).join("  ");
  console.log(`\n  Collected ${result.sources.length} sources — ${connectorSummary}`);
  if (result.degraded) {
    console.warn(`  ⚠ Degraded run: ${result.degraded_reasons.join("; ")}`);
  }
  console.log("  Done.\n");
} catch (err) {
  if (runId) await failIngestionRun(runId, err).catch(() => {});
  console.error(err);
  process.exit(1);
}

await flushCostBuffer().catch(() => {});
