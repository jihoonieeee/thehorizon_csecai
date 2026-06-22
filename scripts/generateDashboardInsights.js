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

const SRC_SELECT = "main_category,short_summary,analyst_brief,tags,source_type,title";

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
  const byCategory = {};         // cat → [{summary, source_type}]
  const tagCounts  = {};         // tagId → count
  const catCounts  = {};         // cat → count
  const catMaturitySrcs = {};    // cat → [sources] for maturity
  for (const c of CATEGORIES) { byCategory[c.key] = []; catCounts[c.key] = 0; catMaturitySrcs[c.key] = []; }

  for (const s of rows) {
    const cat = s.main_category;
    if (!byCategory[cat]) continue;
    catCounts[cat]++;
    catMaturitySrcs[cat].push(s);
    const text = (s.analyst_brief || s.short_summary || "").trim();
    if (text.length > 20) byCategory[cat].push(text);
    for (const tag of (s.tags || [])) {
      if (getTag(tag)) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  return { byCategory, tagCounts, catCounts, catMaturitySrcs };
}

// ── Historical comparison (deterministic for changes/signals) ──────────────────

function computeWhatsChanged(currTags, prevTags) {
  const ids = new Set([...Object.keys(currTags), ...Object.keys(prevTags)]);
  const growing = [], declining = [], stable = [], appeared = [];
  for (const id of ids) {
    const curr = currTags[id] || 0;
    const prev = prevTags[id] || 0;
    const delta = curr - prev;
    const label = tagLabel(id);
    if (prev === 0 && curr >= 2) {
      appeared.push({ label, delta, indicator: "new", note: `${curr} new source${curr !== 1 ? "s" : ""}` });
    } else if (delta >= 2 && curr >= prev * 1.3) {
      growing.push({ label, delta, indicator: "+", note: `+${delta} vs last period` });
    } else if (delta <= -2) {
      declining.push({ label, delta, indicator: "-", note: `${delta} vs last period` });
    } else if (curr >= 3 && Math.abs(delta) <= 1) {
      stable.push({ label, delta, indicator: "stable", note: `~${curr} sources` });
    }
  }
  const top = (arr, by) => arr.sort((a, b) => by(b) - by(a)).slice(0, 5);
  return {
    growing:   top(growing,   x => x.delta),
    declining: top(declining, x => -x.delta),
    stable:    top(stable,    x => Math.abs(x.delta) === 0 ? 1 : 0),
    new:       top(appeared,  x => x.delta),
  };
}

function computeEmergingSignals(currTags, prevTags) {
  const signals = [];
  for (const id of Object.keys(currTags)) {
    const curr = currTags[id] || 0;
    const prev = prevTags[id] || 0;
    // Weak-but-now-gaining: was a faint signal (1-3), now meaningfully larger.
    if (prev >= 1 && prev <= 3 && (curr - prev) >= 3) {
      signals.push({
        signal:   tagLabel(id),
        previous: "Weak signal",
        current:  "Emerging trend",
        reason:   `+${curr - prev} new sources this period (${prev} → ${curr})`,
        delta:    curr - prev,
      });
    }
  }
  return signals.sort((a, b) => b.delta - a.delta).slice(0, 5);
}

const ASSESS_CHANGE_SYSTEM = `You compare AI-threat category ASSESSMENTS between two consecutive periods and report ONLY material changes.

A material change = the strategic posture moved (e.g. research-only → affecting production; emerging → established; contained → bypassable). Pure rewording is NOT material — omit it.

For each material change return: category, previous (prior assessment), current (new assessment), reason (what evidence drove it, referencing the maturity deltas given).

Return ONLY JSON: {"changes":[{"category":"<key>","previous":"...","current":"...","reason":"..."}]}  (empty array if none material).`;

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
  try {
    const out = await callAnthropic({
      system: ASSESS_CHANGE_SYSTEM,
      user: `Compare the periods. Report only material changes.\n\n${user}`,
      maxTokens: 800,
    });
    return Array.isArray(out.changes) ? out.changes.slice(0, 5) : [];
  } catch (err) {
    console.log(`  [assessment-changes] failed: ${err.message.slice(0, 50)}`);
    return [];
  }
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

    const whatsChanged    = computeWhatsChanged(curr.tagCounts, prev.tagCounts);
    const emergingSignals = computeEmergingSignals(curr.tagCounts, prev.tagCounts);

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
      whats_changed:      whatsChanged,
      assessment_changes: assessmentChanges,
      emerging_signals:   emergingSignals,
    };

    const { error: metaErr } = await supabase.from("dashboard_insights").upsert({
      win: WINDOW, window_key: period.key, window_label: period.label,
      category: META_CATEGORY, points: meta, source_count: currRows.length,
    }, { onConflict: "window_key,category" });
    if (metaErr) console.log(`  meta DB FAIL: ${metaErr.message.slice(0, 60)}`);

    console.log(`  Comparison: ${whatsChanged.growing.length} growing, ${whatsChanged.new.length} new, ${whatsChanged.declining.length} declining; ${emergingSignals.length} emerging; ${assessmentChanges.length} assessment changes`);
  }

  console.log(`\n  Done: ${generated} generated, ${skipped} skipped`);
}

import { flushCostBuffer } from "../lib/llm/usagePersistence.js";
main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error("\nFATAL:", err.message); process.exit(1); });
