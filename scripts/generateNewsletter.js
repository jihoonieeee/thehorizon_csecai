#!/usr/bin/env node
/**
 * generateNewsletter.js
 *
 * Generates a weekly AI threat intelligence newsletter (HTML) from:
 *   1. dashboard_insights — per-category assessments + insight bullets (pre-generated)
 *   2. sources            — curated reading list candidates for the window
 *   3. LLM (Haiku)        — rewrites each source's analyst_brief into a plain-English blurb
 *   4. LLM (Sonnet)       — assembles the full newsletter HTML from insights + blurbs
 *
 * The newsletter is written to ./output/newsletter-<YYYY-MM-DD>.html.
 * No email is sent; generation only.
 *
 * Usage:
 *   node scripts/generateNewsletter.js [--window week|month] [--asof YYYY-MM-DD] [--out path/to/file.html] [--dry-run]
 *
 * --window   week (default) | month
 * --asof     override "now" for historical backfill
 * --out      override output path
 * --dry-run  print the assembled context but skip LLM calls and file write
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { loadPrompt }   from "../lib/prompts/promptLoader.js";
import { computeImportance } from "../lib/pipeline/scoring/importance.js";
import { sourceSignalScore } from "../lib/pipeline/scoring/sourceSignal.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const getArg  = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const hasFlag = f => args.includes(f);

const WINDOW  = getArg("--window", "week");
const ASOF    = getArg("--asof",   null);
const DRY_RUN = hasFlag("--dry-run");

if (!["week", "month"].includes(WINDOW)) {
  console.error("--window must be week | month"); process.exit(1);
}

const NOW = ASOF ? new Date(`${ASOF}T12:00:00Z`) : new Date();

// ── Supabase ──────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Period helpers ────────────────────────────────────────────────────────────

function buildPeriod(window, now) {
  const d = new Date(now);
  if (window === "week") {
    // Monday–Sunday week containing `now`
    const day = d.getUTCDay() || 7;          // 1=Mon … 7=Sun
    const mon = new Date(d);
    mon.setUTCDate(d.getUTCDate() - (day - 1));
    const sun = new Date(mon);
    sun.setUTCDate(mon.getUTCDate() + 6);
    const fmt = dt => dt.toISOString().slice(0, 10);
    return {
      key:        `week-${fmt(mon)}`,
      label:      `Week of ${mon.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`,
      date_from:  fmt(mon),
      date_to:    fmt(sun),
      date_range: `${mon.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} – ${sun.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`,
    };
  }
  // month
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const from = new Date(Date.UTC(y, m, 1));
  const to   = new Date(Date.UTC(y, m + 1, 0));
  const fmt  = dt => dt.toISOString().slice(0, 10);
  return {
    key:        `month-${fmt(from).slice(0, 7)}`,
    label:      from.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
    date_from:  fmt(from),
    date_to:    fmt(to),
    date_range: `${from.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} – ${to.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`,
  };
}

// ── Anthropic API helper ──────────────────────────────────────────────────────

const HAIKU_MODEL  = process.env.ANTHROPIC_HAIKU_MODEL  || "claude-haiku-4-5-20251001";
const SONNET_MODEL = process.env.ANTHROPIC_MODEL        || "claude-sonnet-4-6";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isRetryable(err) {
  if (!err) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  if (/aborted|timeout|fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(err.message || "")) return true;
  return [429, 500, 502, 503, 504, 529].includes(err.status);
}

async function callAnthropic({ system, user, model, maxTokens = 2000, retries = 3 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(90000),
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        const err = new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
        err.status = res.status;
        if (isRetryable(err) && attempt < retries) { lastErr = err; continue; }
        throw err;
      }
      const json = await res.json();
      const raw  = json.content?.[0]?.text || "";
      // Strip markdown code fences if present
      const cleaned = raw.replace(/^```(?:json|html)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      return cleaned;
    } catch (err) {
      if (isRetryable(err) && attempt < retries) { lastErr = err; continue; }
      throw err;
    }
  }
  throw lastErr;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {
    // Try to extract a JSON object from surrounding text
    const m = text.match(/\{[\s\S]*\}/);
    if (m) try { return JSON.parse(m[0]); } catch {}
    throw new Error(`JSON parse failed. Raw: ${text.slice(0, 200)}`);
  }
}

// ── Load category insights from dashboard_insights ────────────────────────────

const CATEGORIES = [
  { key: "traditional_ai_threats", label: "Traditional AI Threats" },
  { key: "llm_threats",            label: "LLM Threats" },
  { key: "agentic_ai_threats",     label: "Agentic AI Threats" },
  { key: "ai_enabled_threats",     label: "AI-Enabled Threats" },
];

const META_CATEGORY = "_period_meta";

async function loadInsights(periodKey) {
  // Try the exact period key first; fall back to the most recent prior period of
  // the same window type (same prefix) so the newsletter can still run when this
  // week's insight job hasn't fired yet.
  let { data: rows } = await supabase
    .from("dashboard_insights")
    .select("category,points,window_label")
    .eq("window_key", periodKey);

  let fromLabel = null;
  if (!rows?.length) {
    const prefix = periodKey.split("-")[0]; // "week" | "month"
    const { data: prior } = await supabase
      .from("dashboard_insights")
      .select("category,points,window_label,window_key")
      .like("window_key", `${prefix}-%`)
      .order("created_at", { ascending: false })
      .limit(20);
    if (prior?.length) {
      const recentKey = prior[0].window_key;
      rows = prior.filter(r => r.window_key === recentKey);
      fromLabel = prior[0].window_label;
      console.log(`  [insights] No data for ${periodKey}; falling back to ${recentKey}`);
    }
  }

  if (!rows?.length) return { categories: {}, meta: null, fromLabel };

  const categories = {};
  let meta = null;

  for (const r of rows) {
    if (r.category === META_CATEGORY) {
      meta = r.points;
    } else {
      const p = r.points;
      if (p?.insights?.length) categories[r.category] = p;
    }
  }

  return { categories, meta, fromLabel };
}

// ── Load reading list sources ─────────────────────────────────────────────────

const SRC_SELECT = "id,title,url,publisher,date_published,main_category,trust_tier,source_type,tags,short_summary,analyst_brief,intelligence";

function summaryText(s) {
  // analyst_brief may be string (L3/L4 pipeline) or object; short_summary is always string
  const ab = typeof s.analyst_brief === "string" ? s.analyst_brief : "";
  return (ab || s.short_summary || s.intelligence?.source_summary || "").trim();
}

async function loadReadingList(dateFrom, dateTo, limit = 18) {
  const { data, error } = await supabase
    .from("sources")
    .select(SRC_SELECT)
    .eq("validation_status", "pass")
    .in("trust_tier", ["primary", "high", "curated"])
    .gte("date_published", dateFrom)
    .lte("date_published", dateTo)
    .not("main_category", "is", null)
    .not("main_category", "eq", "unclear_or_adjacent");

  if (error) throw new Error(`DB: ${error.message}`);
  const rows = data || [];

  // Rank: importance tier + source signal score, then recency
  const ranked = rows
    .filter(s => s.url && summaryText(s).length > 30)
    .map(s => ({ ...s, _imp: computeImportance(s) }))
    .sort((a, b) =>
      sourceSignalScore(b) - sourceSignalScore(a) ||
      (b.date_published || "").localeCompare(a.date_published || "")
    );

  // Cap at `limit`, ensuring at least one source per category where possible
  const byCategory = {};
  for (const s of ranked) {
    (byCategory[s.main_category] ??= []).push(s);
  }
  const picked = new Set();
  const result = [];

  // First pass: one guaranteed pick per category
  for (const cat of CATEGORIES) {
    const best = (byCategory[cat.key] || []).find(s => !picked.has(s.id));
    if (best) { picked.add(best.id); result.push(best); }
  }
  // Fill up to limit with remaining top-ranked sources
  for (const s of ranked) {
    if (result.length >= limit) break;
    if (!picked.has(s.id)) { picked.add(s.id); result.push(s); }
  }

  // Final sort: keep category grouping for readability
  return result.sort((a, b) => {
    const ci = CATEGORIES.findIndex(c => c.key === a.main_category);
    const cj = CATEGORIES.findIndex(c => c.key === b.main_category);
    return ci - cj || (b.date_published || "").localeCompare(a.date_published || "");
  });
}

// ── Generate per-source blurbs (Haiku, batched) ───────────────────────────────

const BLURB_SYSTEM = loadPrompt("newsletter/source-blurb").system;
const BLURB_BATCH  = 5;   // sources per LLM call

function buildBlurbUser(sources) {
  const items = sources.map((s, i) => {
    const catLabel = CATEGORIES.find(c => c.key === s.main_category)?.label || s.main_category;
    const summary  = summaryText(s).slice(0, 500);
    const tags     = (s.tags || []).slice(0, 5).join(", ");
    return `--- SOURCE ${i + 1} ---
id: ${s.id}
title: ${s.title || "(untitled)"}
publisher: ${s.publisher || "unknown"}
date: ${s.date_published?.slice(0, 10) || "unknown"}
category: ${catLabel}
source_type: ${s.source_type || "unknown"}
tags: ${tags || "none"}
analyst_brief: ${summary || "(none)"}`;
  }).join("\n\n");

  return `Generate a reading list blurb for each source below.\n\n${items}`;
}

async function generateBlurbs(sources) {
  const blurbMap = {};
  for (let i = 0; i < sources.length; i += BLURB_BATCH) {
    const batch = sources.slice(i, i + BLURB_BATCH);
    const label = batch.map(s => s.title?.slice(0, 30)).join(", ");
    process.stdout.write(`  [blurbs] batch ${Math.floor(i / BLURB_BATCH) + 1}: ${label}...\n`);
    try {
      const raw  = await callAnthropic({ system: BLURB_SYSTEM, user: buildBlurbUser(batch), model: HAIKU_MODEL, maxTokens: 1600 });
      const json = parseJson(raw);
      for (const b of (json.blurbs || [])) {
        if (b.id && b.blurb) blurbMap[b.id] = b.blurb.trim();
      }
    } catch (err) {
      console.log(`  [blurbs] batch failed: ${err.message.slice(0, 80)} — using raw summaries as fallback`);
      for (const s of batch) {
        blurbMap[s.id] = summaryText(s).slice(0, 220) || s.title || "";
      }
    }
    if (i + BLURB_BATCH < sources.length) await sleep(400);
  }
  return blurbMap;
}

// ── Assemble newsletter context for Sonnet ────────────────────────────────────

function buildDigestUser(period, insights, sources, blurbMap) {
  const lines = [];

  // Category insights
  lines.push("=== CATEGORY INSIGHTS ===\n");
  for (const cat of CATEGORIES) {
    const d = insights.categories[cat.key];
    if (!d?.insights?.length) {
      lines.push(`[${cat.label}]\nNo analysis available for this period.\n`);
      continue;
    }
    lines.push(`[${cat.label}]`);
    lines.push(`Assessment: ${d.assessment || "No assessment generated."}`);
    lines.push(`Confidence: ${d.confidence || "unknown"} (${d.confidence_reason || ""})`);
    lines.push(`Evidence maturity: ${d.evidence_maturity || "unknown"}`);
    lines.push("Insights:");
    for (const ins of (d.insights || []).slice(0, 3)) {
      lines.push(`  • ${ins.insight}`);
      if (ins.implication) lines.push(`    → ${ins.implication}`);
    }
    lines.push("");
  }

  // Emerging signals from meta row
  const signals = insights.meta?.emerging_signals || [];
  if (signals.length) {
    lines.push("=== EMERGING SIGNALS ===\n");
    for (const s of signals.slice(0, 6)) {
      const text = typeof s === "string" ? s : (s.signal || s.headline || JSON.stringify(s));
      lines.push(`  • ${text}`);
    }
    lines.push("");
  }

  // Reading list
  lines.push("=== READING LIST ===\n");
  for (const s of sources) {
    const catLabel = CATEGORIES.find(c => c.key === s.main_category)?.label || s.main_category;
    const blurb    = blurbMap[s.id] || summaryText(s).slice(0, 200) || s.title || "";
    lines.push(`[${catLabel}] ${s.title || "(untitled)"}`);
    lines.push(`url: ${s.url}`);
    lines.push(`publisher: ${s.publisher || "unknown"} · date: ${s.date_published?.slice(0, 10) || "unknown"}`);
    lines.push(`blurb: ${blurb}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Inline CSS for the newsletter ─────────────────────────────────────────────
// Written as a template the LLM can use as-is inside the <head>.

const NEWSLETTER_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: #f3f4f6; color: #111827; margin: 0; padding: 0; }
  .hz-wrapper { max-width: 640px; margin: 32px auto; background: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  .hz-header { background: #111827; color: #f9fafb; padding: 32px 36px 24px; }
  .hz-header h1 { margin: 0 0 6px; font-size: 1.3rem; font-weight: 700; letter-spacing: -0.01em; }
  .hz-header .hz-period { font-size: 0.8rem; color: #9ca3af; margin: 0 0 14px; }
  .hz-header .hz-lead { font-size: 0.95rem; color: #e5e7eb; line-height: 1.6; margin: 0; }
  .hz-body { padding: 28px 36px; }
  .hz-category { margin-bottom: 32px; padding-bottom: 28px; border-bottom: 1px solid #e5e7eb; }
  .hz-category:last-of-type { border-bottom: none; }
  .hz-category h2 { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin: 0 0 10px; }
  .hz-assessment { font-size: 0.93rem; font-weight: 600; color: #111827; line-height: 1.55; margin: 0 0 12px; }
  .hz-insights { margin: 0 0 10px; padding: 0 0 0 18px; }
  .hz-insights li { font-size: 0.85rem; color: #374151; line-height: 1.6; margin-bottom: 6px; }
  .hz-confidence { display: inline-block; font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px; border-radius: 4px; }
  .hz-conf-high { background: #dcfce7; color: #15803d; }
  .hz-conf-moderate { background: #fef9c3; color: #a16207; }
  .hz-conf-low { background: #f3f4f6; color: #6b7280; }
  .hz-signals { margin-bottom: 32px; padding: 20px 22px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb; }
  .hz-signals h2 { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin: 0 0 12px; }
  .hz-signals ul { margin: 0; padding: 0 0 0 18px; }
  .hz-signals li { font-size: 0.84rem; color: #374151; line-height: 1.6; margin-bottom: 5px; }
  .hz-reading { margin-bottom: 12px; }
  .hz-reading h2 { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin: 0 0 16px; }
  .hz-source { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #f3f4f6; }
  .hz-source:last-child { border-bottom: none; }
  .hz-cat-tag { display: inline-block; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 7px; border-radius: 3px; background: #eff6ff; color: #1d4ed8; margin-bottom: 5px; }
  .hz-source-title { display: block; font-size: 0.91rem; font-weight: 600; color: #111827; text-decoration: none; line-height: 1.4; margin-bottom: 3px; }
  .hz-source-title:hover { color: #2563eb; }
  .hz-meta { font-size: 0.73rem; color: #9ca3af; display: block; margin-bottom: 6px; }
  .hz-blurb { font-size: 0.83rem; color: #4b5563; line-height: 1.65; margin: 0; }
  .hz-footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px 36px; font-size: 0.78rem; color: #9ca3af; text-align: center; }
`.trim();

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const period  = buildPeriod(WINDOW, NOW);
  const today   = NOW.toISOString().slice(0, 10);
  const outDir  = path.join(process.cwd(), "output");
  const outFile = getArg("--out", path.join(outDir, `newsletter-${today}.html`));

  console.log(`\n The Horizon — Newsletter Generator`);
  console.log(`  Window : ${period.label} (${period.date_from} → ${period.date_to})`);
  console.log(`  Key    : ${period.key}`);
  if (DRY_RUN) console.log("  [DRY-RUN] No LLM calls or file writes.\n");

  // ── Step 1: Load insights ──────────────────────────────────────────────────
  process.stdout.write("\n[1/4] Loading category insights...\n");
  const insights = await loadInsights(period.key);
  const catCount = Object.keys(insights.categories).length;
  console.log(`  ${catCount} categories loaded${insights.fromLabel ? ` (from ${insights.fromLabel})` : ""}`);
  if (!catCount) console.log("  WARNING: no insights found — newsletter will have thin category sections");

  // ── Step 2: Load reading list sources ─────────────────────────────────────
  process.stdout.write("\n[2/4] Loading reading list sources...\n");
  const sources = await loadReadingList(period.date_from, period.date_to);
  console.log(`  ${sources.length} sources selected for reading list`);
  if (!sources.length) console.log("  WARNING: no sources found for this window — check date range");

  if (DRY_RUN) {
    console.log("\n[DRY-RUN] Context preview:\n");
    console.log(buildDigestUser(period, insights, sources, {}));
    return;
  }

  // ── Step 3: Generate per-source blurbs ────────────────────────────────────
  process.stdout.write("\n[3/4] Generating source blurbs (Haiku)...\n");
  const blurbMap = sources.length ? await generateBlurbs(sources) : {};
  console.log(`  ${Object.keys(blurbMap).length}/${sources.length} blurbs generated`);

  // ── Step 4: Assemble newsletter ────────────────────────────────────────────
  process.stdout.write("\n[4/4] Assembling newsletter (Sonnet)...\n");

  const DIGEST_SYSTEM = loadPrompt("newsletter/digest").system
    .replace("{{period_label}}", period.label)
    .replace("{{date_range}}",   period.date_range)
    .replace("{{today}}",        today);

  const css        = `<style>\n${NEWSLETTER_CSS}\n</style>`;
  const digestUser = buildDigestUser(period, insights, sources, blurbMap);

  let html;
  try {
    html = await callAnthropic({
      system:    DIGEST_SYSTEM,
      user:      digestUser,
      model:     SONNET_MODEL,
      maxTokens: 6000,
    });
    // Ensure it starts with DOCTYPE (model may have omitted it)
    if (!html.trimStart().startsWith("<!")) {
      html = `<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n${css}\n<title>The Horizon — ${period.label}</title></head>\n<body>${html}</body></html>`;
    } else {
      // Inject CSS before </head> if not already present
      if (!html.includes(".hz-wrapper")) {
        html = html.replace("</head>", `${css}\n</head>`);
      }
    }
  } catch (err) {
    console.error(`\nFATAL: newsletter assembly failed: ${err.message}`);
    process.exit(1);
  }

  // ── Write output ───────────────────────────────────────────────────────────
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, html, "utf8");

  const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  console.log(`\n  Done. Written to: ${outFile} (${kb} KB)`);
  console.log(`  Open in browser: file://${path.resolve(outFile)}\n`);
}

main().catch(err => { console.error("\nFATAL:", err.message); process.exit(1); });
