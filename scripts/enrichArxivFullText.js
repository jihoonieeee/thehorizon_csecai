#!/usr/bin/env node
/**
 * enrichArxivFullText.js — Backfill full HTML paper text for arXiv research sources.
 *
 * Most arXiv sources in the DB only carry abstract text (~1 500 chars) because the
 * full-text HTML fetch was happening inside the connector's timeout budget and being
 * aborted before it could complete. This script finds all arXiv research sources
 * with short full_text and fetches the HTML paper body for them.
 *
 * Safe to re-run: sources already carrying >3 000 chars of full_text are skipped.
 *
 * Usage:
 *   node scripts/enrichArxivFullText.js [--limit N] [--dry-run] [--gap-ms N]
 *
 *   --limit N     Max sources to process (default: 500)
 *   --dry-run     Fetch and measure text but do not write to DB
 *   --gap-ms N    Milliseconds between requests (default: 2500; arXiv asks for ≥3s total)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { arxivIdFrom, fetchFullPaperText } from "../lib/pipeline/ingest/connectors/arxivConnector.js";

const args   = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIMIT   = parseInt(getArg("--limit", "500"), 10);
const DRY_RUN = args.includes("--dry-run");
const GAP_MS  = parseInt(getArg("--gap-ms", "2500"), 10);

const MIN_FULL_TEXT = 3000;  // sources below this threshold get enriched

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\narXiv full-text enrichment backfill`);
  console.log(`  Limit:   ${LIMIT} sources`);
  console.log(`  Gap:     ${GAP_MS}ms between requests`);
  console.log(`  Dry run: ${DRY_RUN}`);
  console.log();

  // Load arXiv research sources with short full_text, newest first.
  const { data, error } = await supabase
    .from("sources")
    .select("id, title, url, full_text")
    .or("publisher.ilike.%arxiv%,url.ilike.%arxiv.org%")
    .in("source_type", ["research_finding", "benchmark_evaluation", "capability_demonstration"])
    .eq("validation_status", "pass")
    .order("date_published", { ascending: false })
    .limit(LIMIT * 3);  // over-fetch; we'll filter by full_text length in JS

  if (error) { console.error("DB load failed:", error.message); process.exit(1); }

  const candidates = (data || []).filter(
    (s) => (s.full_text?.length || 0) < MIN_FULL_TEXT
  ).slice(0, LIMIT);

  console.log(`Found ${candidates.length} sources needing enrichment (of ${data?.length} loaded)\n`);
  if (!candidates.length) { console.log("Nothing to do."); return; }

  let enriched = 0, skipped = 0, failed = 0;
  const startMs = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const source = candidates[i];
    const arxivId = arxivIdFrom(source.url);

    if (!arxivId) {
      console.log(`  [${i + 1}/${candidates.length}] SKIP  no arXiv ID  — ${source.url}`);
      skipped++;
      continue;
    }

    let fullText = null;
    try {
      fullText = await fetchFullPaperText(arxivId);
    } catch (err) {
      console.log(`  [${i + 1}/${candidates.length}] ERROR ${arxivId} — ${err.message}`);
      failed++;
      await sleep(GAP_MS);
      continue;
    }

    if (!fullText) {
      console.log(`  [${i + 1}/${candidates.length}] PDF   ${arxivId} — no HTML version`);
      skipped++;
      await sleep(GAP_MS);
      continue;
    }

    const prevLen = source.full_text?.length || 0;
    console.log(`  [${i + 1}/${candidates.length}] OK    ${arxivId} — ${prevLen} → ${fullText.length} chars | ${source.title?.slice(0, 60)}`);

    if (!DRY_RUN) {
      const { error: updateErr } = await supabase
        .from("sources")
        .update({ full_text: fullText, clean_text: fullText })
        .eq("id", source.id);

      if (updateErr) {
        console.warn(`    DB update failed: ${updateErr.message}`);
        failed++;
      } else {
        enriched++;
      }
    } else {
      enriched++;
    }

    await sleep(GAP_MS);
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
  console.log(`\n── Summary ──────────────────────────────────────────────────`);
  console.log(`  Enriched: ${enriched}`);
  console.log(`  PDF-only: ${skipped}`);
  console.log(`  Errors:   ${failed}`);
  console.log(`  Elapsed:  ${elapsed}s`);
  if (DRY_RUN) console.log(`  (dry run — no DB writes)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
