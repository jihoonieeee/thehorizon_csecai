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
 *   --days <n>        Lookback window in days (default: 30)
 *   --limit <n>       Max sources to load (default: 200)
 *   --category <cat>  Filter by threat category
 *   --no-llm          Deterministic mode (no LLM calls, for testing)
 *   --no-slides       Skip slide generation (synthesis only)
 *   --no-persist      Do not write results to Supabase
 *   --out <dir>       Custom output directory (default: outputs/v2/<run_id>)
 *
 * Examples:
 *   node scripts/runHorizonScanV2.js --days 7
 *   node scripts/runHorizonScanV2.js --days 30 --no-llm
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

const DAYS      = parseInt(getArg("--days", "30"), 10);
const LIMIT     = parseInt(getArg("--limit", "200"), 10);
const CATEGORY  = getArg("--category");
const NO_LLM    = hasFlag("--no-llm");
const NO_SLIDES = hasFlag("--no-slides");
const NO_PERSIST= hasFlag("--no-persist");
const OUT_DIR   = getArg("--out");

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
  console.log(`\n${banner}`);
  console.log(`  Horizon Scan v2`);
  console.log(`  Days: ${DAYS} | Limit: ${LIMIT} | LLM: ${NO_LLM ? "off" : "on"} | Slides: ${NO_SLIDES ? "off" : "on"}`);
  console.log(`${banner}\n`);

  // ── Load sources ────────────────────────────────────────────────────────────
  let sources = [];
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
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );
    const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let query = supabase.from("sources").select("*")
      .gte("date_published", since)
      .order("date_published", { ascending: false })
      .limit(LIMIT);
    if (CATEGORY) query = query.eq("main_category", CATEGORY);

    const { data, error } = await query;
    if (error) { console.error("DB error:", error.message); process.exit(1); }
    sources = data || [];
    console.log(`  Loaded ${sources.length} sources from Supabase (last ${DAYS} days)\n`);
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

  // Persist dashboard state to Supabase (snapshots table)
  if (!NO_PERSIST && process.env.SUPABASE_URL) {
    try {
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      );
      const snapshot_id = `snapshot-${result.run_id}`;
      await supabase.from("snapshots").upsert({
        snapshot_id,
        run_id:       result.run_id,
        created_at:   result.run_date,
        source_count: result.counts.sources_relevant,
        pipeline_version: result.pipeline_version,
        dashboard_state: result.dashboard_state,
        category_analyses: result.category_analyses,
        counts: result.counts,
      }, { onConflict: "snapshot_id" });
      console.log(`  Persisted snapshot: ${snapshot_id}`);
    } catch (err) {
      console.warn(`  Snapshot persist failed: ${err.message}`);
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
