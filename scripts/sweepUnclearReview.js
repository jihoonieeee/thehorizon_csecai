#!/usr/bin/env node
/**
 * sweepUnclearReview.js — re-run the classifier over sources flagged in the
 * "others" bucket (main_category=unclear_or_adjacent, validation_status=review)
 * and promote the ones that are genuinely one of the four offensive categories.
 *
 * The LLM is the judge (updated classify.md). Governance/benchmark/survey/
 * reference/defensive content correctly STAYS unclear — only sources the
 * classifier assigns an OFFENSIVE category (disposition==="offensive") are
 * promoted and moved to validation_status=pass. Adjacent/reference calls are
 * reported but left as review, so this can only ADD categories, never demote.
 *
 * Safety: degraded LLM result retried then SKIPPED (never persisted). Curated
 * protected.
 *
 * Usage:
 *   node scripts/sweepUnclearReview.js --dry-run [--limit N]
 *   node scripts/sweepUnclearReview.js --persist [--limit N]
 */

import "dotenv/config";

process.env.LLM_PROVIDER_ORDER = "anthropic";
delete process.env.OPENAI_API_KEY;   delete process.env.OPENAI_API_KEY_2;
delete process.env.GROQ_API_KEY;     delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY_2;

const args    = process.argv.slice(2);
const hasFlag = f => args.includes(f);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const PERSIST = hasFlag("--persist");
const DRY_RUN = !PERSIST;
const LIMIT   = parseInt(getArg("--limit", "0"), 10) || null;
const TODAY   = new Date().toISOString().slice(0, 10);

const { createClient } = await import("@supabase/supabase-js");
const { understandSource } = await import("../lib/pipeline/understand/understandSource.js");
const { computeImportance } = await import("../lib/pipeline/scoring/importance.js");
const { isGenericNoiseCve } = await import("../lib/pipeline/ingest/genericCveGate.js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SEL = "id,title,url,publisher,date_published,main_category,tags,source_type,trust_tier,short_summary,analyst_brief,full_text,intelligence,validation_status";
const OFFENSIVE = new Set(["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"]);
const tagsOnly = a => (a || []).filter(t => /^(TAI|LLM|ASI|AE)\d/.test(t));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isDegraded = r => typeof r?.rejection_reason === "string" && r.rejection_reason.startsWith("LLM error");

async function classify(src) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await understandSource({ ...src });
    if (!isDegraded(r)) return { r, degraded: false };
    await sleep(3000 * (attempt + 1));
  }
  return { r: null, degraded: true };
}

async function loadCandidates() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("sources").select(SEL)
      .eq("main_category", "unclear_or_adjacent").eq("validation_status", "review")
      .order("date_published", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  // Skip clearly-defensive rows — they belong in adjacent by design.
  const cand = rows.filter(s => !s.intelligence?.is_defensive);
  return LIMIT ? cand.slice(0, LIMIT) : cand;
}

async function main() {
  const rows = await loadCandidates();
  console.log(`\n${"═".repeat(66)}`);
  console.log(`  Sweep unclear/review → offensive · ${DRY_RUN ? "DRY RUN" : "PERSIST"} · ${rows.length} candidates · Anthropic`);
  console.log(`${"═".repeat(66)}\n`);

  let promoted = 0, stayed = 0, failed = 0, persisted = 0;
  const dest = {};

  for (let i = 0; i < rows.length; i++) {
    const src = rows[i];
    let r, degraded;
    try { ({ r, degraded } = await classify(src)); }
    catch (e) { console.log(`  [${i+1}/${rows.length}] FAIL — ${e.message.slice(0,50)}`); failed++; continue; }
    if (degraded) { console.log(`  [${i+1}/${rows.length}] SKIP (LLM failed 3x) — ${(src.title||"").slice(0,46)}`); failed++; continue; }

    const to = r.category || "unclear_or_adjacent";
    const isOffensive = OFFENSIVE.has(to) && r.disposition === "offensive" && r.keep && !isGenericNoiseCve(r);

    if (isOffensive) { promoted++; dest[to] = (dest[to]||0)+1; }
    else stayed++;

    const mark = isOffensive ? "→" : "·";
    console.log(`  [${i+1}/${rows.length}] ${mark} ${to.padEnd(22)} [${tagsOnly(r.primary_tags).join(",")}]  ${(src.title||"").slice(0,44)}`);

    if (PERSIST && isOffensive) {
      const intel = {
        ...(src.intelligence || {}),
        is_defensive: r.is_defensive || false,
        mechanism_classification: r.mechanism_classification || null,
        importance: { ...computeImportance(r), scored_at: new Date().toISOString() },
        unclear_review_sweep_at: TODAY,
      };
      const { error: upErr } = await supabase.from("sources").update({
        main_category: to,
        tags: r.primary_tags || [],
        source_type: r.source_type || src.source_type,
        validation_status: "pass",
        layer3_status: "pass",
        relevance_tier: "core",
        ai_specificity_score: 80,
        intelligence: intel,
      }).eq("id", src.id);
      if (upErr) console.log(`        DB FAIL: ${upErr.message.slice(0,50)}`);
      else persisted++;
    }
    await sleep(250);
  }

  console.log(`\n${"─".repeat(66)}`);
  console.log(`  Promoted to offensive: ${promoted} · stayed unclear/adjacent: ${stayed} · failed: ${failed}`);
  if (PERSIST) console.log(`  Persisted: ${persisted}`);
  console.log(`  Destinations: ${JSON.stringify(dest)}`);
  console.log(`${"─".repeat(66)}\n`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
