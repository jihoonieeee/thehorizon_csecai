/**
 * Newsletter generation core.
 * Called by scripts/generateNewsletter.js (local) and api/generate-report.js
 * (format="newsletter" via vercel dev / local server).
 *
 * Entry point:
 *   generateNewsletterHtml(supabase, { window, asof }) → Promise<string>  (full HTML)
 */

import { loadPrompt }        from "../prompts/promptLoader.js";
import { computeImportance } from "../pipeline/scoring/importance.js";
import { sourceSignalScore } from "../pipeline/scoring/sourceSignal.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const CATEGORIES = [
  { key: "traditional_ai_threats", label: "Traditional AI Threats" },
  { key: "llm_threats",            label: "LLM Threats"            },
  { key: "agentic_ai_threats",     label: "Agentic AI Threats"     },
  { key: "ai_enabled_threats",     label: "AI-Enabled Threats"     },
];

const META_CATEGORY = "_period_meta";

const HAIKU_MODEL  = process.env.ANTHROPIC_HAIKU_MODEL  || "claude-haiku-4-5-20251001";
const SONNET_MODEL = process.env.ANTHROPIC_MODEL        || "claude-sonnet-4-6";

// ── Period math ────────────────────────────────────────────────────────────────

export function buildPeriod(window, now = new Date()) {
  const d = new Date(now);

  if (window === "week") {
    const day = d.getUTCDay() || 7;
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

// ── Anthropic helper ───────────────────────────────────────────────────────────

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
      return raw.replace(/^```(?:json|html)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    } catch (err) {
      if (isRetryable(err) && attempt < retries) { lastErr = err; continue; }
      throw err;
    }
  }
  throw lastErr;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) try { return JSON.parse(m[0]); } catch {}
    throw new Error(`JSON parse failed. Raw: ${text.slice(0, 200)}`);
  }
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

export async function loadInsights(supabase, periodKey) {
  let { data: rows } = await supabase
    .from("dashboard_insights")
    .select("category,points,window_label,window_key")
    .eq("window_key", periodKey);

  let fromLabel = null;
  if (!rows?.length) {
    const prefix = periodKey.split("-")[0];
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
    }
  }

  if (!rows?.length) return { categories: {}, meta: null, fromLabel };

  const categories = {};
  let meta = null;
  for (const r of rows) {
    if (r.category === META_CATEGORY) meta = r.points;
    else if (r.points?.insights?.length) categories[r.category] = r.points;
  }
  return { categories, meta, fromLabel };
}

const SRC_SELECT = "id,title,url,publisher,date_published,main_category,trust_tier,source_type,tags,short_summary,analyst_brief,intelligence";

function summaryText(s) {
  const ab = typeof s.analyst_brief === "string" ? s.analyst_brief : "";
  return (ab || s.short_summary || s.intelligence?.source_summary || "").trim();
}

export async function loadReadingList(supabase, dateFrom, dateTo, limit = 8) {
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

  const ranked = rows
    .filter(s => s.url && summaryText(s).length > 30)
    .map(s => ({ ...s, _imp: computeImportance(s) }))
    .sort((a, b) =>
      sourceSignalScore(b) - sourceSignalScore(a) ||
      (b.date_published || "").localeCompare(a.date_published || "")
    );

  const byCategory = {};
  for (const s of ranked) (byCategory[s.main_category] ??= []).push(s);

  const picked = new Set(), result = [];
  for (const cat of CATEGORIES) {
    const best = (byCategory[cat.key] || []).find(s => !picked.has(s.id));
    if (best) { picked.add(best.id); result.push(best); }
  }
  for (const s of ranked) {
    if (result.length >= limit) break;
    if (!picked.has(s.id)) { picked.add(s.id); result.push(s); }
  }

  return result.sort((a, b) => {
    const ci = CATEGORIES.findIndex(c => c.key === a.main_category);
    const cj = CATEGORIES.findIndex(c => c.key === b.main_category);
    return ci - cj || (b.date_published || "").localeCompare(a.date_published || "");
  });
}

// ── Blurb generation (Haiku, batched) ─────────────────────────────────────────

let BLURB_SYSTEM = null;  // loaded lazily on first call
const BLURB_BATCH  = 5;

function buildBlurbUser(sources) {
  return "Generate a reading list blurb for each source below.\n\n" +
    sources.map((s, i) => {
      const catLabel = CATEGORIES.find(c => c.key === s.main_category)?.label || s.main_category;
      return `--- SOURCE ${i + 1} ---
id: ${s.id}
title: ${s.title || "(untitled)"}
publisher: ${s.publisher || "unknown"}
date: ${s.date_published?.slice(0, 10) || "unknown"}
category: ${catLabel}
source_type: ${s.source_type || "unknown"}
tags: ${(s.tags || []).slice(0, 5).join(", ") || "none"}
analyst_brief: ${summaryText(s).slice(0, 500) || "(none)"}`;
    }).join("\n\n");
}

export async function generateBlurbs(sources, log = () => {}) {
  if (!BLURB_SYSTEM) BLURB_SYSTEM = loadPrompt("newsletter/source-blurb").system;
  const blurbMap = {};
  for (let i = 0; i < sources.length; i += BLURB_BATCH) {
    const batch = sources.slice(i, i + BLURB_BATCH);
    log(`blurbs batch ${Math.floor(i / BLURB_BATCH) + 1}/${Math.ceil(sources.length / BLURB_BATCH)}`);
    try {
      const raw  = await callAnthropic({ system: BLURB_SYSTEM, user: buildBlurbUser(batch), model: HAIKU_MODEL, maxTokens: 1600 });
      const json = parseJson(raw);
      for (const b of (json.blurbs || [])) {
        if (b.id && b.blurb) blurbMap[b.id] = b.blurb.trim();
      }
    } catch {
      for (const s of batch) blurbMap[s.id] = summaryText(s).slice(0, 220) || s.title || "";
    }
    if (i + BLURB_BATCH < sources.length) await sleep(400);
  }
  return blurbMap;
}

// ── Digest assembly (Sonnet) ───────────────────────────────────────────────────

function buildDigestUser(period, insights, sources, blurbMap) {
  const lines = ["=== CATEGORY INSIGHTS ===\n"];

  for (const cat of CATEGORIES) {
    const d = insights.categories[cat.key];
    if (!d?.insights?.length) {
      lines.push(`[${cat.label}]\nNo analysis available for this period.\n`);
      continue;
    }
    lines.push(`[${cat.label}]`);
    lines.push(`Assessment: ${d.assessment || "No assessment generated."}`);
    lines.push("Insights:");
    for (const ins of (d.insights || []).slice(0, 3)) {
      lines.push(`  • ${ins.insight}`);
      if (ins.implication) lines.push(`    → ${ins.implication}`);
    }
    lines.push("");
  }

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

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Generate a plain-text newsletter for the given window/asof.
 * Output is copy-pasteable into any email client.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ window?: string, asof?: string, log?: Function }} opts
 * @returns {Promise<{ text: string, period: object, sourceCount: number, insightCount: number }>}
 */
export async function generateNewsletterHtml(supabase, opts = {}) {
  const { window = "week", asof = null, log = () => {} } = opts;
  const now    = asof ? new Date(`${asof}T12:00:00Z`) : new Date();
  const today  = now.toISOString().slice(0, 10);
  const period = buildPeriod(window, now);

  log(`period: ${period.label} (${period.date_from} → ${period.date_to})`);

  log("loading insights...");
  const insights = await loadInsights(supabase, period.key);
  const insightCount = Object.values(insights.categories).reduce((n, d) => n + (d.insights?.length || 0), 0);
  log(`${insightCount} insight bullets across ${Object.keys(insights.categories).length} categories`);

  log("loading reading list...");
  const sources = await loadReadingList(supabase, period.date_from, period.date_to);
  log(`${sources.length} sources selected`);

  log("generating source blurbs (Haiku)...");
  const blurbMap = sources.length ? await generateBlurbs(sources, log) : {};
  log(`${Object.keys(blurbMap).length} blurbs ready`);

  log("assembling newsletter (Sonnet)...");
  const DIGEST_SYSTEM = loadPrompt("newsletter/digest").system
    .replace("{{period_label}}", period.label)
    .replace("{{date_range}}",   period.date_range)
    .replace("{{today}}",        today);

  const text = await callAnthropic({
    system:    DIGEST_SYSTEM,
    user:      buildDigestUser(period, insights, sources, blurbMap),
    model:     SONNET_MODEL,
    maxTokens: 4000,
  });

  return { text, period, sourceCount: sources.length, insightCount };
}
