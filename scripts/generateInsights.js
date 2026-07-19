#!/usr/bin/env node
/**
 * generateInsights.js
 *
 * Runs the L6 analysis pipeline for a given timeframe and persists results
 * to the category_insights table. Replaces generateDashboardInsights.js.
 *
 * Usage:
 *   node scripts/generateInsights.js --window week|month|quarter
 *   node scripts/generateInsights.js --window month --asof 2026-06-15
 *   node scripts/generateInsights.js --date-from 2026-07-01 --date-to 2026-07-18
 *   node scripts/generateInsights.js --window week --category llm_threats
 *   node scripts/generateInsights.js --window month --force
 *   node scripts/generateInsights.js --window month --dry-run
 *
 * Flags:
 *   --window week|month|quarter    Reporting timeframe (default: month)
 *   --asof  YYYY-MM-DD             Override "now" for historical backfill
 *   --date-from YYYY-MM-DD         Custom range start (use with --date-to)
 *   --date-to   YYYY-MM-DD         Custom range end
 *   --category  <name>             Run one category only
 *   --force                        Overwrite existing rows for this window
 *   --dry-run                      Print output without writing to DB
 *   --no-evidence                  Skip L5 evidence items (faster, lower attribution quality)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { getCompletedPeriodWindow } from "../lib/time/reportingWindow.js";
import { runAnalysis }              from "../lib/pipeline/analysis/runAnalysis.js";
import { buildCorpusSummary }       from "../lib/pipeline/analysis/corpusSummary.js";
import { setCurrentRunId }          from "../lib/llm/usagePersistence.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const hasFlag = f => args.includes(f);

const WIN        = getArg("--window", "month");
const ASOF       = getArg("--asof", null);
const DATE_FROM  = getArg("--date-from", null);
const DATE_TO    = getArg("--date-to", null);
const ONLY_CAT   = getArg("--category", null);
const FORCE      = hasFlag("--force");
const DRY_RUN    = hasFlag("--dry-run");
const NO_EV      = hasFlag("--no-evidence");

if (!["week", "month", "quarter", "annual"].includes(WIN) && !DATE_FROM) {
  console.error("--window must be week | month | quarter | annual, or provide --date-from / --date-to");
  process.exit(1);
}

// ── Supabase ──────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Resolve window ────────────────────────────────────────────────────────────

function resolveWindow() {
  if (DATE_FROM && DATE_TO) {
    return {
      type:      "custom",
      key:       `custom-${DATE_FROM}-${DATE_TO}`,
      label:     `${DATE_FROM} to ${DATE_TO}`,
      date_from: DATE_FROM,
      date_to:   DATE_TO,
    };
  }
  const now = ASOF ? new Date(`${ASOF}T12:00:00Z`) : new Date();
  const w   = getCompletedPeriodWindow(WIN, now);
  return {
    type:      w.win,
    key:       w.key,
    label:     w.label,
    date_from: w.date_from,
    date_to:   w.date_to,
  };
}

// ── Load sources ──────────────────────────────────────────────────────────────

const OFFENSIVE_CATS = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

async function loadSources(dateFrom, dateTo) {
  const cats = ONLY_CAT ? [ONLY_CAT] : OFFENSIVE_CATS;

  const results = await Promise.all(cats.map(cat =>
    supabase
      .from("sources")
      .select("*")
      .eq("main_category", cat)
      .eq("validation_status", "pass")
      .gte("date_published", dateFrom)
      .lte("date_published", dateTo)
      .order("date_published", { ascending: false })
  ));

  const sources = [];
  const seen = new Set();
  for (const { data, error } of results) {
    if (error) { console.error("DB error:", error.message); continue; }
    for (const s of data || []) {
      if (!seen.has(s.id)) { seen.add(s.id); sources.push(s); }
    }
  }
  return sources;
}

async function loadEvidenceItems(sourceIds) {
  if (!sourceIds.length) return [];
  // evidence_items table keyed by source_id
  const CHUNK = 100;
  const items = [];
  for (let i = 0; i < sourceIds.length; i += CHUNK) {
    const chunk = sourceIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("evidence_items")
      .select("*")
      .in("source_id", chunk);
    if (error) { console.warn("evidence_items load error:", error.message); continue; }
    items.push(...(data || []));
  }
  return items;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const windowInfo = resolveWindow();
  console.log(`\nGenerating insights for: ${windowInfo.label} (${windowInfo.key})`);
  console.log(`Period: ${windowInfo.date_from} → ${windowInfo.date_to}`);
  if (ONLY_CAT) console.log(`Category: ${ONLY_CAT} only`);
  if (FORCE)    console.log("--force: overwriting existing rows");
  if (DRY_RUN)  console.log("--dry-run: not writing to DB");

  const runId = `insights-${windowInfo.key}-${Date.now()}`;
  setCurrentRunId(runId);

  // Load sources
  console.log("\nLoading sources…");
  const sources = await loadSources(windowInfo.date_from, windowInfo.date_to);
  if (!sources.length) {
    console.error(`No sources found for ${windowInfo.date_from} → ${windowInfo.date_to}`);
    process.exit(1);
  }
  console.log(`  ${sources.length} sources loaded`);

  // Load evidence items (optional)
  let evidenceItems = [];
  if (!NO_EV) {
    console.log("Loading evidence items…");
    evidenceItems = await loadEvidenceItems(sources.map(s => s.id));
    console.log(`  ${evidenceItems.length} evidence items loaded`);
  }

  // Build corpus summary
  const corpusSummary = buildCorpusSummary(sources, sources);

  // Run analysis
  console.log("\nRunning L6 analysis…");
  const analyses = await runAnalysis(
    sources,
    evidenceItems,
    corpusSummary,
    windowInfo,
    {
      skipLlm: false,
      supabase: DRY_RUN ? null : supabase,
      force: FORCE,
    }
  );

  // Print summary
  console.log("\n── Results ──");
  for (const ca of analyses) {
    const approved = (ca.insights || []).filter(i => !i.blocked).length;
    const blocked  = (ca.insights || []).filter(i => i.blocked).length;
    console.log(`  ${ca.category}: ${ca.assessment_status} — ${approved} insights${blocked ? ` (${blocked} blocked)` : ""}`);
    for (const ins of (ca.insights || []).filter(i => !i.blocked)) {
      console.log(`    • [${ins.evidence_maturity}] ${ins.title}`);
      console.log(`      Sources: ${(ins.cited_sources || []).map(cs => cs.publisher || cs.source_id.slice(0, 8)).join(", ")}`);
    }
  }

  if (DRY_RUN) {
    console.log("\n[dry-run] Not written to DB. Pass without --dry-run to persist.");
  } else {
    console.log(`\nPersisted to category_insights (window_key: ${windowInfo.key})`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
