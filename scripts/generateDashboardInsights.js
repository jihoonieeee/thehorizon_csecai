#!/usr/bin/env node
/**
 * generateDashboardInsights.js
 *
 * Generates per-category STRUCTURED strategic insights for a completed dashboard
 * timeframe (week / month / quarter), plus a period snapshot used for historical
 * comparison on the Overview page. Called by GitHub Actions on a schedule;
 * idempotent — skips window_key × category rows that already exist (unless --force).
 *
 * PIPELINE (per category) — never papers → insights directly:
 *   Stage A (Sonnet):  source summaries → atomic findings → 2-5 themes
 *   Stage B (Sonnet):  themes (NOT raw papers) → structured insights + assessment
 *   QA      (Haiku):   reject paper-summaries / claims beyond the evidence maturity
 *   Deterministic:     evidence maturity (from source_type) + confidence cap
 *
 * Each insight is an object: { insight, explanation_points, evidence, confidence,
 *   confidence_reason, sources[], explanation_qa }.
 *
 * After all categories, a `_period_meta` row stores the period snapshot and
 * top_sources (same editorial selection as the newsletter).
 *
 * Storage note: the structured payloads live inside the existing JSONB `points`
 * column (no schema migration required). Category rows hold an object; the
 * `_period_meta` row holds the snapshot + comparison object.
 *
 * Usage:
 *   node scripts/generateDashboardInsights.js --window week|month|quarter
 *   node scripts/generateDashboardInsights.js --window month --force    # overwrite
 *   node scripts/generateDashboardInsights.js --window month --dry-run  # print only
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { getCompletedPeriodWindow } from "../lib/time/reportingWindow.js";
import { getTag } from "../lib/config/taxonomyRegistry.js";
import {
  computeEvidenceMaturity,
  deriveConfidence,
  maturityShortLine,
} from "../lib/dashboard/evidenceMaturity.js";
import { persistCallCost, setCurrentRunId } from "../lib/llm/usagePersistence.js";
import { sourceSignalScore, isNoiseSource, bySignalThenRecency, partitionBySignal, readingValueOf } from "../lib/pipeline/scoring/sourceSignal.js";
import { maturityOf, MATURITY_RANK } from "../lib/pipeline/scoring/maturityLevel.js";
import { significanceRank } from "../lib/pipeline/scoring/researchSignificance.js";
import { loadPrompt } from "../lib/prompts/promptLoader.js";
import { loadCandidates, selectSourcesWithLlm } from "../lib/newsletter/index.js";

const args     = process.argv.slice(2);
const getArg   = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const hasFlag  = f => args.includes(f);

const WINDOW   = getArg("--window", "week");
const FORCE    = hasFlag("--force");
const DRY_RUN  = hasFlag("--dry-run");
// --asof <YYYY-MM-DD> overrides "now" so a historical completed period can be
// backfilled (e.g. --window month --asof 2026-05-15 targets April). Defaults to now.
const ASOF     = getArg("--asof", null);
const ONLY     = getArg("--only", null);   // regenerate a single category, leave others intact
const NOW      = ASOF ? new Date(`${ASOF}T12:00:00Z`) : new Date();
// The actual reporting date — passed to QA so it judges "future-dated" identifiers
// (e.g. a fabricated CVE) against THIS date, not the model's training cutoff. Without
// it the QA wrongly flags every real current-year CVE as fabricated.
const REPORT_DATE = NOW.toISOString().slice(0, 10);
const REPORT_YEAR = REPORT_DATE.slice(0, 4);

if (!["week", "month", "quarter", "annual"].includes(WINDOW)) {
  console.error("--window must be week | month | quarter | annual"); process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const META_CATEGORY = "_period_meta";

const CATEGORIES = [
  { key: "traditional_ai_threats", label: "Traditional AI Threats" },
  { key: "llm_threats",            label: "LLM Threats" },
  { key: "agentic_ai_threats",     label: "Agentic AI Threats" },
  { key: "ai_enabled_threats",     label: "AI-Enabled Threats" },
];

const tagLabel = (id) => getTag(id)?.label || id;

// ── Generic Anthropic JSON call ────────────────────────────────────────────────
// This script calls the Anthropic API directly (not via llmRouter), so it must
// persist its own cost events — otherwise dashboard-insight spend is invisible in
// llm_cost_log. Every call logs its token usage under a `task` context.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Transient: a 60–90s timeout/abort, or a retryable HTTP status (429 rate-limit,
// 5xx, 529 overloaded). These spiked under API load and caused whole insight
// sets to fall back; retry with backoff instead.
function isRetryable(err) {
  if (!err) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  if (/aborted|timeout|fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(err.message || "")) return true;
  return [429, 500, 502, 503, 504, 529].includes(err.status);
}

async function callAnthropic({ system, user, model, maxTokens = 1200, task = "dashboard_insight", retries = 3 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const usedModel = model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        // 90s: the multi-signal emerging-signals / themes calls return large JSON
        // and were tripping a 60s cap under API load.
        signal: AbortSignal.timeout(90000),
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model:      usedModel,
          max_tokens: maxTokens,
          // Cache the (per-stage-identical) system prompt so the 4 category calls
          // that share it re-read at ~0.1x. Only long prompts clear the cache
          // minimum; short ones silently don't cache (harmless).
          system: system && system.length >= 4000
            ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
            : system,
          messages: [{ role: "user", content: user }],
        }),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        const e = new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`);
        e.status = res.status;
        throw e;
      }
      const data = await res.json();

      // Persist cost (fire-and-forget; never let logging break generation).
      try {
        persistCallCost({
          task,
          provider:     "anthropic",
          model:        usedModel,
          inputTokens:  data.usage?.input_tokens  || 0,
          outputTokens: data.usage?.output_tokens || 0,
          cacheReadTokens:     data.usage?.cache_read_input_tokens     || 0,
          cacheCreationTokens: data.usage?.cache_creation_input_tokens || 0,
        });
      } catch { /* ignore */ }

      const text = data.content?.[0]?.text?.trim() || "";
      return extractJson(text);
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isRetryable(err)) {
        // Exponential backoff with jitter: ~2s, 4s, 8s.
        const wait = Math.round(2000 * 2 ** attempt * (0.8 + Math.random() * 0.4));
        console.log(`  [anthropic] ${task} ${err.name === "TimeoutError" ? "timeout" : (err.message || "").slice(0, 40)} — retry ${attempt + 1}/${retries} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Robust JSON extraction from an LLM response. Handles the common malformations
// that broke the old greedy `text.match(/\{[\s\S]*\}/)` + raw JSON.parse:
//   - ```json fences / prose around the object
//   - trailing prose after the object (greedy regex swallowed it → parse error)
//   - trailing commas before } or ]  ("Expected ',' or ']' after array element")
//   - a truncated object (maxTokens hit) → close the open brackets so we recover
//     whatever complete fields we can instead of throwing away the whole call.
export function extractJson(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("empty response");

  // Strip a leading ```json / ``` fence if present.
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // Locate the JSON object by balancing braces from the first "{", ignoring
  // braces inside strings. This avoids grabbing trailing prose.
  const start = unfenced.indexOf("{");
  if (start === -1) throw new Error(`No JSON object in response: ${unfenced.slice(0, 120)}`);

  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }

  // Complete object found, or truncated (depth>0) — take what we have and repair.
  let candidate = end !== -1 ? unfenced.slice(start, end) : unfenced.slice(start);

  const tryParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

  let parsed = tryParse(candidate);
  if (parsed !== undefined) return parsed;

  // Repair pass: drop trailing commas, then for truncation close any still-open
  // strings/arrays/objects so a cut-off response yields its complete prefix.
  let repaired = candidate.replace(/,\s*([}\]])/g, "$1");
  parsed = tryParse(repaired);
  if (parsed !== undefined) return parsed;

  if (end === -1) {
    repaired = closeTruncatedJson(candidate);
    parsed = tryParse(repaired.replace(/,\s*([}\]])/g, "$1"));
    if (parsed !== undefined) return parsed;
  }

  throw new Error(`Unparseable JSON: ${candidate.slice(0, 120)}`);
}

// Best-effort recovery of a truncated JSON object (maxTokens cut mid-response):
// rewind to the last point where a complete value sat at an array/object
// boundary, then close the brackets that were open AT THAT POINT. Snapshotting
// the stack at each boundary (not just at the end) avoids emitting a dangling
// key or half-written value.
function closeTruncatedJson(s) {
  let inStr = false, esc = false;
  const stack = [];               // pending closers, outermost first
  let safePos = 0;                // index after the last complete boundary value
  let safeStack = [];             // stack snapshot at safePos
  const snapshot = (i) => { safePos = i + 1; safeStack = stack.slice(); };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;   // string closed — boundary only if a comma/close follows
    } else if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") { stack.pop(); snapshot(i); }       // a value just completed
    else if (ch === ",") snapshot(i - 1);   // value before the comma is complete; exclude the comma
  }

  if (!safePos) return s + stack.reverse().join("");   // nothing complete yet — close what we can
  const head = s.slice(0, safePos).replace(/,\s*$/, "");
  return head + safeStack.reverse().join("");
}

// ── Stage A: findings → themes ─────────────────────────────────────────────────

const THEMES_SYSTEM = loadPrompt("insights/themes").system;

function buildThemesPrompt(catLabel, windowLabel, findings, leadFlags = []) {
  // Present findings in two labelled groups so the model can anchor themes in the
  // strongest signal. Both are capped upstream (composeCategoryFindings).
  const lead = findings.filter((_, i) => leadFlags[i]);
  const bg   = findings.filter((_, i) => !leadFlags[i]);
  const priorityBlock = lead.length
    ? `PRIORITY findings (realized incidents / landmark research — anchor themes here):\n${lead.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\n\n`
    : "";
  const bgBlock = bg.length
    ? `BACKGROUND findings (lower-signal context — supporting only):\n${bg.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`
    : "";
  return `Category: ${catLabel}
Period: ${windowLabel}
Source findings (${findings.length} grounded facts / summaries; ${lead.length} priority, ${bg.length} background):

${priorityBlock}${bgBlock}

Extract findings and cluster into themes, led by the PRIORITY findings.`;
}

// ── Stage B: themes → structured insights ──────────────────────────────────────

const INSIGHTS_SYSTEM = loadPrompt("insights/insights").system;

function buildInsightsPrompt(catLabel, windowLabel, themes, maturity, confidence) {
  const themeLines = themes.map((t, i) => {
    // Cap per-theme findings so each insight stays anchored to 3–5 sources.
    // Wider caps produce insights spanning 10+ sources that attribution cannot
    // fully cover, causing citation grounding to kill otherwise valid insights.
    const pf = (t.priority_findings   || t.findings || []).slice(0, 4);
    const bf = (t.background_findings || []).slice(0, 2);
    const mechanism = t.shared_mechanism ? `\n   Mechanism: ${t.shared_mechanism}` : "";
    const pfLines = pf.length ? `\n   Priority evidence:\n${pf.map(f => `     • ${f}`).join("\n")}` : "";
    const bfLines = bf.length ? `\n   Background corroboration:\n${bf.map(f => `     · ${f}`).join("\n")}` : "";
    return `Theme ${i + 1}: ${t.theme}${mechanism}${pfLines}${bfLines}`;
  }).join("\n\n");
  return `Category: ${catLabel}
Period: ${windowLabel}

EVIDENCE MATURITY (drives your calibration — do not overclaim beyond it):
  ${maturityShortLine(maturity)}  (total ${maturity.total})
  Confidence ceiling: ${confidence.level} — ${confidence.reason}

ANALYTICAL THEMES (each theme names a shared mechanism; synthesise from the pattern, not from individual findings):

${themeLines}

Produce the assessment and structured insights.`;
}

// ── QA: publication gate — factual accuracy, citation fidelity, maturity language ──

const QA_SYSTEM = loadPrompt("insights/insight-qa").system;

async function qaInsights(insights, maturity, catLabel, status = {}) {
  status.ran = false;
  if (!process.env.ANTHROPIC_API_KEY) { status.reason = "no_api_key"; return insights; }
  const user = `Category: ${catLabel}
Reporting date: ${REPORT_DATE}. A CVE year is only "future-dated" if AFTER this date. CVEs from ${REPORT_YEAR} and earlier are current.
Evidence maturity: ${maturityShortLine(maturity)} (total ${maturity.total})

INSIGHTS (title + explanation bullets + supporting evidence):
${insights.map((p, i) => `[${i}] Title: ${p.title || p.insight}\nOpening: ${p.insight}\nEvidence: ${p.evidence || "(none)"}\n${(p.explanation_points || []).map(b => `    - ${b}`).join("\n")}`).join("\n")}

Run the validation checklist. Return a verdict for every index.`;

  let verdicts;
  try {
    const out = await callAnthropic({
      system: QA_SYSTEM, user, task: "dashboard_insight_qa",
      model: process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
      maxTokens: 1200,
    });
    verdicts = out.verdicts;
    if (!Array.isArray(verdicts)) throw new Error("no verdicts");
    status.ran = true;
  } catch (err) {
    status.reason = "error";
    console.log(`  [QA] check failed (${err.message.slice(0, 50)}) — keeping all`);
    return insights;
  }

  const kept = [];
  insights.forEach((p, i) => {
    const v = verdicts.find(v => v.index === i);
    if (!v || v.verdict === "ok") {
      kept.push(p);
    } else if (v.verdict === "needs_correction") {
      // Apply corrections in-place; drop bullets flagged by bullets_to_drop
      const dropSet = new Set(Array.isArray(v.bullets_to_drop) ? v.bullets_to_drop : []);
      const corrected = {
        ...p,
        title:             v.corrected_title   || p.title,
        insight:           v.corrected_insight || p.insight,
        explanation_points: (p.explanation_points || []).filter((_, idx) => !dropSet.has(idx)),
      };
      console.log(`  [QA] CORRECTED [${i}]: ${(v.reason || "").slice(0, 80)}`);
      kept.push(corrected);
    } else {
      // verdict === "remove"
      console.log(`  [QA] REMOVED [${i}] ${v.verdict.toUpperCase()}: ${(v.reason || "").slice(0, 80)}`);
    }
  });
  return kept;
}

// Split a prose explanation into clean, standalone bullet points. Used only as a
// safety net when the model returns a paragraph instead of explanation_points, so
// a stored insight always carries point-form elaboration (never a cryptic wall of
// text the UI has to guess how to break up). Breaks on transitional connectives
// and sentence boundaries; drops fragments too short to stand alone.
function proseToBullets(text) {
  if (!text) return [];
  const CONNECTIVES = /(?<=[.!?])\s+(?=(?:Separately|Additionally|Also|However|Furthermore|Moreover|Meanwhile|In addition|At the same time|Notably|Importantly|Critically|By contrast|Unlike|Because|Worse|Crucially),?\s)/g;
  let parts = String(text).split(CONNECTIVES);
  parts = parts.flatMap(p => p.split(/(?<=[a-z0-9"')\]])\.\s+(?=[A-Z"'])/));
  return parts
    .map(s => s.trim().replace(/^[-•*]\s*/, ""))
    .filter(s => s.length > 25)
    .slice(0, 7);   // cap to keep the dropdown scannable
}

// ── Source loading ─────────────────────────────────────────────────────────────

const SRC_SELECT = "id,main_category,short_summary,analyst_brief,intelligence,tags,source_type,trust_tier,title,url,publisher,date_published,parent_source_id,is_digest,reading_value";

// Some pipeline-enriched sources leave the top-level short_summary/analyst_brief
// columns empty and stash the prose under intelligence.source_summary. Fall back
// to it so those sources still feed the insight pipeline instead of looking
// unenriched.
function summaryText(s) {
  return (s.analyst_brief || s.short_summary || s.intelligence?.source_summary || "").trim();
}

export async function loadWindowSources(from, to) {
  const { data, error } = await supabase
    .from("sources")
    .select(SRC_SELECT)
    .eq("validation_status", "pass")
    // Exclude ONLY genuinely-flagged sources (needs_review = true). Use IS NOT TRUE
    // rather than <> true so the vast majority of unflagged rows (needs_review NULL)
    // are KEPT — a plain .neq drops NULLs too (NULL <> true is unknown), which was
    // silently starving the insight pool.
    .not("needs_review", "is", true)
    // Insights are bucketed BY DATE into a reporting window — a source with an
    // estimated/inferred date could be counted in the wrong period, so only
    // authoritative-dated sources feed insight generation (matches the
    // newsletter, agent, and slide surfaces). Confirm a date on the Sources page
    // (→ date_confidence="exact") to include the source.
    .eq("date_confidence", "exact")
    .gte("date_published", from)
    .lte("date_published", to)
    .not("main_category", "is", null)
    .in("reading_value", ["essential", "recommended"]);
  if (error) throw new Error(error.message);
  return data || [];
}

// Tag counts + per-category source buckets from a raw source list.
function bucketSources(rows) {
  const byCategory = {};         // cat → [summary strings]
  const tagCounts  = {};         // tagId → count
  const tagSources = {};         // tagId → [{title,url,publisher,date,summary}]
  const catCounts  = {};         // cat → count
  const catMaturitySrcs = {};    // cat → [sources] for maturity
  for (const c of CATEGORIES) { byCategory[c.key] = []; catCounts[c.key] = 0; catMaturitySrcs[c.key] = []; }

  for (const s of rows) {
    const cat = s.main_category;
    if (!byCategory[cat]) continue;
    catCounts[cat]++;
    catMaturitySrcs[cat].push(s);
    const text = summaryText(s);
    if (text.length > 20) byCategory[cat].push(text);
    for (const tag of (s.tags || [])) {
      if (!getTag(tag)) continue;
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      (tagSources[tag] ??= []).push({
        title:     s.title,
        url:       s.url,
        publisher: s.publisher,
        date:      s.date_published?.slice(0, 10),
        summary:   text,
      });
    }
  }
  return { byCategory, tagCounts, tagSources, catCounts, catMaturitySrcs };
}

// ── Evidence-backed findings (Layer-5 evidence table → insight input) ──────────
// The dashboard previously fed insights from per-source summaries only, which
// covered ~16% of the corpus. The `evidence` table holds grounded atomic facts
// for far more sources; using those as Stage-A input both widens coverage and
// improves grounding. Per-source summaries remain a fallback for sources that
// have no evidence yet (so nothing regresses).

const SPEC_RANK = { high: 3, medium: 2, low: 1 };

// Load Layer-5 evidence rows for a set of source IDs. PostgREST caps .in() URL
// length, so chunk the IDs; paginate each chunk past the 1000-row cap.
async function loadWindowEvidence(sourceIds) {
  const out = [];
  const CHUNK = 150;
  for (let i = 0; i < sourceIds.length; i += CHUNK) {
    const ids = sourceIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("evidence")
        .select("source_id,fact,quote_grounded,specificity")
        .in("source_id", ids)
        .range(from, from + 999);
      if (error) { console.log(`  [evidence load] ${error.message.slice(0, 60)}`); break; }
      if (!data?.length) break;
      out.push(...data);
      if (data.length < 1000) break;
    }
  }
  return out;
}

// Build the Stage-A input for one category: grounded evidence facts spread
// round-robin across sources (breadth — every source contributes before any
// source contributes a second fact), then per-source summaries as fallback for
// sources with no evidence.
//
// SIGNAL-PRIORITISED (noise resistance): the round-robin rotates over sources
// ordered by combined signal (importance reality + research significance + trust)
// STRONGEST-FIRST, and pure-noise sources are held back — they only contribute if
// the signal sources don't fill the cap. So a realized incident or a landmark
// paper leads the findings pool and a low-signal source can't crowd it out. Within
// a single source, facts are still ordered by the discrete quote_grounded +
// specificity flags only (no fuzzy per-fact scoring).
function composeCategoryFindings(catRows, evItems = [], cap = 40) {
  const bySource = new Map();
  for (const e of evItems) {
    const f = (e.fact || "").trim();
    if (f.length < 15) continue;
    if (!bySource.has(e.source_id)) bySource.set(e.source_id, []);
    bySource.get(e.source_id).push(e);
  }
  for (const arr of bySource.values()) {
    arr.sort((a, b) =>
      (b.quote_grounded ? 1 : 0) - (a.quote_grounded ? 1 : 0) ||
      (SPEC_RANK[b.specificity] || 0) - (SPEC_RANK[a.specificity] || 0));
  }

  // Order the source queues by signal (strongest first), noise sources last, so
  // the round-robin admits high-signal sources before it ever reaches noise.
  const rowById = new Map(catRows.map(r => [r.id, r]));
  const { signal: signalIds, noise: noiseIds } = partitionBySignal(
    [...bySource.keys()].map(id => rowById.get(id)).filter(Boolean)
  );   // signalIds/noiseIds are source ROWS (partitionBySignal returns rows)
  const orderedQueues = [...signalIds, ...noiseIds]           // each is a source ROW
    .map(row => ({ row, q: bySource.get(row.id) }))
    .filter(x => x.q && x.q.length);

  // A finding "leads" when its source is the genuine headline material this period:
  // a realized real-world incident, a proven/demonstrated exploit, or LANDMARK
  // research. loadWindowSources already gates on reading_value in [essential,
  // recommended], so checking that here makes ALL sources lead — breaking the
  // PRIORITY/BACKGROUND distinction. Only "essential" auto-qualifies; "recommended"
  // sources must earn lead status via maturity or research significance.
  const isLead = (row) => row && (
    readingValueOf(row) === "essential" ||
    ["operational", "observed", "disclosed"].includes(maturityOf(row)) ||
    significanceRank(row) >= 3
  );

  // Overcounting guard: a landscape report's many findings are ONE report's
  // evidence, not many independent corroborations. Cap findings per effective
  // parent (a child's parent_source_id, else its own id) so a single report can
  // seed a theme but never dominate or inflate corroboration.
  const MAX_PER_PARENT = 3;
  const parentOf = (row) => row?.parent_source_id || row?.id;
  const perParent = new Map();

  // Signal prefix for findings: [maturity | source_type | publisher]
  // Gives themes and insights LLMs the data to rank operational evidence above research.
  const signalPrefix = (row) => {
    const m = maturityOf(row) || "research";
    const t = row?.source_type || "unknown";
    const p = row?.publisher ? row.publisher.split(" ")[0].replace(/[,.]$/, "") : "unknown";
    return `[${m} | ${t} | ${p}]`;
  };

  const entries = [];   // { text, lead }
  let i = 0, guard = 0;
  const guardMax = cap * (orderedQueues.length + 1) + 20;
  while (entries.length < cap && orderedQueues.some(x => x.q.length) && guard++ < guardMax) {
    const x = orderedQueues[i++ % orderedQueues.length];
    if (!x.q.length) continue;
    const p = parentOf(x.row);
    if ((perParent.get(p) || 0) >= MAX_PER_PARENT) { x.q.length = 0; continue; }
    perParent.set(p, (perParent.get(p) || 0) + 1);
    const fact = x.q.shift().fact.trim();
    entries.push({ text: `${signalPrefix(x.row)} ${fact}`, lead: isLead(x.row) });
  }
  const fromEvidence = entries.length;
  const covered = new Set(bySource.keys());

  // Summary fallback for sources with no evidence — signal-ordered too, and pure
  // noise excluded unless the pool is still thin.
  if (entries.length < cap) {
    const { signal, noise } = partitionBySignal(catRows.filter(r => !covered.has(r.id)));
    const fallbackOrder = entries.length + signal.length >= 8 ? signal : [...signal, ...noise];
    for (const r of fallbackOrder) {
      if (entries.length >= cap) break;
      const t = summaryText(r);
      if (t.length > 20) {
        entries.push({ text: `${signalPrefix(r)} ${t}`, lead: isLead(r) });
        covered.add(r.id);
      }
    }
  }

  return {
    findings:    entries.map(e => e.text),
    leadFlags:   entries.map(e => e.lead),
    leadCount:   entries.filter(e => e.lead).length,
    fromEvidence,
    fromSummary: entries.length - fromEvidence,
    evidenceSources: bySource.size,
    signalSources: signalIds.length,
    noiseSuppressed: noiseIds.length,
  };
}

// ── Generic second-model QA for any generated statements ───────────────────────
// Returns a boolean[] (true = grounded/keep) aligned to `statements`.

// Assessment QA — calibrated for a ONE-SENTENCE category posture (a generalization),
// not a factual statement. An assessment is SUPPOSED to be broad; we only reject
// maturity-overreach or a posture the validated insights don't support.
const ASSESS_QA_SYSTEM = loadPrompt("insights/assessment-qa").system;

// Returns { keep: boolean, corrected: string|null }
async function qaAssessment(assessment, insights, maturity, status = {}) {
  status.ran = false;
  if (!assessment) { status.reason = "empty"; return { keep: true, corrected: null }; }
  if (!process.env.ANTHROPIC_API_KEY) { status.reason = "no_api_key"; return { keep: true, corrected: null }; }
  const user = `Evidence maturity: ${maturityShortLine(maturity)} (total ${maturity.total})

VALIDATED INSIGHTS (already QA-passed — the assessment must be consistent with these):
${insights.map((p, i) => `[${i}] ${p.insight}`).join("\n")}

ASSESSMENT to verify:
"${assessment}"

Return the verdict.`;
  try {
    const out = await callAnthropic({
      system: ASSESS_QA_SYSTEM, user, task: "dashboard_assessment_qa",
      model: process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
      maxTokens: 300,
    });
    status.ran = true;
    const verdict = out.verdict || "ok";
    if (verdict === "ok") return { keep: true, corrected: null };
    if (verdict === "corrected" && out.corrected_assessment) {
      console.log(`     [QA] assessment CORRECTED: ${(out.reason || "").slice(0, 70)}`);
      return { keep: true, corrected: out.corrected_assessment };
    }
    // verdict === "remove"
    console.log(`     [QA] assessment REMOVED: ${(out.reason || "").slice(0, 70)}`);
    return { keep: false, corrected: null };
  } catch (err) {
    status.reason = "error";
    console.log(`     [QA:assessment] check failed (${err.message.slice(0, 40)}) — keeping`);
    return { keep: true, corrected: null };
  }
}


// ── Source attribution: tag the critical contributing sources per insight ──────
// After insights are generated + QA'd, this determines which real sources most
// directly support each insight, so the dashboard can show clickable citations
// instead of prose. The LLM may ONLY pick from the provided source list, so
// citations are always resolvable to a real URL (no hallucinated references).

// Maturity ordering used to rank which sources appear in the attribution
// candidate pool (operational evidence first — it is the most citable).
const SRC_TYPE_RANK = {
  incident: 6, threat_intelligence: 6, adversary_adoption_signal: 6,
  exploit_disclosure: 5, vulnerability: 4,
  capability_demonstration: 3, benchmark_evaluation: 3, research_finding: 3,
  defensive_capability: 2,
  attack_surface_signal: 1, governance_signal: 1, societal_harm_signal: 1,
  unknown: 0,
};

const titleOf = (t) => String(t || "").trim();

const ATTRIBUTION_SYSTEM = loadPrompt("insights/attribution").system;
const CITE_GROUND_SYSTEM = loadPrompt("insights/citation-grounding").system;

// Quarter/annual insights synthesise a CLUSTER of sources; week/month focus on a
// single event. Attribution + grounding scale with this: synthesis windows cite the
// whole cluster (so every named technique's source is present and each bullet grounds),
// event windows prefer a single source.
const SYNTHESIS_WINDOW = WINDOW === "quarter" || WINDOW === "annual";
// Month windows can have 20-30 sources per category — allow more citations so
// cross-source synthesis insights don't fail grounding due to under-attribution.
const CITE_CAP = SYNTHESIS_WINDOW ? 8 : WINDOW === "month" ? 6 : 3;

function buildAttributionPrompt(catLabel, windowLabel, insights, sources) {
  const insightLines = insights.map((p, i) => `[${i}] ${p.insight}`).join("\n");
  const sourceLines = sources.map((s, i) =>
    `${i + 1}. (${s.source_type || "unknown"}) ${titleOf(s.title).slice(0, 120)} — ${summaryText(s).slice(0, 160)}`
  ).join("\n");
  const mode = SYNTHESIS_WINDOW
    ? `This is a QUARTER/ANNUAL synthesis: each insight generalises a PATTERN across several sources. Cite EVERY source the insight draws on — every named technique, incident, or measured result in the insight must have its source attributed here (up to 8). Under-citing a synthesis insight is an error.`
    : `This is a WEEK/MONTH card. Cite EVERY source the insight draws on — if the insight synthesises a pattern across multiple sources, attribute all of them (up to 3). Do NOT limit to a single source when the insight is grounded in two or three. Under-citing is an error.`;
  return `Category: ${catLabel}   Period: ${windowLabel}
Attribution mode: ${mode}

INSIGHTS:
${insightLines}

SOURCES (attribute supporting source numbers to each insight from THIS list only):
${sourceLines}

Return the attributions.`;
}

// Attach `sources: [{title,url,publisher,date,source_type}]` to each insight.
// Best-effort: on any failure, insights get an empty sources array (UI hides it).
export async function attributeSources(insights, catSources, windowLabel, catLabel) {
  const withEmpty = insights.map(p => ({ ...p, sources: [] }));
  if (!insights.length || !catSources?.length) return withEmpty;
  if (!process.env.ANTHROPIC_API_KEY) return withEmpty;

  // Candidate pool: sources with real summaries, ranked by combined signal
  // (importance reality + research significance + trust), maturity, then recency —
  // so the attributable citations are drawn from the strongest sources (a landmark
  // paper or realized incident) rather than whatever is merely most recent.
  const ranked = [...catSources]
    .filter(s => s.url && summaryText(s).length > 20)
    .sort((a, b) =>
      sourceSignalScore(b) - sourceSignalScore(a) ||
      (SRC_TYPE_RANK[b.source_type] || 0) - (SRC_TYPE_RANK[a.source_type] || 0) ||
      (b.date_published || "").localeCompare(a.date_published || ""))
    .slice(0, 70);   // wider citation pool — the LLM sees more before choosing which to cite
  if (!ranked.length) return withEmpty;

  let attributions = [];
  try {
    const out = await callAnthropic({
      system: ATTRIBUTION_SYSTEM, task: "dashboard_attribution",
      // Attribution is a matching task (pick supporting source numbers) — Haiku
      // handles it well at a fraction of Sonnet's cost.
      model: process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
      user: buildAttributionPrompt(catLabel, windowLabel, insights, ranked),
      maxTokens: 700,
    });
    attributions = Array.isArray(out.attributions) ? out.attributions : [];
  } catch {
    return withEmpty;
  }

  const byIndex = new Map(
    attributions
      .filter(a => Number.isInteger(a.insight_index))
      .map(a => [a.insight_index, Array.isArray(a.source_numbers) ? a.source_numbers : []])
  );

  // Dedup a citation list so the SAME article never appears twice — even when it
  // was ingested under two URLs (query params, amp, http/https, a digest child +
  // its parent). Match on a normalised URL (protocol/www/query/fragment/trailing
  // slash stripped, PATH kept so distinct articles from one publisher stay
  // distinct) AND on a normalised title (catches the same story at genuinely
  // different URLs).
  const normUrl = (u) => String(u || "").toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "")
    .replace(/[?#].*$/, "").replace(/\/+$/, "");
  const normTitle = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();

  return insights.map((p, i) => {
    const nums = (byIndex.get(i) || []).filter(n => Number.isInteger(n) && n >= 1 && n <= ranked.length);
    const seenUrl = new Set();
    const seenTitle = new Set();
    const srcs = [];
    for (const n of nums.slice(0, CITE_CAP)) {   // week/month cap 3, quarter/annual cap 8 — insight is validated against these only
      const s = ranked[n - 1];
      if (!s) continue;
      const uk = normUrl(s.url), tk = normTitle(s.title);
      if (seenUrl.has(uk) || (tk && seenTitle.has(tk))) continue;
      seenUrl.add(uk); if (tk) seenTitle.add(tk);
      srcs.push({
        title:       titleOf(s.title),
        url:         s.url,
        publisher:   s.publisher || null,
        date:        s.date_published?.slice(0, 10) || null,
        source_type: s.source_type || null,
        reading_value: readingValueOf(s) ?? null,
        maturity:      maturityOf(s) || null,
        significance:  s.intelligence?.significance?.level || null,
      });
    }
    return { ...p, sources: srcs };
  });
}

// ── Citation grounding: keep only bullets the CITED sources actually support ────
// Runs AFTER attribution. Each explanation bullet is checked against ONLY the
// insight's cited sources (not the whole corpus). This catches the failure where a
// bullet drifts to a DIFFERENT source's finding ("A second attack, FloatDoor…"),
// which the pool-wide fact-check missed because that fact was real elsewhere in the
// window. Unsupported bullets are dropped; if the insight's explanation collapses,
// the whole insight is removed — a headline whose walkthrough can't be grounded in
// its own citations is not trustworthy.
async function groundExplanationsInCitations(insights, catSources, catLabel) {
  if (!process.env.ANTHROPIC_API_KEY) return insights;
  const normUrl = (u) => String(u || "").toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  const byUrl = new Map();
  for (const s of (catSources || [])) if (s.url) byUrl.set(normUrl(s.url), s);

  const kept = [];
  for (const p of insights) {
    const bullets = Array.isArray(p.explanation_points) ? p.explanation_points.filter(Boolean) : [];
    if (!bullets.length) { kept.push(p); continue; }

    const cited = (p.sources || []).map(c => byUrl.get(normUrl(c.url))).filter(Boolean);
    if (!cited.length) {
      // No resolvable cited-source text — can't ground the walkthrough. Keep the
      // (already headline-QA'd) insight but drop the unverifiable elaboration.
      kept.push({ ...p, explanation_points: [], explanation: "", explanation_qa: "no_citations" });
      continue;
    }

    // Ground against the cited source's FULL TEXT (abstract/body), not its number-free
    // summary. For digest children (parent_source_id set), also include the parent's
    // full text — children have thin text (700-900 chars) but the insight bullets
    // reference facts only present in the parent report (10k-20k chars).
    const { data: fullRows } = await supabase.from("sources")
      .select("id,full_text,parent_source_id").in("id", cited.map(s => s.id));
    const fullById = Object.fromEntries((fullRows || []).map(r => [r.id, r]));

    // Collect parent IDs needed for thin children
    const parentIds = [...new Set((fullRows || []).map(r => r.parent_source_id).filter(Boolean))];
    const parentRows = parentIds.length
      ? (await supabase.from("sources").select("id,full_text").in("id", parentIds)).data || []
      : [];
    const parentTextById = Object.fromEntries(parentRows.map(r => [r.id, r.full_text || ""]));

    const citedText = cited.map((s, i) => {
      const row = fullById[s.id];
      let body = (row?.full_text || summaryText(s));
      // Supplement thin child text with parent text
      if (row?.parent_source_id && body.length < 2000) {
        const parentText = parentTextById[row.parent_source_id] || "";
        if (parentText) body = body + "\n\n[Parent report context]\n" + parentText;
      }
      return `[S${i + 1}] ${titleOf(s.title)} — ${body.slice(0, 4000)}`;
    }).join("\n\n");
    let verdicts;
    try {
      const out = await callAnthropic({
        system: CITE_GROUND_SYSTEM, task: "dashboard_citation_grounding",
        model: process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
        user: `Insight: ${p.insight}\n\nCITED SOURCES (the only allowed scope):\n${citedText}\n\nBULLETS:\n${bullets.map((b, i) => `[${i}] ${b}`).join("\n")}\n\nVerdict for every bullet index. For unsupported and coherence_drift verdicts, provide a correction field.`,
        maxTokens: 1400,
      });
      verdicts = Array.isArray(out.verdicts) ? out.verdicts : null;
    } catch { verdicts = null; }
    if (!verdicts) { kept.push(p); continue; }

    // Build final bullet list: ok → keep, correctable → use correction, fatal → drop
    const CORRECTABLE = new Set(["unsupported", "coherence_drift"]);
    const FATAL       = new Set(["contradicts", "entity_drift", "redundant"]);
    const finalBullets = [];
    const corrected_log = [], dropped_log = [];

    bullets.forEach((b, k) => {
      const v = verdicts.find(v => v.index === k);
      if (!v || v.verdict === "ok") {
        finalBullets.push(b);
      } else if (CORRECTABLE.has(v.verdict) && v.correction) {
        finalBullets.push(v.correction);
        corrected_log.push(`[${v.verdict}→corrected] ${(v.reason || "").slice(0, 50)}`);
      } else {
        dropped_log.push(`[${v.verdict}] ${(v.reason || "").slice(0, 50)}`);
      }
    });

    if (corrected_log.length)
      console.log(`  [QA:citation] "${p.insight.slice(0, 46)}" — corrected ${corrected_log.length} bullet(s): ${corrected_log.join(" | ").slice(0, 110)}`);
    if (dropped_log.length)
      console.log(`  [QA:citation] "${p.insight.slice(0, 46)}" — dropped ${dropped_log.length}/${bullets.length} bullet(s): ${dropped_log.join(" | ").slice(0, 110)}`);

    if (finalBullets.length < 2) {
      console.log(`  [QA:citation] REMOVED insight — only ${finalBullets.length} bullet(s) survived grounding: ${p.insight.slice(0, 55)}`);
      continue;
    }
    kept.push({ ...p, explanation_points: finalBullets, explanation: finalBullets.join(" "), explanation_qa: "citation_grounded" });
  }
  return kept;
}

// ── Top sources ────────────────────────────────────────────────────────────────
// Uses the same candidate loading and editorial selection as the newsletter so the
// dashboard Overview and the newsletter always surface the same sources for the period.
async function selectTopSources(supabase, period) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const candidates = await loadCandidates(supabase, period.date_from, period.date_to);
    if (candidates.length < 3) return null;
    const selected = await selectSourcesWithLlm(candidates, period);
    if (!selected.length) return null;
    return selected.map(s => ({
      title:      titleOf(s.title),
      url:        s.url,
      publisher:  s.publisher || null,
      date:       s.date_published?.slice(0, 10) || null,
      category:   s.main_category,
      trust_tier: s.trust_tier || null,
      maturity:   maturityOf(s) || null,
      summary:    summaryText(s).slice(0, 240) || null,
      why:        s._reason ? String(s._reason).trim().slice(0, 220) : null,
      story_type: s._story_type || null,
    }));
  } catch (err) {
    console.log(`  [top-sources] failed: ${err.message.slice(0, 60)}`);
    return null;
  }
}

// ── Per-category generation ────────────────────────────────────────────────────

async function generateCategory(cat, windowLabel, findings, maturitySrcs, leadFlags = []) {
  const maturity   = computeEvidenceMaturity(maturitySrcs);
  const confidence = deriveConfidence(maturity);
  const totalCount = maturitySrcs.length; // canonical = all validated sources (matches the card)

  // Stage A: findings → themes. maxTokens scales with input — 40 evidence facts
  // produce a longer themes payload than the old 24 summaries; too low truncates
  // the JSON mid-array.
  const themesOut = await callAnthropic({
    system: THEMES_SYSTEM, task: "dashboard_themes",
    user: buildThemesPrompt(cat.label, windowLabel, findings, leadFlags),
    maxTokens: 3000,
  });
  const themes = Array.isArray(themesOut.themes) ? themesOut.themes : [];
  if (!themes.length) throw new Error("no themes extracted");

  // Stage B: themes → structured insights. maxTokens raised to fit the new
  // 120-180-word explanation per insight (2-4 insights → ~600-720 extra words).
  const out = await callAnthropic({
    system: INSIGHTS_SYSTEM, task: "dashboard_insights",
    user: buildInsightsPrompt(cat.label, windowLabel, themes, maturity, confidence),
    maxTokens: 2800,
  });
  let insights = Array.isArray(out.insights) ? out.insights : [];
  insights = insights
    .filter(p => p && typeof p.insight === "string" && p.insight.trim().length > 15)
    .map(p => {
      // Elaboration is now an ARRAY of bullet points (explanation_points). Keep a
      // joined `explanation` string too, for the fact-check QA below and back-compat
      // with any older reader. If a model still returns a prose `explanation`, keep it
      // as the string (the UI falls back to splitting it).
      let points = Array.isArray(p.explanation_points)
        ? p.explanation_points.map(s => String(s || "").trim().replace(/^[-•*]\s*/, "")).filter(s => s.length > 3)
        : [];
      // Robustness: if the model returned a prose `explanation` instead of the
      // bullet array (it occasionally does), split it into clean bullets HERE so
      // the stored insight always has point-form elaboration and the UI never has
      // to fall back to its own cryptic sentence-splitter.
      if (!points.length && typeof p.explanation === "string" && p.explanation.trim().length > 40) {
        points = proseToBullets(p.explanation);
      }
      const explanationStr = points.length ? points.join(" ") : (p.explanation || "").trim();
      return {
        title:              (p.title || "").trim(),
        insight:            p.insight.trim(),
        explanation_points: points,
        explanation:        explanationStr,
        evidence:           (p.evidence || "").trim(),
        confidence:         confidence.level,                 // deterministic, cannot be overstated
        confidence_reason:  (p.confidence_reason || confidence.reason).trim(),
      };
    });
  if (totalCount === 1) insights = insights.slice(0, 1);
  const beforeQa = insights.length;

  // Headline QA — drop summaries, overreach, fabrication, and low-signal lone CVEs.
  const insightQa = {};
  if (insights.length) insights = await qaInsights(insights, maturity, cat.label, insightQa);

  const emptyResult = () => ({
    insights: [], assessment: null, assessment_qa: "not_generated",
    qa_status: insightQa.ran ? "passed" : (insightQa.reason === "no_api_key" ? "skipped_no_key" : "degraded"),
    confidence: confidence.level, confidence_reason: confidence.reason,
    evidence_maturity: maturity, removed: beforeQa,
  });
  if (!insights.length) { console.log(`     (no insight-worthy material — ${beforeQa} candidate(s) all filtered)`); return emptyResult(); }

  // Attribution FIRST — tag the real sources that support each insight, so the
  // grounding check below can validate the explanation against ONLY those cited
  // sources (not the whole corpus). Order matters: writing the walkthrough from a
  // multi-source theme and validating it against the whole pool let bullets drift
  // to other sources' findings ("A second attack, FloatDoor…") and still pass.
  insights = await attributeSources(insights, maturitySrcs, windowLabel, cat.label);

  // CITATION GROUNDING — drop explanation bullets the cited sources don't support;
  // remove the insight if its walkthrough collapses. This is the strong guarantee
  // that every bullet is verifiable from the citations shown beside it.
  insights = await groundExplanationsInCitations(insights, maturitySrcs, cat.label);
  if (!insights.length) { console.log(`     (all insights removed by citation grounding)`); return emptyResult(); }

  // QA the category ASSESSMENT sentence itself — it drives period-over-period
  // comparison, so it must be grounded too. (Previously stored un-audited.)
  let assessment = (out.assessment || "").trim() || null;
  let assessment_qa = "not_generated";
  if (assessment) {
    const aStatus = {};
    const { keep, corrected } = await qaAssessment(assessment, insights, maturity, aStatus);
    if (!aStatus.ran) {
      assessment_qa = "degraded";
    } else if (!keep) {
      assessment_qa = "rejected";
      assessment = null;
    } else if (corrected) {
      assessment_qa = "corrected";
      assessment = corrected;
    } else {
      assessment_qa = "passed";
    }
  }

  // Roll up an overall QA status the dashboard can display honestly.
  const qa_status = insightQa.ran
    ? "passed"
    : (insightQa.reason === "no_api_key" ? "skipped_no_key" : "degraded");

  return {
    insights,
    assessment,
    assessment_qa,
    qa_status,
    confidence:        confidence.level,
    confidence_reason: confidence.reason,
    evidence_maturity: maturity,
    removed:           beforeQa - insights.length,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const now    = NOW;
  const period = getCompletedPeriodWindow(WINDOW, now);
  setCurrentRunId(`dash-${WINDOW}-${period.key}`);   // attribute cost rows to this run

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Dashboard Insights v2: ${WINDOW.toUpperCase()} / ${period.key}`);
  console.log(`  Period: ${period.date_from} → ${period.date_to}  (${period.label})`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : FORCE ? "FORCE" : "normal (skip existing)"}`);
  console.log(`${"═".repeat(60)}\n`);

  const { data: existing } = await supabase
    .from("dashboard_insights").select("category").eq("window_key", period.key);
  const existingCats = new Set((existing || []).map(r => r.category));

  const currRows = await loadWindowSources(period.date_from, period.date_to);
  const curr     = bucketSources(currRows);

  // Load Layer-5 evidence for the window's sources and bucket facts by the
  // source's category (#1). This is the primary Stage-A input; summaries fall back.
  const evRows = await loadWindowEvidence(currRows.map(r => r.id));
  const catOf  = new Map(currRows.map(r => [r.id, r.main_category]));
  const evidenceByCat = {};
  for (const c of CATEGORIES) evidenceByCat[c.key] = [];
  for (const e of evRows) {
    const cat = catOf.get(e.source_id);
    if (evidenceByCat[cat]) evidenceByCat[cat].push(e);
  }
  console.log(`  Evidence: ${evRows.length} facts across ${new Set(evRows.map(e => e.source_id)).size} sources\n`);

  let generated = 0, skipped = 0;
  const currAssess = {};

  for (const cat of CATEGORIES) {
    // --only <category> regenerates a single category, leaving the others (and the
    // period-meta comparison, which still needs every category's assessment) intact.
    if (ONLY && cat.key !== ONLY) {
      const { data: row } = await supabase.from("dashboard_insights").select("points").eq("window_key", period.key).eq("category", cat.key).maybeSingle();
      if (row?.points?.assessment) currAssess[cat.key] = row.points.assessment;
      skipped++; continue;
    }
    const mSrcs      = curr.catMaturitySrcs[cat.key];
    const maturity   = computeEvidenceMaturity(mSrcs);
    const confidence = deriveConfidence(maturity);

    // Compose findings: evidence facts (round-robin across sources) + summary fallback.
    const catRows = currRows.filter(r => r.main_category === cat.key);
    // Give the synthesis a wide view of the period's sources in ONE pass (was 40)
    // so it can see the whole field and pick/cluster the strongest signals rather
    // than latching onto whatever a small window happened to include.
    const { findings, leadFlags, leadCount, fromEvidence, fromSummary, evidenceSources, noiseSuppressed } =
      composeCategoryFindings(catRows, evidenceByCat[cat.key], 70);

    if (!FORCE && existingCats.has(cat.key)) {
      console.log(`  ${cat.label.padEnd(28)} SKIP (already generated)`);
      // Pull its stored assessment so comparison still works.
      const { data: row } = await supabase
        .from("dashboard_insights").select("points")
        .eq("window_key", period.key).eq("category", cat.key).maybeSingle();
      if (row?.points?.assessment) currAssess[cat.key] = row.points.assessment;
      skipped++; continue;
    }
    const totalCount = mSrcs.length; // canonical (matches the dashboard card)
    if (totalCount === 0) {
      console.log(`  ${cat.label.padEnd(28)} SKIP (0 sources)`);
      skipped++; continue;
    }
    if (findings.length === 0) {
      console.log(`  ${cat.label.padEnd(28)} SKIP (${totalCount} sources but no evidence facts or summaries)`);
      skipped++; continue;
    }

    console.log(`  ${cat.label.padEnd(28)} ${totalCount} sources · ${findings.length} findings (${leadCount} priority, ${fromEvidence} facts/${evidenceSources} src + ${fromSummary} summaries · ${noiseSuppressed} noise held back) · ${maturityShortLine(maturity)} · conf=${confidence.level}`);
    if (DRY_RUN) { skipped++; continue; }

    let result;
    try {
      result = await generateCategory(cat, period.label, findings, mSrcs, leadFlags);
    } catch (err) {
      console.log(`     FAIL: ${err.message.slice(0, 70)}`);
      continue;
    }

    currAssess[cat.key] = result.assessment;
    console.log(`     → ${result.insights.length} insights${result.removed ? `, ${result.removed} removed by QA` : ""} · QA:${result.qa_status}/assess:${result.assessment_qa} · "${(result.assessment || "").slice(0, 60)}"`);
    result.insights.forEach(p => console.log(`        • ${p.insight}`));

    const { error: upErr } = await supabase.from("dashboard_insights").upsert({
      win:          WINDOW,
      window_key:   period.key,
      window_label: period.label,
      category:     cat.key,
      points:       {
        schema:            "v2",
        insights:          result.insights,
        assessment:        result.assessment,
        confidence:        result.confidence,
        confidence_reason: result.confidence_reason,
        evidence_maturity: result.evidence_maturity,
        qa_status:         result.qa_status,         // #3: passed | degraded | skipped_no_key
        assessment_qa:     result.assessment_qa,     // #3: passed | rejected | degraded | not_generated
        findings_basis:    { facts: fromEvidence, summaries: fromSummary, evidence_sources: evidenceSources },
      },
      source_count: totalCount,
    }, { onConflict: "window_key,category" });

    if (upErr) console.log(`     DB FAIL: ${upErr.message.slice(0, 60)}`);
    else generated++;
    await new Promise(r => setTimeout(r, 400));
  }

  // ── Period snapshot + top sources ────────────────────────────────────────────
  if (!DRY_RUN) {
    // Top sources: same selection logic as the newsletter so dashboard and newsletter
    // always surface the same sources. Null → api/dashboard falls back to deterministic order.
    const topSources = await selectTopSources(supabase, period);
    console.log(`\n  Top sources: ${topSources ? `${topSources.length} selected + justified` : "none (fallback to deterministic order)"}`);

    const meta = {
      schema: "meta-v1",
      snapshot: {
        total:           currRows.length,
        category_counts: curr.catCounts,
        tag_counts:      curr.tagCounts,
        assessments:     currAssess,
      },
      top_sources: topSources,
    };

    const { error: metaErr } = await supabase.from("dashboard_insights").upsert({
      win: WINDOW, window_key: period.key, window_label: period.label,
      category: META_CATEGORY, points: meta, source_count: currRows.length,
    }, { onConflict: "window_key,category" });
    if (metaErr) console.log(`  meta DB FAIL: ${metaErr.message.slice(0, 60)}`);
  }

  console.log(`\n  Done: ${generated} generated, ${skipped} skipped`);
}

import { flushCostBuffer } from "../lib/llm/usagePersistence.js";
import { fileURLToPath } from "url";

// Only run the pipeline when invoked as a CLI — importing the module (e.g. for
// tests of extractJson) must not trigger generation.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then(() => flushCostBuffer())
    .catch(err => { console.error("\nFATAL:", err.message); process.exit(1); });
}
