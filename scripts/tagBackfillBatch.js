#!/usr/bin/env node
/**
 * tagBackfillBatch.js — stamp intelligence.backfill_source on a batch of sources.
 *
 * Useful after running backfillSources.js (arXiv), which does not accept --flag-as.
 * Queries sources created after a given timestamp (or publisher filter) and merges
 * the backfill_source key into their intelligence JSONB.
 *
 * Usage:
 *   node scripts/tagBackfillBatch.js --tag TAG [--since-ts ISO] [--pub-since YYYY-MM-DD] [--publisher PUB] [--dry-run]
 *
 *   --since-ts    filter by created_at >= ISO (row insertion time)
 *   --pub-since   filter by date_published >= YYYY-MM-DD (article publish date) — use this
 *                 when sources were ingested much earlier than their publish date
 *
 * Examples:
 *   node scripts/tagBackfillBatch.js --pub-since 2025-01-01 --tag traditional_ai_2025 --publisher "protect ai"
 *   node scripts/tagBackfillBatch.js --since-ts 2026-07-15T10:00:00Z --tag traditional_ai_2025 --publisher arxiv
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const args      = process.argv.slice(2);
const getArg    = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const DRY_RUN   = args.includes("--dry-run");
const SINCE_TS  = getArg("--since-ts", null);
const PUB_SINCE = getArg("--pub-since", null);
const TAG       = getArg("--tag", null);
const PUBLISHER = getArg("--publisher", "").toLowerCase();

if ((!SINCE_TS && !PUB_SINCE) || !TAG) {
  console.error("Usage: node scripts/tagBackfillBatch.js --tag TAG [--since-ts ISO] [--pub-since YYYY-MM-DD] [--publisher PUB] [--dry-run]");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Tag Backfill Batch`);
  if (SINCE_TS)  console.log(`  Since (created_at):    ${SINCE_TS}`);
  if (PUB_SINCE) console.log(`  Since (date_published): ${PUB_SINCE}`);
  console.log(`  Tag:       ${TAG}`);
  if (PUBLISHER) console.log(`  Publisher: ${PUBLISHER}`);
  if (DRY_RUN)   console.log(`  [DRY RUN]`);
  console.log(`${"═".repeat(60)}\n`);

  // Build query — filter by created_at or date_published depending on which was supplied
  let query = supabase
    .from("sources")
    .select("id, publisher, intelligence, created_at, date_published");

  if (SINCE_TS)  query = query.gte("created_at",    SINCE_TS);
  if (PUB_SINCE) query = query.gte("date_published", PUB_SINCE);
  if (PUBLISHER) query = query.ilike("publisher", `%${PUBLISHER}%`);

  query = query.order("date_published", { ascending: true });

  const { data, error } = await query;
  if (error) throw new Error(`DB query failed: ${error.message}`);

  let rows = data || [];
  // Skip rows already tagged
  const toTag = rows.filter(r => (r.intelligence?.backfill_source) !== TAG);

  const sinceLabel = SINCE_TS || PUB_SINCE;
  console.log(`  Found ${rows.length} sources${sinceLabel ? ` since ${sinceLabel}` : ""}${PUBLISHER ? ` (publisher: ${PUBLISHER})` : ""}`);
  console.log(`  ${toTag.length} need tagging (${rows.length - toTag.length} already tagged)\n`);

  if (toTag.length === 0) {
    console.log("  Nothing to do.");
    return;
  }

  if (DRY_RUN) {
    toTag.slice(0, 10).forEach(r =>
      console.log(`  [dry] would tag ${r.id.slice(0, 8)} [${r.publisher}] ${r.created_at?.slice(0, 19)}`)
    );
    if (toTag.length > 10) console.log(`  ... and ${toTag.length - 10} more`);
    return;
  }

  let tagged = 0, failed = 0;
  for (const row of toTag) {
    const merged = { ...(row.intelligence || {}), backfill_source: TAG };
    const { error: updateErr } = await supabase
      .from("sources")
      .update({ intelligence: merged })
      .eq("id", row.id);
    if (updateErr) { console.error(`  ✗ ${row.id}: ${updateErr.message}`); failed++; }
    else           { tagged++; process.stdout.write("."); }
  }

  console.log(`\n\n  Tagged: ${tagged}  Failed: ${failed}`);
  console.log(`\n  Query tagged sources:`);
  console.log(`    SELECT id, title, publisher, date_published FROM sources`);
  console.log(`    WHERE intelligence->>'backfill_source' = '${TAG}';`);
}

main().catch(err => { console.error(err); process.exit(1); });
