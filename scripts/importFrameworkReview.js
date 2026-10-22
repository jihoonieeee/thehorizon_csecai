#!/usr/bin/env node
/**
 * importFrameworkReview.js — load the analysts' answers from a reviewed MITRE
 * review sheet into source_framework_reviews (migration 031).
 *
 * The enrich step (lib/pipeline/understand/mapFrameworks.js) shows the answers
 * for the most similar reviewed sources as examples, so every imported review
 * makes later tagging follow the log's conventions more closely. Re-importing a
 * sheet replaces its rows (upsert on source + framework).
 *
 * Usage:
 *   node scripts/importFrameworkReview.js <reviewed.xlsx> [--batch YYYY-MM] [--dry-run]
 *
 *   --batch    label for this review (default: the YYYY-MM in the file name, e.g.
 *              review-2026-08.xlsx → 2026-08). enrichSources.js --examples-from
 *              uses it to choose which reviews may serve as examples.
 */

import "dotenv/config";
import path from "path";
import { readReviewedAnswers } from "../lib/frameworks/reviewSheet.js";

const args    = process.argv.slice(2);
const FILE    = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--batch");
const bIdx    = args.indexOf("--batch");
const DRY_RUN = args.includes("--dry-run");
if (!FILE) { console.error("Usage: node scripts/importFrameworkReview.js <reviewed.xlsx> [--batch YYYY-MM] [--dry-run]"); process.exit(1); }
const BATCH = bIdx >= 0 ? args[bIdx + 1] : (/(\d{4}-\d{2})/.exec(path.basename(FILE)) || [])[1];
if (!BATCH) { console.error("Could not infer the batch from the file name — pass --batch YYYY-MM"); process.exit(1); }

const { answers, ignored } = readReviewedAnswers(FILE);
const rows = answers.map(a => ({
  source_id:     a.source_id,
  framework:     a.framework,
  outcome:       a.outcome,
  technique_ids: a.ids,
  verdict:       a.verdict,
  review_batch:  BATCH,
  review_file:   path.basename(FILE),
}));

const count = (fw, o) => rows.filter(r => r.framework === fw && r.outcome === o).length;
console.log(`\n  ${path.basename(FILE)} → batch ${BATCH}: ${new Set(rows.map(r => r.source_id)).size} reviewed sources, ${rows.length} answers`);
for (const fw of ["attack", "atlas"]) {
  console.log(`    ${fw.padEnd(7)} tagged ${count(fw, "tagged")}  N/A ${count(fw, "not_applicable")}  blank ${count(fw, "none")}`);
}
if (ignored.size) console.log(`  IDs not in the pinned catalogues (dropped): ${[...ignored].map(([k, v]) => `${k}×${v}`).join(", ")}`);

if (DRY_RUN) { console.log("\n  Dry run — nothing written."); process.exit(0); }

const { supabase } = await import("../lib/storage/supabaseClient.js");
const { upsertReviewAnswers } = await import("../lib/storage/frameworkStore.js");
await upsertReviewAnswers(supabase, rows);
console.log(`\n  Imported ${rows.length} answers into source_framework_reviews.`);
