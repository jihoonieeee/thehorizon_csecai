#!/usr/bin/env node
/**
 * resortCorpus.js — re-run the LLM classifier over a category or the whole corpus.
 *
 * Usage:
 *   node scripts/resortCorpus.js --dry-run [--limit N] [--category llm_threats]
 *   node scripts/resortCorpus.js --persist [--category llm_threats] [--gemini] [--delay 2000]
 *   node scripts/resortCorpus.js --persist --from-skips   # Anthropic retry of skip log
 *
 * --gemini       Use Gemini 2.5 Flash instead of Anthropic (Haiku)
 * --delay N      ms between requests (default: 2000 for Gemini, 600 for Anthropic)
 * --from-skips   Load source IDs from scripts/.resort-skips.json and re-run on Anthropic
 * --category X   Filter to a single main_category
 * --status X     Comma-separated validation_status values (default: pass,review)
 * --limit N      Process at most N sources
 *
 * Skip log: scripts/.resort-skips.json — written after every run; --from-skips consumes it.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

const args     = process.argv.slice(2);
const hasFlag  = f => args.includes(f);
const getArg   = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };

const FROM_SKIPS = hasFlag("--from-skips");
const USE_GEMINI = hasFlag("--gemini") && !FROM_SKIPS;  // --from-skips always uses Anthropic

// ── LLM provider selection ────────────────────────────────────────────────────
if (USE_GEMINI) {
  process.env.LLM_PROVIDER_ORDER = "gemini";
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY_2;
  delete process.env.GROQ_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
} else {
  process.env.LLM_PROVIDER_ORDER = "anthropic";
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY_2;
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY_2;
}

const PERSIST        = hasFlag("--persist");
const DRY_RUN        = !PERSIST;
const LIMIT          = parseInt(getArg("--limit", "0"), 10) || null;
const STATUS         = getArg("--status", "pass,review").split(",").map(s => s.trim()).filter(Boolean);
const CATEGORY       = getArg("--category", null);
const DEFAULT_DELAY  = USE_GEMINI ? 2000 : 600;
const DELAY          = parseInt(getArg("--delay", String(DEFAULT_DELAY)), 10);
const SKIP_LOG       = new URL("../scripts/.resort-skips.json", import.meta.url).pathname;
const TODAY          = new Date().toISOString().slice(0, 10);

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
    // Exponential backoff on LLM errors (e.g. 503 rate-limit)
    const wait = DELAY * 2 * (attempt + 1);
    console.log(`    ↺ retry ${attempt + 1}/3 in ${wait}ms — ${(src.title || "").slice(0, 40)}`);
    await sleep(wait);
  }
  return { r: null, degraded: true };
}

const SEL_BY_IDS = "id,title,url,publisher,date_published,main_category,tags,source_type,trust_tier,short_summary,analyst_brief,full_text,intelligence,validation_status";

async function loadFromSkipLog() {
  if (!existsSync(SKIP_LOG)) throw new Error(`Skip log not found: ${SKIP_LOG}`);
  const ids = JSON.parse(readFileSync(SKIP_LOG, "utf8"));
  if (!ids.length) { console.log("  Skip log is empty — nothing to retry."); process.exit(0); }
  console.log(`  Loading ${ids.length} sources from skip log…`);
  // Fetch in batches of 50 (PostgREST IN limit)
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const { data, error } = await supabase.from("sources").select(SEL_BY_IDS).in("id", batch);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
  }
  return out;
}

async function loadAll() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from("sources").select(SEL).in("validation_status", STATUS)
      .order("date_published", { ascending: false }).range(from, from + 999);
    if (CATEGORY) q = q.eq("main_category", CATEGORY);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
    if (LIMIT && out.length >= LIMIT) break;
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

async function main() {
  const rows = FROM_SKIPS ? await loadFromSkipLog() : await loadAll();
  const providerLabel = USE_GEMINI ? "Gemini 2.5 Flash" : "Anthropic (Haiku)";
  const scopeLabel    = FROM_SKIPS ? "skip-log retry" : CATEGORY ? `category=${CATEGORY}` : "ALL categories";

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  Resort — ${DRY_RUN ? "DRY RUN" : "PERSIST"} · ${rows.length} sources · ${providerLabel}`);
  console.log(`  scope=${scopeLabel} · delay=${DELAY}ms · status=${STATUS.join(",")}`);
  console.log(`${"═".repeat(70)}\n`);

  const moves    = {};
  const skipIds  = [];
  let changed = 0, stayed = 0, failed = 0, persisted = 0, rejected = 0;

  for (let i = 0; i < rows.length; i++) {
    const src = rows[i];
    let r, degraded;
    try { ({ r, degraded } = await classify(src)); }
    catch (e) {
      console.log(`  [${i+1}/${rows.length}] FAIL  ${src.id.slice(0,10)} — ${e.message.slice(0,50)}`);
      skipIds.push(src.id);
      failed++;
      await sleep(DELAY);
      continue;
    }
    if (degraded) {
      console.log(`  [${i+1}/${rows.length}] SKIP  ${(src.title||"").slice(0,55)}`);
      skipIds.push(src.id);
      failed++;
      await sleep(DELAY);
      continue;
    }

    const from = src.main_category || "none";
    const to   = r.category || "unclear_or_adjacent";
    if (to !== from) { changed++; moves[`${from} → ${to}`] = (moves[`${from} → ${to}`]||0)+1; }
    else stayed++;

    if ((i + 1) % 25 === 0 || to !== from) {
      const flag = r.mechanism_classification?.guardrail_flag ? ` ⚠` : "";
      console.log(`  [${i+1}/${rows.length}] ${to===from?"=":"→"} ${to.padEnd(22)} [${tagsOnly(r.primary_tags).join(",")}]${flag}  ${(src.title||"").slice(0,44)}`);
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

    await sleep(DELAY);
  }

  // Write skip log (overwrites previous; --from-skips will clear it on success)
  if (skipIds.length) {
    writeFileSync(SKIP_LOG, JSON.stringify(skipIds, null, 2));
    console.log(`\n  ⚠  ${skipIds.length} skipped → ${SKIP_LOG}`);
    console.log(`     Re-run with: node scripts/resortCorpus.js --persist --from-skips`);
  } else if (FROM_SKIPS) {
    // Clear the log on a clean retry pass
    writeFileSync(SKIP_LOG, JSON.stringify([]));
    console.log(`\n  ✓  All skips resolved — skip log cleared.`);
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  Changed: ${changed} · unchanged: ${stayed} · skipped: ${failed}`);
  if (PERSIST) console.log(`  Persisted: ${persisted} · newly rejected: ${rejected}`);
  if (Object.keys(moves).length) {
    console.log(`  Top moves:`);
    for (const [m, n] of Object.entries(moves).sort((a,b)=>b[1]-a[1]).slice(0, 20))
      console.log(`    ${String(n).padStart(4)}  ${m}`);
  }
  console.log(`${"─".repeat(70)}\n`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
