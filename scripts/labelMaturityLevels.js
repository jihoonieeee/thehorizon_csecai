#!/usr/bin/env node
/**
 * labelMaturityLevels.js — Classify all sources on the unified 5-level maturity ladder.
 *
 * Reads sources where intelligence.maturity_level is null (unless --force).
 * Calls the LLM (Haiku by default — cheap, sufficient for classification).
 * Writes intelligence.maturity_level + intelligence.maturity_reason to each source.
 *
 * Usage:
 *   node scripts/labelMaturityLevels.js [--force] [--limit N] [--category KEY] [--dry-run]
 *
 * --force     Re-classify even sources that already have a maturity_level.
 * --limit N   Process at most N sources (default: all).
 * --category  Only process one main_category key.
 * --dry-run   Print classification results without writing to DB.
 */

import "dotenv/config";
import { createClient }          from "@supabase/supabase-js";
import { classifyMaturityLevel, deterministicMaturity, MATURITY_LEVELS, MATURITY_RANK }
  from "../lib/pipeline/scoring/maturityLevel.js";

const args     = process.argv.slice(2);
const hasFlag  = f => args.includes(f);
const getArg   = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };

const FORCE    = hasFlag("--force");
const DRY_RUN  = hasFlag("--dry-run");
const LIMIT    = parseInt(getArg("--limit", "0"), 10) || 0;
const CATEGORY = getArg("--category", "");
const BATCH    = 5;   // parallel LLM calls per batch
const PAUSE_MS = 800; // pause between batches to avoid rate limits

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ── LLM caller — Haiku primary, Gemini fallback ──────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callHaiku(system, user) {
  const key   = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001";
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      signal:  AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model, max_tokens: 256,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
      }),
    });
    if (res.status === 429 || res.status >= 500) { await sleep(8000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Haiku HTTP ${res.status}`);
    const data  = await res.json();
    const text  = data.content?.[0]?.text?.trim() || "";
    const clean = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    const start = clean.search(/\{/);
    return JSON.parse(start >= 0 ? clean.slice(start) : clean);
  }
  throw new Error("Haiku: exhausted retries");
}

async function callGemini(system, user) {
  const key   = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2;
  const model = process.env.GEMINI_LITE_MODEL || "gemini-2.5-flash-lite";
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const prompt = `${system}\n\n${user}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    { method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 256 } }) },
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  const clean = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
  const start = clean.search(/\{/);
  return JSON.parse(start >= 0 ? clean.slice(start) : clean);
}

async function callLLM(system, user) {
  try { return await callHaiku(system, user); } catch {
    return await callGemini(system, user);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("  Label Maturity Levels");
  if (FORCE)   console.log("  --force: re-classifying all sources");
  if (DRY_RUN) console.log("  --dry-run: no writes to DB");
  console.log("═".repeat(60) + "\n");

  // Build query
  let q = supabase
    .from("sources")
    .select("id,title,url,publisher,source_type,main_category,short_summary,analyst_brief,intelligence")
    .eq("validation_status", "pass")
    .not("main_category", "is", null)
    .not("main_category", "eq", "unclear_or_adjacent")
    .order("date_published", { ascending: false });

  if (!FORCE) {
    // Only sources missing maturity_level
    q = q.is("intelligence->>maturity_level", null);
  }
  if (CATEGORY) q = q.eq("main_category", CATEGORY);
  if (LIMIT)    q = q.limit(LIMIT);

  const { data: sources, error } = await q;
  if (error) { console.error("DB error:", error.message); process.exit(1); }
  if (!sources?.length) { console.log("No sources to classify."); return; }

  console.log(`${sources.length} sources to classify\n`);

  const counts = Object.fromEntries(MATURITY_LEVELS.map(l => [l, 0]));
  counts.deterministic = 0;
  counts.errors = 0;
  let done = 0;

  for (let i = 0; i < sources.length; i += BATCH) {
    const batch = sources.slice(i, i + BATCH);
    await Promise.all(batch.map(async src => {
      let result;
      try {
        result = await classifyMaturityLevel(src, callLLM);
      } catch {
        result = deterministicMaturity(src);
        counts.errors++;
      }
      if (result.method === "deterministic") counts.deterministic++;
      counts[result.level] = (counts[result.level] || 0) + 1;

      if (DRY_RUN) {
        console.log(`[${result.method.slice(0,3)}] ${result.level.padEnd(13)} (${result.confidence}) ${src.title?.slice(0,70)}`);
        console.log(`       ${result.reason}`);
      } else {
        const newIntel = {
          ...(src.intelligence || {}),
          maturity_level:      result.level,
          maturity_confidence: result.confidence,
          maturity_reason:     result.reason,
          maturity_method:     result.method,
          maturity_at:         new Date().toISOString(),
        };
        const { error: writeErr } = await supabase
          .from("sources")
          .update({ intelligence: newIntel })
          .eq("id", src.id);
        if (writeErr) {
          console.warn(`  WRITE ERROR ${src.id}: ${writeErr.message}`);
          counts.errors++;
        }
      }
      done++;
      process.stdout.write(`  ${done}/${sources.length}\r`);
    }));
    if (i + BATCH < sources.length) await sleep(PAUSE_MS);
  }

  console.log(`\n\nDone.\n`);
  console.log("Results:");
  const sorted = MATURITY_LEVELS.map(l => [l, counts[l]]).sort(([a], [b]) => MATURITY_RANK[b] - MATURITY_RANK[a]);
  for (const [level, n] of sorted) {
    const bar = "█".repeat(Math.round(n / Math.max(...Object.values(counts)) * 20));
    console.log(`  ${level.padEnd(14)} ${String(n).padStart(4)}  ${bar}`);
  }
  console.log(`  ${"(deterministic)".padEnd(14)} ${String(counts.deterministic).padStart(4)}  (fallback used)`);
  console.log(`  ${"(errors)".padEnd(14)} ${String(counts.errors).padStart(4)}`);
}

main().catch(err => { console.error("\nFatal:", err.message); process.exit(1); });
