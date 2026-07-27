#!/usr/bin/env node
/**
 * recoverEstimatedDates.js — deterministic publish-date recovery for sources
 * whose date_confidence is not "exact".
 *
 * Runs lib/pipeline/ingest/upgradeDate.js (no LLM) over every validation=pass
 * source with date_confidence != "exact". When the header region of full_text
 * contains an unambiguous date that agrees with the stored date within ±2 days,
 * the source is promoted to date_confidence="exact" (clearing needs_review, the
 * same effect as confirming the date in the dashboard). Sources with no matchable
 * date are flagged needs_review=true so they surface as "flagged" on the sources
 * page — and, per the downstream gates, are held out of the newsletter, agent
 * retrieval, and dashboard insights until a human resolves the date. They are
 * also written out to a CSV for review.
 *
 * Dry-run by default — prints the plan and writes the unresolved list. Pass
 * --execute to write the promotions + flags to the DB.
 *
 * Usage:
 *   node scripts/recoverEstimatedDates.js            # dry-run (no writes)
 *   node scripts/recoverEstimatedDates.js --execute  # apply promotions
 */

import "dotenv/config";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { upgradeDate } from "../lib/pipeline/ingest/upgradeDate.js";

const EXECUTE = process.argv.includes("--execute");
const UNRESOLVED_CSV = "output/uncertain_dates_unresolved.csv";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const FIELDS = [
  "id", "title", "url", "publisher", "source_type",
  "source_origin", "discovery_route", "needs_review",
  "date_published", "date_published_actual", "date_confidence", "full_text",
].join(",");

async function loadUncertain() {
  let rows = [], from = 0;
  while (true) {
    const { data, error } = await sb.from("sources").select(FIELDS)
      .eq("validation_status", "pass").neq("date_confidence", "exact")
      .order("date_published", { ascending: false }).range(from, from + 999);
    if (error) { console.error("load error:", error.message); process.exit(1); }
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

const csvEsc = s => `"${String(s ?? "").replace(/"/g, '""')}"`;

async function main() {
  console.log(`\n  The Horizon — Estimated-date recovery${EXECUTE ? "  [EXECUTE]" : "  [dry-run]"}\n`);

  const rows = await loadUncertain();
  console.log(`  Loaded ${rows.length} sources (validation=pass, date_confidence != "exact")\n`);

  const promotions = [];   // { row, from, to, shifted }
  const unresolved = [];    // rows upgradeDate could not date

  for (const row of rows) {
    const res = upgradeDate(row);
    if (!res) { unresolved.push(row); continue; }
    const stored = (row.date_published || "").slice(0, 10);
    promotions.push({ row, from: stored || "(none)", to: res.date_published, shifted: res.date_published !== stored, res });
  }

  const shifts   = promotions.filter(p => p.shifted);
  const confirms = promotions.filter(p => !p.shifted);

  // Only the promotions that were flagged need their review flag cleared; only
  // the unresolved rows that are NOT already flagged need it set.
  const toClearFlag = promotions.filter(p => p.row.needs_review === true);
  const toSetFlag   = unresolved.filter(r => r.needs_review !== true);

  console.log(`  ── PLAN ──`);
  console.log(`  promote estimated -> exact, date unchanged:  ${confirms.length}`);
  console.log(`  promote AND shift date (within ±2 days):     ${shifts.length}`);
  console.log(`    ↳ of which clear needs_review:             ${toClearFlag.length}`);
  console.log(`  unresolved (no date found):                  ${unresolved.length}`);
  console.log(`    ↳ newly flagged needs_review=true:         ${toSetFlag.length}  (${unresolved.length - toSetFlag.length} already flagged)`);
  console.log(`  total promotions: ${promotions.length} / ${rows.length}\n`);

  if (shifts.length) {
    console.log(`  Date shifts (stored -> recovered):`);
    for (const p of shifts)
      console.log(`   ${p.from} -> ${p.to}  ${(p.row.publisher || "?").slice(0, 22).padEnd(22)} ${(p.row.title || "").slice(0, 50)}`);
    console.log("");
  }

  // Always (re)write the unresolved list so the caller has something to review.
  fs.mkdirSync("output", { recursive: true });
  const lines = ["date_published,date_confidence,source_origin,publisher,title,url,id"];
  for (const r of unresolved) lines.push([
    (r.date_published || "").slice(0, 10), r.date_confidence,
    r.source_origin || r.discovery_route || "", r.publisher, r.title, r.url, r.id,
  ].map(csvEsc).join(","));
  fs.writeFileSync(UNRESOLVED_CSV, lines.join("\n"));
  console.log(`  Flagged ${unresolved.length} unresolved sources -> ${UNRESOLVED_CSV}\n`);

  if (!EXECUTE) {
    console.log(`  [dry-run] nothing written to the DB.`);
    console.log(`  Re-run with --execute to apply ${promotions.length} promotions + flag ${toSetFlag.length} sources.\n`);
    return;
  }

  // Promote recoverable sources: set the exact date and clear any review flag
  // (mirrors the dashboard "confirm date" behaviour).
  let promoted = 0;
  for (const p of promotions) {
    const { error } = await sb.from("sources")
      .update({ date_published: p.res.date_published, date_confidence: "exact", needs_review: false })
      .eq("id", p.row.id);
    if (error) { console.log(`  promote error (${p.row.id}): ${error.message}`); continue; }
    promoted++;
  }

  // Flag the unresolved sources so they surface on the sources page and are held
  // out of downstream (newsletter / agent / insights) until a human dates them.
  let flagged = 0;
  for (const r of toSetFlag) {
    const { error } = await sb.from("sources")
      .update({ needs_review: true })
      .eq("id", r.id);
    if (error) { console.log(`  flag error (${r.id}): ${error.message}`); continue; }
    flagged++;
  }

  console.log(`  Promoted ${promoted}/${promotions.length} to date_confidence="exact".`);
  console.log(`  Flagged  ${flagged}/${toSetFlag.length} unresolved sources needs_review=true.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
