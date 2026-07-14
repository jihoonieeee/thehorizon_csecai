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
 * Each insight is an object: { insight, evidence, implication, broken_assumption,
 *   watch_next, confidence, confidence_reason }.
 *
 * After all categories, a `_period_meta` row stores the snapshot and three
 * lightweight historical-comparison blocks vs the previous period:
 *   whats_changed (growing/stable/declining/new), assessment_changes, emerging_signals.
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
import { computeImportance } from "../lib/pipeline/scoring/importance.js";
import { sourceSignalScore, isNoiseSource, bySignalThenRecency, partitionBySignal } from "../lib/pipeline/scoring/sourceSignal.js";
import { significanceRank } from "../lib/pipeline/scoring/researchSignificance.js";
import { loadPrompt } from "../lib/prompts/promptLoader.js";

const args     = process.argv.slice(2);
const getArg   = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const hasFlag  = f => args.includes(f);

const WINDOW   = getArg("--window", "week");
const FORCE    = hasFlag("--force");
const DRY_RUN  = hasFlag("--dry-run");
// --asof <YYYY-MM-DD> overrides "now" so a historical completed period can be
// backfilled (e.g. --window month --asof 2026-05-15 targets April). Defaults to now.
const ASOF     = getArg("--asof", null);
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
  const themeLines = themes.map((t, i) =>
    `Theme ${i + 1}: ${t.theme}\n` + (t.findings || []).slice(0, 8).map(f => `   - ${f}`).join("\n")
  ).join("\n\n");
  return `Category: ${catLabel}
Period: ${windowLabel}

EVIDENCE MATURITY (this drives your calibration — do not overclaim beyond it):
  ${maturityShortLine(maturity)}  (total ${maturity.total})
  Confidence ceiling for this category: ${confidence.level} — ${confidence.reason}

THEMES (synthesise from these patterns, not from individual sources):

${themeLines}

Produce the assessment and structured insights.`;
}

// ── QA: Haiku rejects paper-summaries / overreach ──────────────────────────────

const QA_SYSTEM = loadPrompt("insights/insight-qa").system;

async function qaInsights(insights, maturity, catLabel, status = {}) {
  status.ran = false;
  if (!process.env.ANTHROPIC_API_KEY) { status.reason = "no_api_key"; return insights; }
  const user = `Category: ${catLabel}
Reporting date: ${REPORT_DATE} (today). A CVE/date is only "future-dated" if AFTER this date. CVEs from ${REPORT_YEAR} and earlier are current, NOT fabricated by year alone.
Evidence maturity: ${maturityShortLine(maturity)} (total ${maturity.total})

INSIGHTS:
${insights.map((p, i) => `[${i}] ${p.insight}  (implication: ${p.implication})`).join("\n")}

Audit each. Return a verdict for every index.`;

  let verdicts;
  try {
    const out = await callAnthropic({
      system: QA_SYSTEM, user, task: "dashboard_insight_qa",
      model: process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
      maxTokens: 700,
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
    if (!v || v.verdict === "ok") kept.push(p);
    else console.log(`  [QA] REMOVED [${i}] ${v.verdict.toUpperCase()}: ${(v.reason || "").slice(0, 80)}`);
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

const SRC_SELECT = "id,main_category,short_summary,analyst_brief,intelligence,tags,source_type,trust_tier,title,url,publisher,date_published,parent_source_id,is_digest";

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
    .not("main_category", "is", null);
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
  // research (a field-first / new-surface result). Notable/routine research and
  // plain disclosures are background context; noise is excluded entirely upstream.
  const isLead = (row) => row && (["realized", "proven"].includes(computeImportance(row).reality) || significanceRank(row) >= 3);

  // Overcounting guard: a landscape report's many findings are ONE report's
  // evidence, not many independent corroborations. Cap findings per effective
  // parent (a child's parent_source_id, else its own id) so a single report can
  // seed a theme but never dominate or inflate corroboration.
  const MAX_PER_PARENT = 3;
  const parentOf = (row) => row?.parent_source_id || row?.id;
  const perParent = new Map();

  const entries = [];   // { text, lead }
  let i = 0, guard = 0;
  const guardMax = cap * (orderedQueues.length + 1) + 20;
  while (entries.length < cap && orderedQueues.some(x => x.q.length) && guard++ < guardMax) {
    const x = orderedQueues[i++ % orderedQueues.length];
    if (!x.q.length) continue;
    const p = parentOf(x.row);
    if ((perParent.get(p) || 0) >= MAX_PER_PARENT) { x.q.length = 0; continue; }   // parent capped — drop the queue
    perParent.set(p, (perParent.get(p) || 0) + 1);
    entries.push({ text: x.q.shift().fact.trim(), lead: isLead(x.row) });
  }
  const fromEvidence = entries.length;
  const covered = new Set(bySource.keys());

  // Summary fallback for sources with no evidence — signal-ordered too, and pure
  // noise excluded unless the pool is still thin (so we never starve a sparse
  // category, but noise never leads).
  if (entries.length < cap) {
    const { signal, noise } = partitionBySignal(catRows.filter(r => !covered.has(r.id)));
    const fallbackOrder = entries.length + signal.length >= 8 ? signal : [...signal, ...noise];
    for (const r of fallbackOrder) {
      if (entries.length >= cap) break;
      const t = summaryText(r);
      if (t.length > 20) { entries.push({ text: t, lead: isLead(r) }); covered.add(r.id); }
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

const STMT_QA_SYSTEM = loadPrompt("insights/statement-qa").system;

// Assessment QA — calibrated for a ONE-SENTENCE category posture (a generalization),
// not a factual statement. An assessment is SUPPOSED to be broad; we only reject
// maturity-overreach or a posture the validated insights don't support.
const ASSESS_QA_SYSTEM = loadPrompt("insights/assessment-qa").system;

async function qaAssessment(assessment, insights, maturity, status = {}) {
  status.ran = false;
  if (!assessment) { status.reason = "empty"; return true; }
  if (!process.env.ANTHROPIC_API_KEY) { status.reason = "no_api_key"; return true; }
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
    if (verdict !== "ok") console.log(`     [QA] assessment ${verdict.toUpperCase()}: ${(out.reason || "").slice(0, 70)}`);
    return verdict === "ok";
  } catch (err) {
    status.reason = "error";
    console.log(`     [QA:assessment] check failed (${err.message.slice(0, 40)}) — keeping`);
    return true;
  }
}

async function qaStatements(statements, evidenceText, kind = "statement", status = {}) {
  status.ran = false;
  if (!statements.length) { status.reason = "empty"; return statements.map(() => true); }
  if (!process.env.ANTHROPIC_API_KEY) { status.reason = "no_api_key"; return statements.map(() => true); }
  const user = `Type: ${kind}
Reporting date: ${REPORT_DATE} (today). A CVE or date is only "future-dated" if it is AFTER this date. CVEs from ${REPORT_YEAR} and earlier are NOT future-dated — do not flag them for their year alone.

STATEMENTS:
${statements.map((s, i) => `[${i}] ${s}`).join("\n")}

EVIDENCE they must be grounded in:
${evidenceText}

Verdict for every index.`;
  try {
    const out = await callAnthropic({
      system: STMT_QA_SYSTEM, user, task: "dashboard_statement_qa",
      model: process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
      maxTokens: 700,
    });
    const verdicts = out.verdicts || [];
    status.ran = true;
    return statements.map((_, i) => {
      const v = verdicts.find(v => v.index === i);
      const keep = !v || v.verdict === "ok";
      if (!keep) console.log(`  [QA:${kind}] REMOVED [${i}]: ${(v.reason || "").slice(0, 70)}`);
      return keep;
    });
  } catch (err) {
    status.reason = "error";
    console.log(`  [QA:${kind}] check failed (${err.message.slice(0, 40)}) — keeping all`);
    return statements.map(() => true);
  }
}

// ── Emerging signals: weak-but-gaining themes, with analysis + explorable sources

function detectEmergingSignals(currTags, prevTags) {
  const signals = [];
  for (const id of Object.keys(currTags)) {
    const curr = currTags[id] || 0;
    const prev = prevTags[id] || 0;
    // Weak-but-now-gaining: was a faint signal (1-3), now meaningfully larger.
    if (prev >= 1 && prev <= 3 && (curr - prev) >= 3) {
      signals.push({ tag_id: id, signal: tagLabel(id), prev, curr, delta: curr - prev });
    }
  }
  return signals.sort((a, b) => b.delta - a.delta).slice(0, 5);
}

const SIGNAL_SYSTEM = loadPrompt("insights/emerging-signals").system;

// Deterministic, source-grounded fallbacks so EVERY signal carries elaboration
// even when the LLM skips one or its analysis fails QA.
function fallbackAnalysis(sig) {
  return `Early signal — ${sig.signal} appeared in ${sig.curr} source${sig.curr === 1 ? "" : "s"} this period, ` +
    `up from ${sig.prev}. Evidence is still thin; treat it as an emerging watch item, not a confirmed trend.`;
}
function normalizeWatch(watch, sig) {
  let pts = Array.isArray(watch)
    ? watch
    : (typeof watch === "string" && watch.trim() ? [watch.trim()] : []);
  pts = pts.map(w => String(w).trim()).filter(Boolean).slice(0, 3);
  if (!pts.length) {
    pts = [
      `Corroboration from a second, independent source type`,
      `${sig.signal} moving from disclosure to observed exploitation`,
    ];
  }
  return pts;
}

async function enrichEmergingSignals(signals, currTagSources) {
  if (!signals.length) return [];

  // Attach explorable source refs (deduped by url/title), cap 8 per signal.
  for (const sig of signals) {
    const seen = new Set();
    sig.sources = (currTagSources[sig.tag_id] || []).filter(s => {
      const k = s.url || s.title; if (!k || seen.has(k)) return false; seen.add(k); return true;
    }).slice(0, 8).map(({ summary, ...ref }) => ref); // strip summary from stored refs
    sig.previous = "Weak signal";
    sig.current  = "Emerging trend";
    sig.reason   = `+${sig.delta} sources this period (${sig.prev} → ${sig.curr})`;
  }

  if (!process.env.ANTHROPIC_API_KEY) return signals;

  // Evidence grounding per signal — built ONCE and shared by the analysis
  // generator and the QA verifier. They must see the same summaries, otherwise
  // the QA flags as "overreach" any specific (CVE / product / stat) the analysis
  // legitimately drew from a source the QA couldn't see.
  const signalEvidence = signals.map(sig =>
    (currTagSources[sig.tag_id] || [])
      .map(s => s.summary).filter(Boolean).slice(0, 6).map(s => s.slice(0, 220))
  );

  // One LLM call for all signals' analysis, grounded in their summaries.
  const blocks = signals.map((sig, i) =>
    `[${i}] Signal: ${sig.signal} (${sig.prev} → ${sig.curr} sources)\n` +
    signalEvidence[i].map(s => `   - ${s}`).join("\n")
  ).join("\n\n");

  let analyses = [];
  try {
    const out = await callAnthropic({
      system: SIGNAL_SYSTEM, task: "dashboard_emerging_signals",
      user: `Write analysis for each emerging signal.\n\n${blocks}`,
      maxTokens: 1200,
    });
    analyses = Array.isArray(out.signals) ? out.signals : [];
  } catch (err) {
    console.log(`  [emerging] analysis failed: ${err.message.slice(0, 40)}`);
    return signals;
  }

  signals.forEach((sig, i) => {
    const a = analyses.find(x => x.index === i) || analyses[i];
    sig.analysis = (a?.analysis || "").trim() || fallbackAnalysis(sig);
    sig.watch    = normalizeWatch(a?.watch, sig);
  });

  // Second-model QA on the generated analyses. A failed verdict means the LLM
  // analysis wasn't grounded — swap in the deterministic fallback (grounded by
  // construction) rather than blanking the signal, so every card keeps elaboration.
  const verdicts = await qaStatements(
    signals.map(s => s.analysis),
    // Same evidence the analysis was grounded in (signalEvidence), so QA verifies
    // against what the generator actually saw — not a narrower slice.
    signals.map((s, i) => `${s.signal}:\n${signalEvidence[i].map(x => `   - ${x}`).join("\n")}`).join("\n\n"),
    "emerging-signal",
  );
  signals.forEach((s, i) => {
    if (!verdicts[i]) { s.analysis = fallbackAnalysis(s); s.watch = normalizeWatch(null, s); }
  });

  return signals;
}

const ASSESS_CHANGE_SYSTEM = loadPrompt("insights/assessment-changes").system;

async function computeAssessmentChanges(currAssess, prevAssess, maturityDeltas) {
  const cats = Object.keys(currAssess).filter(c => prevAssess[c]);
  if (!cats.length || !process.env.ANTHROPIC_API_KEY) return [];
  const user = cats.map(c => {
    const d = maturityDeltas[c] || {};
    return `Category: ${c}
  Previous: ${prevAssess[c]}
  Current:  ${currAssess[c]}
  Evidence delta: ${Object.entries(d).map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v}`).join(", ") || "n/a"}`;
  }).join("\n\n");
  let changes = [];
  try {
    const out = await callAnthropic({
      system: ASSESS_CHANGE_SYSTEM, task: "dashboard_assessment_changes",
      user: `Compare the periods. Report only material changes, terse.\n\n${user}`,
      maxTokens: 700,
    });
    changes = Array.isArray(out.changes) ? out.changes.slice(0, 5) : [];
  } catch (err) {
    console.log(`  [assessment-changes] failed: ${err.message.slice(0, 50)}`);
    return [];
  }

  // Second-model QA: each change must be grounded in the assessments + deltas.
  const evidence = cats.map(c =>
    `${c}: prev="${prevAssess[c]}" curr="${currAssess[c]}" deltas=${Object.entries(maturityDeltas[c] || {}).map(([k, v]) => `${k}${v >= 0 ? "+" : ""}${v}`).join(",")}`
  ).join("\n");
  const verdicts = await qaStatements(
    changes.map(c => `${c.category}: ${c.from} → ${c.to} (${c.reason})`),
    evidence, "assessment-change",
  );
  return changes.filter((_, i) => verdicts[i]);
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

function buildAttributionPrompt(catLabel, windowLabel, insights, sources) {
  const insightLines = insights.map((p, i) => `[${i}] ${p.insight}`).join("\n");
  const sourceLines = sources.map((s, i) =>
    `${i + 1}. (${s.source_type || "unknown"}) ${titleOf(s.title).slice(0, 120)} — ${summaryText(s).slice(0, 160)}`
  ).join("\n");
  return `Category: ${catLabel}   Period: ${windowLabel}

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
    for (const n of nums.slice(0, 5)) {
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
        // Contribution signal so the UI can show WHY this source was cited: its
        // importance tier and (for research) how significant it is.
        importance:   computeImportance(s).tier,
        significance: s.intelligence?.significance?.level || null,
      });
    }
    return { ...p, sources: srcs };
  });
}

// ── Top sources: deterministic filter → LLM semantic rank + justify ────────────
// The insight pipeline already reads the window's sources; here the same context
// yields the "top sources" for the period. A deterministic importance filter bounds
// the candidate pool (real offensive signal only), then one LLM call RANKS them and
// writes a one-sentence justification per pick. The LLM's judgment also collapses
// duplicate reports of the same event for free (it won't list an event twice) — which
// is why no similarity threshold is needed. Falls back to null (→ deterministic order
// in api/dashboard) when the key is missing or the call fails.

const TOP_SOURCES_SYSTEM = loadPrompt("insights/top-sources").system;

function buildTopSourcesPrompt(windowLabel, candidates, n) {
  const lines = candidates.map((s, i) =>
    `${i + 1}. [${s._tier}] (${s.source_type || "?"}) ${titleOf(s.title).slice(0, 110)} — ${summaryText(s).slice(0, 150)} [${s.publisher || "?"}]`
  ).join("\n");
  return `Period: ${windowLabel}

Select the TOP ${n} most consequential sources (ranked). Candidates:

${lines}

Return { "top": [ { "n", "why" } ] } with at most ${n} entries, most important first.`;
}

export async function selectTopSources(windowRows, windowLabel, n = 10) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  // Deterministic candidate pool: strong offensive signal with a usable summary,
  // ranked by combined signal. Admits realized/proven incidents AND landmark/notable
  // research (a first-of-kind paper is a legitimate top source even though its
  // reality is only "research") — the significance overlay is what lets it in.
  const REAL = { realized: 3, proven: 2 };
  const candidates = windowRows
    .map(s => ({ ...s, _imp: computeImportance(s), _tier: computeImportance(s).tier }))
    .filter(s => s.url && s._imp.posture === "offensive" && summaryText(s).length > 20 &&
      (REAL[s._imp.reality] || significanceRank(s) >= 2))   // realized/proven OR landmark/notable research
    .sort((a, b) => sourceSignalScore(b) - sourceSignalScore(a) || (b.date_published || "").localeCompare(a.date_published || ""))
    .slice(0, 40);
  if (candidates.length < 3) return null;

  let picks = [];
  try {
    const out = await callAnthropic({
      system: TOP_SOURCES_SYSTEM, task: "dashboard_top_sources",
      user: buildTopSourcesPrompt(windowLabel, candidates, n),
      maxTokens: 900,
    });
    picks = Array.isArray(out.top) ? out.top : [];
  } catch { return null; }

  const seen = new Set(), top = [];
  for (const p of picks) {
    const i = Number(p.n);
    if (!Number.isInteger(i) || i < 1 || i > candidates.length) continue;
    const s = candidates[i - 1];
    if (!s || seen.has(s.url)) continue;
    seen.add(s.url);
    top.push({
      title:      titleOf(s.title),
      url:        s.url,
      publisher:  s.publisher || null,
      date:       s.date_published?.slice(0, 10) || null,
      category:   s.main_category,
      trust_tier: s.trust_tier || null,
      importance: s._imp.tier,
      reality:    s._imp.reality,
      significance: s.intelligence?.significance?.level || null,   // landmark|notable|… (research only)
      summary:    summaryText(s).slice(0, 240) || null,
      why:        typeof p.why === "string" ? p.why.trim().slice(0, 220) : null,
    });
    if (top.length >= n) break;
  }
  return top.length ? top : null;
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
        insight:            p.insight.trim(),
        explanation_points: points,
        explanation:        explanationStr,
        evidence:           (p.evidence || "").trim(),
        broken_assumption:  (p.broken_assumption || "").trim(),
        implication:        (p.implication || "").trim(),
        watch_next:         (p.watch_next || "").trim(),
        confidence:         confidence.level,                 // deterministic, cannot be overstated
        confidence_reason:  (p.confidence_reason || confidence.reason).trim(),
      };
    });
  if (totalCount === 1) insights = insights.slice(0, 1);
  const beforeQa = insights.length;

  // Headline QA — drop summaries, overreach, fabrication, and low-signal lone CVEs.
  const insightQa = {};
  if (insights.length) insights = await qaInsights(insights, maturity, cat.label, insightQa);

  // Fact-check the depth EXPLANATIONS against the same findings they were written
  // from. If an explanation invents specifics (e.g. a fabricated CVE number) or
  // overreaches the evidence, the whole insight is UNTRUSTWORTHY — a headline built
  // on the same reasoning can't be trusted just because the paragraph was cut, so a
  // failed explanation REMOVES the entire insight, not just its narrative.
  // `findings` is the grounded pool.
  const explained = insights.map((p, i) => ({ i, text: p.explanation })).filter(x => x.text && x.text.length > 40);
  if (explained.length) {
    const explQa = {};
    const evidenceText = findings.slice(0, 70).map((f, i) => `${i + 1}. ${f}`).join("\n");
    const verdicts = await qaStatements(explained.map(x => x.text), evidenceText, "insight-explanation", explQa);
    const drop = new Set();
    explained.forEach((x, k) => {
      if (explQa.ran && !verdicts[k]) {
        drop.add(x.i);
        console.log(`  [QA] REMOVED insight [${x.i}] — explanation failed fact-check: ${insights[x.i].insight.slice(0, 70)}`);
      } else if (explQa.ran) {
        insights[x.i].explanation_qa = "passed";
      }
    });
    if (drop.size) insights = insights.filter((_, i) => !drop.has(i));
  }

  // NOTHING INSIGHT-WORTHY → return an empty (but valid) result, not an error. The
  // caller writes an empty insight set so the card honestly shows "no insight this
  // period" and stale insights are overwritten — better than forcing a weak one.
  if (!insights.length) {
    console.log(`     (no insight-worthy material — ${beforeQa} candidate(s) all filtered)`);
    return {
      insights: [], assessment: null, assessment_qa: "not_generated",
      qa_status: insightQa.ran ? "passed" : (insightQa.reason === "no_api_key" ? "skipped_no_key" : "degraded"),
      confidence: confidence.level, confidence_reason: confidence.reason,
      evidence_maturity: maturity, removed: beforeQa,
    };
  }

  // Attribution: tag the real sources that most critically support each insight,
  // so the dashboard shows clickable citations rather than prose "evidence".
  insights = await attributeSources(insights, maturitySrcs, windowLabel, cat.label);

  // QA the category ASSESSMENT sentence itself — it drives period-over-period
  // comparison, so it must be grounded too. (Previously stored un-audited.)
  let assessment = (out.assessment || "").trim() || null;
  let assessment_qa = "not_generated";
  if (assessment) {
    const aStatus = {};
    // Ground the assessment against the already-validated insights (+ maturity),
    // using the calibrated assessment check that permits generalization.
    const keepAssessment = await qaAssessment(assessment, insights, maturity, aStatus);
    if (!aStatus.ran) {
      assessment_qa = "degraded";              // QA could not run (keyless/error)
    } else if (!keepAssessment) {
      assessment_qa = "rejected";
      assessment = null;                        // don't let an overreaching posture drive comparison
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
  // Previous period of the same window type (for comparison): pick a date inside
  // the current period and ask the helper for the period completed before it.
  const prevPeriod = getCompletedPeriodWindow(WINDOW, new Date(`${period.date_from}T12:00:00Z`));

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Dashboard Insights v2: ${WINDOW.toUpperCase()} / ${period.key}`);
  console.log(`  Period: ${period.date_from} → ${period.date_to}  (${period.label})`);
  console.log(`  Compare vs: ${prevPeriod.key} (${prevPeriod.date_from} → ${prevPeriod.date_to})`);
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
  const currMaturity = {};

  for (const cat of CATEGORIES) {
    const mSrcs      = curr.catMaturitySrcs[cat.key];
    const maturity   = computeEvidenceMaturity(mSrcs);
    const confidence = deriveConfidence(maturity);
    currMaturity[cat.key] = maturity;

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

  // ── Period snapshot + historical comparison ──────────────────────────────────
  if (!DRY_RUN) {
    console.log(`\n  Building period snapshot + comparison vs ${prevPeriod.key}...`);
    const prevRows = await loadWindowSources(prevPeriod.date_from, prevPeriod.date_to);
    const prev     = bucketSources(prevRows);

    // Previous assessments from the stored prev-period category rows (if any).
    const prevAssess = {};
    const prevMaturity = {};
    const { data: prevCatRows } = await supabase
      .from("dashboard_insights").select("category,points")
      .eq("window_key", prevPeriod.key).neq("category", META_CATEGORY);
    for (const r of (prevCatRows || [])) {
      if (r.points?.assessment) prevAssess[r.category] = r.points.assessment;
      if (r.points?.evidence_maturity) prevMaturity[r.category] = r.points.evidence_maturity;
    }

    const emergingSignals = await enrichEmergingSignals(
      detectEmergingSignals(curr.tagCounts, prev.tagCounts),
      curr.tagSources,
    );

    // Maturity deltas per category for the assessment-change reasoning.
    const maturityDeltas = {};
    for (const c of CATEGORIES) {
      const cm = currMaturity[c.key] || {}, pm = prevMaturity[c.key] || {};
      maturityDeltas[c.key] = {
        research:      (cm.research || 0)      - (pm.research || 0),
        vulnerabilities:(cm.vulnerabilities||0)- (pm.vulnerabilities || 0),
        exploitation:  (cm.exploitation || 0)  - (pm.exploitation || 0),
        incidents:     (cm.incidents || 0)     - (pm.incidents || 0),
        operational:   (cm.operational || 0)   - (pm.operational || 0),
      };
    }
    const assessmentChanges = await computeAssessmentChanges(currAssess, prevAssess, maturityDeltas);

    // Editor-selected, justified top sources for the period (LLM semantic rank over
    // the deterministic importance pool). Null → api/dashboard uses the deterministic order.
    const topSources = await selectTopSources(currRows, period.label, 10);
    console.log(`  Top sources: ${topSources ? `${topSources.length} selected + justified` : "none (fallback to deterministic order)"}`);

    const meta = {
      schema: "meta-v1",
      compared_to: prevPeriod.key,
      compared_to_label: prevPeriod.label,
      snapshot: {
        total:           currRows.length,
        category_counts: curr.catCounts,
        tag_counts:      curr.tagCounts,
        assessments:     currAssess,
      },
      assessment_changes: assessmentChanges,
      emerging_signals:   emergingSignals,
      top_sources:        topSources,   // [{ title,url,publisher,date,category,importance,why }] | null
    };

    const { error: metaErr } = await supabase.from("dashboard_insights").upsert({
      win: WINDOW, window_key: period.key, window_label: period.label,
      category: META_CATEGORY, points: meta, source_count: currRows.length,
    }, { onConflict: "window_key,category" });
    if (metaErr) console.log(`  meta DB FAIL: ${metaErr.message.slice(0, 60)}`);

    console.log(`  Comparison: ${emergingSignals.length} emerging signals, ${assessmentChanges.length} assessment changes`);
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
