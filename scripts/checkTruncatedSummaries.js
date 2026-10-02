#!/usr/bin/env node
/**
 * checkTruncatedSummaries.js — list sources whose short_summary was cut off
 * by the old hard 600-char slice in understandSource.js.
 *
 * A summary is flagged when it is exactly 600 chars long and does not end in
 * sentence punctuation — the signature of the old mid-word truncation. New
 * classifications use capSummary() and no longer produce these.
 *
 * Read-only. Fix flagged rows by reclassifying them or editing the summary in
 * the Sources tab.
 *
 * Usage:
 *   node scripts/checkTruncatedSummaries.js            # summary + first 20 rows
 *   node scripts/checkTruncatedSummaries.js --all      # list every flagged row
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SHOW_ALL = process.argv.includes("--all");
const OLD_LIMIT = 600;
const PAGE = 1000;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const flagged = [];
let total = 0;
for (let from = 0; ; from += PAGE) {
  const { data, error } = await sb
    .from("sources")
    .select("id, title, date_published, short_summary")
    .not("short_summary", "is", null)
    .order("id")
    .range(from, from + PAGE - 1);
  if (error) { console.error("Query failed:", error.message); process.exit(1); }
  if (!data.length) break;
  total += data.length;
  for (const r of data) {
    const s = r.short_summary || "";
    if (s.length === OLD_LIMIT && !/[.!?)"'”’]$/.test(s.trim())) flagged.push(r);
  }
  if (data.length < PAGE) break;
}

console.log(`Scanned ${total} sources with a short_summary.`);
console.log(`Truncated at ${OLD_LIMIT} chars: ${flagged.length}\n`);

flagged.sort((a, b) => String(b.date_published || "").localeCompare(String(a.date_published || "")));
for (const r of SHOW_ALL ? flagged : flagged.slice(0, 20)) {
  console.log(`${(r.date_published || "").slice(0, 10) || "no-date   "}  ${r.id}  ${(r.title || "").slice(0, 80)}`);
  console.log(`    …${r.short_summary.slice(-60)}`);
}
if (!SHOW_ALL && flagged.length > 20) console.log(`\n(${flagged.length - 20} more — rerun with --all)`);
