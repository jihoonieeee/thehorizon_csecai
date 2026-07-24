/**
 * Newsletter generation core.
 * Called by scripts/generateNewsletter.js (local) and api/generate-report.js
 * (format="newsletter" via vercel dev / local server).
 *
 * Entry point:
 *   generateNewsletterHtml(supabase, { window, asof }) → Promise<{ html, text, ... }>
 *
 * Flow:
 *   1. Haiku  — per-source blurbs (JSON)
 *   2. Sonnet — per-category editorial intros (JSON)
 *   3. Code   — assembles the final HTML (reliable, no LLM-generated markup)
 */

import { loadPrompt }        from "../prompts/promptLoader.js";
import { sourceSignalScore } from "../pipeline/scoring/sourceSignal.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const CATEGORIES = [
  { key: "traditional_ai_threats", label: "Traditional AI Threats" },
  { key: "llm_threats",            label: "LLM Threats"            },
  { key: "agentic_ai_threats",     label: "Agentic AI Threats"     },
  { key: "ai_enabled_threats",     label: "AI-Enabled Threats"     },
];

// Max candidates to pass to the LLM selector. Sorted by sourceSignalScore so
// the cap is quality-biased (tail sources in a very busy month are unlikely picks).
const CANDIDATE_LIMIT = 60;

const META_CATEGORY = "_period_meta";

const HAIKU_MODEL  = process.env.ANTHROPIC_HAIKU_MODEL  || "claude-haiku-4-5-20251001";
const SONNET_MODEL = process.env.ANTHROPIC_MODEL        || "claude-sonnet-4-6";

// ── Period math ────────────────────────────────────────────────────────────────

export function buildPeriod(window, now = new Date()) {
  const d = new Date(now);

  if (window === "week") {
    const day = d.getUTCDay() || 7;
    const mon = new Date(d);
    mon.setUTCDate(d.getUTCDate() - (day - 1) - 7);
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

  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to   = new Date(Date.UTC(y, m, 0));
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

const SRC_SELECT = "id,title,url,publisher,date_published,date_published_actual,date_confidence,main_category,trust_tier,source_type,tags,short_summary,intelligence,parent_source_id";

function summaryText(s) {
  return (s.short_summary || s.intelligence?.source_summary || "").trim();
}

// Cap sources from the same digest family to maxPerFamily entries.
// Caller must pre-sort by signal so the best-ranked family member is kept.
function dedupByFamily(sources, maxPerFamily = 1) {
  const counts = new Map();
  return sources.filter(s => {
    const key = s.parent_source_id || s.id;
    const n = counts.get(key) || 0;
    if (n >= maxPerFamily) return false;
    counts.set(key, n + 1);
    return true;
  });
}

// ── Candidate loading ──────────────────────────────────────────────────────────
// Hard data-quality gates only — no editorial ranking. The LLM decides what's
// important. reading_value is included as a field (signal for the LLM) but is
// no longer a gate.

export async function loadCandidates(supabase, dateFrom, dateTo) {
  const { data, error } = await supabase
    .from("sources")
    .select(SRC_SELECT)
    .eq("validation_status", "pass")
    .not("needs_review", "is", true)
    .in("trust_tier", ["primary", "high"])
    .eq("date_confidence", "exact")
    .gte("date_published", dateFrom)
    .lte("date_published", `${dateTo}T23:59:59`)
    .not("main_category", "is", null)
    .not("main_category", "eq", "unclear_or_adjacent");

  if (error) throw new Error(`DB: ${error.message}`);
  const rows = data || [];

  const inWindow = (s) => {
    const d = (s.date_published_actual || s.date_published || "").slice(0, 10);
    return d && d >= dateFrom && d <= dateTo;
  };

  // Filter to sources with usable content, sort by signal, dedup digest families
  // (keep highest-signal member per family), then cap to CANDIDATE_LIMIT.
  return dedupByFamily(
    rows
      .filter(s => s.url && inWindow(s) && summaryText(s).length > 30)
      .sort((a, b) => sourceSignalScore(b) - sourceSignalScore(a))
  ).slice(0, CANDIDATE_LIMIT);
}

// ── LLM source selection (Sonnet) ──────────────────────────────────────────────

let SELECTION_SYSTEM = null;

// Short reference IDs (C01, C02…) used in the LLM prompt instead of raw UUIDs.
// The LLM reliably returns these; we map back to source objects via refToSource.
function candidateRef(i) {
  return `C${String(i + 1).padStart(2, "0")}`;
}

function buildSelectionUser(candidates, period) {
  const lines = [
    `Period: ${period.label} (${period.date_from} to ${period.date_to})`,
    `Candidate pool: ${candidates.length} sources`,
    `Use the ref field (C01, C02…) as the id value in your JSON output.`,
    "",
  ];

  for (let i = 0; i < candidates.length; i++) {
    const s     = candidates[i];
    const intel = s.intelligence || {};
    const mc    = intel.mechanism_classification || {};
    const sig   = intel.significance || {};
    const summary = (s.short_summary || intel.source_summary || "").trim().slice(0, 400);
    const catLabel = CATEGORIES.find(c => c.key === s.main_category)?.label || s.main_category;

    lines.push(`--- ${candidateRef(i)} ---`);
    lines.push(`ref: ${candidateRef(i)}`);
    lines.push(`title: ${s.title || "(untitled)"}`);
    lines.push(`publisher: ${s.publisher || "unknown"}  |  date: ${(s.date_published || "").slice(0, 10)}`);
    lines.push(`category: ${catLabel}`);
    lines.push(`source_type: ${s.source_type || "?"}  |  importance: ${intel.importance?.tier || "?"}  |  maturity: ${intel.maturity_level || "?"}  |  reading_value: ${s.reading_value || "?"}`);
    if (sig.level) lines.push(`significance: ${sig.level}${sig.broken_assumption ? `  |  breaks: "${sig.broken_assumption}"` : ""}`);
    const mechanism = mc.mechanism || null;
    const entities  = (intel.key_entities || []).slice(0, 5).join(", ");
    if (mechanism || entities) lines.push(`mechanism: ${mechanism || "?"}  |  key_entities: ${entities || "none"}`);
    const tags = (s.tags || []).slice(0, 6).join(", ");
    if (tags) lines.push(`tags: ${tags}`);
    lines.push(`summary: ${summary || "(none)"}`);
    lines.push("");
  }

  return lines.join("\n");
}

export async function selectSourcesWithLlm(candidates, period, log = () => {}) {
  if (!candidates.length) return [];
  if (!SELECTION_SYSTEM) SELECTION_SYSTEM = loadPrompt("newsletter/source-selection").system;

  log(`selecting from ${candidates.length} candidates (Sonnet)...`);
  let raw;
  try {
    raw = await callAnthropic({
      system:    SELECTION_SYSTEM,
      user:      buildSelectionUser(candidates, period),
      model:     SONNET_MODEL,
      maxTokens: 2000,
    });
  } catch (err) {
    log(`selection LLM call failed: ${err.message}`);
    throw err;
  }

  let json;
  try {
    json = parseJson(raw);
  } catch (err) {
    log(`selection JSON parse failed. Raw (first 400): ${raw.slice(0, 400)}`);
    throw err;
  }

  if (!json.selection?.length) {
    log(`selection returned empty. Raw (first 400): ${raw.slice(0, 400)}`);
    throw new Error("LLM returned empty selection");
  }

  // Map C01…CXX refs back to source objects.
  const refMap = Object.fromEntries(candidates.map((s, i) => [candidateRef(i), s]));
  const selected = [];
  for (const item of (json.selection || [])) {
    const src = refMap[item.id];
    if (src && !selected.includes(src)) {
      selected.push({ ...src, _story_type: item.story_type || null, _reason: item.reason || null });
    }
  }

  if (!selected.length) {
    log(`WARNING: LLM returned ${json.selection.length} items but none matched refs`);
    log(`First returned id: "${json.selection[0]?.id}"  expected format: C01–C${String(candidates.length).padStart(2,"0")}`);
  }

  log(`${selected.length} sources selected:`);
  for (const s of selected) log(`  [${s._story_type || "?"}] ${s.title?.slice(0, 65)}`);
  return selected;
}

// ── loadReadingList — thin wrapper kept for script/dry-run compatibility ───────

export async function loadReadingList(supabase, dateFrom, dateTo, limit = 12, opts = {}) {
  const { log = () => {} } = opts;
  const candidates = await loadCandidates(supabase, dateFrom, dateTo);
  const period = { label: `${dateFrom} to ${dateTo}`, date_from: dateFrom, date_to: dateTo };
  const selected = await selectSourcesWithLlm(candidates, period, log);
  return selected.slice(0, limit);
}

// ── Blurb generation (Haiku, batched) ─────────────────────────────────────────

let BLURB_SYSTEM = null;
const BLURB_BATCH = 5;

function buildBlurbUser(sources) {
  return "Generate a reading list blurb for each source below.\n\n" +
    sources.map((s, i) => {
      const catLabel     = CATEGORIES.find(c => c.key === s.main_category)?.label || s.main_category;
      const intel        = s.intelligence || {};
      const mc           = intel.mechanism_classification || {};
      const mechanism    = mc.mechanism || null;
      const entities     = (intel.key_entities || []).slice(0, 5).join(", ");
      const maturity     = intel.maturity_level || null;
      const impTier      = intel.importance?.tier || null;
      const brokenAssump = intel.significance?.broken_assumption || null;
      return `--- SOURCE ${i + 1} ---
id: ${s.id}
title: ${s.title || "(untitled)"}
publisher: ${s.publisher || "unknown"}
date: ${s.date_published?.slice(0, 10) || "unknown"}
category: ${catLabel}
story_type: ${s._story_type || s.source_type || "unknown"}
importance_tier: ${impTier || "unknown"}
maturity_level: ${maturity || "unknown"}
mechanism: ${mechanism || "unknown"}
key_entities: ${entities || "none"}
tags: ${(s.tags || []).slice(0, 5).join(", ") || "none"}${brokenAssump ? `\nbroken_assumption: ${brokenAssump}` : ""}
summary: ${summaryText(s).slice(0, 500) || "(none)"}`;
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

// ── Dedup QA (Haiku) ───────────────────────────────────────────────────────────

let DEDUP_SYSTEM = null;

function buildDedupUser(sources) {
  return "Reading list selected for this edition. Identify duplicate coverage of the same event.\n\n" +
    sources.map((s, i) => {
      const catLabel = CATEGORIES.find(c => c.key === s.main_category)?.label || s.main_category;
      return `--- SOURCE ${i + 1} ---
id: ${s.id}
title: ${s.title || "(untitled)"}
publisher: ${s.publisher || "unknown"}
date: ${s.date_published?.slice(0, 10) || "unknown"}
category: ${catLabel}
summary: ${summaryText(s).slice(0, 300) || "(none)"}`;
    }).join("\n\n");
}

export async function dedupReadingList(sources, log = () => {}) {
  const remove = new Set();
  if (!Array.isArray(sources) || sources.length < 2) return remove;
  if (!process.env.ANTHROPIC_API_KEY) return remove;
  try {
    if (!DEDUP_SYSTEM) DEDUP_SYSTEM = loadPrompt("newsletter/dedup-qa").system;
    const ids = new Set(sources.map(s => s.id));
    log(`dedup QA over ${sources.length} candidates...`);
    const raw  = await callAnthropic({ system: DEDUP_SYSTEM, user: buildDedupUser(sources), model: HAIKU_MODEL, maxTokens: 1200 });
    const json = parseJson(raw);
    for (const c of (json.clusters || [])) {
      if (!c || !ids.has(c.keep)) continue;
      for (const rid of (c.remove || [])) {
        if (rid !== c.keep && ids.has(rid)) remove.add(rid);
      }
    }
    if (remove.size) log(`dedup removed ${remove.size} duplicate(s): ${[...remove].map(id => id.slice(0,8)).join(", ")}`);
    else log("dedup: no duplicate event clusters found");
  } catch (err) {
    log(`dedup QA skipped (${err.message.slice(0, 60)})`);
    return new Set();
  }
  return remove;
}

// ── Category intro generation (Sonnet) ────────────────────────────────────────
// Generates a short editorial paragraph per category. Returns a plain object
// { [catKey]: "intro prose" }. Fails open — empty strings mean the HTML renderer
// omits the intro rather than crashing.

let INTRO_SYSTEM = null;

function buildIntroUser(sources, blurbMap, insightCats) {
  const lines = [];
  for (const cat of CATEGORIES) {
    const catSources = sources.filter(s => s.main_category === cat.key);
    if (!catSources.length) continue;

    lines.push(`=== ${cat.label} ===`);
    const ci = insightCats[cat.key];
    if (ci?.assessment) lines.push(`Period assessment: ${ci.assessment}`);
    if (ci?.insights?.length) {
      lines.push("Key trends:");
      for (const ins of ci.insights.slice(0, 3))
        lines.push(`- ${ins.insight}${ins.implication ? ` — ${ins.implication}` : ""}`);
    }
    lines.push("Sources:");
    for (const s of catSources) {
      const blurb = blurbMap[s.id] || summaryText(s).slice(0, 200) || "";
      lines.push(`  [${s.source_type || "?"} / ${s.intelligence?.importance?.tier || "?"}] ${s.title || ""}`);
      if (blurb) lines.push(`  ${blurb}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function generateCategoryIntros(sources, blurbMap, insightCats, log = () => {}) {
  if (!INTRO_SYSTEM) INTRO_SYSTEM = loadPrompt("newsletter/digest").system;
  const intros = {};
  try {
    const raw  = await callAnthropic({ system: INTRO_SYSTEM, user: buildIntroUser(sources, blurbMap, insightCats), model: SONNET_MODEL, maxTokens: 1200 });
    const json = parseJson(raw);
    for (const cat of CATEGORIES) {
      intros[cat.key] = (json[cat.key] || "").trim();
    }
  } catch (err) {
    log(`category intros skipped (${err.message.slice(0, 60)})`);
  }
  return intros;
}

// ── HTML renderer (pure code — no LLM markup) ─────────────────────────────────

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}


// ── Compatibility export for api/dashboard.js ─────────────────────────────────
// Returns { text: html, html, period, sourceCount, insightCount } so the API
// caller (which spreads result into the response) gets the html under both keys.
export async function generateNewsletterHtml(supabase, opts = {}) {
  const { window = "week", asof = null, log = () => {} } = opts;
  const now    = asof ? new Date(`${asof}T12:00:00Z`) : new Date();
  const today  = now.toISOString().slice(0, 10);
  const period = buildPeriod(window, now);

  log(`period: ${period.label} (${period.date_from} → ${period.date_to})`);

  log("loading candidates...");
  const candidates = await loadCandidates(supabase, period.date_from, period.date_to);
  log(`${candidates.length} candidates in window`);

  const selected = await selectSourcesWithLlm(candidates, period, log);

  const blurbMap   = selected.length ? await generateBlurbs(selected, log) : {};
  const { categories: insightCats } = await loadInsights(supabase, period.key);
  const insightCount = Object.values(insightCats).reduce((n, ci) => n + (ci?.insights?.length || 0), 0);
  const introMap   = await generateCategoryIntros(selected, blurbMap, insightCats, log);
  const html       = renderNewsletterHtml(period, selected, blurbMap, introMap, today);

  return { text: html, html, period, sourceCount: selected.length, insightCount };
}

// ── HTML renderer (pure code — no LLM markup) ─────────────────────────────────

export function renderNewsletterHtml(period, sources, blurbMap, introMap, today) {
  const categorySections = CATEGORIES
    .map(cat => {
      const catSources = sources.filter(s => s.main_category === cat.key);
      if (!catSources.length) return null;
      return { cat, sources: catSources };
    })
    .filter(Boolean);

  let sourceCounter = 0;

  const sectionsHtml = categorySections.map(({ cat, sources: catSources }, sectionIdx) => {
    const intro = introMap[cat.key] || "";

    const sourcesHtml = catSources.map((s, srcIdx) => {
      sourceCounter++;
      const n         = sourceCounter;
      const title     = esc(s.title || "(untitled)");
      const publisher = esc(s.publisher || "");
      const date      = fmtDate(s.date_published);
      const blurb     = esc(blurbMap[s.id] || summaryText(s).slice(0, 220) || "");
      const url       = esc(s.url || "#");
      const isLast    = srcIdx === catSources.length - 1;

      return `
        <div style="padding:24px 0;${isLast ? "" : "border-bottom:1px solid #f3f4f6;"}">
          <div style="font-size:11px;font-weight:500;color:#d1d5db;margin-bottom:8px;letter-spacing:0.02em;">${n}</div>
          <div style="font-size:16px;font-weight:600;color:#111827;line-height:1.45;margin-bottom:6px;">${title}</div>
          <div style="font-size:12px;color:#9ca3af;margin-bottom:13px;">${publisher ? `${publisher} &middot; ` : ""}${date}</div>
          <p style="font-size:14px;color:#374151;line-height:1.75;margin:0 0 13px;">${blurb}</p>
          <a href="${url}" style="font-size:13px;color:#2563eb;text-decoration:none;font-weight:500;">Read article &rarr;</a>
        </div>`;
    }).join("");

    const introHtml = intro
      ? `<p style="font-size:14px;color:#6b7280;line-height:1.8;margin:0 0 8px;">${esc(intro)}</p>`
      : "";

    const topRule = sectionIdx > 0
      ? `<div style="height:1px;background:#e5e7eb;margin-bottom:40px;"></div>`
      : "";

    return `
      ${topRule}
      <div style="margin-bottom:40px;">
        <div style="font-size:18px;font-weight:700;color:#111827;letter-spacing:-0.01em;margin-bottom:16px;">${esc(cat.label)}</div>
        ${introHtml}
        ${sourcesHtml}
      </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>The Horizon &mdash; ${esc(period.label)}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;-webkit-font-smoothing:antialiased;">
  <div style="max-width:560px;margin:0 auto;padding:52px 24px 64px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Helvetica,Arial,sans-serif;color:#111827;">

    <!-- Header -->
    <div style="margin-bottom:40px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;color:#9ca3af;text-transform:uppercase;margin-bottom:14px;">AI Threat Intelligence</div>
      <div style="font-size:26px;font-weight:700;color:#111827;letter-spacing:-0.02em;line-height:1.2;margin-bottom:8px;">The Horizon</div>
      <div style="font-size:14px;color:#6b7280;">${esc(period.label)} &middot; ${esc(period.date_range)}</div>
    </div>

    <div style="height:1px;background:#e5e7eb;margin-bottom:40px;"></div>

    <!-- Sections -->
    ${sectionsHtml}

    <!-- Footer -->
    <div style="height:1px;background:#e5e7eb;margin-bottom:24px;"></div>
    <div style="font-size:12px;color:#9ca3af;text-align:center;letter-spacing:0.02em;">The Horizon &middot; ${esc(today)}</div>

  </div>
</body>
</html>`;
}
