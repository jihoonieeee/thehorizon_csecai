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

const THEMES_SYSTEM = `You are an AI threat intelligence analyst. You are given source summaries for ONE threat category over ONE time period.

Do TWO things:
1. Extract atomic FINDINGS — single, concrete things each source establishes (a capability shown, a control bypassed, a vulnerability class, a real incident, a measured result). KEEP the concrete specifics: the named technique, the affected system/product/model, the threat actor, the CVE ID, and any hard numbers (success rate, count, dollar loss). Drop only the "a paper by X shows…" framing — never drop the substance that makes the finding specific and checkable.
2. Cluster the findings into 2-5 THEMES — recurring patterns that span multiple findings. A theme is a pattern, not a single paper.

Do NOT write conclusions or implications yet. Just findings and the themes they form.
Keep each finding tight (under 25 words) but SPECIFIC — a reader must be able to tell exactly what happened and to what system. Compress; do not echo source text verbatim, and do not generalise away the specifics.

Return ONLY valid JSON:
{"themes": [{"theme": "short theme name", "findings": ["finding", "finding", ...]}]}`;

function buildThemesPrompt(catLabel, windowLabel, findings) {
  // findings are already capped upstream (composeCategoryFindings); show all.
  const lines = findings.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `Category: ${catLabel}
Period: ${windowLabel}
Source findings (${findings.length} grounded facts / summaries spanning the period's sources):

${lines}

Extract findings and cluster into themes.`;
}

// ── Stage B: themes → structured insights ──────────────────────────────────────

const INSIGHTS_SYSTEM = `You are a principal AI threat intelligence analyst writing a horizon-scan briefing for security leadership. You synthesise THEMES into SPECIFIC, GROUNDED insights that a defender can act on.

A real INSIGHT is a sharp judgment anchored in concrete evidence. It states:
  WHAT SPECIFICALLY HAPPENED (name the technique, system, actor, or measured result)
  → WHY IT MATTERS (the control it defeats or the assumption it breaks)
  → WHAT A DEFENDER SHOULD DO DIFFERENTLY.

Be SPECIFIC. Name the actual attack technique, the affected class of systems (e.g. "MCP servers", "vLLM inference endpoints", "AI coding agents", "RAG retrieval layers"), the threat behaviour, and any hard numbers. An insight that could have been written a year ago without reading these sources is TOO GENERIC — rewrite it to reflect what THIS period's evidence specifically shows.

GOOD (specific, grounded, names the concrete failure + so-what):
- "Attackers are chaining low-severity CVEs in agentic platforms (AutoGPT, Flowise, LiteLLM) into full RCE — so 'low severity' scores can no longer defer patching on agent infrastructure."
- "Prompt injection hidden in third-party GitHub repos now drives coding agents (Claude Code, Windsurf) to exfiltrate SSH keys — untrusted repo content must be treated as executable input, not data."
- "Deepfake voice/video defeated live video-call verification in a confirmed nine-figure fraud, retiring visual identity confirmation as a standalone control for wire authorisation."

BAD (too abstract / could apply to any period — REWRITE to be specific):
- "The AI attack surface is expanding faster than defenses can mature." (vague truism)
- "Organizations must adopt a proactive security posture for AI." (generic advice)
- "AI-enabled attacks are becoming more sophisticated." (says nothing checkable)

Also BAD (bare paper summary with no judgment — REJECT):
- "A new benchmark evaluated jailbreak robustness across models."

For EACH insight, produce these fields:
- insight: one specific, grounded judgment naming the concrete technique/system + why it matters, 20-38 words, active voice. Prefer naming real systems/techniques over abstractions.
- evidence: the concrete kinds of evidence behind it (e.g. "five distinct CVEs across AutoGPT, Flowise and LiteLLM; one confirmed breach"), grounded in the themes.
- broken_assumption: the specific defensive assumption or control that no longer holds.
- implication: the concrete action or posture change a defender should make in response.
- watch_next: what specific evidence would strengthen, weaken, or change this assessment.
- confidence_reason: one clause tying confidence to evidence maturity (e.g. "multiple CVEs but no confirmed in-the-wild chaining yet").

CALIBRATION (critical): You are told the EVIDENCE MATURITY for this category. If the evidence is research/vulnerability-only with no observed exploitation, you MUST NOT claim activity is "confirmed", "operational", "at scale", or "in the wild". Frame as demonstrated capability and shifting assumptions, not active campaigns.

Also produce a one-sentence "assessment": the current overall posture for this category (used for period-over-period comparison). The assessment is bound by the SAME evidence-maturity calibration as the insights — its verb must match the evidence:
  - research/vulnerability-only (no observed exploitation) → describe demonstrated capability and shifting assumptions. Use verbs like "research is demonstrating", "capability is maturing", "assumptions are weakening". Do NOT say "escalating into production", "moving in-the-wild", "being weaponised", or "confirmed in operations".
  - exploitation/incidents/operational evidence present → you MAY describe escalation or operational use, proportional to that evidence.
Examples calibrated to maturity:
  - research-heavy:  "LLM jailbreak capability is maturing in research faster than guardrail designs can absorb."
  - operational:     "AI-enabled deepfake fraud has crossed from demonstration into confirmed financial-loss incidents."
Pick the verb that the stated maturity supports — an overreaching assessment will be rejected downstream.

Write 2-4 insights for rich periods; 1-2 for thin ones. Never pad.

Return ONLY valid JSON:
{"assessment": "...", "insights": [{"insight": "...", "evidence": "...", "broken_assumption": "...", "implication": "...", "watch_next": "...", "confidence_reason": "..."}]}`;

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

const QA_SYSTEM = `You audit AI-threat insights for an intelligence briefing. For each insight, return one verdict.

Insights SHOULD be specific and name real techniques, systems, or actors — do NOT reject an insight for being specific. Reject only these:

REJECT (verdict "summary") if the insight is a bare description of one paper/CVE/benchmark with NO judgment — i.e. it states what a source found but draws no consequence for defenders (no broken assumption, no posture change, no "so what").
REJECT (verdict "overreach") if it claims confirmed/operational/in-the-wild/at-scale activity when the stated evidence maturity is research/vulnerability-only.
KEEP (verdict "ok") if it names something concrete AND draws a consequence — what changed + a broken assumption or a defender action — and stays within the evidence maturity. A specific, grounded insight that names real systems is exactly what we want; keep it.

Return ONLY JSON: {"verdicts":[{"index":0,"verdict":"ok"|"summary"|"overreach","reason":"..."|null}]}`;

async function qaInsights(insights, maturity, catLabel, status = {}) {
  status.ran = false;
  if (!process.env.ANTHROPIC_API_KEY) { status.reason = "no_api_key"; return insights; }
  const user = `Category: ${catLabel}
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

// ── Source loading ─────────────────────────────────────────────────────────────

const SRC_SELECT = "id,main_category,short_summary,analyst_brief,intelligence,tags,source_type,title,url,publisher,date_published";

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
// sources with no evidence. No fuzzy importance ranking — within a single source
// facts are ordered by the discrete quote_grounded + specificity flags only.
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

  const findings = [];
  const queues = [...bySource.values()];
  let i = 0, guard = 0;
  const guardMax = cap * (queues.length + 1) + 20;
  while (findings.length < cap && queues.some(q => q.length) && guard++ < guardMax) {
    const q = queues[i++ % queues.length];
    if (q.length) findings.push(q.shift().fact.trim());
  }
  const fromEvidence = findings.length;
  const covered = new Set(bySource.keys());

  if (findings.length < cap) {
    for (const r of catRows) {
      if (findings.length >= cap) break;
      if (covered.has(r.id)) continue;
      const t = summaryText(r);
      if (t.length > 20) { findings.push(t); covered.add(r.id); }
    }
  }

  return {
    findings,
    fromEvidence,
    fromSummary: findings.length - fromEvidence,
    evidenceSources: bySource.size,
  };
}

// ── Generic second-model QA for any generated statements ───────────────────────
// Returns a boolean[] (true = grounded/keep) aligned to `statements`.

const STMT_QA_SYSTEM = `You fact-check statements in an AI threat intelligence briefing against the evidence they were derived from.

For each statement return a verdict:
- "ok": grounded — every specific claim is supported by or directly inferable from the evidence, and it does not assert confirmed/operational/in-the-wild activity beyond what the evidence shows.
- "reject": ungrounded — invents specifics, overreaches the evidence maturity, or contradicts the evidence.

Return ONLY JSON: {"verdicts":[{"index":0,"verdict":"ok"|"reject","reason":"..."|null}]}`;

// Assessment QA — calibrated for a ONE-SENTENCE category posture (a generalization),
// not a factual statement. An assessment is SUPPOSED to be broad; we only reject
// maturity-overreach or a posture the validated insights don't support.
const ASSESS_QA_SYSTEM = `You verify a one-sentence category ASSESSMENT (the overall threat posture for a category this period).

An assessment is a GENERALIZATION that rolls up the category's validated insights. Do NOT reject it for being broad, high-level, or for not naming specific sources — that is its job.

Return verdict "ok" unless one of these is true:
- "overreach": it claims confirmed / operational / in-the-wild / at-scale activity when the stated evidence maturity is research- or vulnerability-only.
- "unsupported": it asserts a posture or direction the validated insights below do not support (e.g. claims escalation the insights never indicate).

Return ONLY JSON: {"verdict":"ok"|"overreach"|"unsupported","reason":"..."|null}`;

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

const SIGNAL_SYSTEM = `You are an AI threat intelligence analyst writing the "Emerging Signals" watchlist — themes that were faint last period and are now gaining evidence.

You are given EVERY signal by index, each with its source summaries this period. Return one object for EVERY index — never skip a signal. For each:
- "analysis": 1-2 sentences (25-45 words) on WHAT is driving the uptick and WHY it matters for defenders — the shift in the threat, not a paper summary.
- "watch": an array of 2-3 short, concrete monitoring points — specific things a defender should watch for that would confirm (or kill) this as a real trend. Each is a terse phrase (≤14 words), not a sentence, and they must be distinct and actionable.
  GOOD watch point: "RAG backend credentials abused in a named real-world incident"
  GOOD watch point: "exploit kits adding a retrieval-index poisoning module"
  GOOD watch point: "the CVE moving from disclosure to observed exploitation"
  BAD watch point:  "watch for more activity" (vague, not actionable)

Ground everything in the provided summaries. Do not claim confirmed/operational/in-the-wild activity unless the summaries show it. No paper-name-dropping.

Return ONLY JSON: {"signals":[{"index":0,"analysis":"...","watch":["...","..."]}]}`;

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

const ASSESS_CHANGE_SYSTEM = `You compare AI-threat category ASSESSMENTS between two consecutive periods and report ONLY material changes.

A material change = the strategic posture moved (e.g. research-only → affecting production; emerging → established; contained → bypassable). Pure rewording is NOT material — omit it.

Write for SKIMMABILITY. For each material change return:
- "category": the category key
- "from": the OLD posture as a terse 2-5 word label (e.g. "research-stage")
- "to": the NEW posture as a terse 2-5 word label (e.g. "production-affecting")
- "reason": one tight clause (max 14 words) citing the evidence delta that drove it
Do NOT restate the full assessment sentences. Keep every field short.

Return ONLY JSON: {"changes":[{"category":"<key>","from":"...","to":"...","reason":"..."}]}  (empty array if none material).`;

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

const ATTRIBUTION_SYSTEM = `You are an AI threat intelligence analyst attributing SOURCES to strategic insights.

You are given (1) a numbered list of INSIGHTS for one threat category, and (2) a numbered list of SOURCES (real articles, papers, CVEs, incident reports) available for that category and period.

For EACH insight, identify the 2-5 SOURCES that most directly and critically support it — the specific findings, incidents, or disclosures a reader must see to trust that insight. Choose only sources whose content genuinely underpins the insight. Do NOT pad to a fixed count; if only two sources truly matter, return two.

Rules:
- Use ONLY source numbers from the provided list. Never invent a source number.
- Order each insight's sources most-critical first.
- A source may support more than one insight.
- Prefer sources that establish the concrete evidence (an incident, an exploit, a measured result) over generic context.

Return ONLY JSON: {"attributions":[{"insight_index":0,"source_numbers":[3,7,12]}]}`;

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

  // Candidate pool: sources with real summaries, richest evidence + most recent
  // first, capped to keep the prompt bounded.
  const ranked = [...catSources]
    .filter(s => s.url && summaryText(s).length > 20)
    .sort((a, b) =>
      (SRC_TYPE_RANK[b.source_type] || 0) - (SRC_TYPE_RANK[a.source_type] || 0) ||
      (b.date_published || "").localeCompare(a.date_published || ""))
    .slice(0, 40);
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

  return insights.map((p, i) => {
    const nums = (byIndex.get(i) || []).filter(n => Number.isInteger(n) && n >= 1 && n <= ranked.length);
    const seen = new Set();
    const srcs = [];
    for (const n of nums.slice(0, 5)) {
      const s = ranked[n - 1];
      if (!s || seen.has(s.url)) continue;
      seen.add(s.url);
      srcs.push({
        title:       titleOf(s.title),
        url:         s.url,
        publisher:   s.publisher || null,
        date:        s.date_published?.slice(0, 10) || null,
        source_type: s.source_type || null,
      });
    }
    return { ...p, sources: srcs };
  });
}

// ── Per-category generation ────────────────────────────────────────────────────

async function generateCategory(cat, windowLabel, findings, maturitySrcs) {
  const maturity   = computeEvidenceMaturity(maturitySrcs);
  const confidence = deriveConfidence(maturity);
  const totalCount = maturitySrcs.length; // canonical = all validated sources (matches the card)

  // Stage A: findings → themes. maxTokens scales with input — 40 evidence facts
  // produce a longer themes payload than the old 24 summaries; too low truncates
  // the JSON mid-array.
  const themesOut = await callAnthropic({
    system: THEMES_SYSTEM, task: "dashboard_themes",
    user: buildThemesPrompt(cat.label, windowLabel, findings),
    maxTokens: 3000,
  });
  const themes = Array.isArray(themesOut.themes) ? themesOut.themes : [];
  if (!themes.length) throw new Error("no themes extracted");

  // Stage B: themes → structured insights
  const out = await callAnthropic({
    system: INSIGHTS_SYSTEM, task: "dashboard_insights",
    user: buildInsightsPrompt(cat.label, windowLabel, themes, maturity, confidence),
    maxTokens: 1600,
  });
  let insights = Array.isArray(out.insights) ? out.insights : [];
  insights = insights
    .filter(p => p && typeof p.insight === "string" && p.insight.trim().length > 15)
    .map(p => ({
      insight:           p.insight.trim(),
      evidence:          (p.evidence || "").trim(),
      broken_assumption: (p.broken_assumption || "").trim(),
      implication:       (p.implication || "").trim(),
      watch_next:        (p.watch_next || "").trim(),
      confidence:        confidence.level,                 // deterministic, cannot be overstated
      confidence_reason: (p.confidence_reason || confidence.reason).trim(),
    }));
  if (totalCount === 1) insights = insights.slice(0, 1);
  if (!insights.length) throw new Error("no insights produced");

  const beforeQa = insights.length;
  const insightQa = {};
  insights = await qaInsights(insights, maturity, cat.label, insightQa);
  if (!insights.length) throw new Error(`all ${beforeQa} insights removed by QA`);

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
    const { findings, fromEvidence, fromSummary, evidenceSources } =
      composeCategoryFindings(catRows, evidenceByCat[cat.key], 40);

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

    console.log(`  ${cat.label.padEnd(28)} ${totalCount} sources · ${findings.length} findings (${fromEvidence} facts/${evidenceSources} src + ${fromSummary} summaries) · ${maturityShortLine(maturity)} · conf=${confidence.level}`);
    if (DRY_RUN) { skipped++; continue; }

    let result;
    try {
      result = await generateCategory(cat, period.label, findings, mSrcs);
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
