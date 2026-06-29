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
    main_claims:    Array.isArray(intel.main_claims)  ? intel.main_claims  : [],
    key_numbers:    Array.isArray(intel.key_numbers)  ? intel.key_numbers  : [],
    short_summary:  row.short_summary || row.analyst_brief || "",
  };
}

async function main() {
  const banner = "═".repeat(64);
  console.log(`\n${banner}`);
  console.log(`  Synthesis-Only Pipeline  (L5 evidence + L6 synthesis + QA)`);
  console.log(`  Days: ${DAYS}  Limit: ${LIMIT}  Skip QA: ${SKIP_QA}  Persist: ${!NO_PERSIST}`);
  console.log(`${banner}\n`);

  const t0 = Date.now();

  // ── Load enriched sources from DB ─────────────────────────────────────────
  const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const { data: rows, error } = await supabase
    .from("sources")
    .select("id,title,url,publisher,date_published,main_category,trust_tier,source_type,full_text,summary,short_summary,analyst_brief,tags,intelligence,validation_status")
    .eq("validation_status", "pass")
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
  const { extractAllEvidence } = await import("../lib/pipeline/extractEvidence.js");
  const { buildCorpusSummary, buildEvidenceGraph } = await import("../lib/pipeline/corpusSummary.js");
  const { synthesizeAllCategories, synthesizeCrossCategory } = await import("../lib/pipeline/synthesizeCategory.js");
  const { buildPresentation } = await import("../lib/pipeline/buildPresentation.js");
  const { buildDashboardState } = await import("../lib/pipeline/dashboard.js");
  const { DOMAINS } = await import("../lib/pipeline/taxonomy.js");

  const ACTIVE_CATEGORIES = DOMAINS.filter(d => d !== "unclear_or_adjacent");

  console.log(`  [L5] Extracting evidence...`);
  const { items: evidenceItems, packs, counts: evCounts } = await extractAllEvidence(
    sources, ACTIVE_CATEGORIES,
    { concurrency: 5, onProgress: (done, total) => process.stdout.write(`    ${done}/${total}\r`) }
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

  // ── Build dashboard state + run_id ────────────────────────────────────────
  const run_id   = `v2-synthesis-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const run_date = new Date().toISOString();
  const elapsed4 = ((Date.now() - t0) / 1000).toFixed(1);

  const runResult = { run_id, run_date, category_analyses, evidence_items: evidenceItems, corpus_summary, cross_category };
  const dashboard_state = buildDashboardState(runResult);

  // ── Write local outputs ────────────────────────────────────────────────────
  const outDir = path.join(ROOT, "outputs", "v2", run_id);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`  Writing outputs → ${outDir}`);
  save(outDir, "run-summary.json", { run_id, run_date, pipeline_version: "synthesis-only-v1", counts: { sources_input: sources.length, evidence_items: evCounts.after_dedup, evidence_strong: evCounts.strong, judgments_total: totalJudgments, judgments_approved: approvedJudgments }, elapsed_seconds: parseFloat(elapsed4), corpus_summary });
  save(outDir, "category-analyses.json", category_analyses);
  save(outDir, "evidence-items.json", evidenceItems.slice(0, 500));
  save(outDir, "evidence-graph.json", evidence_graph);
  save(outDir, "cross-category.json", cross_category);
  save(outDir, "dashboard-state.json", dashboard_state);

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
        synthesis: {
          run_id, run_date,
          category_analyses,
          evidence_items: evidenceItems.slice(0, 500),
          corpus_summary,
          cross_category,
          dashboard_state,
        },
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
        slide_count:       0,
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
}

import { flushCostBuffer } from "../lib/llm/usagePersistence.js";
main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error("\nFATAL:", err.message, "\n", err.stack?.slice(0, 600)); process.exit(1); });
