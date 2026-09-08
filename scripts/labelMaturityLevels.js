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
import { jsonChat }              from "../lib/llm/jsonChat.js";
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

// ── LLM caller — the shared platform seam (PLATFORM_AI_API_KEY) ──────────────
// Was a bespoke Haiku→Gemini pair reading ANTHROPIC_API_KEY/GEMINI_API_KEY
// directly. Now routes through platformChat like the rest of the codebase, so
// swapping provider or model is an env change (PLATFORM_AI_*), not a code edit.
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callLLM(system, user, opts = {}) {
  return jsonChat({
    // "standard", not "cheap", on purpose. This is a durable corpus-wide write
    // that drives dashboard ranking, and the maturity prompt is ~120 lines of
    // boundary rules. Measured on 8 real sources: the cheap tier spends ~63
    // output tokens (no reasoning) vs standard's ~873, and systematically
    // under-classifies. Whole-corpus delta is ~$3.60 — worth it, once.
    tier:      "standard",
    system,
    user,
    schema:    opts.schema,
    // The maturity prompt is ~2k tokens and Gemini 2.5 thinking tokens count
    // against the cap — too small a budget returns empty text, which used to
    // silently degrade every source to the deterministic fallback. The answer
    // itself is ~80 tokens; the rest of this budget is headroom for thinking.
    maxTokens: 3072,
    timeoutMs: 60000,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("  Label Maturity Levels");
  if (FORCE)   console.log("  --force: re-classifying all sources");
  if (DRY_RUN) console.log("  --dry-run: no writes to DB");
  console.log("═".repeat(60) + "\n");

  // Build query. PostgREST caps a single response at 1000 rows, so this pages
  // explicitly with .range() — without it a >1000-row corpus is silently
  // truncated and the tail is never classified, with no error to signal it.
  const PAGE = 500;
  const baseQuery = () => {
    let q = supabase
      .from("sources")
      .select("id,title,url,publisher,source_type,main_category,short_summary,analyst_brief,intelligence")
      .eq("validation_status", "pass")
      .not("main_category", "is", null)
      .not("main_category", "eq", "unclear_or_adjacent")
      .order("date_published", { ascending: false })
      .order("id", { ascending: true });   // tiebreak — stable paging on duplicate dates

    if (!FORCE) {
      // Only sources missing maturity_level
      q = q.is("intelligence->>maturity_level", null);
    }
    if (CATEGORY) q = q.eq("main_category", CATEGORY);
    return q;
  };

  const sources = [];
  for (let from = 0; ; from += PAGE) {
    const want = LIMIT ? Math.min(PAGE, LIMIT - sources.length) : PAGE;
    if (want <= 0) break;
    const { data: page, error } = await baseQuery().range(from, from + want - 1);
    if (error) { console.error("DB error:", error.message); process.exit(1); }
    if (!page?.length) break;
    sources.push(...page);
    if (page.length < want) break;
  }

  if (!sources.length) { console.log("No sources to classify."); return; }

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
