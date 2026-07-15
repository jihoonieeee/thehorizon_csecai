/**
 * fixArxivDates.js
 *
 * Fetches exact submission dates from the arXiv Atom API for all arXiv sources
 * in the DB that currently have non-exact date confidence (estimated/inferred/low/none).
 *
 * The arXiv API returns the precise submission day, which is deterministically
 * authoritative — unlike the YYMM.NNNNN ID, which only encodes year+month.
 *
 * Usage:
 *   node scripts/fixArxivDates.js [--dry-run]
 */

import { supabase } from "../lib/storage/supabaseClient.js";
import { arxivIdFromUrl } from "../lib/pipeline/ingest/normalizeSource.js";
import { enrichArxivDate } from "../lib/pipeline/ingest/connectors/arxivConnector.js";

const DRY_RUN = process.argv.includes("--dry-run");
const RATE_LIMIT_MS = 3000; // arXiv asks for ≥3s between requests

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`fixArxivDates — ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);

  // Fetch all arXiv sources without an exact date confidence
  const { data, error } = await supabase
    .from("sources")
    .select("id, url, date_published, date_confidence, publisher")
    .or("url.ilike.%arxiv.org%,publisher.ilike.%arxiv%")
    .not("date_confidence", "eq", "exact");

  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  console.log(`Found ${data.length} arXiv sources with non-exact date confidence.\n`);

  let fixed = 0;
  let failed = 0;
  let skipped = 0;

  for (const source of data) {
    const arxivId = arxivIdFromUrl(source.url);
    if (!arxivId) {
      console.log(`  SKIP  ${source.url?.slice(0, 70)} — no arXiv ID in URL`);
      skipped++;
      continue;
    }

    process.stdout.write(`  Fetching ${arxivId} (current: ${source.date_confidence}, ${source.date_published?.slice(0, 10) ?? "no date"}) ... `);

    const result = await enrichArxivDate(arxivId);

    if (!result) {
      console.log("FAILED (API error or not found)");
      failed++;
      await sleep(RATE_LIMIT_MS);
      continue;
    }

    console.log(`→ ${result.date_published}`);

    if (!DRY_RUN) {
      const { error: updateError } = await supabase
        .from("sources")
        .update({
          date_published:  result.date_published + "T00:00:00+00:00",
          date_confidence: "exact",
          needs_review:    false,
        })
        .eq("id", source.id);

      if (updateError) {
        console.error(`    UPDATE FAILED: ${updateError.message}`);
        failed++;
      } else {
        fixed++;
      }
    } else {
      fixed++;
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\nDone.`);
  console.log(`  Fixed:   ${fixed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);

  if (DRY_RUN) console.log("\n(Dry run — no DB changes made. Re-run without --dry-run to apply.)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
