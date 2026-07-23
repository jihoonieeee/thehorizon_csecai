#!/usr/bin/env node
/**
 * classify.js — L4a–f: classify all unclassified sources.
 *
 * Queries every source with main_category IS NULL (regardless of age or origin —
 * connector sources, web discovery sources, digest children all flow through here)
 * and runs the full classification pipeline:
 *
 *   L4a  digestFanout          — split multi-topic reports into per-finding children
 *   L4b  understandAllSources  — LLM classify.md call; writes main_category, tags,
 *                                short_summary, key_entities, claim_extraction_status='success'
 *   L4c  qaClassificationLLM   — cross-model QA verifier; auto-fixes misclassifications
 *   L4d  assessSignificance    — research significance overlay (research_finding sources)
 *   L4e  runScoringPass        — reading_value, importance tier, LLM maturity upgrade
 *   L4f  category rollup       — refresh digest parent intelligence.all_categories
 *
 * Sources that pass produce claim_extraction_status='success'. Sources the LLM
 * deems irrelevant are set to validation_status='reject'.
 *
 * Usage:
 *   node scripts/classify.js [--limit N] [--sig-limit N]
 *
 * Options:
 *   --limit N      Max sources to classify per run (default 200). Newest first.
 *   --sig-limit N  Max significance LLM calls (default 100).
 */

import "dotenv/config";
import { createClient }          from "@supabase/supabase-js";
import { understandAllSources }  from "../lib/pipeline/understand/understandSource.js";
import { qaClassificationLLM }   from "../lib/pipeline/understand/qaClassification.js";
import { detectDigest, fanOutDigest } from "../lib/pipeline/ingest/digestFanout.js";
import { extractAndSaveReportInsights } from "../lib/pipeline/ingest/extractLongReportInsights.js";
import {
  assessSignificance,
  isSignificanceEligible,
} from "../lib/pipeline/scoring/researchSignificance.js";
import { computeImportance }     from "../lib/pipeline/scoring/importance.js";
import { classifyMaturityLevel } from "../lib/pipeline/scoring/maturityLevel.js";
import { upgradeDate }           from "../lib/pipeline/ingest/upgradeDate.js";
import { upgradeText }           from "../lib/pipeline/ingest/upgradeText.js";
import { routedLLM }             from "../lib/llm/llmRouter.js";
import { callLLM }               from "../lib/llm/callLLM.js";
import { flushCostBuffer }       from "../lib/llm/usagePersistence.js";

const args     = process.argv.slice(2);
const getArg   = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIMIT    = parseInt(getArg("--limit",     "200"), 10);
const SIG_LIMIT= parseInt(getArg("--sig-limit", "100"), 10);
const DIGEST_CAP = 10;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const llmFn    = (sys, usr, opts) => callLLM(sys, usr, opts);
const sigLlmFn = async (sys, usr, opts) => {
  const { result } = await routedLLM(sys, usr, {
    task: "research_significance",
    requires_json: true,
    schema: opts.schema,
  });
  return result;
};

// ── L4d: Research significance ─────────────────────────────────────────────────
async function runSignificance(newlyScoredIds) {
  console.log("\n── L4d: Research significance ─────────────────────────────────");

  const { data: rows, error } = await supabase
    .from("sources")
    .select("id,title,publisher,tags,source_type,short_summary,summary,full_text,intelligence")
    .in("source_type", ["research_finding", "benchmark_evaluation"])
    .eq("validation_status", "pass")
    .is("intelligence->significance", null)
    .order("date_published", { ascending: false })
    .limit(SIG_LIMIT * 2);

  if (error) { console.warn("  Significance DB load failed:", error.message); return; }
  if (!rows?.length) { console.log("  No unscored research sources."); return; }

  const thisRunSet = new Set(newlyScoredIds);
  const todo = [
    ...rows.filter(r => thisRunSet.has(r.id)),
    ...rows.filter(r => !thisRunSet.has(r.id)),
  ].slice(0, SIG_LIMIT);

  console.log(`  ${rows.length} unscored; scoring ${todo.length}`);

  const scoredAt = new Date().toISOString();
  const dist = {};
  let written = 0;

  for (const s of todo) {
    if (!isSignificanceEligible(s)) continue;
    let sig;
    try {
      sig = await assessSignificance(s, { llmFn: sigLlmFn, scoredAt });
    } catch (e) {
      console.warn(`  ✗ ${s.id.slice(0, 8)} — ${e.message.slice(0, 60)}`);
      continue;
    }
    if (!sig) continue;
    dist[sig.level] = (dist[sig.level] || 0) + 1;
    const mark = sig.level === "landmark" ? "★" : sig.level === "notable" ? "▸" : " ";
    console.log(`  ${mark} [${sig.level}] ${s.title?.slice(0, 70)}`);
    const { error: we } = await supabase
      .from("sources")
      .update({ intelligence: { ...(s.intelligence || {}), significance: sig } })
      .eq("id", s.id);
    if (we) console.warn(`      ! write: ${we.message.slice(0, 60)}`);
    else written++;
  }

  console.log(`  Wrote ${written} significance records — ${JSON.stringify(dist)}`);
}

// ── L4e: Scoring pass ──────────────────────────────────────────────────────────
async function runScoringPass(sources) {
  console.log(`\n── L4e: Scoring (reading_value / importance / maturity) ───────`);
  if (!sources.length) { console.log("  Nothing to score."); return; }

  const now  = new Date().toISOString();
  const CONC = 4;
  let rvCount = 0, impCount = 0, matCount = 0;

  for (let i = 0; i < sources.length; i += CONC) {
    const batch = sources.slice(i, i + CONC);
    await Promise.all(batch.map(async (s) => {
      const updates = {};

      if (!s.reading_value) {
        const imp = computeImportance(s);
        updates.reading_value =
          imp.tier === "realized"                                           ? "essential"
          : (imp.tier === "proven" && s.source_type === "threat_intelligence") ? "essential"
          : imp.tier === "proven"                                           ? "recommended"
          : imp.tier === "noise"                                            ? "background"
          : "analyst";
        rvCount++;
      }

      const imp = computeImportance(s);
      updates.intelligence = { ...(s.intelligence || {}), importance: imp };
      impCount++;

      if (s.intelligence?.maturity_method === "deterministic") {
        try {
          const m = await classifyMaturityLevel(s, callLLM);
          updates.intelligence = {
            ...updates.intelligence,
            maturity_level:      m.level,
            maturity_confidence: m.confidence,
            maturity_reason:     m.reason,
            maturity_method:     m.method,
            maturity_at:         now,
          };
          matCount++;
        } catch { /* non-blocking */ }
      }

      // Deterministic date upgrade: if full_text contains an explicit publish
      // date that agrees with the stored date, promote confidence to "exact".
      const dateUp = upgradeDate(s);
      if (dateUp) {
        updates.date_published  = dateUp.date_published;
        updates.date_confidence = dateUp.date_confidence;
      }

      // Text upgrade: re-fetch via Jina when full_text is below the usable
      // threshold (navigation stubs, paywalled previews, RSS teasers).
      const textUp = await upgradeText(s);
      if (textUp) {
        updates.full_text = textUp.full_text;
        console.log(`  [text-upgrade] ${s.id.slice(0,8)}: ${(s.full_text||"").length} → ${textUp.full_text.length} chars`);
      }

      if (Object.keys(updates).length > 0) {
        supabase.from("sources").update(updates).eq("id", s.id)
          .then(({ error }) => { if (error) console.warn(`  [L4e] ${s.id.slice(0,8)}: ${error.message}`); })
          .catch(() => {});
      }
    }));
  }

  console.log(`  reading_value: ${rvCount}  importance: ${impCount}  maturity-upgrade: ${matCount}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  L4 Classify — ${new Date().toISOString().slice(0, 16)} UTC`);
  console.log(`  limit: ${LIMIT}  sig-limit: ${SIG_LIMIT}`);
  console.log(`${"═".repeat(60)}`);

  // ── Load all unclassified sources ──────────────────────────────────────────
  // main_category IS NULL is the authoritative "not yet classified" signal.
  // No time filter — classify everything pending, newest first, up to --limit.
  console.log("\n── Load: unclassified sources ─────────────────────────────────");

  const { data, error } = await supabase
    .from("sources")
    .select("id,title,url,publisher,source_type,trust_tier,full_text,clean_text,summary,main_category,validation_status,layer3_status,candidate_domain,ai_threat_focus,date_published,is_digest,parent_source_id,intelligence")
    .is("main_category", null)
    .or("validation_status.neq.reject,validation_status.is.null")
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  if (error) { console.error("DB load failed:", error.message); process.exit(1); }
  if (!data?.length) { console.log("  No unclassified sources. Done."); return; }
  console.log(`  ${data.length} sources loaded\n`);

  const scoredAt = new Date().toISOString();

  // ── L4a: Digest fanout ──────────────────────────────────────────────────────
  console.log("\n── L4a: Digest fanout ─────────────────────────────────────────");

  const digestDetected = data.map(s => ({ s, isDigest: detectDigest(s).is_digest && !s.parent_source_id }));
  const digestSources  = digestDetected.filter(x => x.isDigest).map(x => x.s).slice(0, DIGEST_CAP);
  const singleSources  = digestDetected.filter(x => !x.isDigest).map(x => x.s);

  let fanoutCount = 0;
  const allChildren    = [];
  const fallbackSingles = [];

  for (const digestSrc of digestSources) {
    try {
      const { is_digest, children, parent_patch } = await fanOutDigest(digestSrc, { llmFn, scoredAt });
      if (!is_digest || !children.length) {
        fallbackSingles.push(digestSrc);
        continue;
      }
      await supabase.from("sources").upsert(children, { onConflict: "id", ignoreDuplicates: false });
      allChildren.push(...children);
      await supabase.from("sources").update({
        is_digest:         true,
        main_category:     "unclear_or_adjacent",
        validation_status: "pass",
        layer3_status:     "pass",
        intelligence: { ...(digestSrc.intelligence || {}), ...parent_patch.intelligence },
      }).eq("id", digestSrc.id);
      extractAndSaveReportInsights(
        { ...digestSrc, intelligence: { ...(digestSrc.intelligence || {}), ...parent_patch?.intelligence }, is_digest: true },
        supabase,
      ).catch(() => {});
      fanoutCount += children.length;
    } catch (err) {
      console.warn(`  [fanout] ${digestSrc.id} failed: ${err.message.slice(0, 80)}`);
      fallbackSingles.push(digestSrc);
    }
  }
  console.log(`  ${fanoutCount} children from ${digestSources.length} digest(s); ${fallbackSingles.length} fallback(s)`);

  // ── L4b: Classify ──────────────────────────────────────────────────────────
  console.log("\n── L4b: Classify ──────────────────────────────────────────────");

  const toClassify = [
    ...singleSources.map(s => ({ ...s, main_category: null, layer3_status: null })),
    ...fallbackSingles.map(s => ({ ...s, main_category: null, layer3_status: null })),
    ...allChildren,
  ];

  const { relevant, discarded, counts } = await understandAllSources(
    toClassify,
    { skipLlm: false, supabase, concurrency: 4 },
  );
  console.log(`  Classified: ${relevant.length} relevant / ${discarded.length} discarded`);

  const newResearchIds = relevant
    .filter(s => !s._from_cache && isSignificanceEligible(s))
    .map(s => s.id);

  // Fire-and-forget deep extraction for long threat intel reports.
  const longThreatIntel = relevant.filter(s => !s._from_cache && s.source_type === "threat_intelligence");
  if (longThreatIntel.length) {
    console.log(`  [report-insights] queuing ${longThreatIntel.length} threat intel source(s)`);
    for (const s of longThreatIntel) extractAndSaveReportInsights(s, supabase).catch(() => {});
  }

  // ── L4c: QA ────────────────────────────────────────────────────────────────
  console.log("\n── L4c: Classification QA ─────────────────────────────────────");
  const { report } = await qaClassificationLLM(relevant, {
    skipLlm: false, full: true, concurrency: 3, supabase,
  });
  console.log(`  QA: ${report.agreed}/${report.checked} agreed, ${report.fixed} auto-fixed (${report.agreement_rate.toFixed(0)}%)`);

  // ── L4d: Research significance ─────────────────────────────────────────────
  await runSignificance(newResearchIds);

  // ── L4e: Scoring ───────────────────────────────────────────────────────────
  if (relevant.length > 0) {
    await runScoringPass(relevant.filter(s => !s._from_cache));
  }

  // ── L4f: Sync digest parent metadata ──────────────────────────────────────
  // When L4a split a multi-topic report, the parent container was marked
  // is_digest=true and its main_category was set to unclear_or_adjacent (it has
  // no single topic). Now that the children are classified, we write two things
  // back to the parent:
  //
  //   1. intelligence.all_categories — the distinct categories across all children
  //      (e.g. ["agentic_ai_threats","llm_threats"]). The Sources page reads this
  //      to show category badges on digest containers.
  //
  //   2. Date fix — the fanout LLM occasionally infers a different date for a child
  //      than the parent has. Overwrite any drifted child dates with the parent's
  //      authoritative date so all children share the same publication date.
  //
  // This step only runs when children were classified in this run (affectedParentIds
  // is the set of parent IDs whose children just got a main_category assigned).
  const affectedParentIds = [...new Set(
    [...relevant, ...discarded].map(s => s.parent_source_id).filter(Boolean),
  )];
  if (affectedParentIds.length) {
    console.log(`\n── L4f: Sync digest parent metadata (${affectedParentIds.length} parents) ──`);
    let synced = 0, dateFixes = 0;
    for (const pid of affectedParentIds) {
      const { data: parent } = await supabase
        .from("sources").select("id,date_published,date_confidence,intelligence").eq("id", pid).single();
      if (!parent) continue;
      const { data: children } = await supabase
        .from("sources").select("id,main_category,date_published").eq("parent_source_id", pid);
      if (!children?.length) continue;

      // Write all_categories to parent.
      const allCats = [...new Set(children.map(c => c.main_category).filter(Boolean))].sort();
      await supabase.from("sources").update({
        intelligence: { ...(parent.intelligence || {}), all_categories: allCats },
      }).eq("id", pid);
      synced++;

      // Fix children whose date drifted from the parent's.
      const toFix = children.filter(c => parent.date_published && c.date_published !== parent.date_published);
      if (toFix.length) {
        await supabase.from("sources")
          .update({ date_published: parent.date_published, date_confidence: parent.date_confidence || "exact" })
          .in("id", toFix.map(c => c.id));
        dateFixes += toFix.length;
      }
    }
    console.log(`  Synced ${synced} parents, fixed ${dateFixes} child dates`);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  By category: ${JSON.stringify(counts?.by_category || {})}`);
  console.log("  Done.\n");
}

main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error(err); process.exit(1); });
