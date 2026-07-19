#!/usr/bin/env node
/**
 * runTestSetDeck.js — Generate a slide deck from a curated test set
 *
 * Loads a test set JSON (from buildTestSets.js), re-fetches full source rows
 * from Supabase, maps them to the pipeline input format, and runs the synthesis
 * + deck generation pipeline (L5 evidence → L6 synthesis → L7-L8 deck).
 *
 * This is identical in structure to runSynthesisOnly.js but constrained to the
 * source IDs in the test set rather than a date-windowed query.
 *
 * Usage:
 *   node scripts/runTestSetDeck.js --set <path> [--pptx] [--no-persist] [--skip-qa]
 *
 * Options:
 *   --set <path>    Path to test set JSON (required)
 *   --pptx          Render deck to .pptx file
 *   --no-persist    Do not write results to Supabase
 *   --skip-qa       Skip synthesis QA step
 *   --out <dir>     Custom output directory
 *
 * Output:
 *   outputs/test_decks/<set_id>/run-summary.json
 *   outputs/test_decks/<set_id>/category-analyses.json
 *   outputs/test_decks/<set_id>/evidence-items.json
 *   outputs/test_decks/<set_id>/deck.json
 *   outputs/test_decks/<set_id>/deck.pptx  (if --pptx)
 *   outputs/test_decks/<set_id>/report.md
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient }  from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const hasFlag = (f) => args.includes(f);

const SET_PATH   = getArg("--set");
const PPTX       = hasFlag("--pptx");
const NO_PERSIST = hasFlag("--no-persist");
const SKIP_QA    = hasFlag("--skip-qa");
const OUT_DIR    = getArg("--out");

if (!SET_PATH) {
  console.error("Usage: node scripts/runTestSetDeck.js --set <path-to-test-set.json>");
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function save(dir, name, data) {
  const p = path.join(dir, name);
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(p, content);
  console.log(`  → ${name}`);
  return p;
}

// ── Map DB row to pipeline input format (mirrors runSynthesisOnly.js) ─────────

function mapDbSource(row) {
  const intel = row.intelligence || {};
  return {
    id:             row.id,
    title:          row.title,
    url:            row.url,
    publisher:      row.publisher,
    date_published: row.date_published,
    full_text:      row.full_text || row.summary || "",

    // Fields expected by extractAllEvidence / synthesizeAllCategories
    relevant:            true,
    category:            row.main_category,
    primary_tags:        row.tags || [],
    sub_techniques:      [],
    ai_enabled_overlay:  false,
    source_type:         row.source_type  || "unknown",
    trust_tier:          row.trust_tier   || "unknown",
    key_entities:        Array.isArray(intel.key_entities) ? intel.key_entities.filter(e => typeof e === "string") : [],
    key_terms:           Array.isArray(intel.key_terms)    ? intel.key_terms.filter(e => typeof e === "string") : [],
    main_claims:         Array.isArray(intel.main_claims)  ? intel.main_claims  : [],
    key_numbers:         Array.isArray(intel.key_numbers)  ? intel.key_numbers  : [],
    short_summary:       row.short_summary || row.analyst_brief || "",
  };
}

// ── Markdown export ───────────────────────────────────────────────────────────

function buildMarkdown(result, setMeta) {
  const { category_analyses, corpus_summary, cross_category, deck, run_id, run_date } = result;
  const lines = [];

  lines.push(`# AI Threat Intelligence Deck — ${setMeta.set_name}`);
  lines.push(`\n**Test set**: \`${setMeta.set_id}\`  `);
  lines.push(`**Run ID**: \`${run_id}\`  `);
  lines.push(`**Date**: ${run_date.slice(0, 10)}  `);
  lines.push(`**Sources**: ${setMeta.source_count} (${Object.entries(setMeta.category_counts).map(([k,v]) => `${k.split("_")[0]}:${v}`).join(" ")})  `);
  if (corpus_summary?.date_range) lines.push(`**Period**: ${corpus_summary.date_range}`);
  lines.push(`\n**Purpose**: ${setMeta.purpose}\n`);

  // Category analyses
  for (const ca of category_analyses || []) {
    const approved = (ca.judgments || []).filter(j => !j.blocked);
    lines.push(`\n## ${ca.category.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}`);
    lines.push(`\n_Status: ${ca.assessment_status || "–"} | ${approved.length} approved judgments_\n`);

    for (const j of approved) {
      lines.push(`### ${j.judgment}`);
      if (j.what_changed)    lines.push(`\n**What changed**: ${j.what_changed}`);
      if (j.why_this_matters) lines.push(`\n**Why it matters**: ${j.why_this_matters}`);
      if (j.causal_mechanism) lines.push(`\n**Mechanism**: ${j.causal_mechanism}`);
      lines.push(`\n**Confidence**: ${j.confidence}`);
      if (j.caveats?.length)  lines.push(`\n**Caveats**: ${j.caveats.join("; ")}`);
      if (j.evidence_for?.length) lines.push(`\n**Evidence**: ${j.evidence_for.join(", ")}`);
      if (j.recommended_action) lines.push(`\n**Action**: ${j.recommended_action}`);
      lines.push("");
    }

    if (ca.evidence_gaps?.length > 0) {
      lines.push(`**Evidence gaps**: ${ca.evidence_gaps.join("; ")}\n`);
    }
  }

  // Cross-category
  if ((cross_category?.patterns || []).length > 0) {
    lines.push(`\n## Cross-Category Patterns\n`);
    for (const p of cross_category.patterns) {
      lines.push(`### ${p.pattern}`);
      lines.push(p.description || "");
      if (p.implication) lines.push(`\n**Implication**: ${p.implication}\n`);
    }
  }

  // Deck slides
  if (deck?.slides?.length > 0) {
    lines.push(`\n---\n\n## Presentation Slides (${deck.slides.length} slides)\n`);
    for (const slide of deck.slides) {
      if (["cover"].includes(slide.slide_type)) continue;
      lines.push(`### Slide ${slide.slide_number}: ${slide.headline || slide.argument || slide.slide_type}`);
      for (const b of slide.bullets || []) {
        const ref = b.evidence_id ? ` [${b.evidence_id}]` : "";
        lines.push(`- ${b.text}${ref}`);
      }
      if (slide.speaker_notes) {
        lines.push(`\n> _${String(slide.speaker_notes).replace(/\n/g, " ").slice(0, 200)}_\n`);
      }
    }
  }

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load test set
  if (!fs.existsSync(SET_PATH)) {
    console.error(`Test set not found: ${SET_PATH}`);
    process.exit(1);
  }
  const testSet = JSON.parse(fs.readFileSync(SET_PATH, "utf8"));
  const setId   = testSet.set_id;
  const sourceIds = testSet.sources.map(s => s.id);

  const banner = "═".repeat(64);
  console.log(`\n${banner}`);
  console.log(`  Test Set Deck Generator`);
  console.log(`  Set: ${testSet.set_name}`);
  console.log(`  Sources: ${sourceIds.length} | PPTX: ${PPTX} | Persist: ${!NO_PERSIST}`);
  console.log(`${banner}\n`);

  // Setup output dir
  const outDir = OUT_DIR
    ? path.resolve(OUT_DIR)
    : path.join(ROOT, "outputs/test_decks", setId);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`  Output dir: ${path.relative(ROOT, outDir)}\n`);

  const t0 = Date.now();

  // ── Load full source rows from Supabase ────────────────────────────────────
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  // Fetch in batches of 100 (Supabase .in() limit)
  console.log(`  [DB] Loading ${sourceIds.length} full source rows...`);
  let dbRows = [];
  const CHUNK = 100;
  for (let i = 0; i < sourceIds.length; i += CHUNK) {
    const chunk = sourceIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("sources")
      .select("id,title,url,publisher,date_published,main_category,trust_tier,source_type,full_text,summary,short_summary,analyst_brief,tags,intelligence,validation_status")
      .in("id", chunk);
    if (error) { console.error("DB error:", error.message); process.exit(1); }
    dbRows.push(...(data || []));
  }
  console.log(`  [DB] Loaded ${dbRows.length}/${sourceIds.length} rows`);

  // Warn about any missing rows
  const loadedIds = new Set(dbRows.map(r => r.id));
  const missing = sourceIds.filter(id => !loadedIds.has(id));
  if (missing.length > 0) {
    console.warn(`  [DB] Warning: ${missing.length} source IDs from test set not found in DB`);
  }

  const sources = dbRows.map(mapDbSource);
  const elapsed1 = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  [DB] Mapped ${sources.length} sources (+${elapsed1}s)\n`);

  // ── Import pipeline modules ────────────────────────────────────────────────
  const { extractAllEvidence }                     = await import("../lib/pipeline/extraction/extractEvidence.js");
  const { buildCorpusSummary, buildEvidenceGraph } = await import("../lib/pipeline/analysis/corpusSummary.js");
  const { runAnalysis }                            = await import("../lib/pipeline/analysis/runAnalysis.js");
  const { synthesizeCrossCategory }               = await import("../lib/pipeline/slides/synthesizeCrossCategory.js");
  const { buildPresentation }                      = await import("../lib/pipeline/slides/buildPresentation.js");
  const { buildDashboardState }                    = await import("../lib/pipeline/dashboard.js");
  const { DOMAINS }                                = await import("../lib/pipeline/understand/taxonomy.js");

  const ACTIVE_CATEGORIES = DOMAINS.filter(d => d !== "unclear_or_adjacent");

  // ── L5: Extract evidence ───────────────────────────────────────────────────
  console.log(`  [L5] Extracting evidence from ${sources.length} sources...`);
  const { items: evidenceItems, packs, counts: evCounts } = await extractAllEvidence(
    sources, ACTIVE_CATEGORIES,
    { concurrency: 4, supabase, onProgress: (done, total) => process.stdout.write(`    ${done}/${total}\r`) },
  );
  process.stdout.write("\n");
  const elapsed2 = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  [L5] ${evCounts.total_extracted} extracted → ${evCounts.after_dedup} after dedup (${evCounts.strong} strong, ${evCounts.usable} usable) (+${elapsed2}s)\n`);

  // ── Corpus summary ─────────────────────────────────────────────────────────
  const corpus_summary  = buildCorpusSummary(sources, sources);
  const evidence_graph  = buildEvidenceGraph(sources, evidenceItems);
  console.log(`  [CORPUS] ${corpus_summary.date_range || "–"} | ${ACTIVE_CATEGORIES.map(c => `${c.split("_")[0]}:${corpus_summary.source_count_by_category?.[c]||0}`).join(" ")}\n`);

  // ── L6: Analysis ─────────────────────────────────────────────────────────
  console.log(`  [L6] Analysing categories...`);
  const windowInfo = {
    type: "testset", key: `testset-${setId}`,
    label: corpus_summary.date_range || "test set",
    date_from: "", date_to: "",
  };
  const category_analyses = await runAnalysis(
    sources, evidenceItems, corpus_summary, windowInfo,
    { skipLlm: SKIP_QA, supabase: null }
  );
  const totalInsights  = category_analyses.reduce((n, ca) => n + (ca.insights||[]).filter(i=>!i.blocked).length, 0);
  const elapsed3 = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  [L6] ${totalInsights} approved insights (+${elapsed3}s)\n`);

  const cross_category = await synthesizeCrossCategory(category_analyses, { skipLlm: SKIP_QA });
  console.log(`  [slides] ${(cross_category.patterns||[]).length} cross-category patterns\n`);

  // ── L7-L8: Deck ───────────────────────────────────────────────────────────
  console.log(`  [L7-L8] Building presentation...`);
  const deck = await buildPresentation(
    category_analyses,
    cross_category,
    evidenceItems,
    { corpus_summary },
  );
  const elapsed4 = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  [L7-L8] ${deck?.slides?.length || 0} slides generated (+${elapsed4}s)\n`);

  // ── Compose result ─────────────────────────────────────────────────────────
  const run_id   = `testset-${setId}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const run_date = new Date().toISOString();

  const runResult = {
    run_id, run_date,
    test_set_id:   setId,
    test_set_name: testSet.set_name,
    source_count:  sources.length,
    category_analyses,
    evidence_items: evidenceItems,
    corpus_summary,
    cross_category,
    deck,
    counts: {
      sources_input:       sources.length,
      evidence_items:      evCounts.after_dedup,
      evidence_strong:     evCounts.strong,
      judgments_total:     totalJudgments,
      judgments_approved:  approvedJudgments,
      slides:              deck?.slides?.length || 0,
    },
    elapsed_seconds: parseFloat(elapsed4),
  };

  const dashboard_state = buildDashboardState(runResult);

  // ── Write outputs ──────────────────────────────────────────────────────────
  console.log(`  Writing outputs → ${path.relative(ROOT, outDir)}`);
  save(outDir, "run-summary.json",       { run_id, run_date, test_set_id: setId, counts: runResult.counts, elapsed_seconds: runResult.elapsed_seconds, corpus_summary });
  save(outDir, "category-analyses.json", category_analyses);
  save(outDir, "evidence-items.json",    evidenceItems.slice(0, 500));
  save(outDir, "evidence-graph.json",    evidence_graph);
  save(outDir, "cross-category.json",    cross_category);
  save(outDir, "dashboard-state.json",   dashboard_state);
  save(outDir, "deck.json",              deck);

  const mdContent = buildMarkdown(runResult, testSet);
  save(outDir, "report.md", mdContent);

  // ── PPTX ──────────────────────────────────────────────────────────────────
  if (PPTX && deck?.slides?.length > 0) {
    console.log("\n  [PPTX] Rendering deck...");
    try {
      const { renderDeckPptx } = await import("../lib/pipeline/slides/renderDeckPptx.js");
      const pptxPath = path.join(outDir, "deck.pptx");
      await renderDeckPptx(deck, pptxPath);
      console.log(`  → deck.pptx`);
    } catch (err) {
      console.warn(`  PPTX rendering failed: ${err.message}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(48)}`);
  console.log(`  Test Set Deck Complete`);
  console.log(`  Run ID:    ${run_id}`);
  console.log(`  Sources:   ${sources.length}`);
  console.log(`  Evidence:  ${evCounts.after_dedup} items (${evCounts.strong} strong)`);
  console.log(`  Judgments: ${approvedJudgments}/${totalJudgments} approved`);
  console.log(`  Slides:    ${deck?.slides?.length || 0}`);
  console.log(`  Duration:  ${elapsed4}s`);
  console.log(`\n  Audit with:`);
  console.log(`    node scripts/auditTestDeck.js --deck ${path.relative(ROOT, path.join(outDir, "deck.json"))} --set ${SET_PATH} --out outputs/test_decks/${setId}_audit.md`);
}

main().catch(err => { console.error(err); process.exit(1); });
