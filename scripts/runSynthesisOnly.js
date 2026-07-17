#!/usr/bin/env node
/**
 * runSynthesisOnly.js — Skip L2-L4, run L5+L6+QA on already-enriched corpus.
 *
 * Sources in the DB already have main_category, tags, short_summary, and
 * intelligence fields from understandCorpus.js. This script maps those DB fields
 * to the format expected by extractAllEvidence and synthesizeAllCategories,
 * bypassing the expensive understandAllSources re-classification step.
 *
 * Usage:
 *   node scripts/runSynthesisOnly.js [--days N] [--limit N] [--skip-qa] [--no-persist]
 *
 * Defaults: days=365, limit=1000
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient }  from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args       = process.argv.slice(2);
const getArg     = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const hasFlag    = (f) => args.includes(f);

const DAYS       = parseInt(getArg("--days",  "365"), 10);
const LIMIT      = parseInt(getArg("--limit", "1000"), 10);
const SKIP_QA    = hasFlag("--skip-qa");
const NO_PERSIST = hasFlag("--no-persist");
const SKIP_SLIDES       = hasFlag("--no-slides");
const SKIP_LLM          = hasFlag("--no-llm");
// Force re-extraction of sources whose cached evidence is missing walkthrough data.
// Use when evidenceStore schema was just updated (e.g. walkthrough fields added).
const FORCE_REWALK      = hasFlag("--force-reextract");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function save(dir, name, data) {
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(path.join(dir, name), content);
}

// ── Map DB row → understandSource output shape ────────────────────────────────
// extractAllEvidence and synthesizeAllCategories expect the output shape from
// understandSource. DB rows have the same data under different field names.

function mapDbSource(row) {
  const intel = row.intelligence || {};
  return {
    id:             row.id,
    title:          row.title,
    url:            row.url,
    publisher:      row.publisher,
    date_published: row.date_published,
    full_text:      row.full_text || row.summary || "",

    // understandSource fields — mapped from DB
    relevant:       true,
    category:       row.main_category,
    primary_tags:   row.tags || [],
    sub_techniques: [],
    ai_enabled_overlay: false,
    source_type:    row.source_type  || "unknown",
    trust_tier:     row.trust_tier   || "unknown",
    key_entities:   Array.isArray(intel.key_entities) ? intel.key_entities.filter(e => typeof e === "string") : [],
    key_terms:      Array.isArray(intel.key_terms)    ? intel.key_terms.filter(e => typeof e === "string") : [],
    main_claims:    Array.isArray(intel.main_claims)  ? intel.main_claims  : [],
    key_numbers:    Array.isArray(intel.key_numbers)  ? intel.key_numbers  : [],
    short_summary:  row.short_summary || row.analyst_brief || "",
  };
}

async function main() {
  const banner = "═".repeat(64);
  console.log(`\n${banner}`);
  console.log(`  Synthesis-Only Pipeline  (L5 evidence + L6 synthesis + QA + slides)`);
  console.log(`  Days: ${DAYS}  Limit: ${LIMIT}  Skip QA: ${SKIP_QA}  Persist: ${!NO_PERSIST}  Slides: ${!SKIP_SLIDES}`);
  console.log(`${banner}\n`);

  const t0 = Date.now();

  // ── Load enriched sources from DB ─────────────────────────────────────────
  const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const { data: rows, error } = await supabase
    .from("sources")
    .select("id,title,url,publisher,date_published,main_category,trust_tier,source_type,full_text,summary,short_summary,analyst_brief,tags,intelligence,validation_status")
    .eq("validation_status", "pass")
    .not("needs_review", "is", true)
    .not("main_category", "is", null)
    .not("main_category", "eq", "unclear_or_adjacent")
    .gte("date_published", since)
    .order("date_published", { ascending: false })
    .limit(LIMIT);

  if (error) { console.error("DB error:", error.message); process.exit(1); }

  const sources = (rows || []).map(mapDbSource);
  const elapsed1 = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Loaded ${sources.length} enriched sources from DB (+${elapsed1}s)\n`);

  // ── L5: Extract evidence ───────────────────────────────────────────────────
  const { extractAllEvidence } = await import("../lib/pipeline/extraction/extractEvidence.js");
  const { buildCorpusSummary, buildEvidenceGraph } = await import("../lib/pipeline/analysis/corpusSummary.js");
  const { synthesizeAllCategories, synthesizeCrossCategory } = await import("../lib/pipeline/analysis/synthesizeCategory.js");
  const { selectAllCaseStudies } = await import("../lib/pipeline/analysis/selectCaseStudies.js");
  const { generateAllOutlooks }  = await import("../lib/pipeline/analysis/generateOutlook.js");
  const { buildPresentation }    = await import("../lib/pipeline/slides/buildPresentation.js");
  const { renderDeckPptx }       = await import("../lib/pipeline/slides/renderDeckPptx.js");
  const { buildDashboardState }  = await import("../lib/pipeline/dashboard.js");
  const { DOMAINS } = await import("../lib/pipeline/understand/taxonomy.js");

  const ACTIVE_CATEGORIES = DOMAINS.filter(d => d !== "unclear_or_adjacent");

  console.log(`  [L5] Extracting evidence...`);
  // --force-reextract: invalidate the content hash for sources that have
  // report_analysis walkthroughs but whose cached evidence has no walkthrough_steps.
  // This forces those sources to be re-extracted with the new schema.
  let sourcesForExtraction = sources;
  if (FORCE_REWALK) {
    const { contentHashOf, getEvidenceHashes, loadEvidence } = await import("../lib/storage/evidenceStore.js");
    const ids = sources.map(s => s.id);
    const hashes = await getEvidenceHashes(supabase, ids);
    const cached = await loadEvidence(supabase, ids);
    const cachedBySource = new Map();
    for (const ev of cached) {
      if (!cachedBySource.has(ev.source_id)) cachedBySource.set(ev.source_id, []);
      cachedBySource.get(ev.source_id).push(ev);
    }
    // Identify sources with report_analysis walkthroughs but no cached walkthrough_steps
    const toInvalidate = new Set(
      sources
        .filter(s => {
          const walkthroughs = s.intelligence?.report_analysis?.attack_walkthroughs || [];
          if (!walkthroughs.length) return false;
          const evs = cachedBySource.get(s.id) || [];
          return !evs.some(e => e.walkthrough_steps?.length);
        })
        .map(s => s.id)
    );
    if (toInvalidate.size) {
      console.log(`  [L5] --force-reextract: invalidating cache for ${toInvalidate.size} sources with missing walkthroughs`);
      // Temporarily mutate source full_text to bust the content hash for these sources
      sourcesForExtraction = sources.map(s =>
        toInvalidate.has(s.id)
          ? { ...s, full_text: (s.full_text || "") + "\n__REEXTRACT__" }
          : s
      );
    }
  }
  const { items: evidenceItems, packs, counts: evCounts } = await extractAllEvidence(
    sourcesForExtraction, ACTIVE_CATEGORIES,
    { supabase, concurrency: 5, onProgress: (done, total) => process.stdout.write(`    ${done}/${total}\r`), skipLlm: SKIP_LLM }
  );
  process.stdout.write("\n");
  const elapsed2 = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  [L5] ${evCounts.total_extracted} extracted → ${evCounts.after_dedup} after dedup (${evCounts.strong} strong, ${evCounts.usable} usable) (+${elapsed2}s)\n`);

  // ── Corpus summary ─────────────────────────────────────────────────────────
  console.log(`  [CORPUS] Building summary...`);
  const corpus_summary = buildCorpusSummary(sources, sources);
  const evidence_graph = buildEvidenceGraph(sources, evidenceItems);
  console.log(`  [CORPUS] ${corpus_summary.date_range} | ${ACTIVE_CATEGORIES.map(c => `${c.split("_")[0]}:${corpus_summary.source_count_by_category?.[c]||0}`).join(" ")}\n`);

  // ── L6: Synthesis + QA ────────────────────────────────────────────────────
  console.log(`  [L6] Synthesizing categories (Opus) + second-model QA (Sonnet)...`);
  const category_analyses = await synthesizeAllCategories(packs, sources, corpus_summary, { skipQa: SKIP_QA });

  const totalJudgments    = category_analyses.reduce((n, ca) => n + (ca.judgments || []).length, 0);
  const approvedJudgments = category_analyses.reduce((n, ca) => n + (ca.approved_judgment_count || 0), 0);
  const elapsed3 = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  [L6] ${totalJudgments} total judgments, ${approvedJudgments} approved after QA (+${elapsed3}s)\n`);

  console.log(`  [L6] Running cross-category synthesis...`);
  const cross_category = await synthesizeCrossCategory(category_analyses, {});
  console.log(`  [L6] ${(cross_category.patterns||[]).length} cross-category patterns\n`);

  // ── L6.3–L6.5: Case studies + outlooks ───────────────────────────────────
  const packsMap      = Object.fromEntries(packs.map(p => [p.category, p]));
  const evidence_index = Object.fromEntries(evidenceItems.map(ei => [ei.evidence_id, ei]));

  console.log(`  [L6.3] Selecting case studies...`);
  const case_studies = await selectAllCaseStudies(packsMap, evidence_index, { skipLlm: SKIP_LLM });

  console.log(`  [L6.5] Generating outlooks...`);
  // Drive outlook generation from category_analyses (which carry outlook_assessment
  // and evidence_for) rather than separate developments/insights objects that are
  // only available in the full runPipeline.js path. Pass stub byCategory so the
  // parallel loop iterates all four categories; the LLM uses the dossier context
  // and the legacyOutlookFallback from category_analyses for real data.
  const stubByCategory = Object.fromEntries(ACTIVE_CATEGORIES.map(c => [c, []]));
  const all_outlooks = await generateAllOutlooks(
    { byCategory: stubByCategory, overall: [] },
    { byCategory: stubByCategory, overall: [] },
    category_analyses, evidenceItems, { skipLlm: SKIP_LLM },
  );
  console.log(`  [L6.5] ${Object.values(all_outlooks.byCategory||{}).filter(Boolean).length} category outlooks\n`);

  // ── L7-L8: Slide generation ───────────────────────────────────────────────
  let deck = null;
  if (!SKIP_SLIDES) {
    console.log(`  [L7-L8] Building presentation deck...`);
    const t_slides = Date.now();
    // Pass starred + importance tier from source metadata so buildPresentation
    // can prioritise tier_1 evidence without an extra DB query.
    const starredSourceUrls   = sources.filter(s => s.starred).map(s => s.url).filter(Boolean);
    const importanceTierByUrl = Object.fromEntries(
      sources
        .filter(s => s.url && s.intelligence?.importance?.tier)
        .map(s => [s.url, s.intelligence.importance.tier])
    );
    deck = await buildPresentation(category_analyses, cross_category, evidenceItems, {
      skipLlm: SKIP_LLM,
      corpusSummary:    corpus_summary,
      allOutlooks:      all_outlooks,
      starredSourceUrls,
      importanceTierByUrl,
      caseStudies:      case_studies,
    });
    const elapsed_slides = ((Date.now() - t_slides) / 1000).toFixed(1);
    console.log(`  [L7-L8] ${deck.slides.length} slides, ${deck.traceability_issues.length} traceability issues, ${deck.coherence_issues?.length || 0} coherence issues (+${elapsed_slides}s)\n`);
  }

  // ── Build dashboard state + run_id ────────────────────────────────────────
  const run_id   = `v2-synthesis-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const run_date = new Date().toISOString();
  const elapsed4 = ((Date.now() - t0) / 1000).toFixed(1);

  const runResult = { run_id, run_date, category_analyses, evidence_items: evidenceItems, corpus_summary, cross_category, case_studies, all_outlooks };
  const dashboard_state = buildDashboardState(runResult);

  // ── Write local outputs ────────────────────────────────────────────────────
  const outDir = path.join(ROOT, "outputs", "v2", run_id);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`  Writing outputs → ${outDir}`);
  save(outDir, "run-summary.json", { run_id, run_date, pipeline_version: "synthesis-only-v1", counts: { sources_input: sources.length, evidence_items: evCounts.after_dedup, evidence_strong: evCounts.strong, judgments_total: totalJudgments, judgments_approved: approvedJudgments, slides: deck?.slides?.length || 0 }, elapsed_seconds: parseFloat(elapsed4), corpus_summary });
  save(outDir, "category-analyses.json", category_analyses);
  save(outDir, "evidence-items.json", evidenceItems.slice(0, 500));
  save(outDir, "evidence-graph.json", evidence_graph);
  save(outDir, "cross-category.json", cross_category);
  save(outDir, "dashboard-state.json", dashboard_state);
  if (deck) save(outDir, "deck.json", deck);

  // ── PPTX rendering ─────────────────────────────────────────────────────────
  if (deck && !SKIP_SLIDES) {
    const pptxPath = path.join(outDir, `horizon-scan-${run_id}.pptx`);
    try {
      const { path: p, slide_count: sc } = await renderDeckPptx(deck, pptxPath, { title: `AI Cyber Threat Horizon Scan — ${corpus_summary.date_range || run_date.slice(0, 10)}` });
      console.log(`  PPTX saved → ${p}  (${sc} slides)`);
    } catch (err) {
      console.warn(`  PPTX render failed: ${err.message}`);
    }
  }

  // QA report per category
  const qaReport = category_analyses.map(ca => ({
    category: ca.category,
    assessment_status: ca.assessment_status,
    judgments_total: (ca.judgments||[]).length,
    judgments_approved: ca.approved_judgment_count || 0,
    qa_report: ca.qa_report || null,
  }));
  save(outDir, "qa-report.json", qaReport);
  console.log(`  QA report saved to qa-report.json\n`);

  // ── Persist to Supabase ────────────────────────────────────────────────────
  if (!NO_PERSIST) {
    console.log(`  Persisting to Supabase...`);

    // Write per-category strategic insights for the dashboard
    try {
      const insightRows = category_analyses
        .filter(ca => (ca.judgments||[]).some(j => !j.blocked))
        .map(ca => {
          const approved = (ca.judgments||[]).filter(j => !j.blocked);
          const parts = [];
          // Primary insight: first approved judgment's core finding
          if (approved[0]?.judgment?.length > 20) parts.push(approved[0].judgment);
          // Secondary: why it matters from the second judgment if available
          if (approved[1]?.why_this_matters?.length > 20) parts.push(approved[1].why_this_matters);
          else if (approved[0]?.why_this_matters?.length > 20 && parts.length < 2) parts.push(approved[0].why_this_matters);
          // Tertiary: outlook
          const obs = ca.outlook_assessment?.observed_basis;
          if (obs?.length > 20 && parts.length < 3) parts.push(obs);

          return {
            run_id,
            category:       ca.category,
            insight_text:   parts.slice(0, 3).join(" "),
            judgment_count: approved.length,
          };
        });

      if (insightRows.length) {
        const { error } = await supabase.from("synthesis_insights").upsert(insightRows, { onConflict: "run_id,category" });
        if (error) console.warn(`  Insights persist failed: ${error.message}`);
        else console.log(`  Insights saved: ${insightRows.length} categories`);
      }
    } catch (err) {
      console.warn(`  Insights persist error: ${err.message}`);
    }
    try {
      const snapshot_id = `snapshot-${run_id}`;
      await supabase.from("snapshots").upsert({
        snapshot_id,
        run_id,
        created_at:        run_date,
        source_count:      sources.length,
        pipeline_version:  "synthesis-only-v1",
        dashboard_state,
        category_analyses,
        counts: { sources_input: sources.length, evidence_items: evCounts.after_dedup, judgments_total: totalJudgments, judgments_approved: approvedJudgments },
      }, { onConflict: "snapshot_id" });
      console.log(`  Snapshot persisted: ${snapshot_id}`);
    } catch (err) {
      console.warn(`  Snapshot persist failed: ${err.message}`);
    }

    try {
      // saveDeck() expects the old pipeline schema; bypass it and write directly to Blob
      const { uploadArchiveJson } = await import("../lib/storage/blobArchiveStore.js");
      const { supabase: sb } = await import("../lib/storage/supabaseClient.js");

      const deck_id      = `v2-${run_id}`;
      const generated_at = run_date;
      const payload = {
        deck_id,
        generated_at,
        pipeline_version:  "synthesis-only-v1",
        run_id,
        source_count:      sources.length,
        slide_count:       deck?.slides?.length || 0,
        synthesis: {
          run_id, run_date,
          category_analyses,
          evidence_items:    evidenceItems.slice(0, 500),
          corpus_summary,
          cross_category,
          case_studies,
          all_outlooks,
          dashboard_state,
        },
        ...(deck ? { deck } : {}),
      };

      let blob_path = null;
      try {
        const dateKey = generated_at.slice(0, 10);
        const res = await uploadArchiveJson(`decks/${dateKey}/${deck_id}.json`, payload);
        blob_path = res.url;
        console.log(`  Deck blob uploaded → ${blob_path}`);
      } catch (blobErr) {
        console.warn(`  Blob upload skipped: ${blobErr.message}`);
      }

      // Write a decks table row so the chatbot's loadLatestDeck() can find it
      await sb.from("decks").upsert({
        deck_id,
        generated_at,
        source_count:      sources.length,
        pipeline_version:  "synthesis-only-v1",
        blob_path,
        synthesis_version: "synthesis-only-v1",
        slide_count:       deck?.slides?.length || 0,
        overall_pass:      true,
      }, { onConflict: "deck_id" });
      console.log(`  Deck row saved → available to chatbot and dashboard`);
    } catch (err) {
      console.warn(`  Deck persist failed: ${err.message}`);
    }
  }

  console.log(`\n${"─".repeat(64)}`);
  console.log(`  Done in ${elapsed4}s`);
  console.log(`  Sources:   ${sources.length}`);
  console.log(`  Evidence:  ${evCounts.after_dedup} items (${evCounts.strong} strong)`);
  console.log(`  Judgments: ${approvedJudgments} approved / ${totalJudgments} total`);
  console.log(`  Patterns:  ${(cross_category.patterns||[]).length} cross-category`);
  if (deck) console.log(`  Slides:    ${deck.slides.length} generated (${deck.coherence_issues?.length || 0} coherence issues)`);
}

import { flushCostBuffer } from "../lib/llm/usagePersistence.js";
main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error("\nFATAL:", err.message, "\n", err.stack?.slice(0, 600)); process.exit(1); });
