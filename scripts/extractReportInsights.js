#!/usr/bin/env node
/**
 * extractReportInsights.js — backfill deep-extraction for ALL eligible long reports.
 *
 * Queries ALL sources that are eligible for report extraction:
 *   - is_digest = true  (multi-topic landscape reports)
 *   - trust_tier IN (primary, high, curated)
 *   - full_text length >= 3000 chars
 *   - no existing intelligence.report_analysis (unless --all)
 *
 * The extraction logic lives in lib/pipeline/ingest/extractLongReportInsights.js
 * and is also wired into api/refresh.js so future long reports are auto-processed
 * on ingestion.
 *
 * Usage:
 *   node scripts/extractReportInsights.js [--dry-run] [--id <sourceId>] [--limit N]
 *   node scripts/extractReportInsights.js --all   # re-run even sources with existing RA
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  isEligibleForReportExtraction,
  extractReportAnalysis,
  extractAndSaveReportInsights,
} from "../lib/pipeline/ingest/extractLongReportInsights.js";

const args    = process.argv.slice(2);
const DRY     = args.includes("--dry-run");
const ALL     = args.includes("--all");
const idArg   = args.includes("--id")    ? args[args.indexOf("--id")    + 1] : null;
const LIMIT   = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1], 10) || 100 : 100;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function getTargets() {
  if (idArg) {
    const { data } = await supabase.from("sources").select("*").eq("id", idArg);
    return data || [];
  }

  // All eligible digests: is_digest=true, authoritative trust tier, sufficient text.
  // The isEligibleForReportExtraction() check further enforces the 3000-char floor.
  const { data, error } = await supabase
    .from("sources")
    .select("*")
    .eq("is_digest", true)
    .in("trust_tier", ["primary", "high", "curated"])
    .order("date_published", { ascending: false })
    .limit(LIMIT);

  if (error) throw new Error(`DB query failed: ${error.message}`);
  return data || [];
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set"); process.exit(1);
  }

  const targets = await getTargets();
  console.log(`\nProcessing ${targets.length} report(s)${DRY ? " [DRY RUN]" : ""}${ALL ? " [--all, overwrite existing]" : ""}\n`);

  let saved = 0, skipped = 0, failed = 0;

  for (const src of targets) {
    const chars = src.full_text?.length || 0;
    const hasRA = !!src.intelligence?.report_analysis;

    // In --all mode, temporarily clear report_analysis so eligibility passes
    if (ALL && hasRA) src.intelligence = { ...src.intelligence, report_analysis: undefined };

    if (!isEligibleForReportExtraction(src)) {
      console.log(`  SKIP  ${src.title?.slice(0, 65)} (${hasRA ? "already done" : `${chars} chars / ${src.trust_tier}`})`);
      skipped++;
      continue;
    }

    console.log(`  EXTRACT  ${src.title?.slice(0, 65)} (${chars} chars)`);

    if (DRY) {
      const analysis = await extractReportAnalysis(src).catch(e => { console.log(`    FAIL: ${e.message}`); return null; });
      if (analysis) {
        const { attack_walkthroughs: wt = [], critical_insights: ins = [], trends: tr = [] } = analysis;
        console.log(`    → ${wt.length} walkthroughs, ${ins.length} insights, ${tr.length} trends`);
        for (const w of wt) console.log(`      [walkthrough] ${w.actor} — ${w.technique}`);
      }
      continue;
    }

    const ok = await extractAndSaveReportInsights(src, supabase);
    ok ? saved++ : failed++;
  }

  console.log(`\nSaved: ${saved}  Skipped: ${skipped}  Failed: ${failed}\n`);
}

main().catch(err => { console.error("FATAL:", err.message, err.stack); process.exit(1); });
