#!/usr/bin/env node
/**
 * generateNewsletter.js
 *
 * CLI wrapper around lib/newsletter/index.js.
 * Outputs the generated HTML to ./output/newsletter-<date>.html.
 *
 * Usage:
 *   node scripts/generateNewsletter.js [--window week|month] [--asof YYYY-MM-DD] [--out path] [--dry-run]
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { generateNewsletterHtml, buildPeriod, loadInsights, loadReadingList } from "../lib/newsletter/index.js";

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
  if (DRY_RUN) {
    console.log("  [DRY-RUN] Printing context only.\n");
    const insights = await loadInsights(supabase, period.key);
    const sources  = await loadReadingList(supabase, period.date_from, period.date_to);
    console.log(`  ${Object.keys(insights.categories).length} categories, ${sources.length} sources`);
    return;
  }

  const { html, sourceCount, insightCount } = await generateNewsletterHtml(supabase, {
    window: WINDOW, asof: ASOF,
    log: msg => console.log(`  ${msg}`),
  });

  const outDir  = path.join(process.cwd(), "output");
  const outFile = getArg("--out", path.join(outDir, `newsletter-${today}.html`));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, html, "utf8");

  const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  console.log(`\n  Done. ${insightCount} insights · ${sourceCount} sources`);
  console.log(`  Written to: ${outFile} (${kb} KB)`);
  console.log(`  Open: file://${path.resolve(outFile)}\n`);
}

main().catch(err => { console.error("\nFATAL:", err.message); process.exit(1); });
