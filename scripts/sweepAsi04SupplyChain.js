#!/usr/bin/env node
/**
 * sweepAsi04SupplyChain.js — re-judge agentic_ai_threats sources tagged
 * ASI04_agentic_supply_chain that carry a package/registry supply-chain signal,
 * under the refined ASI04 rule (agent-runtime exploitation vs generic
 * build/install-time package compromise). Genuine agent-loaded supply-chain
 * attacks (ClawHub skills, MCP tool poisoning) stay agentic; generic npm/PyPI
 * account-hijack style compromises (Mastra-style) move out.
 *
 * The LLM (updated classify.md) is the judge. Only moves OUT of agentic are
 * persisted; anything it keeps agentic is left untouched. Curated protected;
 * degraded LLM results retried then skipped.
 *
 *   node scripts/sweepAsi04SupplyChain.js --dry-run [--limit N]
 *   node scripts/sweepAsi04SupplyChain.js --persist [--limit N]
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

const SIGNAL = /npm|pypi|package|registry|maintainer|contributor account|hijack|supply.?chain|dependency|typosquat|malicious.*(release|version)/i;

const { createClient } = await import("@supabase/supabase-js");
const { understandSource } = await import("../lib/pipeline/understand/understandSource.js");

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
  const hits = rows.filter(s =>
    (s.tags || []).includes("ASI04_agentic_supply_chain") && SIGNAL.test(s.title || ""));
  return LIMIT ? hits.slice(0, LIMIT) : hits;
}

async function main() {
  const rows = await loadCandidates();
  console.log(`\n${"═".repeat(66)}`);
  console.log(`  Sweep ASI04 supply-chain (agent-runtime vs generic package) · ${DRY_RUN ? "DRY RUN" : "PERSIST"} · ${rows.length} candidates`);
  console.log(`${"═".repeat(66)}\n`);

  let moved = 0, stayed = 0, failed = 0, persisted = 0;
  const dest = {};

  for (let i = 0; i < rows.length; i++) {
    const src = rows[i];
    if (src.trust_tier === "curated") { console.log(`  [${i+1}/${rows.length}] SKIP curated — ${(src.title||"").slice(0,46)}`); stayed++; continue; }
    let r, degraded;
    try { ({ r, degraded } = await classify(src)); }
    catch (e) { console.log(`  [${i+1}/${rows.length}] FAIL — ${e.message.slice(0,50)}`); failed++; continue; }
    if (degraded) { console.log(`  [${i+1}/${rows.length}] SKIP (LLM failed 3x) — ${(src.title||"").slice(0,44)}`); failed++; continue; }

    const to = r.category || "unclear_or_adjacent";
    const moveOut = to !== "agentic_ai_threats";
    if (moveOut) { moved++; dest[to] = (dest[to]||0)+1; } else stayed++;
    console.log(`  [${i+1}/${rows.length}] ${moveOut?"→":"="} ${to.padEnd(22)} [${tagsOnly(r.primary_tags).join(",")}]  ${(src.title||"").slice(0,42)}`);

    if (PERSIST && moveOut) {
      const keep = r.keep;
      const isAdjacent = r.disposition === "adjacent" || to === "unclear_or_adjacent";
      const status = keep ? (r.disposition === "offensive" ? "pass" : "review") : "review";
      const intel = {
        ...(src.intelligence || {}),
        is_defensive: r.is_defensive || false,
        mechanism_classification: r.mechanism_classification || null,
        asi04_supplychain_sweep_at: TODAY,
      };
      const row = {
        id: src.id, main_category: to,
        tags: isAdjacent ? [...new Set([...(r.primary_tags||[]), "adjacent_context"])] : (r.primary_tags || []),
        validation_status: status, layer3_status: status,
        relevance_tier: r.disposition === "offensive" ? "core" : "adjacent",
        ai_specificity_score: r.disposition === "offensive" ? 80 : 40,
        intelligence: intel,
      };
      const { error: upErr } = await supabase.from("sources").update(row).eq("id", src.id);
      if (upErr) console.log(`        DB FAIL: ${upErr.message.slice(0,50)}`);
      else persisted++;
    }
    await sleep(250);
  }

  console.log(`\n${"─".repeat(66)}`);
  console.log(`  Moved out of agentic: ${moved} · kept agentic: ${stayed} · failed: ${failed}`);
  if (PERSIST) console.log(`  Persisted: ${persisted}`);
  console.log(`  Destinations: ${JSON.stringify(dest)}`);
  console.log(`${"─".repeat(66)}\n`);
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
