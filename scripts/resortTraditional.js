#!/usr/bin/env node
/**
 * resortTraditional.js — re-run the v2 (LLM-assigned) classifier over the whole
 * traditional_ai_threats corpus and (optionally) persist the corrected category
 * + tags. Built to validate the new taxonomy prompt against the sources that were
 * over-collected into traditional/TAI10.
 *
 * Forces GEMINI as the LLM (per request): sets LLM_PROVIDER_ORDER=gemini and
 * removes the OpenAI/Groq keys for this process so both routedLLM and the callLLM
 * fallback use Gemini only.
 *
 * Usage:
 *   node scripts/resortTraditional.js --dry-run [--limit N]      # preview only
 *   node scripts/resortTraditional.js --persist [--limit N]      # write changes
 */

import "dotenv/config";

// ── Force Gemini for this process (before importing the classifier) ────────────
process.env.LLM_PROVIDER_ORDER = "gemini";
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY_2;
delete process.env.GROQ_API_KEY;

const args    = process.argv.slice(2);
const hasFlag = f => args.includes(f);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const PERSIST = hasFlag("--persist");
const DRY_RUN = !PERSIST;
const LIMIT   = parseInt(getArg("--limit", "0"), 10) || null;
// --mode traditional (default) | fix-today  (re-classify today's unclear rows to
// correct any that were degraded by an LLM failure) ; --skip-resorted skips rows
// already resorted today (so a resumed traditional run only touches new ones).
const MODE    = getArg("--mode", "traditional");
const SKIP_RESORTED = hasFlag("--skip-resorted");
const TODAY   = new Date().toISOString().slice(0, 10);

const { createClient } = await import("@supabase/supabase-js");
const { understandSource } = await import("../lib/pipeline/understand/understandSource.js");
const { computeImportance } = await import("../lib/pipeline/scoring/importance.js");
const { isGenericNoiseCve } = await import("../lib/pipeline/ingest/genericCveGate.js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SEL = "id,title,url,publisher,date_published,main_category,tags,source_type,trust_tier,short_summary,analyst_brief,full_text,intelligence,validation_status";
const tagsOnly = a => (a || []).filter(t => /^(TAI|LLM|ASI|AE)\d/.test(t));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// An LLM failure returns a degraded { rejection_reason: "LLM error: …" } result —
// never persist that. Retry a few times (Gemini 503s are transient), then skip.
const isDegraded = (r) => typeof r?.rejection_reason === "string" && r.rejection_reason.startsWith("LLM error");
async function classify(src) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await understandSource({ ...src });
    if (!isDegraded(r)) return { r, degraded: false };
    await sleep(3000 * (attempt + 1));   // 3s, 6s, 9s backoff
  }
  return { r: null, degraded: true };
}

async function main() {
  let q = supabase.from("sources").select(SEL).order("date_published", { ascending: false });
  if (MODE === "fix-today") {
    // Re-classify rows resorted today that landed non-offensive — corrects any the
    // LLM failed on (they were degraded to unclear/reject).
    q = q.eq("intelligence->>resorted_v2_at", TODAY).eq("main_category", "unclear_or_adjacent");
  } else {
    q = q.eq("main_category", "traditional_ai_threats").eq("validation_status", "pass");
  }
  if (LIMIT) q = q.limit(LIMIT);
  let { data: rows, error } = await q;
  if (error) throw new Error(error.message);
  if (SKIP_RESORTED) rows = rows.filter(r => r.intelligence?.resorted_v2_at !== TODAY);

  console.log(`\n${"═".repeat(64)}`);
  console.log(`  Resort traditional_ai_threats — ${DRY_RUN ? "DRY RUN" : "PERSIST"} · ${rows.length} sources · Gemini`);
  console.log(`${"═".repeat(64)}\n`);

  const moves = {};   // "from→to" → count
  let changed = 0, stayed = 0, failed = 0, persisted = 0, rejected = 0;

  for (let i = 0; i < rows.length; i++) {
    const src = rows[i];
    let r, degraded;
    try { ({ r, degraded } = await classify(src)); }
    catch (e) { console.log(`  [${i+1}/${rows.length}] FAIL ${src.id.slice(0,10)} — ${e.message.slice(0,60)}`); failed++; continue; }
    if (degraded) { console.log(`  [${i+1}/${rows.length}] SKIP (LLM failed 3x, not persisted) — ${(src.title||"").slice(0,50)}`); failed++; continue; }

    const from = src.main_category;
    const to   = r.category || "unclear_or_adjacent";
    const move = `${from} → ${to}`;
    if (to !== from) { changed++; moves[move] = (moves[move]||0)+1; }
    else stayed++;

    const flag = r.mechanism_classification?.guardrail_flag ? ` ⚠${r.mechanism_classification.guardrail_flag}` : "";
    console.log(`  [${i+1}/${rows.length}] ${to === from ? "=" : "→"} ${to.padEnd(22)} [${tagsOnly(r.primary_tags).join(",")}]${flag}  ${(src.title||"").slice(0,52)}`);

    if (PERSIST) {
      const keep = r.keep && !isGenericNoiseCve(r);
      const isAdjacent = r.disposition === "adjacent";
      // Never hard-reject curated sources — downgrade to review instead.
      const curatedGuard = src.trust_tier === "curated";
      const status = keep ? (isAdjacent ? "review" : "pass") : (curatedGuard ? "review" : "reject");
      const row = {
        id: src.id,
        main_category: keep ? r.category : (curatedGuard ? r.category : "unclear_or_adjacent"),
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
          resorted_v2_at: new Date().toISOString().slice(0, 10),
        },
      };
      if (!keep && !curatedGuard) rejected++;
      const { error: upErr } = await supabase.from("sources").upsert(row, { onConflict: "id" });
      if (upErr) console.log(`        DB FAIL: ${upErr.message.slice(0,60)}`);
      else persisted++;
    }
    await sleep(250);   // gentle on Gemini rate limits
  }

  console.log(`\n${"─".repeat(64)}`);
  console.log(`  Changed category: ${changed} · stayed traditional: ${stayed} · failed: ${failed}`);
  if (PERSIST) console.log(`  Persisted: ${persisted} · newly rejected: ${rejected}`);
  console.log(`  Moves:`);
  for (const [m, n] of Object.entries(moves).sort((a,b)=>b[1]-a[1])) console.log(`    ${n.toString().padStart(4)}  ${m}`);
  console.log(`${"─".repeat(64)}\n`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
