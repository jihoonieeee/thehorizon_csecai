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

if (!["week", "month", "quarter"].includes(WINDOW)) {
  console.error("--window must be week | month | quarter"); process.exit(1);
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

async function callAnthropic({ system, user, model, maxTokens = 1200 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text?.trim() || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON in response: ${text.slice(0, 160)}`);
  return JSON.parse(match[0]);
}

// ── Stage A: findings → themes ─────────────────────────────────────────────────

const THEMES_SYSTEM = `You are an AI threat intelligence analyst. You are given source summaries for ONE threat category over ONE time period.

Do TWO things:
1. Extract atomic FINDINGS — single, concrete things each source establishes (a capability shown, a control bypassed, a vulnerability class, a measured result). Strip the paper/CVE name; keep the substance.
2. Cluster the findings into 2-5 THEMES — recurring patterns that span multiple findings. A theme is a pattern, not a single paper.

Do NOT write conclusions or implications yet. Just findings and the themes they form.

Return ONLY valid JSON:
{"themes": [{"theme": "short theme name", "findings": ["finding", "finding", ...]}]}`;

function buildThemesPrompt(catLabel, windowLabel, summaries) {
  const lines = summaries.slice(0, 24).map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `Category: ${catLabel}
Period: ${windowLabel}
Sources (${summaries.length} total${summaries.length > 24 ? ", showing 24" : ""}):

${lines}

Extract findings and cluster into themes.`;
}

// ── Stage B: themes → structured insights ──────────────────────────────────────

const INSIGHTS_SYSTEM = `You are a principal AI threat intelligence analyst writing a horizon-scan briefing for security leadership. You synthesise THEMES (not individual papers) into strategic insights.

A real INSIGHT answers, in order:
  WHAT CHANGED → WHAT ASSUMPTION BROKE → WHY IT MATTERS → WHAT TO WATCH NEXT.
It teaches something about the threat landscape that survives the removal of every source name. If deleting the source/paper/CVE name leaves only a summary, it is NOT an insight — reject it.

THE TEST (apply to every insight you write):
- Remove all source names, paper titles, CVE numbers. Does it still teach a defender something about how the landscape is shifting? If no, rewrite or drop it.

GOOD (strategic, names a control + failure mode + implication):
- "Closed/API-only deployment no longer provides the defensive advantage it once did, because effective jailbreaks can now be automated without any model-internal access."
- "Command denylists for terminal-capable agents are structurally defeatable, so blocklist sandboxing can no longer be a primary containment control."

BAD (paper/observation summary — REJECT):
- "Adversarial suffix attacks require no model internals." (observation, not insight)
- "A new benchmark evaluated jailbreak robustness across models." (paper summary)
- "DiffusionHijack exploits PRNG dependencies." (single-source description)

For EACH insight, produce these fields:
- insight: one-sentence strategic judgment (what changed + why it matters), 18-30 words, active voice.
- evidence: what in the themes supports it (kinds of evidence, e.g. "multiple research demonstrations across model families"), NOT a paper citation.
- broken_assumption: the specific defensive assumption that no longer holds.
- implication: what this means operationally for defenders (a posture/control change).
- watch_next: what evidence would strengthen, weaken, or change this assessment.
- confidence_reason: one clause tying confidence to evidence maturity (e.g. "research demonstrations only, no in-the-wild use").

CALIBRATION (critical): You are told the EVIDENCE MATURITY for this category. If the evidence is research/vulnerability-only with no observed exploitation, you MUST NOT claim activity is "confirmed", "operational", "at scale", or "in the wild". Frame as demonstrated capability and shifting assumptions, not active campaigns.

Also produce a one-sentence "assessment": the current overall posture for this category (used for period-over-period comparison), e.g. "Prompt injection is escalating from research into production agent systems."

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

REJECT (verdict "summary") if the insight is merely a description of a paper, CVE, benchmark, or single source — i.e. removing source names would leave only an observation, not a landscape judgment.
REJECT (verdict "overreach") if it claims confirmed/operational/in-the-wild/at-scale activity when the stated evidence maturity is research/vulnerability-only.
KEEP (verdict "ok") if it states what changed + a broken assumption or operational implication, and stays within the evidence maturity.

Return ONLY JSON: {"verdicts":[{"index":0,"verdict":"ok"|"summary"|"overreach","reason":"..."|null}]}`;

async function qaInsights(insights, maturity, catLabel) {
  if (!process.env.ANTHROPIC_API_KEY) return insights;
  const user = `Category: ${catLabel}
Evidence maturity: ${maturityShortLine(maturity)} (total ${maturity.total})

INSIGHTS:
${insights.map((p, i) => `[${i}] ${p.insight}  (implication: ${p.implication})`).join("\n")}

Audit each. Return a verdict for every index.`;

  let verdicts;
  try {
    const out = await callAnthropic({
      system: QA_SYSTEM, user,
      model: process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
      maxTokens: 700,
    });
    verdicts = out.verdicts;
    if (!Array.isArray(verdicts)) throw new Error("no verdicts");
  } catch (err) {
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

const SRC_SELECT = "main_category,short_summary,analyst_brief,intelligence,tags,source_type,title,url,publisher,date_published";

// Pipeline-enriched sources (via sourceEnrichmentStore) leave the top-level
// short_summary/analyst_brief columns empty and stash the prose under
// intelligence.source_summary. Fall back to it so those sources still feed the
// insight pipeline instead of looking unenriched.
function summaryText(s) {
  return (s.analyst_brief || s.short_summary || s.intelligence?.source_summary || "").trim();
}

async function loadWindowSources(from, to) {
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

// ── Generic second-model QA for any generated statements ───────────────────────
// Returns a boolean[] (true = grounded/keep) aligned to `statements`.

const STMT_QA_SYSTEM = `You fact-check statements in an AI threat intelligence briefing against the evidence they were derived from.

For each statement return a verdict:
- "ok": grounded — every specific claim is supported by or directly inferable from the evidence, and it does not assert confirmed/operational/in-the-wild activity beyond what the evidence shows.
- "reject": ungrounded — invents specifics, overreaches the evidence maturity, or contradicts the evidence.

Return ONLY JSON: {"verdicts":[{"index":0,"verdict":"ok"|"reject","reason":"..."|null}]}`;

async function qaStatements(statements, evidenceText, kind = "statement") {
  if (!statements.length || !process.env.ANTHROPIC_API_KEY) return statements.map(() => true);
  const user = `Type: ${kind}

STATEMENTS:
${statements.map((s, i) => `[${i}] ${s}`).join("\n")}

EVIDENCE they must be grounded in:
${evidenceText}

Verdict for every index.`;
  try {
    const out = await callAnthropic({
      system: STMT_QA_SYSTEM, user,
      model: process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
      maxTokens: 700,
    });
    const verdicts = out.verdicts || [];
    return statements.map((_, i) => {
      const v = verdicts.find(v => v.index === i);
      const keep = !v || v.verdict === "ok";
      if (!keep) console.log(`  [QA:${kind}] REMOVED [${i}]: ${(v.reason || "").slice(0, 70)}`);
      return keep;
    });
  } catch (err) {
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

For each signal you are given its source summaries this period. Write a tight 2-part analysis:
- "analysis": 1-2 sentences on WHAT is driving the uptick and WHY it matters for defenders (the shift in the threat, not a paper summary). 25-45 words.
- "watch": one short clause on what would confirm or kill this as a real trend.

Ground everything in the provided summaries. Do not claim confirmed/operational/in-the-wild activity unless the summaries show it. No paper-name-dropping.

Return ONLY JSON: {"signals":[{"index":0,"analysis":"...","watch":"..."}]}`;

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

  // One LLM call for all signals' analysis, grounded in their summaries.
  const blocks = signals.map((sig, i) => {
    const sums = (currTagSources[sig.tag_id] || []).map(s => s.summary).filter(Boolean).slice(0, 6);
    return `[${i}] Signal: ${sig.signal} (${sig.prev} → ${sig.curr} sources)\n` +
      sums.map(s => `   - ${s.slice(0, 220)}`).join("\n");
  }).join("\n\n");

  let analyses = [];
  try {
    const out = await callAnthropic({
      system: SIGNAL_SYSTEM,
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
    sig.analysis = (a?.analysis || "").trim() || null;
    sig.watch    = (a?.watch || "").trim() || null;
  });

  // Second-model QA on the generated analyses.
  const withAnalysis = signals.filter(s => s.analysis);
  const verdicts = await qaStatements(
    withAnalysis.map(s => s.analysis),
    signals.map(s => `${s.signal}: ${(currTagSources[s.tag_id] || []).map(x => x.summary).filter(Boolean).slice(0, 4).join(" | ").slice(0, 400)}`).join("\n"),
    "emerging-signal",
  );
  withAnalysis.forEach((s, i) => { if (!verdicts[i]) { s.analysis = null; s.watch = null; } });

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
      system: ASSESS_CHANGE_SYSTEM,
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

// ── Per-category generation ────────────────────────────────────────────────────

async function generateCategory(cat, windowLabel, summaries, maturitySrcs) {
  const maturity   = computeEvidenceMaturity(maturitySrcs);
  const confidence = deriveConfidence(maturity);
  const totalCount = maturitySrcs.length; // canonical = all validated sources (matches the card)

  // Stage A: findings → themes
  const themesOut = await callAnthropic({
    system: THEMES_SYSTEM,
    user: buildThemesPrompt(cat.label, windowLabel, summaries),
    maxTokens: 1400,
  });
  const themes = Array.isArray(themesOut.themes) ? themesOut.themes : [];
  if (!themes.length) throw new Error("no themes extracted");

  // Stage B: themes → structured insights
  const out = await callAnthropic({
    system: INSIGHTS_SYSTEM,
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
  insights = await qaInsights(insights, maturity, cat.label);
  if (!insights.length) throw new Error(`all ${beforeQa} insights removed by QA`);

  return {
    insights,
    assessment:        (out.assessment || "").trim() || null,
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

  let generated = 0, skipped = 0;
  const currAssess = {};
  const currMaturity = {};

  for (const cat of CATEGORIES) {
    const summaries  = curr.byCategory[cat.key];
    const mSrcs      = curr.catMaturitySrcs[cat.key];
    const maturity   = computeEvidenceMaturity(mSrcs);
    const confidence = deriveConfidence(maturity);
    currMaturity[cat.key] = maturity;

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
    if (summaries.length === 0) {
      console.log(`  ${cat.label.padEnd(28)} SKIP (${totalCount} sources but none enriched with summaries)`);
      skipped++; continue;
    }

    console.log(`  ${cat.label.padEnd(28)} ${totalCount} sources · ${maturityShortLine(maturity)} · conf=${confidence.level}`);
    if (DRY_RUN) { skipped++; continue; }

    let result;
    try {
      result = await generateCategory(cat, period.label, summaries, mSrcs);
    } catch (err) {
      console.log(`     FAIL: ${err.message.slice(0, 70)}`);
      continue;
    }

    currAssess[cat.key] = result.assessment;
    console.log(`     → ${result.insights.length} insights${result.removed ? `, ${result.removed} removed by QA` : ""} · "${(result.assessment || "").slice(0, 70)}"`);
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
main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error("\nFATAL:", err.message); process.exit(1); });
