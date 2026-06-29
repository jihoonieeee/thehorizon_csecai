#!/usr/bin/env node
/**
 * extractEvidenceBatch.js — persist Layer-5 evidence for pass sources, incrementally.
 *
 * Loads classified pass sources, finds the ones with no current cached evidence
 * (or whose full_text changed), extracts evidence for up to --limit of them, and
 * stores it in the `evidence` table. Run repeatedly (e.g. from scrapeLoop.sh) to
 * chip away at the corpus without a giant one-shot LLM bill. Deck runs then reuse
 * this cache instead of re-extracting.
 *
 * Usage:
 *   node scripts/extractEvidenceBatch.js --limit 150 --concurrency 5
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { extractAllEvidence } from "../lib/pipeline/extractEvidence.js";
import { getEvidenceHashes, contentHashOf } from "../lib/storage/evidenceStore.js";

const args   = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIMIT  = parseInt(getArg("--limit", "150"), 10);
const CONC   = parseInt(getArg("--concurrency", "5"), 10);

const CATS = ["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats"];
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Guard: if the evidence table doesn't exist yet (migration not applied), abort
// BEFORE any extraction — otherwise we'd run LLM calls that can't be persisted and
// would re-run every cycle. Apply docs/migrations/011_evidence_table.sql first.
{
  const probe = await sb.from("evidence").select("id").limit(1);
  if (probe.error) {
    console.error(`Evidence table not available (${probe.error.message}). Apply migration 011 first. Skipping.`);
    process.exit(0);
  }
}

console.log("Evidence backfill — finding pass sources without current evidence...");

// Load classified pass sources (newest first). PostgREST caps a single request
// at 1000 rows regardless of .limit(), so paginate via .range() to see the WHOLE
// corpus — otherwise older sources (beyond the newest 1000) are never enriched.
const PAGE = 1000;
let data = [];
for (let from = 0; ; from += PAGE) {
  const { data: page, error } = await sb.from("sources")
    .select("id, title, url, publisher, source_type, trust_tier, main_category, full_text")
    .eq("validation_status", "pass")
    .in("main_category", CATS)
    .order("created_at", { ascending: false })
    .range(from, from + PAGE - 1);
  if (error) { console.error("DB load failed:", error.message); process.exit(1); }
  if (!page?.length) break;
  data.push(...page);
  if (page.length < PAGE) break;
}

const sources = (data || []).map(s => ({ ...s, category: s.main_category }));
const haveHash = await getEvidenceHashes(sb, sources.map(s => s.id));
const stale = sources.filter(s => haveHash.get(s.id) !== contentHashOf(s.full_text || ""));

console.log(`  ${sources.length} pass sources | ${sources.length - stale.length} already cached | ${stale.length} need extraction`);
const batch = stale.slice(0, LIMIT);
if (!batch.length) { console.log("  Nothing to extract. Up to date."); process.exit(0); }

console.log(`  Extracting evidence for ${batch.length} sources (cap ${LIMIT})...`);
const res = await extractAllEvidence(batch, CATS, {
  supabase: sb, concurrency: CONC,
  onProgress: (done, total) => process.stdout.write(`    ${done}/${total}\r`),
});
process.stdout.write("\n");
console.log(`  Done. ${res.counts.after_dedup} evidence items now represented; ${stale.length - batch.length} sources still pending.`);

const { flushPipelineCostToDB } = await import("../lib/llm/usagePersistence.js").catch(() => ({}));
if (flushPipelineCostToDB) await flushPipelineCostToDB().catch(() => {});
