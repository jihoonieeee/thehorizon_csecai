#!/usr/bin/env node
/**
 * generateNewsletter.js
 *
 * CLI wrapper around lib/newsletter/index.js.
 * Outputs an HTML file to ./output/newsletter-<date>.html.
 * Open in a browser → select all → paste into Gmail/Outlook to send.
 *
 * Usage:
 *   node scripts/generateNewsletter.js [--window week|month] [--asof YYYY-MM-DD] [--out path] [--dry-run]
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import {
  buildPeriod, loadCandidates, selectSourcesWithLlm,
  generateBlurbs, loadInsights, generateCategoryIntros, renderNewsletterHtml,
} from "../lib/newsletter/index.js";

const args    = process.argv.slice(2);
const getArg  = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const hasFlag = f => args.includes(f);

const WINDOW  = getArg("--window", "week");
const ASOF    = getArg("--asof",   null);
const DRY_RUN = hasFlag("--dry-run");

if (!["week", "month"].includes(WINDOW)) {
  console.error("--window must be week | month"); process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function main() {
  const now    = ASOF ? new Date(`${ASOF}T12:00:00Z`) : new Date();
  const today  = now.toISOString().slice(0, 10);
  const period = buildPeriod(WINDOW, now);

  console.log(`\n The Horizon — Newsletter Generator`);
  console.log(`  Window : ${period.label} (${period.date_from} → ${period.date_to})`);

  const log = msg => console.log(`  ${msg}`);

  log("loading candidates...");
  const candidates = await loadCandidates(supabase, period.date_from, period.date_to);
  log(`${candidates.length} candidates in window`);

  if (DRY_RUN) {
    console.log(`\n  [DRY-RUN] ${candidates.length} candidates (pre-LLM selection):`);
    for (const s of candidates) {
      const imp = s.intelligence?.importance?.tier || "?";
      console.log(`    ${s.date_published?.slice(0, 10)}  [${s.main_category}]  [${imp}]  ${s.title?.slice(0, 65)}`);
    }
    return;
  }

  const sources = await selectSourcesWithLlm(candidates, period, log);

  log("generating source blurbs (Haiku)...");
  const blurbMap = sources.length ? await generateBlurbs(sources, log) : {};
  log(`${Object.keys(blurbMap).length} blurbs ready`);

  log("loading period insights...");
  const { categories: insightCats, fromLabel: insightsFromLabel } = await loadInsights(supabase, period.key);
  const insightCount = Object.values(insightCats).reduce((n, ci) => n + (ci?.insights?.length || 0), 0);
  if (insightCount) log(`${insightCount} insights loaded (${Object.keys(insightCats).length} categories)`);
  else log(`no insights for ${period.key}${insightsFromLabel ? ` — using most recent: ${insightsFromLabel}` : " — intros synthesised from sources"}`);

  log("generating category intros (Sonnet)...");
  const introMap = await generateCategoryIntros(sources, blurbMap, insightCats, log);
  log(`${Object.values(introMap).filter(Boolean).length} intros ready`);

  log("rendering HTML...");
  const html = renderNewsletterHtml(period, sources, blurbMap, introMap, today);

  const outDir  = path.join(process.cwd(), "output");
  const outFile = getArg("--out", path.join(outDir, `newsletter-${today}.html`));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, html, "utf8");

  const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  console.log(`\n  Done. ${sources.length} sources · ${Object.values(introMap).filter(Boolean).length} category intros`);
  console.log(`  Written to: ${outFile} (${kb} KB)\n`);
}

main().catch(err => { console.error("\nFATAL:", err.message); process.exit(1); });
