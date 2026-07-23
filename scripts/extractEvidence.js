#!/usr/bin/env node
/**
 * extractEvidence.js — L5: extract structured evidence items for eligible sources.
 *
 * Finds classified offensive-category sources that either have no evidence yet
 * or whose full_text has changed (content-hash check), and runs the evidence
 * extraction pipeline on them. Results go to the `evidence` table and are used
 * by slide generation and the chatbot.
 *
 * Eligibility gate (deterministic — no LLM):
 *   - main_category in offensive categories
 *   - reading_value IN (essential, recommended)
 *     OR intelligence.maturity_level IN (operational, observed, demonstrated)
 *
 * Content-hash deduplication means re-running is safe and cheap — already-
 * extracted sources are skipped unless their text changed.
 *
 * Usage:
 *   node scripts/extractEvidence.js [--limit N] [--concurrency N] [--since-hours N]
 *
 * Options:
 *   --limit N         Max sources to process per run (default 150).
 *   --concurrency N   Parallel LLM calls (default 4).
 *   --since-hours N   Only consider sources created in the last N hours (optional).
 *                     Omit for a full-corpus pass (manual backfill).
 */

import "dotenv/config";
import { createClient }      from "@supabase/supabase-js";
import { extractAllEvidence } from "../lib/pipeline/extraction/extractEvidence.js";
import { getEvidenceHashes, contentHashOf } from "../lib/storage/evidenceStore.js";
import { flushCostBuffer }   from "../lib/llm/usagePersistence.js";

const args   = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIMIT  = parseInt(getArg("--limit",       "150"), 10);
const CONC   = parseInt(getArg("--concurrency",  "4"),  10);
const SINCE_H = getArg("--since-hours", null);

const OFFENSIVE_CATS  = ["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats"];
const HIGH_MATURITY   = new Set(["operational", "observed", "demonstrated"]);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

console.log(`\n${"═".repeat(60)}`);
console.log(`  L5 Evidence extraction — ${new Date().toISOString().slice(0, 16)} UTC`);
console.log(`  limit: ${LIMIT}  concurrency: ${CONC}${SINCE_H ? `  since-hours: ${SINCE_H}` : "  (full corpus)"}`);
console.log(`${"═".repeat(60)}\n`);

// Guard: abort before any LLM calls if evidence table is missing.
{
  const probe = await sb.from("evidence").select("id").limit(1);
  if (probe.error) {
    console.error(`Evidence table not available (${probe.error.message}). Apply migration 011 first.`);
    process.exit(0);
  }
}

// Load eligible sources. Paginate to avoid PostgREST 1000-row cap.
const PAGE = 1000;
let data = [];
const sinceTs = SINCE_H ? new Date(Date.now() - parseFloat(SINCE_H) * 3600 * 1000).toISOString() : null;

for (let from = 0; ; from += PAGE) {
  let q = sb
    .from("sources")
    .select("id,title,url,publisher,source_type,trust_tier,main_category,full_text,clean_text,reading_value,intelligence")
    .eq("validation_status", "pass")
    .in("main_category", OFFENSIVE_CATS)
    .order("created_at", { ascending: false })
    .range(from, from + PAGE - 1);

  if (sinceTs) q = q.gte("created_at", sinceTs);

  const { data: page, error } = await q;
  if (error) { console.error("DB load failed:", error.message); process.exit(1); }
  if (!page?.length) break;
  data.push(...page);
  if (page.length < PAGE) break;
}

// Apply eligibility gate in JS (reading_value OR high maturity).
const eligible = data.filter(s =>
  ["essential", "recommended"].includes(s.reading_value) ||
  HIGH_MATURITY.has(s.intelligence?.maturity_level),
);

console.log(`  ${data.length} offensive sources loaded → ${eligible.length} eligible`);

const sources    = eligible.map(s => ({ ...s, category: s.main_category }));
const haveHash   = await getEvidenceHashes(sb, sources.map(s => s.id));
const sourceText = s => s.full_text || s.clean_text || "";
const stale      = sources.filter(s => haveHash.get(s.id) !== contentHashOf(sourceText(s)));

console.log(`  ${eligible.length - stale.length} already cached | ${stale.length} need extraction`);

const batch = stale.slice(0, LIMIT);
if (!batch.length) { console.log("  Nothing to extract. Up to date."); process.exit(0); }

console.log(`  Extracting evidence for ${batch.length} sources (cap ${LIMIT})...\n`);

const res = await extractAllEvidence(batch, OFFENSIVE_CATS, {
  supabase: sb,
  concurrency: CONC,
  onProgress: (done, total) => process.stdout.write(`    ${done}/${total}\r`),
});
process.stdout.write("\n");

console.log(`\n  Done. ${res.counts?.after_dedup ?? "?"} evidence items extracted.`);
if (stale.length - batch.length > 0) {
  console.log(`  ${stale.length - batch.length} sources still pending (re-run to continue).`);
}
console.log();

await flushCostBuffer().catch(() => {});
