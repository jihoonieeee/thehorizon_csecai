#!/usr/bin/env node
/**
 * Horizon Scan v2 — Simplified Pipeline CLI
 *
 * Runs the v2 pipeline (understandSource → extractEvidence → synthesizeCategory
 * → buildPresentation) on sources from the Supabase database or a test fixture set.
 *
 * Usage:
 *   node scripts/runHorizonScanV2.js [options]
 *
 * Options:
 *   --days <n>           Lookback window in days (default: 30)
 *   --limit <n>          Max sources to load (default: 200)
 *   --category <cat>     Filter by threat category
 *   --no-llm             Deterministic mode (no LLM calls, for testing)
 *   --no-slides          Skip slide generation (synthesis only)
 *   --no-persist         Do not write results to Supabase
 *   --out <dir>          Custom output directory (default: outputs/v2/<run_id>)
 *   --classify-only      Run L4 classification only: sets main_category on Supabase
 *                        source rows and marks irrelevant ones as rejected.
 *                        Does NOT run L5-L7 or generate slides.
 *   --unclassified-only  Load only sources that need (re)classification: null main_category
 *                        OR the legacy 'uncategorised' value. Skips already-rejected sources.
 *   --purge              Delete sources classified as unclear_or_adjacent or with the legacy
 *                        'uncategorised' category from the DB. Run after --classify-only.
 *
 * Examples:
 *   node scripts/runHorizonScanV2.js --days 7
 *   node scripts/runHorizonScanV2.js --days 180 --limit 500 --classify-only
 *   node scripts/runHorizonScanV2.js --days 180 --limit 500 --classify-only --unclassified-only
 *   node scripts/runHorizonScanV2.js --purge
 *   node scripts/runHorizonScanV2.js --category llm_threats --days 90
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient }  from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag, def = null) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
function hasFlag(f) { return args.includes(f); }

const DAYS             = parseInt(getArg("--days", "30"), 10);
const LIMIT            = parseInt(getArg("--limit", "200"), 10);
const CATEGORY         = getArg("--category");
const NO_LLM           = hasFlag("--no-llm");
const NO_SLIDES        = hasFlag("--no-slides");
const NO_PERSIST       = hasFlag("--no-persist");
const OUT_DIR          = getArg("--out");
const CLASSIFY_ONLY    = hasFlag("--classify-only");
const UNCLASSIFIED_ONLY= hasFlag("--unclassified-only");
const PURGE            = hasFlag("--purge");

// ── Helpers ───────────────────────────────────────────────────────────────────

function save(dir, name, data) {
  const p = path.join(dir, name);
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(p, content);
  console.log(`  → ${name}`);
  return p;
}

function exportMarkdown(result) {
  const { category_analyses, corpus_summary, cross_category, deck } = result;
  const lines = [];

  lines.push(`# AI Threat Intelligence Report`);
  lines.push(`\n**Run ID**: \`${result.run_id}\`  `);
  lines.push(`**Date**: ${result.run_date.slice(0, 10)}  `);
  lines.push(`**Sources**: ${result.counts.sources_relevant} relevant of ${result.counts.sources_input} total  `);
  lines.push(`**Period**: ${corpus_summary.date_range}\n`);

  // Executive summary
  lines.push(`\n## Executive Summary\n`);
  lines.push(corpus_summary.synthesis_context + "\n");

  const topJudgments = category_analyses.flatMap(ca =>
    (ca.judgments || []).filter(j => !j.blocked && j.confidence === "high")
  ).slice(0, 3);
  if (topJudgments.length > 0) {
    lines.push(`**Key findings:**`);
    for (const j of topJudgments) {
      lines.push(`- **${j.short_takeaway || j.judgment?.slice(0, 80)}** _(${j.confidence} confidence)_`);
    }
  }

  // Cross-category patterns
  if ((cross_category?.patterns || []).length > 0) {
    lines.push(`\n## Cross-Category Patterns\n`);
    for (const p of cross_category.patterns) {
      lines.push(`### ${p.pattern}`);
      lines.push(p.description);
      lines.push(`\n**Implication**: ${p.implication}\n`);
    }
  }

  // Per-category analysis
  for (const ca of category_analyses) {
    const approved = (ca.judgments || []).filter(j => !j.blocked);
    lines.push(`\n## ${ca.category.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}`);
    lines.push(`\n_Status: ${ca.assessment_status} | ${approved.length} judgments | Coverage: ${ca.coverage_assessment?.slice(0, 100)}_\n`);

    for (const j of approved) {
      lines.push(`### ${j.judgment}`);
      lines.push(`\n**What changed**: ${j.what_changed}`);
      lines.push(`\n**Why it matters**: ${j.why_this_matters}`);
      if (j.causal_mechanism) lines.push(`\n**Mechanism**: ${j.causal_mechanism}`);
      lines.push(`\n**Confidence**: ${j.confidence}`);
      if (j.caveats?.length) lines.push(`\n**Caveats**: ${j.caveats.join("; ")}`);
      if (j.evidence_for?.length) lines.push(`\n**Evidence**: ${j.evidence_for.join(", ")}`);
      if (j.recommended_action) lines.push(`\n**Action**: ${j.recommended_action}`);
      lines.push("");
    }

    if (ca.evidence_gaps?.length > 0) {
      lines.push(`**Evidence gaps**: ${ca.evidence_gaps.join("; ")}\n`);
    }
  }

  // Deck appendix
  if (deck?.slides?.length > 0) {
    lines.push(`\n---\n\n## Presentation Deck (${deck.slides.length} slides)\n`);
    for (const slide of deck.slides) {
      if (["cover"].includes(slide.slide_type)) continue;
      lines.push(`### Slide ${slide.slide_number}: ${slide.headline || slide.argument}`);
      for (const b of slide.bullets || []) {
        const evRef = b.evidence_id ? ` [${b.evidence_id}]` : "";
        lines.push(`- ${b.text}${evRef}`);
      }
      if (slide.speaker_notes) {
        lines.push(`\n> _${slide.speaker_notes.replace(/\n/g, " ").slice(0, 200)}_\n`);
      }
    }
  }

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const banner = "═".repeat(64);
  const mode = CLASSIFY_ONLY ? "classify-only" : `full pipeline | Slides: ${NO_SLIDES ? "off" : "on"}`;
  console.log(`\n${banner}`);
  console.log(`  Horizon Scan v2`);
  console.log(`  Days: ${DAYS} | Limit: ${LIMIT} | LLM: ${NO_LLM ? "off" : "on"} | ${mode}`);
  console.log(`${banner}\n`);

  // ── Load sources ────────────────────────────────────────────────────────────
  let sources = [];
  let supabase = null;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("  No Supabase credentials — running with fixture sources");
    const { default: fixtures } = await import("../lib/pipeline/ingest/loadSampleSources.js").catch(() => ({
      default: [],
    }));
    sources = Array.isArray(fixtures) ? fixtures : [];
    if (sources.length === 0) {
      console.error("  No sources available. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
      process.exit(1);
    }
  } else {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );
    const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let query = supabase.from("sources").select("*")
      .gte("date_published", since)
      .order("date_published", { ascending: false })
      .limit(LIMIT);
    if (CATEGORY) query = query.eq("main_category", CATEGORY);
    if (UNCLASSIFIED_ONLY) {
      // Fix 2: catch null AND the legacy 'uncategorised' value from the old MVP pipeline.
      // Fix 3: skip sources already rejected by a prior classify run.
      query = query
        .or("main_category.is.null,main_category.eq.uncategorised")
        .not("validation_status", "eq", "reject");
    }

    const { data, error } = await query;
    if (error) { console.error("DB error:", error.message); process.exit(1); }
    sources = data || [];

    // ── URL deduplication ──────────────────────────────────────────────────────
    const beforeDedup = sources.length;
    const seenUrls = new Set();
    sources = sources.filter(s => {
      const url = s.url || s.canonical_url || s.id;
      if (seenUrls.has(url)) return false;
      seenUrls.add(url);
      return true;
    });
    const dedupRemoved = beforeDedup - sources.length;
    console.log(`  Loaded ${sources.length} sources from Supabase (last ${DAYS} days)${dedupRemoved ? ` · ${dedupRemoved} URL dupes removed` : ""}\n`);
  }

  // ── Classify-only mode: run L4, persist back to Supabase, skip L5-L7 ────────
  if (CLASSIFY_ONLY) {
    // Fix 1: correct function name (was understandSources, export is understandAllSources)
    const { understandAllSources } = await import("../lib/pipeline/v2/understandSource.js");
    console.log(`  [L4] Classifying ${sources.length} sources...`);

    const { relevant, discarded } = await understandAllSources(sources, {
      skipLlm: NO_LLM,
      concurrency: 5,
      onProgress: (done, total) => process.stdout.write(`    ${done}/${total}\r`),
    });
    process.stdout.write("\n");
    console.log(`  [L4] ${relevant.length} relevant / ${discarded.length} discarded`);

    if (!NO_PERSIST && supabase) {
      // Update relevant sources with classified main_category and tags
      const CHUNK = 20;
      let updated = 0, failed = 0;
      for (let i = 0; i < relevant.length; i += CHUNK) {
        const chunk = relevant.slice(i, i + CHUNK);
        await Promise.all(chunk.map(async src => {
          const { error } = await supabase.from("sources").update({
            main_category:  src.category,
            tags:           src.primary_tags || [],
            source_type:    src.source_type || undefined,
          }).eq("id", src.id);
          if (error) failed++; else updated++;
        }));
      }
      console.log(`  Persisted main_category to ${updated} sources (${failed} failed)`);

      // Mark discarded sources as rejected
      const discardedIds = discarded.map(s => s.id).filter(Boolean);
      if (discardedIds.length) {
        for (let i = 0; i < discardedIds.length; i += 100) {
          await supabase.from("sources")
            .update({ validation_status: "reject" })
            .in("id", discardedIds.slice(i, i + 100));
        }
        console.log(`  Marked ${discardedIds.length} sources as rejected`);
      }
    }

    // Category breakdown
    const catCounts = {};
    relevant.forEach(s => { catCounts[s.category] = (catCounts[s.category] || 0) + 1; });
    console.log(`\n  Classification breakdown:`);
    Object.entries(catCounts).sort(([,a],[,b]) => b-a).forEach(([c, n]) => {
      console.log(`    ${c}: ${n}`);
    });
    console.log(`\n${banner}\n`);
    return;
  }

  // ── Purge mode: delete irrelevant sources from DB ─────────────────────────
  if (PURGE) {
    if (!supabase) {
      console.error("  --purge requires Supabase credentials");
      process.exit(1);
    }
    // Delete sources that are clearly irrelevant: unclear_or_adjacent (v2 reject),
    // the legacy 'uncategorised' value from the old MVP pipeline, and anything
    // explicitly rejected by the validation pipeline.
    console.log("  [PURGE] Deleting irrelevant sources from DB...");

    const PURGE_CATEGORIES = ["unclear_or_adjacent", "uncategorised"];
    let totalDeleted = 0;

    // Delete by irrelevant category
    for (const cat of PURGE_CATEGORIES) {
      const { count, error } = await supabase.from("sources")
        .delete({ count: "exact" })
        .eq("main_category", cat);
      if (error) {
        console.warn(`  [PURGE] Failed to delete ${cat}: ${error.message}`);
      } else {
        console.log(`  [PURGE] Deleted ${count || 0} sources with main_category=${cat}`);
        totalDeleted += count || 0;
      }
    }

    // Delete sources explicitly rejected by validation (null category + rejected status)
    const { count: rejCount, error: rejErr } = await supabase.from("sources")
      .delete({ count: "exact" })
      .eq("validation_status", "reject")
      .is("main_category", null);
    if (rejErr) {
      console.warn(`  [PURGE] Failed to delete rejected sources: ${rejErr.message}`);
    } else {
      console.log(`  [PURGE] Deleted ${rejCount || 0} rejected sources (null category)`);
      totalDeleted += rejCount || 0;
    }

    console.log(`\n  [PURGE] Total deleted: ${totalDeleted} sources`);
    console.log(`\n${banner}\n`);
    return;
  }

  // ── Run pipeline ────────────────────────────────────────────────────────────
  const { runPipelineV2 } = await import("../lib/pipeline/v2/runPipelineV2.js");

  const checkpoints = {};
  const result = await runPipelineV2(sources, {
    skipLlm:    NO_LLM,
    skipSlides: NO_SLIDES,
    onProgress: (step, msg) => {},
    onCheckpoint: async (layer, data) => { checkpoints[layer] = data; },
  });

  // ── Write outputs ───────────────────────────────────────────────────────────
  const outDir = OUT_DIR
    ? path.resolve(ROOT, OUT_DIR)
    : path.join(ROOT, "outputs", "v2", result.run_id);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n  Writing outputs to: ${outDir}\n`);

  save(outDir, "run-summary.json", {
    run_id:           result.run_id,
    run_date:         result.run_date,
    pipeline_version: result.pipeline_version,
    counts:           result.counts,
    elapsed_seconds:  result.elapsed_seconds,
    corpus_summary:   result.corpus_summary,
  });

  save(outDir, "dashboard-state.json", result.dashboard_state);
  save(outDir, "category-analyses.json", result.category_analyses);
  save(outDir, "evidence-items.json", result.evidence_items.slice(0, 500));
  save(outDir, "evidence-graph.json", result.evidence_graph);
  save(outDir, "cross-category.json", result.cross_category);

  // Checkpoints
  const ckDir = path.join(outDir, "checkpoints");
  fs.mkdirSync(ckDir, { recursive: true });
  for (const [layer, data] of Object.entries(checkpoints)) {
    fs.writeFileSync(path.join(ckDir, `${layer}.json`), JSON.stringify(data, null, 2));
  }

  // Markdown report
  const md = exportMarkdown(result);
  save(outDir, "analysis-report.md", md);

  if (result.deck) {
    save(outDir, "slide-deck.json", result.deck);
  }

  // Persist to Supabase: snapshot + deck blob + update source classifications
  if (!NO_PERSIST && supabase) {
    // 1. Snapshot row
    try {
      const snapshot_id = `snapshot-${result.run_id}`;
      await supabase.from("snapshots").upsert({
        snapshot_id,
        run_id:            result.run_id,
        created_at:        result.run_date,
        source_count:      result.counts.sources_relevant,
        pipeline_version:  result.pipeline_version,
        dashboard_state:   result.dashboard_state,
        category_analyses: result.category_analyses,
        counts:            result.counts,
      }, { onConflict: "snapshot_id" });
      console.log(`  Persisted snapshot: ${snapshot_id}`);
    } catch (err) {
      console.warn(`  Snapshot persist failed: ${err.message}`);
    }

    // 2. Deck blob + decks table (makes output available to the chatbot)
    try {
      const { saveDeck } = await import("../lib/storage/deckStore.js");
      const deckResult = result.deck || { slides: [], deck_version: "v2", traceability_issues: [] };
      await saveDeck({
        synthesisResult: {
          feed_sources:      result.relevant || [],
          category_analyses: result.category_analyses,
          evidence_items:    result.evidence_items,
          cross_category:    result.cross_category,
          corpus_summary:    result.corpus_summary,
          synthesis_version: result.pipeline_version,
        },
        deckResult,
        qaResult: { overall_pass: true, summary: "v2 pipeline QA", qa_version: "v2" },
        window: {
          start: result.corpus_summary?.date_range?.split(" to ")?.[0],
          end:   result.corpus_summary?.date_range?.split(" to ")?.[1],
        },
        deckId: `deck-v2-${result.run_id.slice(-10)}`,
      });
      console.log(`  Persisted deck to blob + decks table`);
    } catch (err) {
      console.warn(`  Deck persist failed: ${err.message}`);
    }

    // 3. Write main_category and tags back to source rows so chatbot search works
    try {
      const relevant = result.relevant || [];
      const CHUNK = 20;
      let updated = 0;
      for (let i = 0; i < relevant.length; i += CHUNK) {
        await Promise.all(relevant.slice(i, i + CHUNK).map(src =>
          supabase.from("sources").update({
            main_category: src.category,
            tags:          src.primary_tags || [],
          }).eq("id", src.id)
        ));
        updated += Math.min(CHUNK, relevant.length - i);
      }
      if (updated) console.log(`  Updated main_category on ${updated} source rows`);
    } catch (err) {
      console.warn(`  Source classification persist failed: ${err.message}`);
    }
  }

  // ── Final report ────────────────────────────────────────────────────────────
  const { counts } = result;
  console.log(`\n${banner}`);
  console.log(`  Run complete: ${result.run_id}`);
  console.log(`  ${counts.sources_relevant}/${counts.sources_input} sources relevant`);
  console.log(`  ${counts.evidence_strong} strong + ${counts.evidence_items - counts.evidence_strong} other evidence items`);
  console.log(`  ${counts.judgments_approved}/${counts.judgments_total} judgments approved`);
  console.log(`  ${counts.slides_generated} slides generated`);
  console.log(`  Elapsed: ${result.elapsed_seconds}s`);
  console.log(`  Output: ${outDir}`);
  console.log(`${banner}\n`);
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
