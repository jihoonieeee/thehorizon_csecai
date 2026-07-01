#!/usr/bin/env node
/**
 * backfillInsightSources.js
 *
 * Adds source attribution (`insight.sources[]`) to EXISTING dashboard_insights
 * rows without regenerating the insight text. For each stored category insight
 * set, re-loads the window's sources and runs the same attribution step the
 * generator now runs inline, then writes the enriched insights back.
 *
 * Cheap: one LLM call per (window × category), no theme/insight regeneration.
 *
 * Usage:
 *   node scripts/backfillInsightSources.js [--window annual|month|quarter|week] [--dry-run] [--force]
 *   node scripts/backfillInsightSources.js                 # all windows
 *   node scripts/backfillInsightSources.js --window annual # annual only (dashboard default)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { attributeSources, loadWindowSources } from "./generateDashboardInsights.js";
import { flushCostBuffer } from "../lib/llm/usagePersistence.js";

const args    = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ONLY_WIN = getArg("--window", null);
const DRY_RUN  = args.includes("--dry-run");
const FORCE    = args.includes("--force");   // re-attribute even if sources already present

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CAT_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

// Map a stored window_key to its [from, to] date range (YYYY-MM-DD).
function windowRange(win, key) {
  if (win === "annual") {
    // Fixed horizon that matches api/dashboard.js: 2025 Q3 – 2026 Q2.
    return { from: "2025-07-01", to: "2026-06-30" };
  }
  if (win === "month") {
    const [y, m] = key.split("-").map(Number);
    const last = new Date(y, m, 0).getDate();
    return {
      from: `${y}-${String(m).padStart(2, "0")}-01`,
      to:   `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`,
    };
  }
  if (win === "quarter") {
    const [y, q] = key.split("-Q").map(Number);
    const startM = (q - 1) * 3 + 1;
    const endM   = startM + 2;
    const last   = new Date(y, endM, 0).getDate();
    return {
      from: `${y}-${String(startM).padStart(2, "0")}-01`,
      to:   `${y}-${String(endM).padStart(2, "0")}-${String(last).padStart(2, "0")}`,
    };
  }
  if (win === "week") {
    const [y, w] = key.split("-W").map(Number);
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const jan4Dow = (jan4.getUTCDay() + 6) % 7;    // 0 = Monday
    const week1Mon = new Date(jan4);
    week1Mon.setUTCDate(jan4.getUTCDate() - jan4Dow);
    const mon = new Date(week1Mon);
    mon.setUTCDate(week1Mon.getUTCDate() + (w - 1) * 7);
    const sun = new Date(mon);
    sun.setUTCDate(mon.getUTCDate() + 6);
    return { from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10) };
  }
  return null;
}

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Backfill insight source attribution`);
  console.log(`  Window: ${ONLY_WIN || "ALL"}   Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}   Force: ${FORCE}`);
  console.log(`${"═".repeat(60)}\n`);

  let q = sb.from("dashboard_insights")
    .select("id,win,window_key,window_label,category,points")
    .neq("category", "_period_meta");
  if (ONLY_WIN) q = q.eq("win", ONLY_WIN);
  const { data: rows, error } = await q;
  if (error) { console.error("Load error:", error.message); process.exit(1); }

  console.log(`  ${rows?.length || 0} category insight rows to process\n`);

  // Cache loaded window sources so we load each window once, not per category.
  const winSourceCache = new Map();

  let updated = 0, skipped = 0, failed = 0;

  for (const row of rows || []) {
    const points   = row.points || {};
    const insights = Array.isArray(points.insights) ? points.insights : [];
    if (!insights.length) { skipped++; continue; }

    // Skip if already attributed (unless --force)
    const alreadyDone = insights.every(p => Array.isArray(p.sources));
    if (alreadyDone && !FORCE) {
      console.log(`  ${row.win}/${row.window_key} ${row.category.padEnd(24)} SKIP (already attributed)`);
      skipped++;
      continue;
    }

    // Load window sources (cached per window_key)
    const cacheKey = `${row.win}/${row.window_key}`;
    if (!winSourceCache.has(cacheKey)) {
      const range = windowRange(row.win, row.window_key);
      if (!range) { console.log(`  ${cacheKey} — cannot parse window key, skipping`); failed++; continue; }
      const srcs = await loadWindowSources(range.from, range.to);
      winSourceCache.set(cacheKey, srcs);
    }
    const allSrcs = winSourceCache.get(cacheKey);
    const catSrcs = allSrcs.filter(s => s.main_category === row.category);

    if (!catSrcs.length) {
      console.log(`  ${cacheKey} ${row.category.padEnd(24)} SKIP (no sources in range)`);
      skipped++;
      continue;
    }

    // Run attribution
    let enriched;
    try {
      enriched = await attributeSources(insights, catSrcs, row.window_label || row.window_key, CAT_LABELS[row.category] || row.category);
    } catch (e) {
      console.log(`  ${cacheKey} ${row.category.padEnd(24)} FAIL: ${e.message.slice(0, 50)}`);
      failed++;
      continue;
    }

    const totalCites = enriched.reduce((n, p) => n + (p.sources?.length || 0), 0);
    console.log(`  ${cacheKey} ${row.category.padEnd(24)} ${enriched.length} insights · ${totalCites} citations`);
    enriched.forEach(p => {
      const urls = (p.sources || []).map(s => s.title?.slice(0, 40)).join(" | ");
      if (urls) console.log(`      • ${p.insight.slice(0, 55)}\n          ↳ ${urls}`);
    });

    if (!DRY_RUN) {
      const newPoints = { ...points, insights: enriched };
      const { error: upErr } = await sb.from("dashboard_insights")
        .update({ points: newPoints })
        .eq("id", row.id);
      if (upErr) { console.log(`      DB FAIL: ${upErr.message.slice(0, 50)}`); failed++; continue; }
      updated++;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Done: ${updated} updated · ${skipped} skipped · ${failed} failed  ${DRY_RUN ? "(dry run)" : ""}`);
  console.log(`${"═".repeat(60)}\n`);
}

main().then(() => flushCostBuffer()).catch(err => { console.error("FATAL:", err.message); process.exit(1); });
