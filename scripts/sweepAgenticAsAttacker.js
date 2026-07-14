#!/usr/bin/env node
/**
 * sweepAgenticAsAttacker.js — find agentic_ai_threats sources that are really
 * ATTACKER-OPERATED AI campaigns (AI as the weapon, e.g. JADEPUFFER-style
 * "agentic ransomware") and let the LLM re-classify them under the updated
 * classify.md boundary rule ("whose agent is under attack?").
 *
 * We do NOT move on keywords — the signal regex only SELECTS candidates; the
 * Anthropic classifier (with the new boundary rule) is the judge. Attacks that
 * TARGET an agent (prompt injection, goal hijack, memory poisoning) stay agentic.
 *
 * Safety: a degraded LLM result ("LLM error:…") is retried then SKIPPED, never
 * persisted (same guard as resortCorpus.js). Curated sources are protected.
 *
 * Usage:
 *   node scripts/sweepAgenticAsAttacker.js --dry-run [--limit N]
 *   node scripts/sweepAgenticAsAttacker.js --persist [--limit N]
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

const SIGNAL = new RegExp(
  "agentic ransomware|autonomous.*(ransom|intrusion|attack|hack|breach|exfiltrat)|" +
  "AI[- ]agent.*(ransom|hacked|breached|stole|exfiltrat)|" +
  "LLM[- ]?(driven|powered|orchestrated|agent).*(attack|ransom|intrusion|campaign|cyberattack|hacked|exfiltrat)|" +
  "self-?(directed|correcting).*(attack|intrusion)|end-to-end.*autonomous.*(attack|ransom)|" +
  "AI (hacker|attacker).*(exfiltrat|hacked|breach)", "i");

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
      .eq("main_category", "agentic_ai_threats").eq("validation_status", "pass")
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
  console.log(`  Sweep agentic → AI-as-attacker · ${DRY_RUN ? "DRY RUN" : "PERSIST"} · ${rows.length} candidates · Anthropic`);
  console.log(`${"═".repeat(66)}\n`);

  let moved = 0, kept = 0, failed = 0, persisted = 0;
  const moves = {};

  for (let i = 0; i < rows.length; i++) {
    const src = rows[i];
    let r, degraded;
    try { ({ r, degraded } = await classify(src)); }
    catch (e) { console.log(`  [${i+1}/${rows.length}] FAIL — ${e.message.slice(0,50)}`); failed++; continue; }
    if (degraded) { console.log(`  [${i+1}/${rows.length}] SKIP (LLM failed 3x) — ${(src.title||"").slice(0,48)}`); failed++; continue; }

    const to = r.category || "unclear_or_adjacent";
    const changed = to !== "agentic_ai_threats";
    if (changed) { moved++; moves[to] = (moves[to]||0)+1; } else kept++;

    const mark = changed ? "→" : "=";
    console.log(`  [${i+1}/${rows.length}] ${mark} ${to.padEnd(22)} [${tagsOnly(r.primary_tags).join(",")}]  ${(src.title||"").slice(0,46)}`);

    if (PERSIST && changed) {
      const curatedGuard = src.trust_tier === "curated";
      const intel = {
        ...(src.intelligence || {}),
        is_defensive: r.is_defensive || false,
        mechanism_classification: r.mechanism_classification || null,
        importance: { ...computeImportance(r), scored_at: new Date().toISOString() },
        agentic_attacker_sweep_at: TODAY,
      };
      const { error: upErr } = await supabase.from("sources").update({
        main_category: r.category,
        tags: r.primary_tags || [],
        intelligence: intel,
      }).eq("id", src.id);
      if (upErr) console.log(`        DB FAIL: ${upErr.message.slice(0,50)}`);
      else persisted++;
    }
    await sleep(250);
  }

  console.log(`\n${"─".repeat(66)}`);
  console.log(`  Moved out of agentic: ${moved} · kept agentic: ${kept} · failed/skipped: ${failed}`);
  if (PERSIST) console.log(`  Persisted: ${persisted}`);
  console.log(`  Destinations: ${JSON.stringify(moves)}`);
  console.log(`${"─".repeat(66)}\n`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
