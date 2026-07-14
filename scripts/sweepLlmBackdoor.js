#!/usr/bin/env node
/**
 * sweepLlmBackdoor.js — apply the surface-split rule to weight/adapter backdoor
 * sources. A backdoor/poison implanted into an LLM (weights, LoRA/adapter,
 * quantization, or deployment-platform trigger) is LLM03_llm_supply_chain, not
 * TAI02. Classical (non-LLM) model poisoning stays TAI02.
 *
 * We select candidates by a LoRA/backdoor/adapter/poison signal among
 * traditional_ai_threats sources; the updated classify.md prompt (LLM) is the
 * judge — only genuinely LLM-targeted ones move.
 *
 * Safety: degraded LLM result retried then SKIPPED (never persisted). Curated
 * protected. Only moves TO llm_threats are persisted; anything the LLM would
 * send elsewhere (e.g. unclear) is reported but NOT written, to avoid a
 * borderline relevance flip silently rejecting a good source.
 *
 * Usage:
 *   node scripts/sweepLlmBackdoor.js --dry-run [--limit N]
 *   node scripts/sweepLlmBackdoor.js --persist [--limit N]
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

const SIGNAL = /LoRA|adapter|backdoor|trojan|poison|weight.?(implant|tamper)|neural trojan|fine-?tune/i;

const { createClient } = await import("@supabase/supabase-js");
const { understandSource } = await import("../lib/pipeline/understand/understandSource.js");
const { computeImportance } = await import("../lib/pipeline/scoring/importance.js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SEL = "id,title,url,publisher,date_published,main_category,tags,source_type,trust_tier,short_summary,analyst_brief,full_text,intelligence,validation_status";
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
      .eq("main_category", "traditional_ai_threats").eq("validation_status", "pass")
      .order("date_published", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const hits = rows.filter(s => SIGNAL.test(`${s.title || ""} ${s.short_summary || ""}`));
  return LIMIT ? hits.slice(0, LIMIT) : hits;
}

async function main() {
  const rows = await loadCandidates();
  console.log(`\n${"═".repeat(66)}`);
  console.log(`  Sweep TAI backdoor → LLM03 surface-split · ${DRY_RUN ? "DRY RUN" : "PERSIST"} · ${rows.length} candidates · Anthropic`);
  console.log(`${"═".repeat(66)}\n`);

  let movedLlm = 0, stayed = 0, otherFlip = 0, failed = 0, persisted = 0;

  for (let i = 0; i < rows.length; i++) {
    const src = rows[i];
    let r, degraded;
    try { ({ r, degraded } = await classify(src)); }
    catch (e) { console.log(`  [${i+1}/${rows.length}] FAIL — ${e.message.slice(0,50)}`); failed++; continue; }
    if (degraded) { console.log(`  [${i+1}/${rows.length}] SKIP (LLM failed 3x) — ${(src.title||"").slice(0,48)}`); failed++; continue; }

    const to = r.category || "unclear_or_adjacent";
    let mark = "=";
    if (to === "llm_threats") { movedLlm++; mark = "→"; }
    else if (to === "traditional_ai_threats") { stayed++; mark = "="; }
    else { otherFlip++; mark = "?"; }

    console.log(`  [${i+1}/${rows.length}] ${mark} ${to.padEnd(22)} [${tagsOnly(r.primary_tags).join(",")}]  ${(src.title||"").slice(0,44)}`);

    // Only persist the intended move (TAI → llm_threats). Report other flips
    // (e.g. → unclear) without writing, so a borderline relevance call can't
    // silently reject a good source under cover of this sweep.
    if (PERSIST && to === "llm_threats") {
      const intel = {
        ...(src.intelligence || {}),
        is_defensive: r.is_defensive || false,
        mechanism_classification: r.mechanism_classification || null,
        importance: { ...computeImportance(r), scored_at: new Date().toISOString() },
        llm_backdoor_sweep_at: TODAY,
      };
      const { error: upErr } = await supabase.from("sources").update({
        main_category: "llm_threats",
        tags: r.primary_tags || [],
        intelligence: intel,
      }).eq("id", src.id);
      if (upErr) console.log(`        DB FAIL: ${upErr.message.slice(0,50)}`);
      else persisted++;
    }
    await sleep(250);
  }

  console.log(`\n${"─".repeat(66)}`);
  console.log(`  → llm_threats: ${movedLlm} · stayed traditional: ${stayed} · other flip (not written): ${otherFlip} · failed: ${failed}`);
  if (PERSIST) console.log(`  Persisted: ${persisted}`);
  console.log(`${"─".repeat(66)}\n`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
