#!/usr/bin/env node
/**
 * generateSlides — Build a PPTX slide deck from the classified source corpus.
 *
 * Usage:
 *   node scripts/generateSlides.js --from 2026-07-01 --to 2026-07-20
 *   node scripts/generateSlides.js --window month
 *   node scripts/generateSlides.js --window quarter --out ./output/deck.pptx
 *   node scripts/generateSlides.js --window half_year --category llm_threats
 *
 * Options:
 *   --from YYYY-MM-DD   Start of reporting window (inclusive)
 *   --to   YYYY-MM-DD   End of reporting window (inclusive)
 *   --window month|quarter|half_year|year  Rolling window ending today
 *   --out  <path>       Output .pptx path (default: ./output/deck.pptx)
 *   --category <name>   Run a single category only (for debugging)
 *   --skip-qa           Skip entailment spot-check (faster, less safe)
 *   --dry-run           Show corpus stats without generating slides
 */

import "dotenv/config";
import path   from "path";
import fs     from "fs";
import { parseArgs } from "node:util";

import { put }                                    from "@vercel/blob";
import { makeSupabaseClient, fetchSlideCorpus, attachEvidence } from "../lib/slides/fetchSlideCorpus.js";
import { buildCategoryContext, CATEGORIES }       from "../lib/slides/buildCategoryContext.js";
import { generateCategoryReport }                 from "../lib/slides/generateCategoryReport.js";
import { qaReport }                               from "../lib/slides/qaReport.js";
import { planCategorySlides }                     from "../lib/slides/planCategorySlides.js";
import { selectCategorySources }                  from "../lib/slides/selectCategorySources.js";
import { generateOutlookSlide }                   from "../lib/slides/generateOutlookSlide.js";
import { generateOverviewSlide }                  from "../lib/slides/generateOverviewSlide.js";
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
    rerender:   { type: "string" },   // path to a saved deck .json — skips all LLM calls
  },
  strict: false,
});

// ── Re-render shortcut: read saved JSON, render, exit ─────────────────────────
if (argv.rerender) {
  const jsonPath = path.resolve(argv.rerender);
  const outPath  = path.resolve(argv.out);
  const saved    = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const { renderDeckPptx } = await import("../lib/pipeline/slides/renderDeckPptx.js");
  const { slide_count } = await renderDeckPptx(saved.deck, outPath, {
    title: `AI Cyber Threat Horizon Scan — ${saved.timeframe}`,
  });
  process.stdout.write(`✓ Re-rendered ${slide_count} slides → ${outPath}\n`);
  process.exit(0);
}

const WINDOW_DAYS = { month: 30, quarter: 90, half_year: 180, year: 365 };

function resolveTimeframe() {
  if (argv.from && argv.to) {
    return { dateFrom: argv.from, dateTo: argv.to };
  }

  const today = new Date();
  const pad   = n => String(n).padStart(2, "0");
  const ymd   = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const days = WINDOW_DAYS[argv.window] ?? 30;
  const from = new Date(today);
  from.setDate(today.getDate() - days);
  return { dateFrom: ymd(from), dateTo: ymd(today) };
}

function makeTimeframeLabel(dateFrom, dateTo) {
  const f = new Date(dateFrom + "T12:00:00Z");
  const t = new Date(dateTo   + "T12:00:00Z");
  const monthLong = { month: "long", year: "numeric" };
  if (f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear()) {
    return f.toLocaleDateString("en-GB", monthLong);
  }
  if (f.getFullYear() === t.getFullYear()) {
    const m1 = f.toLocaleDateString("en-GB", { month: "long" });
    const m2 = t.toLocaleDateString("en-GB", monthLong);
    return `${m1}–${m2}`;
  }
  return `${f.toLocaleDateString("en-GB", monthLong)} – ${t.toLocaleDateString("en-GB", monthLong)}`;
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

  // ── Step 2a: Source selection (Haiku, parallel) ──────────────────────────
  // Each category's full eligible pool is shown to Haiku, which picks the most
  // strategically valuable sources and identifies clusters (shared mechanisms).
  log("\nStep 2a/6  Selecting sources (parallel)…");
  const selectionResults = await Promise.all(
    activeCategories.map(async cat => {
      const pool = allSources.filter(s => s.main_category === cat);
      const t0 = Date.now();
      const { selectedSources, clusterContext } = await selectCategorySources(cat, pool);
      const ms = Date.now() - t0;
      const note = selectedSources.length < pool.length
        ? `${selectedSources.length} selected from ${pool.length}`
        : `${selectedSources.length} (all)`;
      log(`  ${cat}: ${note} (${ms}ms)`);
      return { cat, selectedSources, clusterContext };
    })
  );

  // ── Step 2b: Attach evidence only to selected sources ────────────────────
  // Load evidence items from DB only for the selected subset — not all 500+ sources.
  const allSelected = selectionResults.flatMap(r => r.selectedSources);
  await attachEvidence(supabase, allSelected);

  // ── Step 2c: Build category contexts (deterministic) ─────────────────────
  log("\nStep 2c/6  Building category contexts…");
  const contexts = {};
  for (const { cat, selectedSources, clusterContext } of selectionResults) {
    contexts[cat] = buildCategoryContext(cat, selectedSources, clusterContext);
  }

  // ── Step 3: Generate category reports (LLM, parallel) ────────────────────
  log("\nStep 3/6  Generating category reports (parallel)…");
  const reportResults = await Promise.allSettled(
    activeCategories.map(async cat => {
      const t0 = Date.now();
      const report = await generateCategoryReport(cat, contexts[cat], timeframeLabel, dateFrom, dateTo);
      const shiftCount = (report.strategic_shifts || []).length;
      log(`  ✓ ${cat}: ${shiftCount} shifts (${Date.now() - t0}ms)`);
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

  // ── Steps 4+5: QA + Outlook + Overview in parallel ───────────────────────
  log("\nSteps 4+5/6  QA checks + Outlook + Overview (parallel)…");
  const allReports = activeCategories.map(c => categoryReports[c]).filter(Boolean);

  // Skip cross-category slides in single-category debug mode — they'd misrepresent the deck
  const [qaResultPairs, outlookRaw, overviewRaw] = await Promise.all([
    Promise.all(
      activeCategories.map(async cat => {
        const report = categoryReports[cat];
        if (!report) return [cat, { issues: [], citation_issue_count: 0, entailment_issue_count: 0 }];
        const qa = await qaReport(report, contexts[cat].sourceIndex, { skipEntailment: skipQa });
        return [cat, qa];
      })
    ),
    singleCat ? Promise.resolve(null) : generateOutlookSlide(allReports, timeframeLabel, dateFrom, dateTo),
    singleCat ? Promise.resolve(null) : generateOverviewSlide(allReports, timeframeLabel, dateFrom, dateTo),
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

  const outlookSlide  = outlookRaw  ? {
    ...outlookRaw,
    watch_items: outlookRaw.watch_items || [],
    caveat:      outlookRaw.caveat || null,
    bullets:     [],
  } : null;
  const overviewSlide = overviewRaw ? { ...overviewRaw, bullets: (overviewRaw.bullets || []).map(b => ({ ...b, cited_urls: [] })) } : null;
  log(`  Overview: ${(overviewSlide?.bullets || []).length} statements`);
  log(`  Outlook:  ${(outlookSlide?.watch_items || []).length} watch items`);

  // ── Step 6: Assemble + render ─────────────────────────────────────────────
  log("\nStep 6/6  Assembling deck and rendering PPTX…");
  const deck = assembleDeck(categorySlides, outlookSlide, overviewSlide, urlSourceInfo, timeframeLabel);

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

  // ── Save deck JSON locally so re-rendering is always possible without new LLM calls ──
  const jsonOutPath = outPath.replace(/\.pptx$/i, ".json");
  fs.writeFileSync(jsonOutPath, JSON.stringify({
    generated_at:     new Date().toISOString(),
    timeframe:        timeframeLabel,
    date_from:        dateFrom,
    date_to:          dateTo,
    window:           argv.window || "custom",
    category:         singleCat || null,
    source_count:     allSources.length,
    slide_count,
    deck,
    category_reports: categoryReports,
  }, null, 2));
  log(`  JSON saved → ${jsonOutPath}`);

  // ── Persist to Vercel Blob + Supabase so the dashboard can find the deck ──
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    log("\nPersisting deck…");
    try {
      const dateKey  = new Date().toISOString().slice(0, 10);
      const window   = argv.window || "custom";
      // Single-category runs use a suffixed key so they never overwrite the full deck blob
      const catSuffix = singleCat ? `-${singleCat}` : "";
      const deckId   = `deck-${dateKey}-${window}${catSuffix}`;
      const blobBase = `decks/${dateKey}/horizon-scan-${window}${catSuffix}`;

      const blobOpts = {
        access:         "private",
        token:          process.env.BLOB_READ_WRITE_TOKEN,
        addRandomSuffix: false,
        allowOverwrite:  true,
      };

      // Upload PPTX
      const pptxBytes = fs.readFileSync(outPath);
      const { url: pptxUrl } = await put(`${blobBase}.pptx`, pptxBytes, {
        ...blobOpts,
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      });
      log(`  PPTX uploaded → ${pptxUrl}`);

      // Upload deck JSON (slides + metadata)
      const deckJson = JSON.stringify({
        deck_id:      deckId,
        generated_at: new Date().toISOString(),
        timeframe:    timeframeLabel,
        date_from:    dateFrom,
        date_to:      dateTo,
        window,
        source_count: allSources.length,
        slide_count,
        deck,
        category_reports: categoryReports,
      }, null, 2);
      const { url: jsonUrl } = await put(`${blobBase}.json`, deckJson, {
        ...blobOpts,
        contentType: "application/json",
      });
      log(`  JSON uploaded → ${jsonUrl}`);

      const { error } = await supabase.from("decks").upsert({
        deck_id:             deckId,
        generated_at:        new Date().toISOString(),
        source_window_start: dateFrom,
        source_window_end:   dateTo,
        source_count:        allSources.length,
        slide_count,
        pptx_url:            pptxUrl,
        blob_path:           jsonUrl,
        deck_version:        deck.deck_version || "slides-v2.0",
      }, { onConflict: "deck_id" });
      if (error) log(`  ⚠ Supabase upsert failed: ${error.message}`);
      else       log(`  Deck row saved (${deckId})`);
    } catch (err) {
      log(`  ⚠ Persist skipped: ${err.message}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
