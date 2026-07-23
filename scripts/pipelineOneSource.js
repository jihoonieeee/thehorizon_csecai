#!/usr/bin/env node
/**
 * pipelineOneSource.js — run the full L4a–L5 pipeline on specific source IDs.
 *
 * Forces LLM_PROVIDER_ORDER=anthropic so Claude Sonnet handles all calls.
 *
 * Usage:
 *   node scripts/pipelineOneSource.js <id1> [id2 ...]
 *
 * Runs:
 *   L4a  detectDigest + fanOutDigest  — split roundups into children
 *   L4b  understandAllSources         — classify + short_summary + tags
 *   L4c  qaClassificationLLM          — cross-model QA (skipped: Anthropic-only mode)
 *   L4e  scoring pass                 — reading_value, importance, date upgrade
 *   L5   extractAllEvidence           — evidence items saved to evidence table
 */

process.env.LLM_PROVIDER_ORDER = "anthropic";

import "dotenv/config";
import { createClient }              from "@supabase/supabase-js";
import { detectDigest, fanOutDigest } from "../lib/pipeline/ingest/digestFanout.js";
import { extractAndSaveReportInsights } from "../lib/pipeline/ingest/extractLongReportInsights.js";
import { understandAllSources }      from "../lib/pipeline/understand/understandSource.js";
import { computeImportance }         from "../lib/pipeline/scoring/importance.js";
import { upgradeDate }               from "../lib/pipeline/ingest/upgradeDate.js";
import { extractAllEvidence }        from "../lib/pipeline/extraction/extractEvidence.js";
import { callLLM }                   from "../lib/llm/callLLM.js";
import { flushCostBuffer }           from "../lib/llm/usagePersistence.js";

const IDS = process.argv.slice(2);
if (!IDS.length) { console.error("Usage: node pipelineOneSource.js <id1> [id2...]"); process.exit(1); }

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const llmFn = (sys, usr, opts) => callLLM(sys, usr, opts);

const OFFENSIVE_CATS = ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"];
const READING_FROM_IMP = { realized:"essential", proven:"recommended", research:"analyst", reference:"analyst", noise:"background" };

const W = 70;
const HR = "─".repeat(W);

// ── Load sources ──────────────────────────────────────────────────────────────

const { data: sources, error: loadErr } = await sb
  .from("sources")
  .select("id,title,url,publisher,source_type,trust_tier,main_category,tags,full_text,clean_text,short_summary,intelligence,source_family,reading_value,date_published,date_confidence,validation_status,layer3_status,is_digest,parent_source_id")
  .in("id", IDS);

if (loadErr) { console.error("Load error:", loadErr.message); process.exit(1); }
if (!sources?.length) { console.error("No sources found for IDs:", IDS); process.exit(1); }

console.log(`\n${"═".repeat(W)}`);
console.log(`  Pipeline run — ${new Date().toISOString().slice(0,16)} UTC`);
console.log(`  Provider: Anthropic (Claude Sonnet)  Sources: ${sources.length}`);
console.log(`  IDs: ${IDS.join(", ")}`);
console.log(`${"═".repeat(W)}\n`);

// ── L4a: Digest fanout ────────────────────────────────────────────────────────

console.log(`── L4a: Digest fanout ${"─".repeat(50)}`);
const scoredAt   = new Date().toISOString();
const toFanout   = sources.filter(s => detectDigest(s).is_digest && !s.parent_source_id);
const toClassify = sources.filter(s => !toFanout.find(d => d.id === s.id));
const allChildren = [];
const fallbackSingles = [];

for (const src of toFanout) {
  const det = detectDigest(src);
  console.log(`  ${src.title?.slice(0,60)} → detectDigest: ${det.reason}`);
  try {
    const { is_digest, children, parent_patch, reason } = await fanOutDigest(src, { llmFn, scoredAt });
    if (!is_digest || !children.length) {
      console.log(`  ✗ LLM: not a digest (${reason}) — treating as single source`);
      fallbackSingles.push(src);
      continue;
    }
    console.log(`  ✓ ${children.length} children extracted:`);
    for (const c of children) console.log(`      [${c.main_category || "?"}] ${c.title?.slice(0,60)}`);

    await sb.from("sources").upsert(children, { onConflict: "id", ignoreDuplicates: false });
    allChildren.push(...children);

    // Mark parent as digest container
    await sb.from("sources").update({
      is_digest:         true,
      main_category:     "unclear_or_adjacent",
      validation_status: "pass",
      layer3_status:     "pass",
      intelligence: { ...(src.intelligence || {}), ...(parent_patch?.intelligence || {}) },
    }).eq("id", src.id);

    // Fire-and-forget report insights
    extractAndSaveReportInsights(
      { ...src, intelligence: { ...(src.intelligence || {}), ...(parent_patch?.intelligence || {}), is_digest: true } },
      sb,
    ).catch(() => {});

  } catch (err) {
    console.warn(`  ✗ fanout error: ${err.message.slice(0,80)}`);
    fallbackSingles.push(src);
  }
}
console.log(`  ${allChildren.length} children, ${fallbackSingles.length} fallback singles\n`);

// ── L4b: Classify ────────────────────────────────────────────────────────────

console.log(`── L4b: Classify ${"─".repeat(54)}`);
const classify_targets = [
  // Force re-classification by stripping the cache gate fields
  ...[...toClassify, ...fallbackSingles].map(s => ({ ...s, layer3_status: null, main_category: null })),
  ...allChildren,
];

if (!classify_targets.length) {
  console.log("  Nothing to classify.");
} else {
  const { relevant, discarded, counts } = await understandAllSources(
    classify_targets,
    { skipLlm: false, supabase: sb, concurrency: 2 },
  );
  console.log(`  Classified: ${relevant.length} relevant / ${discarded.length} discarded`);
  console.log(`  By category: ${JSON.stringify(counts?.by_category || {})}`);

  for (const r of relevant) {
    console.log(`\n  ✓ [${r.category || r.main_category}] ${r.title?.slice(0,60)}`);
    console.log(`    tags: ${(r.primary_tags || []).join(", ") || "(none)"}`);
    console.log(`    summary: ${(r.short_summary || "").slice(0,120)}`);
  }
  for (const d of discarded) {
    console.log(`  ✗ discard: ${d.title?.slice(0,60)} — ${d.rejection_reason || "?"}`);
  }

  // ── L4e: Scoring pass ──────────────────────────────────────────────────────
  console.log(`\n── L4e: Scoring ${"─".repeat(55)}`);
  const to_score = relevant.filter(s => !s._from_cache);
  for (const r of to_score) {
    // Re-fetch to get what was actually persisted
    const { data: fresh } = await sb.from("sources")
      .select("id,main_category,source_type,trust_tier,reading_value,full_text,date_published,date_confidence,intelligence,tags")
      .eq("id", r.id).single();
    if (!fresh) continue;

    const updates = {};
    const imp = computeImportance(fresh);
    const expRead = (imp.tier === "proven" && fresh.source_type === "threat_intelligence")
      ? "essential" : (READING_FROM_IMP[imp.tier] ?? "background");

    if (!fresh.reading_value) { updates.reading_value = expRead; }
    updates.intelligence = { ...(fresh.intelligence || {}), importance: imp };

    const dateUp = upgradeDate(fresh);
    if (dateUp) {
      updates.date_published  = dateUp.date_published;
      updates.date_confidence = dateUp.date_confidence;
      console.log(`  date upgraded → ${dateUp.date_published} (exact)`);
    }

    if (Object.keys(updates).length) {
      await sb.from("sources").update(updates).eq("id", fresh.id);
      console.log(`  scored ${fresh.id.slice(0,8)}: importance=${imp.tier} reading=${updates.reading_value || fresh.reading_value}`);
    }
  }

  // ── L4f: Sync parent metadata ──────────────────────────────────────────────
  const parentIds = [...new Set([...relevant, ...discarded].map(s => s.parent_source_id).filter(Boolean))];
  if (parentIds.length) {
    console.log(`\n── L4f: Sync parent metadata (${parentIds.length}) ${"─".repeat(34)}`);
    for (const pid of parentIds) {
      const { data: parent } = await sb.from("sources").select("id,date_published,intelligence").eq("id", pid).single();
      const { data: kids }   = await sb.from("sources").select("id,main_category,date_published").eq("parent_source_id", pid);
      if (!parent || !kids?.length) continue;
      const allCats = [...new Set(kids.map(c => c.main_category).filter(Boolean))].sort();
      await sb.from("sources").update({ intelligence: { ...(parent.intelligence || {}), all_categories: allCats } }).eq("id", pid);
      console.log(`  parent ${pid.slice(0,8)}: all_categories = [${allCats.join(", ")}]`);
    }
  }
}

// ── L5: Evidence extraction ───────────────────────────────────────────────────

console.log(`\n── L5: Evidence extraction ${"─".repeat(44)}`);

// Collect all IDs to extract: original sources + children
const allIds = [...new Set([
  ...IDS,
  ...allChildren.map(c => c.id),
])];

const { data: ev_sources } = await sb
  .from("sources")
  .select("id,title,url,publisher,source_type,trust_tier,main_category,tags,full_text,clean_text,reading_value,intelligence")
  .in("id", allIds)
  .in("main_category", OFFENSIVE_CATS);

const eligible = (ev_sources || []).filter(s => {
  const text = s.full_text || s.clean_text || "";
  if (text.length < 600)                               return false;
  if (s.trust_tier === "low")                          return false;
  if (!["essential","recommended"].includes(s.reading_value)
      && !["operational","observed"].includes(s.intelligence?.maturity_level)) return false;
  return true;
});

if (!eligible.length) {
  console.log("  No eligible sources for evidence extraction.");
} else {
  console.log(`  ${eligible.length} eligible source(s) — extracting...`);
  const result = await extractAllEvidence(
    eligible.map(s => ({ ...s, category: s.main_category })),
    OFFENSIVE_CATS,
    { supabase: sb, concurrency: 2, onProgress: (d,t) => process.stdout.write(`    ${d}/${t}\r`) },
  );
  process.stdout.write("\n");

  for (const [id, items] of Object.entries(result?.bySource || {})) {
    const src = eligible.find(s => s.id === id);
    console.log(`\n  ✓ ${src?.title?.slice(0,55)} — ${items?.length ?? 0} items`);
    for (const item of (items || []).slice(0, 3)) {
      console.log(`    [${item.evidence_type}/${item.specificity}] ${item.fact?.slice(0,80)}`);
    }
  }
}

await flushCostBuffer();
console.log(`\n${"═".repeat(W)}\n  Done.\n${"═".repeat(W)}\n`);
