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
import { getIsoWeekWindow, getMonthWindow } from "../time/reportingWindow.js";
import { routedLLM }         from "../llm/llmRouter.js";

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


// ── Period math ────────────────────────────────────────────────────────────────

export function buildPeriod(window, now = new Date()) {
  if (window === "week") {
    // SGT-anchored: last completed Mon–Sun ISO week, consistent with reportingWindow.js
    const w   = getIsoWeekWindow(-1, now);
    // start_sgt/end_sgt carry SGT wall-clock dates stored as if UTC (no offset applied)
    const mon = new Date(w.start_sgt);
    const sun = new Date(w.start_sgt);
    sun.setUTCDate(mon.getUTCDate() + 6);
    const fmt = dt => dt.toISOString().slice(0, 10);
    return {
      // Canonical ISO week key (e.g. "2026-W30") — MUST match the window_key
      // that generateDashboardInsights writes via getCompletedPeriodWindow, or
      // loadInsights silently finds nothing.
      key:        w.week_key,
      label:      `Week of ${mon.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`,
      date_from:  fmt(mon),
      date_to:    fmt(sun),
      date_range: `${mon.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} – ${sun.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`,
    };
  }

  // month: SGT-anchored previous calendar month
  const m   = getMonthWindow(-1, now);
  const from = new Date(m.start_sgt);
  const to   = new Date(m.end_sgt);
  const fmt  = dt => dt.toISOString().slice(0, 10);
  return {
    // Canonical month key (e.g. "2026-06") — must match getCompletedPeriodWindow.
    key:        m.month_key,
    label:      from.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
    date_from:  fmt(from),
    date_to:    fmt(to),
    date_range: `${from.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} – ${to.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`,
  };
}

// ── LLM helper ─────────────────────────────────────────────────────────────────
// All newsletter LLM calls go through routedLLM so LLM_ONLY_GEMINI=1 routes them
// to Gemini (Gemini Flash by task profile). Provider failover and cost tracking
// are handled internally; no direct Anthropic calls or manual persistCallCost needed.

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callLlm(system, user, task) {
  const { result } = await routedLLM(system, user, { task, requires_json: true });
  return result; // null when all providers fail; callers handle gracefully
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

export async function loadInsights(supabase, periodKey) {
  let { data: rows } = await supabase
    .from("dashboard_insights")
    .select("category,points,window_label,window_key")
    .eq("window_key", periodKey);

  let fromLabel = null;
  if (!rows?.length) {
    // Fall back to the most recent prior period OF THE SAME WINDOW TYPE. Keys are
    // canonical: week = "YYYY-Www", month = "YYYY-MM", quarter = "YYYY-Qn". Match
    // by shape (inferred from periodKey) so a week newsletter never picks up a
    // month/quarter row.
    const shape = /-W\d/.test(periodKey) ? /^\d{4}-W\d{2}$/
                : /-Q\d/.test(periodKey) ? /^\d{4}-Q\d$/
                : /^\d{4}-\d{2}$/;
    const { data: prior } = await supabase
      .from("dashboard_insights")
      .select("category,points,window_label,window_key")
      .order("created_at", { ascending: false })
      .limit(60);
    const matching = (prior || []).filter(r => shape.test(r.window_key));
    if (matching.length) {
      const recentKey = matching[0].window_key;
      rows = matching.filter(r => r.window_key === recentKey);
      fromLabel = matching[0].window_label;
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

// ── Insights-backed source loading ─────────────────────────────────────────────
// When generateDashboardInsights has already run for this period it stores
// top_sources in the _period_meta row. The newsletter uses the same selection
// logic, so we can read those stored URLs back, look up the full source objects,
// and skip the duplicate LLM selection call entirely.
//
// Returns null if no usable stored selection exists (< 3 sources resolved),
// in which case the caller falls back to selectSourcesWithLlm as normal.
export async function loadTopSourcesFromInsights(supabase, periodKey, log = () => {}) {
  if (!periodKey) return null;
  const { data } = await supabase
    .from("dashboard_insights")
    .select("points")
    .eq("window_key", periodKey)
    .eq("category", "_period_meta")
    .maybeSingle();

  const topSources = data?.points?.top_sources;
  if (!Array.isArray(topSources) || topSources.length < 3) return null;

  const urls = topSources.map(s => s.url).filter(Boolean);
  if (urls.length < 3) return null;

  const { data: rows } = await supabase
    .from("sources")
    .select(SRC_SELECT)
    .in("url", urls);

  if (!rows?.length || rows.length < 3) return null;

  // Restore editorial metadata (_story_type, _reason) from the stored selection
  const metaByUrl = Object.fromEntries(topSources.map(s => [s.url, s]));
  const ordered = urls
    .map(url => {
      const src = rows.find(r => r.url === url);
      if (!src) return null;
      const meta = metaByUrl[url] || {};
      return { ...src, _story_type: meta.story_type || null, _reason: meta.why || null };
    })
    .filter(Boolean);

  log(`using ${ordered.length} top sources from insights _period_meta (skipping LLM selection)`);
  return ordered;
}

// ── LLM source selection (Gemini Flash) ────────────────────────────────────────

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

  log(`selecting from ${candidates.length} candidates (Gemini Flash)...`);
  let json;
  try {
    json = await callLlm(SELECTION_SYSTEM, buildSelectionUser(candidates, period), "newsletter_selection");
  } catch (err) {
    log(`selection LLM call failed: ${err.message}`);
    throw err;
  }

  if (!json?.selection?.length) {
    log(`selection returned empty or null result`);
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

  // Safety net: if the LLM left an entire category absent, backfill with the best
  // unselected source from that category (significance ≥ notable or broken_assumption).
  const selectedIds = new Set(selected.map(s => s.id));
  for (const cat of CATEGORIES) {
    if (selected.some(s => s.main_category === cat.key)) continue;
    const SIG_RANK = { landmark: 4, notable: 3, routine: 2, incremental: 1 };
    const best = candidates
      .filter(c => c.main_category === cat.key && !selectedIds.has(c.id))
      .filter(c => {
        const sig = c.intelligence?.significance;
        return (SIG_RANK[sig?.level] >= 3) || sig?.broken_assumption;
      })
      .sort((a, b) => {
        const sa = SIG_RANK[a.intelligence?.significance?.level] || 0;
        const sb = SIG_RANK[b.intelligence?.significance?.level] || 0;
        return sb - sa;
      })[0];
    if (best) {
      selected.push({ ...best, _story_type: "research", _reason: "category floor backfill" });
      selectedIds.add(best.id);
      log(`  [backfill] ${cat.label}: added ${best.title?.slice(0, 65)}`);
    }
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
      const json = await callLlm(BLURB_SYSTEM, buildBlurbUser(batch), "newsletter_blurb");
      for (const b of (json?.blurbs || [])) {
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
  try {
    if (!DEDUP_SYSTEM) DEDUP_SYSTEM = loadPrompt("newsletter/dedup-qa").system;
    const ids = new Set(sources.map(s => s.id));
    log(`dedup QA over ${sources.length} candidates...`);
    const json = await callLlm(DEDUP_SYSTEM, buildDedupUser(sources), "newsletter_dedup");
    for (const c of (json?.clusters || [])) {
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

// ── Statistic grounding scrub (deterministic, no LLM) ─────────────────────────
// The intro model is given only titles + blurbs + insights, and nothing verifies
// the numbers it writes — so a fabricated success rate can reach the reader. This
// pass drops any sentence whose statistic is not present in that same grounding
// text. It is conservative: a number counts as grounded if a same-form figure
// (percent vs percent, multiplier vs multiplier) within ±1 appears in the input.

// Percentages: "83%", "83.4 %". Multipliers: "3x", "10-fold".
function extractPercents(text)     { return [...String(text).matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(m => parseFloat(m[1])); }
function extractMultipliers(text)  { return [...String(text).matchAll(/(\d+(?:\.\d+)?)\s*(?:x|-?fold)\b/gi)].map(m => parseFloat(m[1])); }

function groundingTextFor(catKey, sources, blurbMap, insightCats) {
  const parts = [];
  const ci = insightCats?.[catKey];
  if (ci?.assessment) parts.push(ci.assessment);
  for (const ins of (ci?.insights || [])) parts.push(`${ins.insight || ""} ${ins.implication || ""}`);
  for (const s of sources.filter(s => s.main_category === catKey)) {
    parts.push(s.title || "");
    parts.push(blurbMap[s.id] || summaryText(s) || "");
  }
  return parts.join("  ");
}

function isGrounded(value, groundedValues) {
  return groundedValues.some(g => Math.abs(g - value) <= 1);
}

// Returns { text, stripped } where stripped is the count of sentences removed.
export function scrubIntro(intro, groundingText) {
  const gPct  = extractPercents(groundingText);
  const gMult = extractMultipliers(groundingText);
  let stripped = 0;

  const paragraphs = intro.split(/\n\n+/).map(para => {
    // Split on a sentence terminator followed by whitespace — the whitespace
    // requirement keeps decimals ("83.4%") and abbreviations from being split.
    const sentences = para.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter(sent => {
      const ungrounded =
        extractPercents(sent).some(p => !isGrounded(p, gPct)) ||
        extractMultipliers(sent).some(m => !isGrounded(m, gMult));
      if (ungrounded) stripped++;
      return !ungrounded;
    });
    return kept.join(" ").replace(/\s+/g, " ").trim();
  }).filter(Boolean);

  return { text: paragraphs.join("\n\n"), stripped };
}

export async function generateCategoryIntros(sources, blurbMap, insightCats, log = () => {}) {
  if (!INTRO_SYSTEM) INTRO_SYSTEM = loadPrompt("newsletter/digest").system;
  const intros = {};
  try {
    const json = await callLlm(INTRO_SYSTEM, buildIntroUser(sources, blurbMap, insightCats), "newsletter_intros");
    let strippedTotal = 0;
    for (const cat of CATEGORIES) {
      const intro = (json?.[cat.key] || "").trim();
      if (!intro) { intros[cat.key] = ""; continue; }
      const { text, stripped } = scrubIntro(intro, groundingTextFor(cat.key, sources, blurbMap, insightCats));
      intros[cat.key] = text;
      strippedTotal += stripped;
    }
    if (strippedTotal) log(`stat grounding: stripped ${strippedTotal} sentence(s) with unverified numbers`);
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

  let selected = await selectSourcesWithLlm(candidates, period, log);

  // Cross-publisher event dedup: drop near-duplicate coverage of the same event
  // that survived family-level dedup (different outlets → different families).
  const dupIds = await dedupReadingList(selected, log);
  if (dupIds.size) selected = selected.filter(s => !dupIds.has(s.id));

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

    // One <p> per finding — the model separates distinct findings with a blank
    // line (\n\n); render each as its own paragraph so multiple findings don't
    // collapse into a single dense block.
    const introHtml = intro
      ? intro
          .split(/\n\n+/)
          .map(p => p.trim())
          .filter(Boolean)
          .map(p => `<p style="font-size:14px;color:#6b7280;line-height:1.8;margin:0 0 12px;">${esc(p)}</p>`)
          .join("")
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
