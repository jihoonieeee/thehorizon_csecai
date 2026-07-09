#!/usr/bin/env node
/**
 * reprocessUnderstand.js — re-run the understand layer over ALL validated sources
 * (not just not-yet-understood ones) to re-type them into the unified canonical
 * source_type vocabulary and refresh category / tags / summary / intelligence.
 *
 * Why: source_type previously held two vocabularies (ingest role-based vs the
 * understand layer's old publication-format set), so identical content (e.g.
 * arXiv papers) appeared as both research_finding AND research_paper. The
 * understand layer now classifies into the single canonical role vocab
 * (lib/config/sourceTypes.js); this re-processes the back-catalogue so every
 * row is consistent.
 *
 * Per source it writes back: source_type (canonical), main_category, tags,
 * trust_tier, short_summary, analyst_brief, intelligence{key_entities, key_terms,
 * main_claims, key_numbers, evidence_quality}, claim_extraction_status.
 *
 *  - Relevance gate: sources the LLM now judges irrelevant are demoted
 *    (validation_status=reject, claim_extraction_status=irrelevant).
 *  - Evidence quality (deterministic, no extra LLM): strong | usable | thin,
 *    from claim count + body length — surfaces low-quality rows for downstream
 *    gates without a second model call.
 *
 * Usage:
 *   node scripts/reprocessUnderstand.js [--dry-run] [--limit N] [--batch N] [--concurrency N]
 *   node scripts/reprocessUnderstand.js --only-legacy   # only rows with a non-canonical source_type
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { understandSource } from "../lib/pipeline/understand/understandSource.js";
import { scrubImpliedQuantitatives } from "../lib/pipeline/analysis/statisticalClaimQa.js";
import { ALL_SOURCE_TYPES, OLD_SOURCE_TYPE_MAP } from "../lib/config/sourceTypes.js";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_LEGACY = args.includes("--only-legacy");
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : d; };
const LIMIT = arg("--limit", 0);
const BATCH_SIZE = arg("--batch", 20);
const CONCURRENCY = arg("--concurrency", 4);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Canonicalise whatever the LLM returns: accept canonical values; map known
// legacy/format values; otherwise unknown.
function canonicalType(t) {
  if (!t) return "unknown";
  if (ALL_SOURCE_TYPES.includes(t)) return t;
  if (OLD_SOURCE_TYPE_MAP[t]) return OLD_SOURCE_TYPE_MAP[t];
  return "unknown";
}

// Deterministic evidence-quality tag from what understand extracted.
function evidenceQuality(u, src) {
  const claims = (u.main_claims || []).length;
  const len = (src.full_text || src.clean_text || src.summary || "").length;
  if (u.relevant === false) return "irrelevant";
  if (claims >= 2 && len >= 500) return "strong";
  if (claims >= 1 && len >= 200) return "usable";
  return "thin";
}

async function pMap(items, fn, concurrency) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    out.push(...await Promise.all(items.slice(i, i + concurrency).map(fn)));
  }
  return out;
}

async function pageAll(select, filter) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    let q = filter(sb.from("sources").select(select)).range(from, from + 999);
    const { data, error } = await q;
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
    if (LIMIT && all.length >= LIMIT) break;
  }
  return LIMIT ? all.slice(0, LIMIT) : all;
}

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Re-process understand — canonical source_type re-typing`);
  console.log(`  Dry: ${DRY_RUN} | Limit: ${LIMIT || "all"} | Batch: ${BATCH_SIZE} | Conc: ${CONCURRENCY} | only-legacy: ${ONLY_LEGACY}`);
  console.log(`${"═".repeat(60)}\n`);

  let sources = await pageAll(
    "id,title,url,publisher,date_published,source_type,trust_tier,full_text,clean_text,summary,main_category,validation_status",
    q => q.eq("validation_status", "pass")
  );

  if (ONLY_LEGACY) {
    sources = sources.filter(s => !ALL_SOURCE_TYPES.includes(s.source_type));
  }
  if (!sources.length) { console.log("  Nothing to re-process."); return; }

  console.log(`  ${sources.length} PASS sources to re-process\n`);
  const t0 = Date.now();
  let processed = 0, retyped = 0, demoted = 0, failed = 0;
  const qualityTally = {};
  const typeTally = {};

  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const batch = sources.slice(i, i + BATCH_SIZE);
    const results = await pMap(batch, async (src) => {
      try { return { src, u: await understandSource(src), ok: true }; }
      catch (err) { return { src, err: err.message, ok: false }; }
    }, CONCURRENCY);

    const updates = [];
    const demote = [];
    for (const r of results) {
      if (!r.ok) { failed++; continue; }
      const { src, u } = r;
      const quality = evidenceQuality(u, src);
      qualityTally[quality] = (qualityTally[quality] || 0) + 1;

      if (u.relevant === false) {
        demote.push(src.id);
        continue;
      }
      const newType = canonicalType(u.source_type);
      typeTally[newType] = (typeTally[newType] || 0) + 1;
      if (newType !== src.source_type) retyped++;

      const sourceText = src.full_text || src.clean_text || src.summary || "";
      const raw = u.short_summary || null;
      const { text: cleanSummary } = raw ? scrubImpliedQuantitatives(raw, sourceText) : { text: raw };
      const rawBrief = u.analyst_brief || null;
      const { text: cleanAnalystBrief } = rawBrief ? scrubImpliedQuantitatives(rawBrief, sourceText) : { text: rawBrief };

      updates.push({
        id: src.id,
        source_type: newType,
        main_category: u.category,
        tags: u.primary_tags || [],
        trust_tier: u.trust_tier || src.trust_tier || "unknown",
        short_summary: cleanSummary,
        analyst_brief: cleanAnalystBrief || cleanSummary,
        intelligence: {
          key_entities: u.key_entities || [],
          key_terms: u.key_terms || [],
          main_claims: u.main_claims || [],
          key_numbers: u.key_numbers || [],
          evidence_quality: quality,
          ...(u.event_date ? { event_date: u.event_date, event_date_confidence: u.event_date_confidence } : {}),
          ...(u.source_coverage_type ? {
            source_coverage_type: u.source_coverage_type,
            ...(u.covered_period_start ? { covered_period_start: u.covered_period_start } : {}),
            ...(u.covered_period_end   ? { covered_period_end:   u.covered_period_end   } : {}),
          } : {}),
        },
        claim_extraction_status: "success",
      });
    }

    if (!DRY_RUN) {
      if (updates.length) {
        const { error } = await sb.from("sources").upsert(updates, { onConflict: "id" });
        if (error) { console.error(`  upsert error: ${error.message}`); failed += updates.length; }
      }
      if (demote.length) {
        await sb.from("sources")
          .update({ validation_status: "reject", claim_extraction_status: "irrelevant" })
          .in("id", demote);
      }
    }
    demoted += demote.length;
    processed += batch.length;

    const el = ((Date.now() - t0) / 1000).toFixed(0);
    const eta = Math.round((sources.length - processed) / (processed / Math.max(1, (Date.now() - t0) / 1000)));
    process.stdout.write(`  ${processed}/${sources.length} | retyped ${retyped} | demoted ${demoted} | failed ${failed} | ${el}s | ETA ~${eta}s\r`);
  }

  console.log(`\n\n${"─".repeat(60)}`);
  console.log(`  Done in ${((Date.now() - t0) / 1000).toFixed(0)}s ${DRY_RUN ? "(dry run)" : ""}`);
  console.log(`  Processed: ${processed} | re-typed: ${retyped} | demoted(irrelevant): ${demoted} | failed: ${failed}`);
  console.log(`  Evidence quality:`, JSON.stringify(qualityTally));
  console.log(`  New source_type spread:`, JSON.stringify(Object.entries(typeTally).sort((a,b)=>b[1]-a[1])));
}

import { flushCostBuffer } from "../lib/llm/usagePersistence.js";
main().then(() => flushCostBuffer()).catch(err => { console.error(err); process.exit(1); });
