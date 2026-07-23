#!/usr/bin/env node
/**
 * dedupeArxiv.js — remove duplicate source rows that arose from the same arXiv
 * paper being ingested via different URL variants (abs/pdf/html, versioned/unversioned).
 *
 * foldUrlVariants() in lib/utils/urlCanonical.js already prevents NEW duplicates.
 * This is a one-time cleanup for rows created before that guard was in place.
 *
 * Strategy per duplicate group:
 *   1. Keep the row with the most full_text characters (richest content).
 *   2. If any inferior row has evidence rows, re-point them to the keeper before deletion.
 *   3. Delete the inferior row(s).
 *
 * Usage:
 *   node scripts/dedupeArxiv.js [--dry-run]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const DRY_RUN = process.argv.includes("--dry-run");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function main() {
  console.log(`dedupeArxiv — ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);

  // Load all validated arXiv sources
  const { data, error } = await supabase
    .from("sources")
    .select("id, url, full_text, starred, is_curated, reading_value, validation_status")
    .ilike("url", "%arxiv.org%")
    .eq("validation_status", "pass");

  if (error) { console.error("Load failed:", error.message); process.exit(1); }

  // Group by canonical arXiv numeric ID (e.g. "2607.15970")
  const byArxivId = new Map();
  for (const s of data) {
    const m = s.url.match(/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d+)/i);
    if (!m) continue;
    const key = m[1];
    if (!byArxivId.has(key)) byArxivId.set(key, []);
    byArxivId.get(key).push(s);
  }

  const groups = [...byArxivId.entries()]
    .map(([key, rows]) => {
      // Deduplicate by DB ID — same ID appearing multiple times is a query artifact
      const seen = new Set();
      const unique = rows.filter(r => seen.has(r.id) ? false : seen.add(r.id));
      return [key, unique];
    })
    .filter(([, rows]) => rows.length > 1); // true duplicates only (different DB IDs)

  console.log(`Found ${groups.length} arXiv papers with multiple source rows.\n`);

  let deleted = 0;
  let evidenceMigrated = 0;
  let skipped = 0;

  for (const [arxivId, rows] of groups) {
    // If any row is starred or curated it must be the keeper regardless of content length.
    // Otherwise keep the row with the most full_text characters.
    const priority = rows.find(r => r.starred || r.is_curated);
    const sorted = [...rows].sort((a, b) => {
      const charDiff = (b.full_text?.length ?? 0) - (a.full_text?.length ?? 0);
      if (charDiff !== 0) return charDiff;
      const aVer = /v\d+/.test(a.url) ? 1 : 0;
      const bVer = /v\d+/.test(b.url) ? 1 : 0;
      return aVer - bVer;
    });

    const keeper = priority ?? sorted[0];
    const drops  = rows.filter(r => r.id !== keeper.id);

    console.log(`  ${arxivId}`);
    console.log(`    KEEP  ${keeper.id.slice(0,8)}  ${keeper.url.replace("https://arxiv.org/","").padEnd(30)}  ${(keeper.full_text?.length ?? 0)}c  rv=${keeper.reading_value}`);

    for (const drop of drops) {
      // Starred/curated rows are always the keeper (handled above); arriving here means
      // this drop is neither — safe to delete.


      // Check for evidence rows on the inferior duplicate
      const { data: evRows } = await supabase
        .from("evidence")
        .select("id")
        .eq("source_id", drop.id);

      const evCount = evRows?.length ?? 0;

      if (evCount > 0) {
        console.log(`    MIGR  ${drop.id.slice(0,8)}  ${drop.url.replace("https://arxiv.org/","").padEnd(30)}  ${(drop.full_text?.length ?? 0)}c  [${evCount} evidence rows → ${keeper.id.slice(0,8)}]`);
        if (!DRY_RUN) {
          const { error: migErr } = await supabase
            .from("evidence")
            .update({ source_id: keeper.id })
            .eq("source_id", drop.id);
          if (migErr) { console.error(`      Migration failed: ${migErr.message}`); continue; }
          evidenceMigrated += evCount;
        } else {
          evidenceMigrated += evCount;
        }
      } else {
        console.log(`    DROP  ${drop.id.slice(0,8)}  ${drop.url.replace("https://arxiv.org/","").padEnd(30)}  ${(drop.full_text?.length ?? 0)}c`);
      }

      if (!DRY_RUN) {
        const { error: delErr } = await supabase
          .from("sources")
          .delete()
          .eq("id", drop.id);
        if (delErr) { console.error(`      Delete failed: ${delErr.message}`); }
        else deleted++;
      } else {
        deleted++;
      }
    }
  }

  console.log(`\nDone.`);
  console.log(`  Rows deleted:          ${deleted}`);
  console.log(`  Evidence rows migrated: ${evidenceMigrated}`);
  console.log(`  Skipped:               ${skipped}`);
  if (DRY_RUN) console.log("\n(Dry run — no changes made. Re-run without --dry-run to apply.)");
}

main().catch(err => { console.error(err); process.exit(1); });
