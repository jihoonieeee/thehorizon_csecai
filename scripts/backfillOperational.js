#!/usr/bin/env node
/**
 * Operational source backfill — 2025 Q3 and beyond.
 *
 * Fetches historical operational sources (incidents, threat intelligence) and
 * runs them through the FULL ingest pipeline — the same path as api/refresh.js:
 *
 *   Connector fetch
 *   → cleanSources          (Layer 2: text cleaning, code-block extraction)
 *   → filterByPublishDate   (date-window gate)
 *   → dedupeSources         (URL + content-hash dedup)
 *   → detectNearDuplicates  (near-duplicate clustering)
 *   → filterAcceptableSources (basic quality gates)
 *   → attachValidityToSources (structural validity scoring)
 *   → validateAndTypeSources  (Layer 3: AI-threat relevance LLM gate)
 *   → attachInitialTags     (initial taxonomy tags)
 *   → computeEligibilityFlags (report-period eligibility)
 *   → archiveSources        (local archive)
 *   → saveSnapshotToDatabase  (Supabase upsert to sources + snapshots tables)
 *
 * Connectors:
 *   aiid     — AI Incident Database (GraphQL API, strict quality gates)
 *   sitemap  — Key operational blogs via XML sitemap crawl:
 *              DFIR Report, Red Canary, Huntress, Volexity, WithSecure, Lumen
 *   kev      — CISA Known Exploited Vulnerabilities (AI-relevant subset)
 *   all      — all of the above (default)
 *
 * Usage:
 *   node scripts/backfillOperational.js [start] [end] [connectors]
 *   node scripts/backfillOperational.js 2025-07-01 2026-06-24
 *   node scripts/backfillOperational.js 2025-07-01 2026-06-24 aiid
 *   node scripts/backfillOperational.js 2025-07-01 2026-06-24 sitemap
 *
 * AIID caution:
 *   The AI Incident Database contains thousands of multilingual low-quality entries.
 *   The connector applies strict gates (English + cyber-threat signal + AI-tool signal
 *   + 150-char minimum). Layer 3 AI-relevance gate provides a second filter pass.
 *   Review saved counts per chunk before trusting volumes.
 *
 * Defaults: start=2025-07-01, end=today, connectors=all
 */

import "dotenv/config";
import { flushCostBuffer }      from "../lib/llm/usagePersistence.js";
import { collectRawSources }    from "../lib/pipeline/ingest/collectRawSources.js";
import { saveSnapshotToDatabase } from "../lib/storage/snapshotDatabase.js";
import { aiidConnector }        from "../lib/pipeline/ingest/connectors/aiidConnector.js";
import { sitemapConnector }     from "../lib/pipeline/ingest/connectors/sitemapConnector.js";
import { cisaKevConnector }     from "../lib/pipeline/ingest/connectors/cisaKevConnector.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── CLI args ──────────────────────────────────────────────────────────────────
//
// Connectors:
//   aiid    — AI Incident Database (GraphQL, strict quality gates)
//   sitemap — Operational security blogs (DFIR Report, Red Canary, Huntress, Volexity)
//   kev     — CISA Known Exploited Vulnerabilities (AI-relevant subset)
//   all     — all of the above (default)

const startArg     = process.argv[2] || "2025-07-01";
const endArg       = process.argv[3] || new Date().toISOString().slice(0, 10);
const connectorArg = (process.argv[4] || "all").toLowerCase();

const runAiid    = connectorArg === "all" || connectorArg.includes("aiid");
const runSitemap = connectorArg === "all" || connectorArg.includes("sitemap");
const runKev     = connectorArg === "all" || connectorArg.includes("kev");

// ── Monthly chunks ────────────────────────────────────────────────────────────
// One calendar month per chunk: keeps AIID + sitemap caps sensible, and
// gives each month its own snapshot_id for easy DB inspection.

function monthChunks(startStr, endStr) {
  const chunks = [];
  let cur = new Date(`${startStr}T00:00:00Z`);
  const fin = new Date(`${endStr}T23:59:59Z`);

  while (cur < fin) {
    const y = cur.getUTCFullYear(), m = cur.getUTCMonth();
    const chunkStart = new Date(Date.UTC(y, m, 1));
    const chunkEnd   = new Date(Math.min(
      new Date(Date.UTC(y, m + 1, 0, 23, 59, 59)).getTime(),
      fin.getTime()
    ));
    chunks.push({
      start_utc: chunkStart.toISOString(),
      end_utc:   chunkEnd.toISOString(),
      label:     chunkStart.toISOString().slice(0, 7),
    });
    cur = new Date(Date.UTC(y, m + 1, 1));
  }
  return chunks;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const chunks = monthChunks(startArg, endArg);

const activeConnectors = [
  ...(runAiid    ? [aiidConnector]    : []),
  ...(runSitemap ? [sitemapConnector] : []),
  ...(runKev     ? [cisaKevConnector] : []),
];

console.log(`\n${"═".repeat(64)}`);
console.log(` Operational Backfill: ${startArg} → ${endArg}`);
console.log(` ${chunks.length} monthly chunks`);
console.log(` Connectors: ${activeConnectors.map(c => c.name).join(" + ")}`);
if (runAiid) {
  console.log(` AIID gates: English + cyber-threat + AI-tool signal + 150-char min`);
  console.log(`             Layer 3 AI-relevance gate provides second filter pass`);
}
console.log(`${"═".repeat(64)}\n`);

let grandTotal = 0;
let errors = 0;

for (let i = 0; i < chunks.length; i++) {
  const chunk = chunks[i];
  const window = { start_utc: chunk.start_utc, end_utc: chunk.end_utc };

  console.log(`\n── [${i + 1}/${chunks.length}] ${chunk.label} ─────────────────────────────`);

  try {
    // Run the full ingest pipeline via collectRawSources.
    // connectors: [] disables the default API connectors (NVD, arXiv, LLM Discovery)
    // — those have their own backfill script (backfillSources.js). Only the
    // extraConnectors (AIID + sitemap) run here, but they still flow through the
    // full pipeline: clean → dedup → near-dedup → validity → Layer 3 LLM gate → save.
    const result = await collectRawSources(window, {
      includeFeeds:    false,  // RSS has no historical depth
      connectors:      [],     // skip NVD / arXiv / LLM Discovery (wrong tool for this job)
      extraConnectors: activeConnectors,
    });

    // Log pipeline funnel
    const pc = result.pipeline_counts;
    console.log(`  raw=${pc.raw}  cleaned=${pc.cleaned}  windowed=${pc.within_publish_date_window}  deduped=${pc.near_deduped}  valid=${pc.usable}  validated=${pc.validation_accepted}`);

    if (result.connector_results) {
      for (const cr of result.connector_results) {
        const status = cr.status === "rejected" ? `ERROR: ${cr.error}` : `${cr.count} sources`;
        console.log(`  [${cr.connector}] ${status}`);
      }
    }

    if (result.sources.length === 0) {
      console.log(`  → 0 sources passed — skipping snapshot save`);
    } else {
      await saveSnapshotToDatabase({
        generated_at:      new Date().toISOString(),
        period:            "monthly",
        stage:             "operational_backfill",
        reporting_window:  result.reporting_window,
        count:             result.sources.length,
        removed_by_publish_date_count: result.removed_by_publish_date_count,
        rejected_count:    result.rejected_count,
        discarded_count:   result.discarded_count,
        pipeline_counts:   result.pipeline_counts,
        sources:           result.sources,
        archive:           result.archive,
        connector_results: result.connector_results,
      });
      console.log(`  ✓ Saved ${result.sources.length} sources`);
      grandTotal += result.sources.length;
    }

    // Log Layer 3 validation breakdown
    if (result.validation_stats) {
      const vs = result.validation_stats;
      console.log(`  Layer 3: ${vs.pass_count ?? 0} pass, ${vs.review_count ?? 0} review, ${vs.reject_count ?? 0} reject`);
    }
    if ((result.discarded_by_relevance_count ?? 0) > 0) {
      console.log(`  Discarded by AI relevance: ${result.discarded_by_relevance_count}`);
    }

  } catch (err) {
    errors++;
    console.error(`  ERROR: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
  }

  // Pause between months — AIID and sitemaps both appreciate the breathing room
  if (i < chunks.length - 1) await sleep(8000);
}

console.log(`\n${"─".repeat(64)}`);
console.log(` Backfill complete.`);
console.log(`   Chunks : ${chunks.length - errors} / ${chunks.length} succeeded`);
console.log(`   Saved  : ${grandTotal} sources total`);
if (errors > 0) console.log(`   Errors : ${errors}`);
console.log(`\n Next: regenerate the analysis deck:`);
console.log(`   npm run horizon:v2 -- --start ${startArg}`);
console.log(`${"═".repeat(64)}\n`);
await flushCostBuffer();
