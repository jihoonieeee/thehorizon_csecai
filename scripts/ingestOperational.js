#!/usr/bin/env node
/**
 * ingestOperational.js — heavier operational-source ingestion that can't run
 * inside Vercel's 60s serverless budget, so it runs in CI (GitHub Actions).
 *
 * Complements the fast Vercel daily ingest (/api/refresh) by adding the two
 * recall-oriented branches that recover operational / incident / threat-intel
 * sources the static RSS feeds miss:
 *
 *   1. Layer 1B web discovery (Tavily/SerpAPI) — finds open-web operational
 *      reporting, incl. bot-blocked vendors (Mandiant, NCC, WithSecure, …) that
 *      have no working RSS/sitemap. Enabled via WEB_DISCOVERY_ENABLED=1.
 *   2. Operational blog sitemap crawl (DFIR Report, Red Canary, Huntress,
 *      Volexity) — incident reports with no date-range API.
 *
 * Registry RSS feeds and the date-range APIs (NVD/arXiv/…) are NOT re-run here —
 * the Vercel daily already covers them. Re-discovered URLs upsert by id (no dupes).
 *
 * Sources persist to the `sources` table under a separate same-day snapshot
 * (snapshot-YYYY-MM-DD-operational) and are picked up by the understand job.
 *
 * Usage:
 *   node scripts/ingestOperational.js [--days N]   (default 7)
 */

import "dotenv/config";
import { collectRawSources } from "../lib/pipeline/ingest/collectRawSources.js";
import { saveSnapshotToDatabase } from "../lib/storage/snapshotDatabase.js";
import { sitemapConnector } from "../lib/pipeline/ingest/connectors/sitemapConnector.js";
import { flushCostBuffer } from "../lib/llm/usagePersistence.js";

const args = process.argv.slice(2);
const di = args.indexOf("--days");
const DAYS = di >= 0 && args[di + 1] ? Math.min(parseInt(args[di + 1], 10) || 7, 30) : 7;

function buildWindow(days) {
  const end = new Date();
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    timezone: "Asia/Singapore",
    start_utc: start.toISOString(),
    end_utc: end.toISOString(),
    start_sgt: new Date(start.getTime() + 8 * 3600 * 1000).toISOString(),
    end_sgt: new Date(end.getTime() + 8 * 3600 * 1000).toISOString(),
  };
}

async function main() {
  const window = buildWindow(DAYS);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Operational ingestion — sitemaps + web discovery`);
  console.log(`  Window: ${window.start_utc.slice(0, 10)} → ${window.end_utc.slice(0, 10)} (${DAYS}d)`);
  console.log(`  Web discovery: ${process.env.WEB_DISCOVERY_ENABLED === "1" ? "ON" : "OFF (set WEB_DISCOVERY_ENABLED=1)"}`);
  console.log(`${"═".repeat(60)}\n`);

  const result = await collectRawSources(window, {
    includeFeeds: false,          // registry RSS handled by the Vercel daily
    connectors: [],               // skip NVD/arXiv/etc. — Vercel daily handles them
    extraConnectors: [sitemapConnector],
    webDiscovery: true,           // force on regardless of env (this is the discovery job)
  });

  const snapshot = {
    generated_at: new Date().toISOString(),
    period: "operational",
    stage: "operational_discovery",
    reporting_window: result.reporting_window,
    count: result.sources.length,
    removed_by_publish_date_count: result.removed_by_publish_date_count,
    rejected_count: result.rejected_count,
    discarded_count: result.discarded_count,
    discarded_by_relevance_count: result.discarded_by_relevance_count,
    validation_stats: result.validation_stats,
    pipeline_counts: result.pipeline_counts,
    sources: result.sources,
    archive: result.archive,
    connector_results: result.connector_results,
  };

  const stored = await saveSnapshotToDatabase(snapshot, { snapshotIdSuffix: "operational" });

  console.log("\n" + "─".repeat(60));
  console.log(`  Persisted: ${snapshot.count} operational sources → ${stored.snapshot_id}`);
  console.log(`  Web discovery accepted: ${result.web_discovery_accepted_count ?? 0} | audit: ${result.web_discovery_audit_count ?? 0}`);
  console.log(`  Sitemap+discovery pipeline:`, JSON.stringify(result.pipeline_counts));
  if (result.degraded) console.log(`  ⚠ degraded: ${result.degraded_reasons.join("; ")}`);
  for (const c of result.connector_results || []) {
    console.log(`    ${c.status} ${String(c.count).padStart(3)} ${c.connector}${c.error ? " — " + c.error : ""}`);
  }
}

main()
  .then(() => flushCostBuffer())
  .catch((err) => { console.error(err); process.exit(1); });
