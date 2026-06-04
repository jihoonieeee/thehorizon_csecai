#!/usr/bin/env node
/**
 * persistProcessedFromCache.js — Persist Layer-4 (understand) enrichment for
 * sources that were ALREADY processed in a prior `--no-persist` run, WITHOUT
 * making any new LLM calls.
 *
 * How it works:
 *   The router (routedLLM) checks its prompt-hash cache BEFORE selecting a
 *   provider. By forcing LLM_PROVIDER_ORDER empty, a cached source returns its
 *   real understanding (llm_used=true, cache_hit) while an UNcached source has
 *   no provider to call and falls back instantly (llm_used=false). We then
 *   persist ONLY the llm_used=true sources, so deterministic fallbacks never
 *   overwrite real DB data.
 *
 * Usage:
 *   node scripts/persistProcessedFromCache.js [limit] [days]
 *   node scripts/persistProcessedFromCache.js 200 90        # default
 *   node scripts/persistProcessedFromCache.js 200 90 --dry  # report only, no writes
 */
import "dotenv/config";

// Cache-only mode: no live providers. Must run BEFORE importing the router.
// NOTE: an empty string is falsy in getProviderOrder() and would fall back to
// the DEFAULT order — use a sentinel that matches no provider case instead, so
// the executor list is empty and only the prompt-hash cache can satisfy a call.
process.env.LLM_PROVIDER_ORDER = "none";

import { listSources }              from "../lib/storage/snapshotDatabase.js";
import { understandSources }        from "../lib/pipeline/understand/understandSources.js";
import { classifySources }          from "../lib/pipeline/classify/classifyCategory.js";
import { persistUnderstandResults } from "../lib/storage/sourceEnrichmentStore.js";

const args  = process.argv.slice(2);
const DRY   = args.includes("--dry");
const nums  = args.filter((a) => /^\d+$/.test(a));
const LIMIT = parseInt(nums[0] || "200", 10);
const DAYS  = parseInt(nums[1] || "90", 10);

function windowFor(days) {
  const end = new Date().toISOString().slice(0, 10);
  const d   = new Date(end);
  d.setDate(d.getDate() - days);
  return { start: d.toISOString().slice(0, 10), end };
}

async function main() {
  const { start, end } = windowFor(DAYS);
  console.log(`\nLoading sources (window ${start} → ${end}, limit ${LIMIT})...`);
  const sources = await listSources({ start, end, limit: LIMIT });
  console.log(`  Loaded ${sources.length} sources.`);

  console.log("\nReplaying understand in CACHE-ONLY mode (no live LLM calls)...");
  const { sources: understood, counts } = await understandSources(sources, {
    skipLlm:     false,
    concurrency: 8,
  });
  console.log(
    `  cache hits (real understanding): ${counts.llm_processed}\n` +
    `  uncached (instant fallback):     ${counts.fallback}\n` +
    `  already stamped:                 ${counts.already_done}`
  );

  // Layer 6 classification so main_category is set on the persisted rows.
  const { sources: classified } = classifySources(understood);

  // Persist ONLY sources that got REAL understanding from cache. Deterministic
  // fallbacks (uncached) are excluded so we never clobber existing DB data.
  const toPersist = classified.filter((s) => s.understanding?.llm_used === true);
  console.log(`\n${toPersist.length} sources have real (cached) understanding to persist.`);

  if (toPersist.length > 0) {
    const sample = toPersist.slice(0, 10).map(
      (s) => `   • [${s.main_category || "uncategorised"}] ${(s.title || "").slice(0, 60)}`
    );
    console.log(sample.join("\n"));
    if (toPersist.length > 10) console.log(`   … and ${toPersist.length - 10} more`);
  }

  if (DRY) {
    console.log("\n[--dry] No writes performed.");
    return;
  }

  if (toPersist.length === 0) {
    console.log("\nNothing to persist.");
    return;
  }

  console.log("\nWriting enrichment to Supabase sources table...");
  const { updated, skipped } = await persistUnderstandResults(toPersist);
  console.log(`  ✓ Updated ${updated} sources (skipped ${skipped}).`);
}

main().catch((err) => {
  console.error("persistProcessedFromCache failed:", err);
  process.exit(1);
});
