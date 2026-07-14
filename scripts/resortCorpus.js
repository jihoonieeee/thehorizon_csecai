#!/usr/bin/env node
/**
 * resortCorpus.js — re-run the v2 (LLM-assigned) classifier over the WHOLE corpus
 * and persist the corrected category + tags. Uses ANTHROPIC (Haiku) as the LLM.
 *
 * Safety: an LLM failure returns a degraded { rejection_reason: "LLM error:…" }
 * result — this is retried (backoff) and, if it still fails, SKIPPED (never
 * persisted), so transient API errors can't corrupt classifications.
 *
 * Usage:
 *   node scripts/resortCorpus.js --dry-run [--limit N]
 *   node scripts/resortCorpus.js --persist [--limit N] [--status pass,review]
 */

import "dotenv/config";

// ── Force Anthropic for this process (before importing the classifier) ─────────
process.env.LLM_PROVIDER_ORDER = "anthropic";
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY_2;
delete process.env.GROQ_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY_2;

const args    = process.argv.slice(2);
const hasFlag = f => args.includes(f);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const PERSIST = hasFlag("--persist");
const DRY_RUN = !PERSIST;
const LIMIT   = parseInt(getArg("--limit", "0"), 10) || null;
const STATUS  = getArg("--status", "pass,review").split(",").map(s => s.trim()).filter(Boolean);
const TODAY   = new Date().toISOString().slice(0, 10);

const { createClient } = await import("@supabase/supabase-js");
const { understandSource } = await import("../lib/pipeline/understand/understandSource.js");
const { computeImportance } = await import("../lib/pipeline/scoring/importance.js");
const { isGenericNoiseCve } = await import("../lib/pipeline/ingest/genericCveGate.js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SEL = "id,title,url,publisher,date_published,main_category,tags,source_type,trust_tier,short_summary,analyst_brief,full_text,intelligence,validation_status";
const tagsOnly = a => (a || []).filter(t => /^(TAI|LLM|ASI|AE)\d/.test(t));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const isDegraded = (r) => typeof r?.rejection_reason === "string" && r.rejection_reason.startsWith("LLM error");
async function classify(src) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await understandSource({ ...src });
    if (!isDegraded(r)) return { r, degraded: false };
    await sleep(2500 * (attempt + 1));
  }
  return { r: null, degraded: true };
}

// Load ALL matching rows past PostgREST's 1000-row cap via range pagination.
async function loadAll() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from("sources").select(SEL).in("validation_status", STATUS)
      .order("date_published", { ascending: false }).range(from, from + 999);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
    if (LIMIT && out.length >= LIMIT) break;
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

async function main() {
  const rows = await loadAll();
  console.log(`\n${"═".repeat(66)}`);
  console.log(`  Resort WHOLE CORPUS — ${DRY_RUN ? "DRY RUN" : "PERSIST"} · ${rows.length} sources · Anthropic (Haiku) · status=${STATUS.join(",")}`);
  console.log(`${"═".repeat(66)}\n`);

  const moves = {};
  let changed = 0, stayed = 0, failed = 0, persisted = 0, rejected = 0;

  for (let i = 0; i < rows.length; i++) {
    const src = rows[i];
    let r, degraded;
    try { ({ r, degraded } = await classify(src)); }
    catch (e) { console.log(`  [${i+1}/${rows.length}] FAIL ${src.id.slice(0,10)} — ${e.message.slice(0,50)}`); failed++; continue; }
    if (degraded) { console.log(`  [${i+1}/${rows.length}] SKIP (LLM failed 3x) — ${(src.title||"").slice(0,50)}`); failed++; continue; }

    const from = src.main_category || "none";
    const to   = r.category || "unclear_or_adjacent";
    if (to !== from) { changed++; moves[`${from} → ${to}`] = (moves[`${from} → ${to}`]||0)+1; }
    else stayed++;

    if ((i + 1) % 25 === 0 || to !== from) {
      const flag = r.mechanism_classification?.guardrail_flag ? ` ⚠` : "";
      console.log(`  [${i+1}/${rows.length}] ${to===from?"=":"→"} ${to.padEnd(22)} [${tagsOnly(r.primary_tags).join(",")}]${flag}  ${(src.title||"").slice(0,46)}`);
    }

    if (PERSIST) {
      const keep = r.keep && !isGenericNoiseCve(r);
      const isAdjacent = r.disposition === "adjacent";
      const curatedGuard = src.trust_tier === "curated";
      const status = keep ? (isAdjacent ? "review" : "pass") : (curatedGuard ? "review" : "reject");
      const row = {
        id: src.id,
        main_category: keep || curatedGuard ? r.category : "unclear_or_adjacent",
        tags: isAdjacent ? [...new Set([...(r.primary_tags||[]), "adjacent_context"])] : (r.primary_tags || []),
        source_type: r.source_type,
        trust_tier: r.trust_tier,
        short_summary: r.short_summary || src.short_summary || null,
        validation_status: status,
        layer3_status: status,
        relevance_tier: r.disposition === "offensive" ? "core" : isAdjacent ? "adjacent" : "off_topic",
        ai_specificity_score: r.disposition === "offensive" ? 80 : isAdjacent ? 40 : 0,
        intelligence: {
          ...(src.intelligence || {}),
          is_defensive: r.is_defensive || false,
          defended_category: r.defended_category || null,
          defensive_techniques: r.defensive_techniques || [],
          mechanism_classification: r.mechanism_classification || null,
          importance: { ...computeImportance(r), scored_at: new Date().toISOString() },
          resorted_v2_at: TODAY,
        },
      };
      if (!keep && !curatedGuard) rejected++;
      const { error: upErr } = await supabase.from("sources").upsert(row, { onConflict: "id" });
      if (upErr) console.log(`        DB FAIL: ${upErr.message.slice(0,50)}`);
      else persisted++;
    }
    await sleep(150);
  }

  console.log(`\n${"─".repeat(66)}`);
  console.log(`  Changed: ${changed} · unchanged: ${stayed} · failed/skipped: ${failed}`);
  if (PERSIST) console.log(`  Persisted: ${persisted} · newly rejected: ${rejected}`);
  console.log(`  Top moves:`);
  for (const [m, n] of Object.entries(moves).sort((a,b)=>b[1]-a[1]).slice(0, 20)) console.log(`    ${String(n).padStart(4)}  ${m}`);
  console.log(`${"─".repeat(66)}\n`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
