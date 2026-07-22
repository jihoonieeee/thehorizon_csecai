#!/usr/bin/env node
/**
 * generateSlides — Build a PPTX slide deck from the classified source corpus.
 *
 * Usage:
 *   node scripts/generateSlides.js --from 2026-07-01 --to 2026-07-20
 *   node scripts/generateSlides.js --window month
 *   node scripts/generateSlides.js --window week --out ./output/deck.pptx
 *   node scripts/generateSlides.js --window month --category llm_threats
 *
 * Options:
 *   --from YYYY-MM-DD   Start of reporting window (inclusive)
 *   --to   YYYY-MM-DD   End of reporting window (inclusive)
 *   --window month|week|quarter  Auto-compute current calendar window
 *   --out  <path>       Output .pptx path (default: ./output/deck.pptx)
 *   --category <name>   Run a single category only (for debugging)
 *   --skip-qa           Skip entailment spot-check (faster, less safe)
 *   --dry-run           Show corpus stats without generating slides
 */

import "dotenv/config";
import path   from "path";
import fs     from "fs";
import { parseArgs } from "node:util";

import { makeSupabaseClient, fetchSlideCorpus }  from "../lib/slides/fetchSlideCorpus.js";
import { buildCategoryContext, CATEGORIES }       from "../lib/slides/buildCategoryContext.js";
import { generateCategoryReport }                 from "../lib/slides/generateCategoryReport.js";
import { qaReport }                               from "../lib/slides/qaReport.js";
import { planCategorySlides }                     from "../lib/slides/planCategorySlides.js";
import { generateOutlookSlide }                   from "../lib/slides/generateOutlookSlide.js";
import { assembleDeck }                           from "../lib/slides/assembleDeck.js";
import { renderDeckPptx }                         from "../lib/pipeline/slides/renderDeckPptx.js";

// ── Arg parsing ───────────────────────────────────────────────────────────────

const { values: argv } = parseArgs({
  options: {
    from:       { type: "string" },
    to:         { type: "string" },
    window:     { type: "string" },
    out:        { type: "string", default: "./output/deck.pptx" },
    category:   { type: "string" },
    "skip-qa":  { type: "boolean", default: false },
    "dry-run":  { type: "boolean", default: false },
  },
  strict: false,
});

function resolveTimeframe() {
  if (argv.from && argv.to) {
    return { dateFrom: argv.from, dateTo: argv.to };
  }

  const today = new Date();
  const pad   = n => String(n).padStart(2, "0");
  const ymd   = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  if (argv.window === "week") {
    const from = new Date(today);
    from.setDate(today.getDate() - 7);
    return { dateFrom: ymd(from), dateTo: ymd(today) };
  }

  if (argv.window === "quarter") {
    const from = new Date(today);
    from.setDate(today.getDate() - 90);
    return { dateFrom: ymd(from), dateTo: ymd(today) };
  }

  // Default: current calendar month up to today
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  return { dateFrom: ymd(monthStart), dateTo: ymd(today) };
}

function makeTimeframeLabel(dateFrom, dateTo) {
  const opts = { month: "long", year: "numeric" };
  const f    = new Date(dateFrom + "T12:00:00Z");
  const t    = new Date(dateTo   + "T12:00:00Z");
  if (f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear()) {
    return f.toLocaleDateString("en-GB", opts);
  }
  return `${dateFrom} to ${dateTo}`;
}

function log(msg) { process.stdout.write(`${msg}\n`); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { dateFrom, dateTo } = resolveTimeframe();
  const timeframeLabel = makeTimeframeLabel(dateFrom, dateTo);
  const outPath = path.resolve(argv.out);
  const skipQa  = argv["skip-qa"] ?? false;
  const dryRun  = argv["dry-run"] ?? false;
  const singleCat = argv.category || null;

  log(`\nGenerating slides: ${timeframeLabel}`);
  log(`  From : ${dateFrom}`);
  log(`  To   : ${dateTo}`);
  if (singleCat) log(`  Category filter: ${singleCat}`);
  if (dryRun)    log(`  Dry run — no LLM calls or PPTX output`);
  log("");

  // ── Step 1: Fetch corpus ──────────────────────────────────────────────────
  log("Step 1/6  Fetching sources…");
  const supabase = makeSupabaseClient();
  const allSources = await fetchSlideCorpus(supabase, dateFrom, dateTo);
  log(`  ${allSources.length} sources fetched`);

  const activeCategories = singleCat ? [singleCat] : CATEGORIES;

  // Show corpus stats
  for (const cat of activeCategories) {
    const n = allSources.filter(s => s.main_category === cat).length;
    log(`  ${cat}: ${n} sources`);
  }

  if (dryRun) {
    log("\nDry run complete.");
    return;
  }

  // ── Step 2: Build category contexts (deterministic) ───────────────────────
  log("\nStep 2/6  Building category contexts…");
  const contexts = {};
  for (const cat of activeCategories) {
    contexts[cat] = buildCategoryContext(cat, allSources);
    log(`  ${cat}: ${contexts[cat].sources.length} sources in dossier`);
  }

  // ── Step 3: Generate category reports (LLM, parallel) ────────────────────
  log("\nStep 3/6  Generating category reports (parallel)…");
  const reportResults = await Promise.allSettled(
    activeCategories.map(async cat => {
      const t0 = Date.now();
      const report = await generateCategoryReport(cat, contexts[cat], timeframeLabel, dateFrom, dateTo);
      const devCount = (report.developments || []).length;
      log(`  ✓ ${cat}: ${devCount} developments (${Date.now() - t0}ms)`);
      return { cat, report };
    })
  );

  const categoryReports = {};
  for (const r of reportResults) {
    if (r.status === "fulfilled") {
      categoryReports[r.value.cat] = r.value.report;
    } else {
      log(`  ✗ ${r.reason?.message || r.reason}`);
    }
  }

  // ── Steps 4+5: QA + Outlook in parallel ──────────────────────────────────
  // Outlook only needs categoryReports (done after step 3); QA is independent.
  // Running them together saves the full wall-clock cost of the outlook call.
  log("\nSteps 4+5/6  QA checks + Outlook (parallel)…");
  const allReports = activeCategories.map(c => categoryReports[c]).filter(Boolean);

  const [qaResultPairs, outlookRaw] = await Promise.all([
    Promise.all(
      activeCategories.map(async cat => {
        const report = categoryReports[cat];
        if (!report) return [cat, { issues: [], citation_issue_count: 0, entailment_issue_count: 0 }];
        const qa = await qaReport(report, contexts[cat].sourceIndex, { skipEntailment: skipQa });
        return [cat, qa];
      })
    ),
    generateOutlookSlide(allReports, timeframeLabel, dateFrom, dateTo),
  ]);

  const qaResults = Object.fromEntries(qaResultPairs);
  for (const cat of activeCategories) {
    const qa = qaResults[cat];
    if (!qa) continue;
    if (qa.citation_issue_count > 0)   log(`  ⚠ ${cat}: ${qa.citation_issue_count} citation issues fixed`);
    if (qa.entailment_issue_count > 0) log(`  ⚠ ${cat}: ${qa.entailment_issue_count} entailment failures flagged`);
    if (qa.citation_issue_count === 0 && qa.entailment_issue_count === 0) log(`  ✓ ${cat}: QA passed`);
  }

  // ── Step 5 (cont): Plan category slides ──────────────────────────────────
  log("\nStep 5/6  Planning slides…");

  // Resolve S-labels → URLs for each category, build urlSourceInfo
  const urlSourceInfo = {};
  const categorySlides = {};

  for (const cat of activeCategories) {
    const report = categoryReports[cat];
    if (!report) { categorySlides[cat] = []; continue; }

    const sourceIndex = contexts[cat].sourceIndex;

    // Build URL-keyed source info for assembleDeck
    for (const [, info] of Object.entries(sourceIndex)) {
      if (info.source_url) {
        urlSourceInfo[info.source_url] = {
          url:       info.source_url,
          title:     info.source_title,
          publisher: info.publisher,
        };
      }
    }

    // Plan slides (deterministic)
    const rawSlides = planCategorySlides(cat, report);

    // Resolve S-labels → URLs in bullets
    const resolvedSlides = rawSlides.map(slide => ({
      ...slide,
      bullets: (slide.bullets || []).map(b => ({
        ...b,
        cited_urls: (b.cited_sources || [])
          .map(label => sourceIndex[label]?.source_url)
          .filter(Boolean),
      })),
      attack_chain: (slide.attack_chain || []),
    }));

    categorySlides[cat] = resolvedSlides;
    log(`  ${cat}: ${resolvedSlides.length} slides`);
  }

  // Outlook bullets have no cited_urls
  const outlookSlide = {
    ...outlookRaw,
    bullets: (outlookRaw.bullets || []).map(b => ({ ...b, cited_urls: [] })),
  };
  log(`  Outlook: ${(outlookSlide.bullets || []).length} bullets`);

  // ── Step 6: Assemble + render ─────────────────────────────────────────────
  log("\nStep 6/6  Assembling deck and rendering PPTX…");
  const deck = assembleDeck(categorySlides, outlookSlide, urlSourceInfo, timeframeLabel);

  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const { slide_count } = await renderDeckPptx(deck, outPath, {
    title: `AI Cyber Threat Horizon Scan — ${timeframeLabel}`,
  });

  log(`\n✓ Done: ${outPath}`);
  log(`  ${slide_count} slides | ${Object.values(urlSourceInfo).length} unique sources cited`);

  // QA summary
  const totalIssues = Object.values(qaResults).reduce((n, q) => n + q.issues.length, 0);
  if (totalIssues > 0) {
    log(`\n⚠ ${totalIssues} QA issue(s) — review logs above`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
