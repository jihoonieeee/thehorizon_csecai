#!/usr/bin/env node
/**
 * promoteFromCandidateDomain.js — promote miscategorized unclear_or_adjacent sources
 * where L3 already identified an offensive category (candidate_domain) with central focus.
 *
 * These sources were correctly identified by the L3 LLM but ended up stuck in
 * unclear_or_adjacent because classifyNewSources.js skips non-null main_category.
 *
 * Promotion logic (no LLM calls):
 *   candidate_domain ∈ VALID_CATEGORIES + ai_threat_focus = "central"
 *     → main_category = candidate_domain, validation_status = "pass",
 *       layer3_status = "pass", relevance_tier = "core", ai_specificity_score = 80
 *
 *   layer3_status = "review" + main_category ∈ VALID_CATEGORIES (already correct cat)
 *     → fix score/tier only (main_category stays), validation_status stays "pass"
 *
 * Usage:
 *   node scripts/promoteFromCandidateDomain.js [--dry-run] [--limit 500]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes("--dry-run");
const getArg   = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const LIMIT    = parseInt(getArg("--limit", "1000"), 10);

const VALID_CATEGORIES = new Set([
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
]);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Batch 1: unclear_or_adjacent pass/review sources with offensive candidate_domain ──
console.log("Loading unclear_or_adjacent sources with offensive candidate_domain...");
const { data: unclear, error: e1 } = await sb.from("sources")
  .select("id, title, main_category, candidate_domain, ai_threat_focus, validation_status, layer3_status, ai_specificity_score, relevance_tier")
  .eq("main_category", "unclear_or_adjacent")
  .neq("validation_status", "reject")
  .limit(LIMIT);

if (e1) { console.error("Load failed:", e1.message); process.exit(1); }

const toPromote = (unclear || []).filter(r =>
  VALID_CATEGORIES.has(r.candidate_domain) && r.ai_threat_focus === "central"
);

console.log(`  ${unclear.length} unclear_or_adjacent non-reject sources loaded`);
console.log(`  ${toPromote.length} eligible for promotion (offensive candidate_domain + central focus)`);

// ── Batch 2: review-stuck sources in a valid category missing score/tier ──────────
console.log("\nLoading review-stuck sources in valid categories missing score/tier...");
const { data: reviewStuck, error: e2 } = await sb.from("sources")
  .select("id, title, main_category, validation_status, layer3_status, ai_specificity_score, relevance_tier")
  .eq("layer3_status", "review")
  .neq("main_category", "unclear_or_adjacent")
  .not("main_category", "is", null)
  .limit(LIMIT);

if (e2) { console.error("Load failed:", e2.message); process.exit(1); }

const toFixScore = (reviewStuck || []).filter(r =>
  VALID_CATEGORIES.has(r.main_category) && (!r.ai_specificity_score || r.ai_specificity_score === 0)
);

console.log(`  ${reviewStuck.length} review-stuck sources in valid categories`);
console.log(`  ${toFixScore.length} missing score/tier`);

if (DRY_RUN) {
  console.log("\n--- DRY RUN: no writes ---");
  console.log("\nWould promote (sample of 10):");
  for (const r of toPromote.slice(0, 10)) {
    console.log(`  ${r.candidate_domain} ← ${r.title?.substring(0, 60)}`);
  }
  console.log("\nWould fix score/tier (sample of 10):");
  for (const r of toFixScore.slice(0, 10)) {
    console.log(`  ${r.main_category} | ${r.title?.substring(0, 60)}`);
  }
  process.exit(0);
}

// ── Write promotions in batches of 50 ────────────────────────────────────────────
const BATCH = 50;
let promotedCount = 0;
let fixedCount = 0;

if (toPromote.length > 0) {
  console.log("\nPromoting miscategorized unclear_or_adjacent sources...");
  for (let i = 0; i < toPromote.length; i += BATCH) {
    const chunk = toPromote.slice(i, i + BATCH);
    const writes = chunk.map(r => ({
      id:                   r.id,
      main_category:        r.candidate_domain,
      validation_status:    "pass",
      layer3_status:        "pass",
      relevance_tier:       "core",
      ai_specificity_score: 80,
    }));
    const { error } = await sb.from("sources").upsert(writes, { onConflict: "id", ignoreDuplicates: false });
    if (error) {
      console.warn(`  [batch ${i}] write error: ${error.message}`);
    } else {
      promotedCount += chunk.length;
      process.stdout.write(`  ${promotedCount}/${toPromote.length}\r`);
    }
  }
  process.stdout.write("\n");
  console.log(`  Promoted ${promotedCount} sources to their correct categories`);
}

if (toFixScore.length > 0) {
  console.log("\nFixing score/tier for review-stuck sources in valid categories...");
  for (let i = 0; i < toFixScore.length; i += BATCH) {
    const chunk = toFixScore.slice(i, i + BATCH);
    const writes = chunk.map(r => ({
      id:                   r.id,
      relevance_tier:       "core",
      ai_specificity_score: 80,
    }));
    const { error } = await sb.from("sources").upsert(writes, { onConflict: "id", ignoreDuplicates: false });
    if (error) {
      console.warn(`  [batch ${i}] write error: ${error.message}`);
    } else {
      fixedCount += chunk.length;
      process.stdout.write(`  ${fixedCount}/${toFixScore.length}\r`);
    }
  }
  process.stdout.write("\n");
  console.log(`  Fixed score/tier on ${fixedCount} review-stuck sources`);
}

// ── Summary ───────────────────────────────────────────────────────────────────────
console.log("\n=== Summary ===");
console.log(`  Promoted to correct category:   ${promotedCount}`);
console.log(`  Score/tier fixed (review-stuck): ${fixedCount}`);

// Category breakdown for promotions
if (toPromote.length > 0) {
  const byCat = {};
  for (const r of toPromote) byCat[r.candidate_domain] = (byCat[r.candidate_domain] || 0) + 1;
  console.log("\n  Promotions by category:");
  for (const [cat, n] of Object.entries(byCat).sort()) console.log(`    ${cat}: ${n}`);
}

const remaining = (unclear || []).filter(r =>
  !VALID_CATEGORIES.has(r.candidate_domain) || r.ai_threat_focus !== "central"
).length;
console.log(`\n  Remaining unclear_or_adjacent (need LLM reclassify): ${remaining}`);
console.log("  Run: node scripts/classifyNewSources.js --reclassify-unclear --limit 200");
