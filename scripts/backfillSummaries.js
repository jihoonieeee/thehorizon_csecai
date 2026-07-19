#!/usr/bin/env node
/**
 * backfillSummaries.js — re-run the understand layer over already-understood
 * sources that are missing a short_summary, and refresh their intelligence
 * (adds key_terms, cleans key_numbers) without touching their classification.
 *
 * Targets: claim_extraction_status='success' AND short_summary IS NULL.
 * (The understand prompt previously never requested short_summary, so ~77% of
 * understood rows have rich claims but no summary — see understandSource.js.)
 *
 * Only short_summary, analyst_brief, and intelligence are overwritten.
 * main_category / tags / source_type / trust_tier are left intact.
 *
 * Usage:
 *   node scripts/backfillSummaries.js [--dry-run] [--limit N] [--batch N] [--concurrency N]
 *
 * Idempotent: a row that gains a summary drops out of the selection on re-run.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { understandSource } from "../lib/pipeline/understand/understandSource.js";
import { scrubImpliedQuantitatives } from "../lib/utils/scrubQuantitatives.js";

const args        = process.argv.slice(2);
const DRY_RUN     = args.includes("--dry-run");
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : d; };
const LIMIT       = arg("--limit", 0);
const BATCH_SIZE  = arg("--batch", 20);
const CONCURRENCY = arg("--concurrency", 4);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function pMap(items, fn, concurrency) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    out.push(...await Promise.all(items.slice(i, i + concurrency).map(fn)));
  }
  return out;
}

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Summary backfill — re-understand summary-less sources`);
  console.log(`  Dry run: ${DRY_RUN} | Limit: ${LIMIT || "all"} | Batch: ${BATCH_SIZE} | Concurrency: ${CONCURRENCY}`);
  console.log(`${"═".repeat(60)}\n`);

  let query = sb
    .from("sources")
    .select("id,title,url,publisher,date_published,source_type,trust_tier,full_text,summary,short_summary")
    .eq("claim_extraction_status", "success")
    .is("short_summary", null)
    .order("date_published", { ascending: false });
  if (LIMIT > 0) query = query.limit(LIMIT);

  const { data: sources, error } = await query;
  if (error) { console.error("DB error:", error.message); process.exit(1); }
  if (!sources?.length) { console.log("  No summary-less understood sources found. All done."); return; }

  console.log(`  ${sources.length} sources to backfill\n`);
  const t0 = Date.now();
  let processed = 0, succeeded = 0, failed = 0, stillEmpty = 0;

  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const batch = sources.slice(i, i + BATCH_SIZE);

    const results = await pMap(batch, async (src) => {
      try { return { src, u: await understandSource(src), ok: true }; }
      catch (err) { return { src, err: err.message, ok: false }; }
    }, CONCURRENCY);

    const updates = [];
    for (const r of results) {
      if (!r.ok) { failed++; continue; }
      const u = r.u;
      const sourceText = r.src.full_text || r.src.summary || "";
      const raw = u.short_summary || null;
      const { text: cleanSummary } = raw ? scrubImpliedQuantitatives(raw, sourceText) : { text: raw };
      if (!cleanSummary) stillEmpty++;  // model still declined — count it
      updates.push({
        id: r.src.id,
        short_summary: cleanSummary,
        analyst_brief: cleanSummary,
        intelligence: {
          key_entities: u.key_entities || [],
          key_terms:    u.key_terms    || [],
          main_claims:  u.main_claims  || [],
          key_numbers:  u.key_numbers  || [],
        },
        // classification fields deliberately omitted — preserved as-is
      });
    }

    if (!DRY_RUN && updates.length) {
      const { error: upErr } = await sb.from("sources").upsert(updates, { onConflict: "id" });
      if (upErr) { console.error(`  Batch upsert error: ${upErr.message}`); failed += updates.length; }
      else succeeded += updates.length;
    } else if (DRY_RUN && updates[0]) {
      console.log(`  [dry] ${updates[0].id.slice(0,8)}… summary="${(updates[0].short_summary||"").slice(0,70)}…"`);
      succeeded += updates.length;
    }

    processed += batch.length;
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    const eta = Math.round((sources.length - processed) / (processed / Math.max(1, (Date.now() - t0) / 1000)));
    process.stdout.write(`  ${processed}/${sources.length} | ${succeeded} ok | ${failed} failed | ${stillEmpty} still-empty | ${el}s | ETA ~${eta}s\r`);
  }

  console.log(`\n\n${"─".repeat(60)}`);
  console.log(`  Done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`  Processed   : ${processed}`);
  console.log(`  Updated     : ${succeeded}${DRY_RUN ? " (dry run)" : ""}`);
  console.log(`  Still empty : ${stillEmpty} (model declined a summary)`);
  console.log(`  Failed      : ${failed}`);
}

import { flushCostBuffer } from "../lib/llm/usagePersistence.js";
main().then(() => flushCostBuffer()).catch(err => { console.error(err); process.exit(1); });
