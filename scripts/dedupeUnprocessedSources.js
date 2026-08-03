#!/usr/bin/env node
/**
 * dedupeUnprocessedSources.js — remove duplicate rows for sources that have not
 * yet been classified (main_category IS NULL).
 *
 * Root cause: when Gemini quota was exhausted during Aug 1–3 ingest, the digest
 * fan-out ran but L3 validation never completed. The same URL was stored multiple
 * times (different full_text snippets, same URL-derived ID) because the upsert
 * dedup relies on L3 completing first. Result: 374 rows for 224 unique URLs.
 *
 * Strategy per duplicate URL group:
 *   1. Keep the row with the longest full_text (richest content).
 *   2. If tied on length, keep the earliest created_at.
 *   3. Delete all other rows by ID.
 *   (No evidence rows exist for unclassified sources — safe to hard-delete.)
 *
 * Usage:
 *   node scripts/dedupeUnprocessedSources.js --dry-run   # preview only
 *   node scripts/dedupeUnprocessedSources.js --execute   # apply deletes
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const DRY_RUN = !process.argv.includes("--execute");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function main() {
  console.log(`dedupeUnprocessedSources — ${DRY_RUN ? "DRY RUN (pass --execute to apply)" : "LIVE EXECUTE"}\n`);

  // Load all unclassified sources (no pagination needed — max ~400 rows)
  const { data: rows, error } = await supabase
    .from("sources")
    .select("id, url, full_text, created_at, title, validation_status")
    .is("main_category", null)
    .order("created_at", { ascending: true });

  if (error) { console.error("DB error:", error.message); process.exit(1); }
  console.log(`Loaded ${rows.length} unclassified rows.`);

  // Group by URL
  const byUrl = new Map();
  for (const row of rows) {
    if (!row.url) continue;
    if (!byUrl.has(row.url)) byUrl.set(row.url, []);
    byUrl.get(row.url).push(row);
  }

  const dupeGroups = [...byUrl.values()].filter(g => g.length > 1);
  console.log(`Unique URLs: ${byUrl.size}  |  URLs with duplicates: ${dupeGroups.length}`);

  if (!dupeGroups.length) {
    console.log("\nNo duplicates found — nothing to do.");
    return;
  }

  // For each group, pick the keeper and collect losers
  const toDelete = [];
  let totalKept = 0;

  for (const group of dupeGroups) {
    // Sort: longest full_text first, then earliest created_at as tiebreak
    group.sort((a, b) => {
      const diff = (b.full_text?.length ?? 0) - (a.full_text?.length ?? 0);
      return diff !== 0 ? diff : new Date(a.created_at) - new Date(b.created_at);
    });

    const keeper = group[0];
    const losers = group.slice(1);
    totalKept++;

    if (DRY_RUN) {
      console.log(`\n  KEEP  ${keeper.id.slice(0,8)}  ft=${keeper.full_text?.length ?? 0}  vs=${keeper.validation_status ?? "null"}  ${keeper.url.slice(0,70)}`);
      for (const l of losers) {
        console.log(`  DEL   ${l.id.slice(0,8)}  ft=${l.full_text?.length ?? 0}  vs=${l.validation_status ?? "null"}`);
      }
    }

    for (const l of losers) toDelete.push(l.id);
  }

  console.log(`\nKeepers: ${totalKept}  |  Rows to delete: ${toDelete.length}`);

  if (DRY_RUN) {
    console.log("\nDry run complete. Run with --execute to apply.");
    return;
  }

  // Delete in batches of 50 (Supabase .in() limit)
  const BATCH = 50;
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const chunk = toDelete.slice(i, i + BATCH);
    const { error: delErr } = await supabase
      .from("sources")
      .delete()
      .in("id", chunk)
      .is("main_category", null); // safety guard — never touch classified rows

    if (delErr) {
      console.error(`Delete error (batch ${i}–${i + chunk.length}):`, delErr.message);
      process.exit(1);
    }
    deleted += chunk.length;
    process.stdout.write(`  Deleted ${deleted}/${toDelete.length}...\r`);
  }

  console.log(`\n\nDone. Deleted ${deleted} duplicate rows.`);

  // Verification
  const { count } = await supabase
    .from("sources")
    .select("*", { count: "exact", head: true })
    .is("main_category", null);
  console.log(`Unclassified rows remaining: ${count}  (expected ~${rows.length - deleted})`);
}

main().catch(err => { console.error(err); process.exit(1); });
