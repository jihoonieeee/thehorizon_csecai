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
import { allMissions } from "../lib/config/discoveryMissions.js";
import { flushCostBuffer } from "../lib/llm/usagePersistence.js";

const args = process.argv.slice(2);
const di = args.indexOf("--days");
const DAYS = di >= 0 && args[di + 1] ? Math.min(parseInt(args[di + 1], 10) || 7, 30) : 7;
const qi = args.indexOf("--queries-per-mission");
const QUERIES_PER_MISSION = qi >= 0 && args[qi + 1] ? Math.max(1, parseInt(args[qi + 1], 10) || 3) : 3;
const gi = args.indexOf("--mission-batch");
const MISSION_BATCH = gi >= 0 && args[gi + 1] ? Math.max(1, parseInt(args[gi + 1], 10) || 4) : 4;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

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
  const missionGroups = chunk(allMissions(), MISSION_BATCH);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Operational ingestion — sitemaps + web discovery (incremental)`);
  console.log(`  Window: ${window.start_utc.slice(0, 10)} → ${window.end_utc.slice(0, 10)} (${DAYS}d)`);
  console.log(`  Web discovery: ${process.env.WEB_DISCOVERY_ENABLED === "1" ? "ON" : "OFF (set WEB_DISCOVERY_ENABLED=1)"}`);
  console.log(`  Batches: 1 sitemap + ${missionGroups.length} discovery (${MISSION_BATCH} missions each, ${QUERIES_PER_MISSION} queries/mission)`);
  console.log(`${"═".repeat(60)}\n`);

  // Each batch is small enough to finish well inside the CI budget. After every
  // batch we persist the CUMULATIVE snapshot — so a timeout mid-run still leaves
  // all completed batches' sources in the DB (the old all-or-nothing persist lost
  // everything on timeout). Sources upsert by id, so cumulative re-persist is cheap
  // and idempotent.
  const batches = [
    { label: "sitemaps", opts: { extraConnectors: [sitemapConnector], webDiscovery: false } },
    ...missionGroups.map((g, i) => ({
      label: `discovery ${i + 1}/${missionGroups.length}`,
      opts: { webDiscovery: true, discoveryMissions: g, discoveryMaxQueriesPerMission: QUERIES_PER_MISSION },
    })),
  ];

  const bySourceId = new Map();   // cumulative dedup across batches
  let lastWindow = window, lastStats = null;
  let totalAccepted = 0, totalAudit = 0;
  const connectorResults = [];
  let storedId = null;

  for (const batch of batches) {
    const t0 = Date.now();
    try {
      const result = await collectRawSources(window, {
        includeFeeds: false,        // registry RSS handled by the Vercel daily
        connectors: [],             // skip NVD/arXiv/etc. — Vercel daily handles them
        ...batch.opts,
      });

      for (const s of result.sources) bySourceId.set(s.id, s);
      lastWindow = result.reporting_window || lastWindow;
      lastStats  = result.validation_stats || lastStats;
      totalAccepted += result.web_discovery_accepted_count ?? 0;
      totalAudit    += result.web_discovery_audit_count ?? 0;
      connectorResults.push(...(result.connector_results || []));

      // Persist cumulative snapshot after this batch (timeout-safe checkpoint).
      const snapshot = {
        generated_at: new Date().toISOString(),
        period: "operational",
        stage: "operational_discovery",
        reporting_window: lastWindow,
        count: bySourceId.size,
        validation_stats: lastStats,
        pipeline_counts: result.pipeline_counts,
        sources: [...bySourceId.values()],
        connector_results: connectorResults,
      };
      const stored = await saveSnapshotToDatabase(snapshot, { snapshotIdSuffix: "operational" });
      storedId = stored.snapshot_id;

      const dt = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  ✓ [${batch.label}] +${result.sources.length} sources → ${bySourceId.size} total persisted (${dt}s)`);
    } catch (err) {
      // A failed batch must not lose prior batches — they're already persisted.
      console.warn(`  ✗ [${batch.label}] failed: ${err.message.slice(0, 80)} — continuing`);
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log(`  Persisted: ${bySourceId.size} operational sources → ${storedId || "(none)"}`);
  console.log(`  Web discovery accepted: ${totalAccepted} | audit: ${totalAudit}`);
}

main()
  .then(() => flushCostBuffer())
  .catch((err) => { console.error(err); process.exit(1); });
