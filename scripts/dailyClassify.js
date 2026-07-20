#!/usr/bin/env node
/**
 * dailyClassify.js — daily pipeline: ingest → clean → classify → QA → significance
 *
 * Runs in GitHub Actions at 22:30 UTC (30 min after the Vercel cron at 22:00 UTC).
 *
 * Layer sequence:
 *   L1  collectRawSources()     — connectors (arXiv, CISA KEV, RSS feeds…)
 *   L2  cleanSources()          — inside collectRawSources; text cleaning + IOC extraction
 *   L3  validateAndTypeSources()— inside collectRawSources; lightweight AI-signal pre-filter
 *         ↓ sources saved to DB by saveSnapshotToDatabase()
 *   L4a digestFanout()          — detects multi-topic reports; splits into child sources
 *                                  (children written to DB with null classification so
 *                                  understandAllSources classifies them with classify.md)
 *   L4b understandAllSources()  — LLM classification (classify.md) on single sources + children
 *   L4c qaClassificationLLM()   — cross-model verifier; auto-fixes misclassifications
 *   L4d assessSignificance()    — Haiku overlay for research_finding / benchmark_evaluation
 *                                  sources; writes intelligence.significance to Supabase
 *
 * Usage:
 *   node scripts/dailyClassify.js [options]
 *
 * Options:
 *   --since-hours N   Look back N hours for unclassified sources (default 3).
 *   --days N          Ingest window in days when --ingest is set (default 3).
 *                     Use 7 for weekly, 30 for monthly.
 *   --limit N         Max sources to classify (default 200).
 *   --ingest          Run L1–L3 collection first (saves to DB), then classify what
 *                     was just ingested.
 *   --sig-limit N     Max significance calls per run (default 100). Caps cost when
 *                     a large backlog accumulates.
 */

import "dotenv/config";
import { createClient }              from "@supabase/supabase-js";
import { understandAllSources }      from "../lib/pipeline/understand/understandSource.js";
import { qaClassificationLLM }       from "../lib/pipeline/understand/qaClassification.js";
import { detectDigest, fanOutDigest }from "../lib/pipeline/ingest/digestFanout.js";
import { extractAndSaveReportInsights } from "../lib/pipeline/ingest/extractLongReportInsights.js";
import {
  assessSignificance,
  isSignificanceEligible,
} from "../lib/pipeline/scoring/researchSignificance.js";
import { routedLLM }                 from "../lib/llm/llmRouter.js";
import { callLLM }                   from "../lib/llm/callLLM.js";
import { flushCostBuffer }           from "../lib/llm/usagePersistence.js";

// ── L1–L3 ingest imports (only used with --ingest) ───────────────────────────
import { collectRawSources }         from "../lib/pipeline/ingest/collectRawSources.js";
import { saveSnapshotToDatabase }    from "../lib/storage/snapshotDatabase.js";
import {
  startIngestionRun,
  finishIngestionRun,
  failIngestionRun,
} from "../lib/storage/ingestionRunStore.js";

// ── Args ──────────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const getArg   = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SINCE_H  = parseFloat(getArg("--since-hours", "3"));
const DAYS     = Math.min(parseInt(getArg("--days", "3"), 10), 30);
const LIMIT    = parseInt(getArg("--limit", "200"), 10);
const SIG_LIMIT= parseInt(getArg("--sig-limit", "100"), 10);
const DO_INGEST= args.includes("--ingest");
const DIGEST_CAP = 10;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ── LLM helpers ───────────────────────────────────────────────────────────────
const llmFn    = (sys, usr, opts) => callLLM(sys, usr, opts);
const sigLlmFn = async (sys, usr, opts) => {
  const { result } = await routedLLM(sys, usr, {
    task: "research_significance",
    requires_json: true,
    schema: opts.schema,
  });
  return result;
};

// ── Step: L1–L3 ingest (optional, --ingest flag) ─────────────────────────────
async function runIngest() {
  console.log("\n── L1–L3: Ingest + clean + validate ──────────────────────────");
  const period = DAYS <= 1 ? "daily" : DAYS <= 7 ? "weekly" : "monthly";
  const now = new Date();
  const end = new Date(now); end.setUTCHours(23, 59, 59, 999);
  const start = new Date(end.getTime() - DAYS * 24 * 60 * 60 * 1000);
  const window = {
    timezone:  "Asia/Singapore",
    start_utc: start.toISOString(),
    end_utc:   end.toISOString(),
    start_sgt: new Date(start.getTime() + 8 * 60 * 60 * 1000).toISOString(),
    end_sgt:   new Date(end.getTime()   + 8 * 60 * 60 * 1000).toISOString(),
  };
  console.log(`  Window: ${window.start_sgt.slice(0, 16)} → ${window.end_sgt.slice(0, 16)} SGT  (${DAYS}d / ${period})`);

  let runId;
  try {
    runId = await startIngestionRun();
    const result = await collectRawSources(window, { enrichArxivFullText: true });

    const snapshot = {
      generated_at:   new Date().toISOString(),
      period,
      stage:          `daily_classify_ingest_${DAYS}d`,
      reporting_window: result.reporting_window,
      count:          result.sources.length,
      rejected_count: result.rejected_count,
      rejected_sources: result.rejected_sources,
      discarded_count:  result.discarded_count,
      discarded_by_validity: result.discarded_by_validity,
      discarded_by_relevance_count: result.discarded_by_relevance_count,
      discarded_by_relevance: result.discarded_by_relevance,
      validation_stats: result.validation_stats,
      pipeline_counts:  result.pipeline_counts,
      sources: result.sources,
      archive: result.archive,
      connector_results: result.connector_results,
    };

    await saveSnapshotToDatabase(snapshot);
    await finishIngestionRun(runId, snapshot);

    const connectorSummary = (result.connector_results || [])
      .map(r => `${r.name}:${r.count ?? 0}`).join("  ");
    console.log(`  Collected ${result.sources.length} sources — ${connectorSummary}`);
    if (result.degraded) {
      console.warn(`  ⚠ Degraded run: ${result.degraded_reasons.join("; ")}`);
    }
  } catch (err) {
    if (runId) await failIngestionRun(runId, err).catch(() => {});
    throw err;
  }
}

// ── Step: L4d significance scoring ───────────────────────────────────────────
async function runSignificance(newlyScoredIds) {
  console.log("\n── L4d: Research significance scoring ────────────────────────");

  // Load all unscored research sources (not just the ones classified this run),
  // bounded by SIG_LIMIT so a large backlog doesn't blow the time budget.
  // Prioritise sources classified in this run (newlyScoredIds) first.
  const { data: rows, error } = await supabase
    .from("sources")
    .select("id,title,publisher,tags,source_type,short_summary,summary,full_text,intelligence")
    .in("source_type", ["research_finding", "benchmark_evaluation"])
    .eq("validation_status", "pass")
    .is("intelligence->significance", null)
    .order("date_published", { ascending: false })
    .limit(SIG_LIMIT * 2); // over-fetch so we can front-load this run's sources

  if (error) { console.warn("  Significance DB load failed:", error.message); return; }
  if (!rows?.length) { console.log("  No unscored research sources."); return; }

  // Front-load sources classified this run; fill remaining slots from the backlog.
  const thisRunSet = new Set(newlyScoredIds);
  const thisRun  = rows.filter(r => thisRunSet.has(r.id));
  const backlog  = rows.filter(r => !thisRunSet.has(r.id));
  const todo     = [...thisRun, ...backlog].slice(0, SIG_LIMIT);

  console.log(`  ${rows.length} unscored; scoring ${todo.length} (this run: ${thisRun.length}, backlog: ${Math.min(backlog.length, todo.length - thisRun.length)})`);

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
    if (sig.level === "landmark") console.log(`      ↳ ${sig.reason}`);

    const { error: we } = await supabase
      .from("sources")
      .update({ intelligence: { ...(s.intelligence || {}), significance: sig } })
      .eq("id", s.id);
    if (we) console.warn(`      ! write: ${we.message.slice(0, 60)}`);
    else written++;
  }

  console.log(`  Wrote ${written} significance records — ${JSON.stringify(dist)}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const since = new Date(Date.now() - SINCE_H * 3600 * 1000).toISOString();
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Daily pipeline — ${new Date().toISOString().slice(0, 16)} UTC`);
  console.log(`  since-hours: ${SINCE_H}  limit: ${LIMIT}  sig-limit: ${SIG_LIMIT}  ingest: ${DO_INGEST}`);
  console.log(`${"═".repeat(60)}`);

  // ── L1–L3: Ingest (optional) ───────────────────────────────────────────────
  if (DO_INGEST) {
    await runIngest();
  }

  // ── Load unclassified sources ──────────────────────────────────────────────
  console.log(`\n── Load: sources since ${since.slice(0, 16)} UTC ────────────────`);

  const { data, error } = await supabase
    .from("sources")
    .select("id,title,url,publisher,source_type,trust_tier,full_text,clean_text,summary,main_category,validation_status,layer3_status,candidate_domain,ai_threat_focus,date_published,is_digest,parent_source_id,intelligence")
    .is("main_category", null)
    // Postgres neq silently excludes NULLs — use or() so digest children
    // (written with validation_status=null) are included alongside pass/review.
    .or("validation_status.neq.reject,validation_status.is.null")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  if (error) { console.error("DB load failed:", error.message); process.exit(1); }
  if (!data?.length) { console.log("  No unclassified sources in window. Done."); return; }
  console.log(`  ${data.length} sources loaded\n`);

  const scoredAt = new Date().toISOString();

  // ── L4a: Digest fanout (before understand) ─────────────────────────────────
  // Multi-topic reports are split into per-finding children first. Children are
  // written to DB with null classification so L4b classifies each child
  // individually with the full classify.md taxonomy rules.
  console.log("\n── L4a: Digest fanout ─────────────────────────────────────────");

  const digestDetected = data.map(s => ({ s, isDigest: detectDigest(s).is_digest && !s.parent_source_id }));
  const digestSources  = digestDetected.filter(x => x.isDigest).map(x => x.s).slice(0, DIGEST_CAP);
  const singleSources  = digestDetected.filter(x => !x.isDigest).map(x => x.s);

  let fanoutCount = 0;
  const allChildren = [];       // children to pass directly into understand
  const fallbackSingles = [];   // digests the LLM says are single-topic → classify normally

  for (const digestSrc of digestSources) {
    try {
      const { is_digest, children, parent_patch } = await fanOutDigest(digestSrc, { llmFn, scoredAt });
      if (!is_digest || !children.length) {
        // LLM disagrees with heuristic — treat as a single source.
        fallbackSingles.push(digestSrc);
        continue;
      }
      // Write children to DB with null classification (understand will classify them).
      await supabase.from("sources").upsert(children, { onConflict: "id", ignoreDuplicates: false });
      allChildren.push(...children);

      // Mark parent as a classified digest container — understand skips it.
      await supabase.from("sources").update({
        is_digest:        true,
        main_category:    "unclear_or_adjacent",
        validation_status: "pass",
        layer3_status:    "pass",
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
  console.log(`  ${fanoutCount} children from ${digestSources.length} digest(s); ${fallbackSingles.length} single-topic fallback(s)`);

  // ── L4b: Classify (understand) ─────────────────────────────────────────────
  // Classifies: single sources + digest children + single-topic fallbacks.
  // Children arrive with null main_category so understandAllSources makes fresh
  // LLM calls on each (layer3_status=null bypasses the cache gate).
  console.log("\n── L4b: Classify (understand) ─────────────────────────────────");

  // Clear layer3_status so understandAllSources bypasses its cache gate and makes
  // fresh LLM calls. The cache gate checks layer3_status (not main_category), so
  // sources loaded with main_category=null but layer3_status="pass" would otherwise
  // be restored via fromDbRow() with category=null — the null:37 bug.
  // Children already have layer3_status=null from buildChildSources.
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

  // Collect IDs of newly classified research sources for significance scoring.
  const newResearchIds = relevant
    .filter(s => !s._from_cache && isSignificanceEligible(s))
    .map(s => s.id);

  // ── L4b-post: Deep extraction for long threat intel reports ─────────────────
  // Digests had extractAndSaveReportInsights fired during fanout (above).
  // Standalone threat intelligence sources that are long enough need the same
  // Sonnet deep-extraction pass (isEligibleForReportExtraction now accepts them).
  // Fire-and-forget — does not block classification QA.
  const longThreatIntel = relevant.filter(
    s => !s._from_cache && s.source_type === "threat_intelligence",
  );
  if (longThreatIntel.length) {
    console.log(`  [report-insights] queuing ${longThreatIntel.length} threat intel source(s) for deep extraction`);
    for (const s of longThreatIntel) {
      extractAndSaveReportInsights(s, supabase).catch(() => {});
    }
  }

  // ── L4c: QA verifier ──────────────────────────────────────────────────────
  console.log("\n── L4c: Classification QA ─────────────────────────────────────");
  const { report } = await qaClassificationLLM(relevant, {
    skipLlm: false, full: true, concurrency: 3, supabase,
  });
  console.log(`  QA: ${report.agreed}/${report.checked} agreed, ${report.fixed} auto-fixed (${report.agreement_rate.toFixed(0)}%)`);

  // ── L4d: Research significance ────────────────────────────────────────────
  await runSignificance(newResearchIds);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  By category: ${JSON.stringify(counts?.by_category || {})}`);
  console.log("  Done.\n");
}

main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error(err); process.exit(1); });
