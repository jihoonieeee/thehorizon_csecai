#!/usr/bin/env node
/**
 * backfillSourceFamily.js — deterministic backfill of source_family.
 *
 * source_family was null on 868+ pass sources because older corpus rows were
 * classified before the field was reliably persisted. This script fills it
 * using the same deterministic classifySourceFamily() logic that understandAllSources
 * now writes on every new classification.
 *
 * reading_value is NOT touched here — it must be set by the LLM via validateAndTypeSource
 * (run scripts/labelSources.js for that).
 *
 * Idempotent: skips sources where source_family is already set. Use --force to re-derive.
 *
 * Usage:
 *   node scripts/backfillSourceFamily.js [--limit 5000] [--force] [--dry-run]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { classifySourceFamily } from "../lib/pipeline/understand/classifySourceFamily.js";

const args    = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const LIMIT   = parseInt(getArg("--limit", "5000"), 10);
const FORCE   = args.includes("--force");
const DRY_RUN = args.includes("--dry-run");
const PAGE    = 1000;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

console.log(`\n${"═".repeat(70)}`);
console.log(`  backfillSourceFamily — source_family only`);
console.log(`  limit=${LIMIT}  force=${FORCE}  dry-run=${DRY_RUN}`);
console.log(`${"═".repeat(70)}\n`);

// ── Load pass/review sources missing source_family ────────────────────────────

let sources = [];
for (let from = 0; sources.length < LIMIT; from += PAGE) {
  const to = from + PAGE - 1;
  let q = sb.from("sources")
    .select("id, title, url, publisher, publisher_class, source_type, trust_tier, tags, is_digest, content_quality, intelligence, source_family")
    .in("validation_status", ["pass", "review"])
    .order("date_published", { ascending: false })
    .range(from, to);

  if (!FORCE) q = q.is("source_family", null);

  const { data, error } = await q;
  if (error) { console.error("DB load error:", error.message); process.exit(1); }
  if (!data?.length) break;
  sources.push(...data);
  if (data.length < PAGE) break;
}

sources = sources.slice(0, LIMIT);
console.log(`  ${sources.length} sources to process\n`);
if (!sources.length) { console.log("  Nothing to do."); process.exit(0); }

// ── Derive and write ──────────────────────────────────────────────────────────

const tally = { written: 0, skipped: 0, errors: 0, family: {} };
const BATCH = 50;

for (let i = 0; i < sources.length; i += BATCH) {
  const batch = sources.slice(i, i + BATCH);

  await Promise.all(batch.map(async (source) => {
    const newFamily = classifySourceFamily(source);
    tally.family[newFamily] = (tally.family[newFamily] || 0) + 1;

    if (!FORCE && source.source_family === newFamily) { tally.skipped++; return; }

    if (DRY_RUN) {
      console.log(`  [dry] ${(source.source_family||"null").padEnd(24)}→ ${newFamily.padEnd(24)} ${(source.title||"").slice(0, 50)}`);
      tally.written++;
      return;
    }

    const { error } = await sb.from("sources").update({ source_family: newFamily }).eq("id", source.id);
    if (error) { console.warn(`  [error] ${source.id}: ${error.message}`); tally.errors++; }
    else tally.written++;
  }));

  process.stdout.write(`  ${Math.min(i + BATCH, sources.length)}/${sources.length}\r`);
}

process.stdout.write("\n");

console.log(`\n${"─".repeat(70)}`);
console.log(`  Written: ${tally.written}  Skipped (unchanged): ${tally.skipped}  Errors: ${tally.errors}`);
if (DRY_RUN) console.log("  (dry-run — no writes performed)");

console.log(`\n  source_family distribution:`);
for (const [k, n] of Object.entries(tally.family).sort((a, b) => b[1] - a[1]))
  if (n) console.log(`    ${k.padEnd(32)} ${n}`);
