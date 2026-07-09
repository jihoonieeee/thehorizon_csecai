#!/usr/bin/env node
/**
 * reviewSources.js — LLM-powered triage of all validation_status='review' sources.
 *
 * Every source in 'review' was held by the gate for a structural reason (stale date,
 * trust ceiling, thin content, off_topic relevance, no ai_threat_focus set) but was
 * not hard-rejected. This script applies a fresh, deliberate LLM judgment to each
 * one and commits the result — promoting genuinely relevant sources to 'pass' and
 * clearing irrelevant ones to 'reject', so nothing stays in indefinite limbo.
 *
 * Decision logic (per source, in order):
 *   1. Re-run full validateAndTypeSource (fresh LLM relevance + QA + final gate).
 *      This handles the 76 sources with no ai_threat_focus (never fully validated)
 *      and may promote the 88 passing+high/primary ones via the P1 operational gate.
 *   2. If gate still returns 'review' AND source has rich text (>=300 chars):
 *      — Run a 'review_judgment' LLM call (Sonnet): analyst reads the full excerpt
 *        and gives a final verdict (promote / reject / keep_review) with explicit
 *        reasoning. This catches the 11 'central' sources stuck in review by a
 *        structural flag and high-quality 'passing' sources the gate undervalued.
 *   3. Persist the decision + reasoning. Never touches 'pass' or 'reject' rows.
 *
 * Usage:
 *   node scripts/reviewSources.js --dry-run
 *   node scripts/reviewSources.js --limit 50 --concurrency 3
 *   node scripts/reviewSources.js --focus central        # only central-focus stuck rows
 *   node scripts/reviewSources.js --focus unvalidated    # only null ai_threat_focus rows
 *   node scripts/reviewSources.js --focus all            # default: all 362 (batched)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { validateAndTypeSource } from "../lib/pipeline/validation/validateAndTypeSource.js";
import { routedLLM } from "../lib/llm/llmRouter.js";
import { loadPrompt } from "../lib/prompts/promptLoader.js";

const args    = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const hasFlag = (f) => args.includes(f);
const DRY     = hasFlag("--dry-run");
const LIMIT   = parseInt(getArg("--limit",  "9999"), 10);
const CONC    = parseInt(getArg("--concurrency", "3"), 10);
const FOCUS   = getArg("--focus", "all"); // all | central | unvalidated | passing

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── LLM reviewer prompt ───────────────────────────────────────────────────────
// Runs ONLY when re-validation still returns 'review'. This is the deliberate
// second-opinion call: a Sonnet analyst reads the full source and decides.
const REVIEW_SYSTEM = loadPrompt("scripts/review-sources").system;

const REVIEW_USER = (source) => `Review this source and give a final verdict.

Title: ${source.title || "(no title)"}
Publisher: ${source.publisher || "Unknown"} (trust: ${source.trust_tier || "unknown"})
Source type: ${source.source_type || "unknown"}
AI threat focus (prior gate verdict): ${source.ai_threat_focus || "not set"} | AI specificity score: ${source.ai_specificity_score ?? "n/a"}
Prior validation summary: ${source.validation_summary || "(none)"}

Text excerpt (up to 3000 chars):
${(source.full_text || source.summary || "").slice(0, 3000)}

Return JSON:
{
  "verdict": "promote" | "reject" | "keep_review",
  "category": "traditional_ai_threats" | "llm_threats" | "agentic_ai_threats" | "ai_enabled_threats" | "unclear_or_adjacent" | null,
  "reasoning": "<one sentence: specific evidence for your verdict>",
  "confidence": "high" | "medium" | "low"
}`;

async function llmReview(source) {
  try {
    const { result } = await routedLLM(REVIEW_SYSTEM, REVIEW_USER(source), {
      task: "review_judgment",
      requires_json: true,
      logLabel: `review-${(source.id || "").slice(0, 16)}`,
    });
    if (!result?.verdict) return null;
    return {
      verdict:    ["promote","reject","keep_review"].includes(result.verdict) ? result.verdict : "keep_review",
      category:   result.category || null,
      reasoning:  result.reasoning || "",
      confidence: result.confidence || "medium",
    };
  } catch { return null; }
}

// ── Load review sources ───────────────────────────────────────────────────────
console.log("════════════════════════════════════════════════════════════");
console.log("  LLM Source Review  —  " + new Date().toISOString().slice(0,19).replace("T"," ") + (DRY ? "  [DRY RUN]" : ""));
console.log(`  Focus: ${FOCUS}  Limit: ${LIMIT}  Concurrency: ${CONC}`);
console.log("════════════════════════════════════════════════════════════\n");

let q = sb.from("sources").select("*").eq("validation_status", "review");
const { data: allReview, error } = await q;
if (error) { console.error("DB load:", error.message); process.exit(1); }

let queue = allReview;
if (FOCUS === "central")     queue = queue.filter(r => r.ai_threat_focus === "central");
if (FOCUS === "unvalidated") queue = queue.filter(r => !r.ai_threat_focus);
if (FOCUS === "passing")     queue = queue.filter(r => r.ai_threat_focus === "passing");

queue = queue.slice(0, LIMIT);

console.log(`Review pool: ${allReview.length} total  →  processing ${queue.length} (focus: ${FOCUS})\n`);

const tally = {
  revalidated_to_pass: 0, revalidated_to_reject: 0, still_review: 0,
  llm_promoted: 0, llm_rejected: 0, llm_kept: 0, llm_failed: 0,
  too_thin: 0, saved: 0,
};
const promoted = [], rejected = [];

async function processOne(src) {
  const flen = (src.full_text || "").length;

  // ── Stage 1: re-run full validation gate ────────────────────────────────────
  const v = await validateAndTypeSource(src, { runQa: true });
  let finalStatus = v.validation_status;
  let finalCategory = v.main_category || src.main_category;
  let method = "revalidation";
  let reasoning = v.validation_summary || "";

  if (finalStatus === "pass") {
    tally.revalidated_to_pass++;
  } else if (finalStatus === "reject") {
    tally.revalidated_to_reject++;
  } else {
    // ── Stage 2: still 'review' → LLM analyst second opinion ──────────────
    if (flen < 300) {
      tally.too_thin++;
      // Thin sources: trust the gate's review verdict, don't spend LLM budget
      tally.still_review++;
      return;
    }
    const judgment = await llmReview(src);
    if (!judgment) {
      tally.llm_failed++;
      tally.still_review++;
      return;
    }
    method = "llm_review";
    reasoning = judgment.reasoning;
    if (judgment.verdict === "promote") {
      finalStatus = "pass";
      finalCategory = judgment.category || finalCategory;
      tally.llm_promoted++;
    } else if (judgment.verdict === "reject") {
      finalStatus = "reject";
      tally.llm_rejected++;
    } else {
      tally.llm_kept++;
      tally.still_review++;
      return; // no write needed — status unchanged
    }
  }

  // ── Stage 3: persist ────────────────────────────────────────────────────────
  const statusLine = `  ${finalStatus.padEnd(6)} [${method.padEnd(13)}] ${(src.publisher||"").slice(0,22).padEnd(22)} ${(src.title||"").slice(0,48)}`;
  if (finalStatus === "pass")   promoted.push({ publisher: src.publisher, title: src.title, method, reasoning });
  if (finalStatus === "reject") rejected.push({ publisher: src.publisher, title: src.title, method, reasoning });

  if (!DRY) {
    const { error: uErr } = await sb.from("sources").update({
      validation_status:    finalStatus,
      layer3_status:        finalStatus,
      downstream_route:     finalStatus === "pass" ? "layer4" : "discard",
      source_type:          v.source_type || src.source_type,
      ai_specificity_score: v.ai_specificity_score ?? src.ai_specificity_score,
      relevance_tier:       v.relevance_tier || src.relevance_tier,
      ai_threat_focus:      v.ai_threat_focus || src.ai_threat_focus,
      main_category:        finalCategory || null,
      validation_summary:   reasoning || src.validation_summary || null,
    }).eq("id", src.id);
    if (uErr) { console.log(`  ! update failed: ${uErr.message}`); return; }
    tally.saved++;
  }
  console.log(statusLine + (DRY ? "  [dry]" : ""));
}

// ── Run in bounded concurrency batches ─────────────────────────────────────────
for (let i = 0; i < queue.length; i += CONC) {
  await Promise.all(queue.slice(i, i + CONC).map(processOne));
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n════════════════════════════════════════════════════════════");
console.log(`  Processed: ${queue.length}`);
console.log(`  Gate promoted  → pass:   ${tally.revalidated_to_pass} (re-validation gate)`);
console.log(`  Gate rejected  → reject: ${tally.revalidated_to_reject}`);
console.log(`  LLM promoted   → pass:   ${tally.llm_promoted} (analyst second opinion)`);
console.log(`  LLM rejected   → reject: ${tally.llm_rejected}`);
console.log(`  LLM kept review:         ${tally.llm_kept}   failed: ${tally.llm_failed}   thin: ${tally.too_thin}`);
console.log(`  Still review:            ${tally.still_review}`);
console.log(`  ${DRY ? "Would write" : "Written"}:              ${DRY ? tally.revalidated_to_pass + tally.revalidated_to_reject + tally.llm_promoted + tally.llm_rejected : tally.saved}`);

if (promoted.length) {
  console.log("\n  PROMOTED to pass:");
  for (const r of promoted.slice(0, 30))
    console.log(`    [${r.method}] ${(r.publisher||"").slice(0,20)} — ${(r.title||"").slice(0,54)}`);
  if (promoted.length > 30) console.log(`    … and ${promoted.length - 30} more`);
}
if (rejected.length) {
  console.log("\n  Cleared to reject:");
  for (const r of rejected.slice(0, 20))
    console.log(`    [${r.method}] ${(r.publisher||"").slice(0,20)} — ${(r.title||"").slice(0,54)}`);
  if (rejected.length > 20) console.log(`    … and ${rejected.length - 20} more`);
}

const { flushCostBuffer } = await import("../lib/llm/usagePersistence.js").catch(() => ({}));
if (flushCostBuffer) await flushCostBuffer().catch(() => {});
