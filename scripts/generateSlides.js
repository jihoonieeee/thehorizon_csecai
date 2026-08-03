#!/usr/bin/env node
/**
 * generateSlides — Build a PPTX slide deck from the classified source corpus.
 *
 * Usage:
 *   node scripts/generateSlides.js --from 2026-07-01 --to 2026-07-20
 *   node scripts/generateSlides.js --window month
 *   node scripts/generateSlides.js --window quarter --out ./output/deck.pptx
 *   node scripts/generateSlides.js --window year --category llm_threats
 *
 * Options:
 *   --from YYYY-MM-DD   Start of reporting window (inclusive) — custom range override
 *   --to   YYYY-MM-DD   End of reporting window (inclusive)   — custom range override
 *   --window month|quarter|year  Previous COMPLETE calendar period
 *                       (SGT-anchored, same semantics as the newsletter — not a
 *                        rolling "last N days ending today" window)
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
import { scrubSlideReport }                       from "../lib/slides/scrubSlideFacts.js";
import { renderDeckPptx }                         from "../lib/pipeline/slides/renderDeckPptx.js";
import { getCompletedPeriodWindow }               from "../lib/time/reportingWindow.js";

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
    // Backup-run guard: exit early (no LLM cost) if a deck for THIS window's
    // target period already exists. Lets a scheduled backup confirm the primary
    // succeeded and regenerate only when it didn't.
    "skip-if-exists": { type: "boolean", default: false },
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

const SLIDE_WINDOWS = ["month", "quarter", "year"];

// Fixed, previous-complete calendar window (SGT-anchored) — same semantics as
// the newsletter. Not a rolling "last N days ending today" window. A --from/--to
// pair overrides with an explicit custom range.
function resolveTimeframe() {
  if (argv.from && argv.to) {
    return { dateFrom: argv.from, dateTo: argv.to, label: makeTimeframeLabel(argv.from, argv.to) };
  }

  const win = argv.window || "month";
  if (!SLIDE_WINDOWS.includes(win)) {
    throw new Error(`Invalid --window "${win}". Must be one of: ${SLIDE_WINDOWS.join(", ")} (or pass --from/--to).`);
  }

  const period = getCompletedPeriodWindow(win);
  return { dateFrom: period.date_from, dateTo: period.date_to, label: period.label, insightKey: period.key };
}

// Load the period's validated dashboard insights, keyed by category. These anchor
// the slide content when present (higher-quality synthesis than re-deriving from
// raw sources). Returns {} when the window has no insights (e.g. the year window,
// or a custom --from/--to range) — the pipeline then falls back to dossier synthesis.
async function loadCategoryInsights(supabase, windowKey) {
  if (!windowKey) return {};
  const { data, error } = await supabase
    .from("dashboard_insights")
    .select("category, points")
    .eq("window_key", windowKey);
  if (error) { log(`  ⚠ insight load failed: ${error.message}`); return {}; }
  const byCat = {};
  for (const r of data || []) {
    if (r.category?.startsWith("_")) continue; // skip _period_meta / _newsletter
    if (r.points?.insights?.length) byCat[r.category] = r.points;
  }
  return byCat;
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

// ── Markdown export ───────────────────────────────────────────────────────────

function renderDeckMarkdown({ generated_at, timeframe, date_from, date_to, window: win, source_count, slide_count, deck }) {
  const lines = [];
  const push = (...args) => lines.push(...args);

  push(
    `# AI Cyber Threat Horizon Scan — ${timeframe}`,
    ``,
    `Generated: ${generated_at.replace("T", " ").slice(0, 19)} UTC | Window: ${win} | Sources: ${source_count} | Slides: ${slide_count}`,
    `Period: ${date_from} → ${date_to}`,
    ``,
  );

  const CONFIDENCE_ICON = { high: "🔴", medium: "🟡", low: "⚪" };
  const MATURITY_ICON   = { emerging: "🌱", active: "⚡", established: "🔒" };

  for (const slide of (deck?.slides || [])) {
    switch (slide.type) {

      case "cover":
        push(`---`, ``, `## Cover`, ``, `> ${slide.headline}`, ``);
        break;

      case "overview":
        push(`---`, ``, `## Overview — ${slide.headline}`, ``);
        for (const b of (slide.bullets || [])) {
          const role  = (b.role || b.bullet_role || "").toUpperCase();
          const label = role ? `**[${role}]** ` : "";
          push(`- ${label}${b.text}`);
        }
        push(``);
        break;

      case "section_summary": {
        const cat = slide.category?.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) || slide.headline;
        push(`---`, ``, `## ${cat}`, ``, `> ${slide.category_summary || ""}`, ``);
        if (slide.shift_headlines?.length) {
          push(`**Shifts covered:**`);
          for (const h of slide.shift_headlines) push(`- ${h}`);
          push(``);
        }
        break;
      }

      case "strategic_shift": {
        const conf = CONFIDENCE_ICON[slide.confidence] || "";
        const mat  = MATURITY_ICON[slide.maturity]    || "";
        push(
          `### ${mat}${conf} [Strategic Shift] ${slide.headline}`,
          ``,
          `**Takeaway:** ${slide.takeaway || ""}`,
          ``,
          `**Confidence:** ${slide.confidence || "—"} | **Maturity:** ${slide.maturity || "—"}`,
          ``,
        );
        for (const b of (slide.bullets || [])) {
          const refs  = (b.cite_nums || []).map(n => `[${n}]`).join("");
          const role  = (b.role || b.bullet_role || "").toUpperCase();
          const label = role ? `**[${role}]** ` : "";
          push(`- ${label}${b.text}${refs ? " " + refs : ""}`);
        }
        if (slide.implication) push(``, `**Implication:** ${slide.implication}`);
        if (slide._footnotes?.length) {
          push(``, `*Sources: ${slide._footnotes.map(f => `[${f.num}] ${f.publisher}`).join(", ")}*`);
        }
        push(``);
        break;
      }

      case "case_study": {
        push(
          `### 🔍 [Case Study] ${slide.headline}`,
          ``,
        );
        if (slide.named_entity) push(`**Entity:** ${slide.named_entity}`, ``);
        for (const b of (slide.bullets || [])) {
          const refs  = (b.cite_nums || []).map(n => `[${n}]`).join("");
          const role  = (b.role || b.bullet_role || "").toUpperCase();
          const label = role ? `**[${role}]** ` : "";
          push(`- ${label}${b.text}${refs ? " " + refs : ""}`);
        }
        if (slide.diagram_spec?.steps?.length) {
          const chain = slide.diagram_spec.steps
            .map(s => (typeof s === "string" ? s : s.step || JSON.stringify(s)))
            .join(" → ");
          push(``, `**Attack chain:** ${chain}`);
        }
        if (slide._footnotes?.length) {
          push(``, `*Sources: ${slide._footnotes.map(f => `[${f.num}] ${f.publisher}`).join(", ")}*`);
        }
        push(``);
        break;
      }

      case "outlook_structured":
        push(`---`, ``, `## 📅 ${slide.headline}`, ``);
        for (const item of (slide.watch_items || [])) {
          const label = item.label ? `**${item.label}:** ` : "";
          push(`- ${label}${item.text || item}`);
        }
        if (slide.caveat) push(``, `> ⚠ ${slide.caveat}`);
        push(``);
        break;

      case "references":
        push(`---`, ``, `## References`, ``);
        for (const r of (slide.bullets || [])) {
          push(`- [${r.ref_num}] **${r.publisher}** — [${r.title}](${r.url})`);
        }
        push(``);
        break;
    }
  }

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { dateFrom, dateTo, label: timeframeLabel, insightKey } = resolveTimeframe();
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

  const supabase = makeSupabaseClient();

  // ── Backup-run guard ──────────────────────────────────────────────────────
  // Exit before any LLM work if a deck for this exact window already exists.
  if (argv["skip-if-exists"] && !singleCat) {
    const win = argv.window || "custom";
    const { data, error } = await supabase
      .from("decks")
      .select("deck_id")
      .eq("source_window_start", dateFrom)
      .eq("source_window_end",   dateTo);
    if (!error && (data || []).some(d => d.deck_id?.endsWith(`-${win}`))) {
      log(`Deck already exists for ${win} (${dateFrom} → ${dateTo}); skipping.\n`);
      return;
    }
    log(`No existing ${win} deck for this period — generating.\n`);
  }

  // ── Step 1: Fetch corpus ──────────────────────────────────────────────────
  log("Step 1/6  Fetching sources…");
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
  // Anchor on the period's validated insights when available (higher quality
  // than re-deriving from raw sources); fall back to dossier-only otherwise.
  const categoryInsights = await loadCategoryInsights(supabase, insightKey);
  const insightCats = Object.keys(categoryInsights);
  log(`\nStep 2c/6  Building category contexts… ${insightCats.length ? `(insight-anchored: ${insightCats.join(", ")})` : "(dossier-only — no insights for this window)"}`);
  const contexts = {};
  for (const { cat, selectedSources, clusterContext } of selectionResults) {
    contexts[cat] = buildCategoryContext(cat, selectedSources, clusterContext, categoryInsights[cat] || null);
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

  // ── Retry categories where the LLM call returned empty (once, sequential) ──
  // Promise.allSettled swallows null LLM responses as fulfilled-but-empty.
  // Retry gives transient platform errors a second chance before the category
  // is silently absent from the deck.
  const emptyDueToLlm = activeCategories.filter(cat => {
    const rep = categoryReports[cat];
    return rep &&
      (rep.strategic_shifts || []).length === 0 &&
      (rep.coverage_gaps || []).some(g => g.includes("LLM call returned empty"));
  });
  if (emptyDueToLlm.length) {
    log(`\n  Retrying ${emptyDueToLlm.length} empty category report(s)…`);
    for (const cat of emptyDueToLlm) {
      const retry = await generateCategoryReport(cat, contexts[cat], timeframeLabel, dateFrom, dateTo);
      if ((retry.strategic_shifts || []).length > 0) {
        categoryReports[cat] = retry;
        log(`  ✓ ${cat}: retry succeeded (${retry.strategic_shifts.length} shifts)`);
      } else {
        log(`  ✗ ${cat}: retry still empty — category will be absent from deck`);
      }
    }
  }

  // ── Maturity ceiling enforcement (deterministic, post-LLM) ───────────────
  // The category-report prompt has maturity rules but LLMs occasionally assign
  // operational_campaign to research-only shifts. Cap maturity based on the
  // actual evidence tiers of the cited sources.
  function capShiftMaturity(shift, sourceIndex) {
    const MAT_RANK = {
      operational_campaign: 5, adversary_adoption: 4, observed_exploitation: 3,
      disclosed_vulnerability: 2, research_demonstration: 1,
    };
    const labels = (shift.supporting_evidence || []).flatMap(e => e.cited_sources || []);
    if (!labels.length) return shift;
    const hasOperational = labels.some(l =>
      ["realized", "proven"].includes(sourceIndex[l]?.importance_tier)
    );
    if (!hasOperational && (MAT_RANK[shift.maturity] || 0) >= 3) {
      log(`  ↳ capped maturity: ${shift.headline?.slice(0, 60)} (${shift.maturity} → disclosed_vulnerability)`);
      return {
        ...shift,
        maturity:   "disclosed_vulnerability",
        confidence: shift.confidence === "high" ? "moderate" : shift.confidence,
      };
    }
    return shift;
  }

  for (const cat of activeCategories) {
    const report = categoryReports[cat];
    if (!report) continue;
    const idx = contexts[cat]?.sourceIndex || {};
    report.strategic_shifts = (report.strategic_shifts || []).map(s => capShiftMaturity(s, idx));
  }

  // ── Fetch full_text for every cited source (once) ─────────────────────────
  // Both the deterministic scrub and the QA gate ground on full_text — the same
  // basis the insight layer uses — not the ~550-char short_summary. Fetch the
  // union of cited URLs a single time and share the map.
  const citedUrls = new Set();
  for (const cat of activeCategories) {
    const report = categoryReports[cat];
    const idx = contexts[cat]?.sourceIndex || {};
    for (const shift of report?.strategic_shifts || [])
      for (const ev of shift.supporting_evidence || [])
        for (const l of ev.cited_sources || []) { const u = idx[l]?.source_url; if (u) citedUrls.add(u); }
  }
  const fullTextByUrl = new Map();
  if (citedUrls.size) {
    const { data } = await supabase.from("sources").select("url,full_text").in("url", [...citedUrls]);
    for (const r of data || []) if (r.full_text) fullTextByUrl.set(r.url, r.full_text);
    log(`  full_text resolved for ${fullTextByUrl.size}/${citedUrls.size} cited sources`);
  }

  // ── Grounding scrub: drop facts with invented/mis-stated figures ──────────
  // Safety net for the prompt's grounding rules — strips a supporting fact whose
  // specific figures are absent from the insight block + the fact's cited sources'
  // full text.
  for (const cat of activeCategories) {
    const report = categoryReports[cat];
    if (!report) continue;
    const dropped = scrubSlideReport(report, contexts[cat], fullTextByUrl);
    for (const d of dropped) {
      log(`  ⚠ ${cat}: dropped ungrounded fact [${(d.ungrounded || []).join(", ")}] — "${d.fact?.slice(0, 80)}"`);
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
        const qa = await qaReport(report, contexts[cat].sourceIndex, { skipEntailment: skipQa, supabase, fullTextByUrl });
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
    if (qa.entailment_issue_count > 0) log(`  ⚠ ${cat}: ${qa.entailment_issue_count} entailment issue(s) (corrected/dropped)`);
    if (qa.citation_issue_count === 0 && qa.entailment_issue_count === 0) log(`  ✓ ${cat}: QA passed`);
    // Surface each gated bullet so it can be reviewed (non-blocking).
    for (const iss of qa.issues || []) {
      if (iss.type === "entailment_failure") {
        log(`      ↳ DROPPED [${iss.cited}] "${iss.bullet}${iss.bullet?.length >= 100 ? "…" : ""}"`);
        if (iss.reason) log(`         reason: ${iss.reason}`);
      } else if (iss.type === "entailment_corrected") {
        log(`      ↳ CORRECTED [${iss.cited}] "${iss.bullet}${iss.bullet?.length >= 100 ? "…" : ""}"`);
        if (iss.reason) log(`         reason: ${iss.reason}`);
      } else if (iss.type === "unresolvable_citation") {
        log(`      ↳ dropped citation ${iss.label} (${iss.context})`);
      }
    }
  }

  // ── Post-QA gate: drop shifts that lost all evidence bullets ────────────
  // qaReport entailment may drop every bullet from a shift. A shift with zero
  // supporting_evidence is assertion without evidence — remove it before
  // planCategorySlides runs so it never reaches the deck.
  for (const cat of activeCategories) {
    const report = categoryReports[cat];
    if (!report) continue;
    const before = (report.strategic_shifts || []).length;
    report.strategic_shifts = (report.strategic_shifts || [])
      .filter(s => (s.supporting_evidence || []).length >= 1);
    const dropped = before - report.strategic_shifts.length;
    if (dropped > 0)
      log(`  ✗ ${cat}: dropped ${dropped} shift(s) with no evidence after QA`);
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

  // ── Save human-readable Markdown for auditing ─────────────────────────────
  const mdOutPath = outPath.replace(/\.pptx$/i, ".md");
  fs.writeFileSync(mdOutPath, renderDeckMarkdown({
    generated_at: new Date().toISOString(),
    timeframe:    timeframeLabel,
    date_from:    dateFrom,
    date_to:      dateTo,
    window:       argv.window || "custom",
    source_count: allSources.length,
    slide_count,
    deck,
  }));
  log(`  MD  saved → ${mdOutPath}`);

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

      // Upload Markdown (human-readable audit copy)
      const mdContent = fs.readFileSync(mdOutPath, "utf8");
      const { url: mdUrl } = await put(`${blobBase}.md`, mdContent, {
        ...blobOpts,
        contentType: "text/markdown",
      });
      log(`  MD  uploaded → ${mdUrl}`);

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
