/**
 * L6.5 — Three-Tier Outlook Generation
 *
 * Produces a structured 6-month outlook per category plus one overall outlook.
 * Each outlook has three tiers:
 *   likely              — ≥70% confidence, specific and falsifiable, ≤35 words
 *   plausible_uncertain — credible if an escalation signal appears; different from likely
 *   watchlist           — speculative, monitoring only, concrete watch signals
 *
 * Every outlook must include what_would_invalidate (falsifiability gate ≥30 chars).
 *
 * QA gates:
 *   Deterministic: forecast ≤35 words, escalation_trigger ≥20 chars, watch_signals ≥1,
 *                  what_would_invalidate ≥30 chars, hedge-verb detection + retry
 *   LLM second-model: category-specificity self-check embedded in prompt
 */

import { randomUUID }  from "crypto";
import { routedLLM }   from "../llm/llmRouter.js";
import { callLLM }     from "../llm/callLLM.js";

// Hedge-verb pattern: forecasts using ONLY these verbs with no specific anchor
// (actor/technique/number) are likely tautologies.
const HEDGE_VERB_ONLY_RE = /^(ai |adversaries |attackers |threat actors |attacks |exploits? )?(will |are likely to |expected to |continue to |continue |evolve |grow |increase |develop |expand |remain |become more )([a-z ]{3,40})\.?$/i;

// ── System prompt ─────────────────────────────────────────────────────────────

const OUTLOOK_SYSTEM = `You are writing a 6-MONTH THREAT OUTLOOK for a CISO briefing.

The outlook has THREE TIERS. Each tier must be derived from the evidence — not generic truisms.

═══ TIER 1 — LIKELY (≥70% confidence within 6 months) ═══
  - MUST name at least ONE of: specific technique, named actor type, target system/sector, measurable threshold
  - ≤35 words — punchy and specific, not a paragraph
  - Derived from: evidence_maturity ≥ adversary_adoption OR ≥2 strong evidence items at observed_exploitation
  BAD:  "AI-enabled attacks will continue to grow and become more sophisticated."  (hedge-verbs, no anchor)
  GOOD: "Nation-state actors will incorporate AI-assisted exploit generation into active campaigns targeting
         critical infrastructure, accelerating from proof-of-concept to operational use within 6 months."

═══ TIER 2 — PLAUSIBLE BUT UNCERTAIN ═══
  - Must describe a DIFFERENT scenario or trajectory from Tier 1 (not a restatement)
  - escalation_trigger REQUIRED (≥20 chars): the ONE specific observable event that confirms this tier
  BAD trigger:  "if more incidents occur"
  GOOD trigger: "when a named threat group publicly claims credit for an AI-assisted breach at a bank or insurer"

═══ TIER 3 — WATCHLIST ═══
  - Speculative only — requires multiple confirming signals to elevate
  - watch_signals[]: 1-3 SPECIFIC, observable signals (not generic "increase in activity")
  BAD signal:  "monitor for more AI attacks"
  GOOD signal: "RAG backend credentials appearing in criminal forums alongside LLM output samples"

═══ FALSIFIABILITY — REQUIRED ═══
what_would_invalidate: a specific, observable signal that proves the outlook wrong.
  BAD:  "if things don't escalate" (circular, unfalsifiable)
  GOOD: "if no threat actor group publicly claims AI-assisted exploitation within 6 months and no IR firm
         reports a case matching this technique pattern by September 2026"

═══ EVIDENCE CONSTRAINT ═══
  - Every tier's forecast must connect to the provided developments and insights
  - Do NOT add capabilities or actors not present in the provided evidence
  - If corpus is thin: Tier 1 may be medium confidence with explicit caveat

═══ CATEGORY-SPECIFICITY SELF-CHECK ═══
Before submitting: "Would this outlook make sense for a DIFFERENT threat category with no modification?"
If YES — it is too generic. Rewrite to name category-specific elements.
Set category_specific: true only if it would NOT apply to another category unchanged.

Return ONLY valid JSON.`;

const OUTLOOK_SCHEMA = {
  type: "object",
  required: ["likely", "plausible_uncertain", "watchlist", "what_would_invalidate", "category_specific"],
  properties: {
    likely: {
      type: "object",
      required: ["forecast", "evidence_basis", "timeline_marker", "confidence"],
      properties: {
        forecast:        { type: "string" },
        evidence_basis:  { type: "array", items: { type: "string" } },
        timeline_marker: { type: "string" },
        confidence:      { type: "string", enum: ["high", "medium"] },
      },
    },
    plausible_uncertain: {
      type: "object",
      required: ["forecast", "evidence_basis", "escalation_trigger", "confidence"],
      properties: {
        forecast:            { type: "string" },
        evidence_basis:      { type: "array", items: { type: "string" } },
        escalation_trigger:  { type: "string" },
        confidence:          { type: "string", enum: ["medium", "low"] },
      },
    },
    watchlist: {
      type: "object",
      required: ["forecast", "watch_signals"],
      properties: {
        forecast:      { type: "string" },
        watch_signals: { type: "array", items: { type: "string" } },
        confidence:    { type: "string" },
      },
    },
    what_would_invalidate: { type: "string" },
    category_specific:     { type: "boolean" },
  },
};

// ── Deterministic QA ──────────────────────────────────────────────────────────

function wordCount(s) {
  return (s || "").trim().split(/\s+/).filter(Boolean).length;
}

function validateOutlook(raw, category) {
  const issues = [];

  if (!raw?.likely?.forecast) {
    issues.push("missing likely.forecast");
    return { valid: false, issues };
  }

  if (wordCount(raw.likely.forecast) > 35)
    issues.push(`likely.forecast too long (${wordCount(raw.likely.forecast)} words; max 35)`);

  if (!(raw.likely.evidence_basis || []).length)
    issues.push("likely.evidence_basis empty");

  if ((raw.plausible_uncertain?.escalation_trigger || "").length < 20)
    issues.push("plausible_uncertain.escalation_trigger too short (< 20 chars)");

  if (!(raw.watchlist?.watch_signals || []).length)
    issues.push("watchlist.watch_signals empty");

  if ((raw.what_would_invalidate || "").length < 30)
    issues.push("what_would_invalidate too short (< 30 chars)");

  // Hedge-verb test on Tier 1
  if (HEDGE_VERB_ONLY_RE.test((raw.likely.forecast || "").trim())) {
    issues.push("likely.forecast uses only hedge-verbs with no specific anchor — retry needed");
    return { valid: false, issues, retryHint: true };
  }

  return { valid: issues.length === 0, issues };
}

// ── Per-category generation ───────────────────────────────────────────────────

export async function generateOutlook(category, developments, insights, evidenceIndex, opts = {}) {
  const { skipLlm = false, legacyOutlookFallback = null } = opts;

  if (skipLlm) return legacyOutlookFallback ? buildLegacyFallback(category, legacyOutlookFallback) : null;

  const devBlock = (developments || []).filter(d => !d._insight_candidate).map(d =>
    `[${d.development_id}] [${d.evidence_maturity}/${d.confidence}] ${d.title}\n  ${d.what_changed.slice(0, 150)}`
  ).join("\n");

  const insBlock = (insights || []).map(ins =>
    `[${ins.insight_id}] [${ins.confidence}] ${ins.insight.slice(0, 120)}\n  broken_assumption: ${ins.broken_assumption.slice(0, 80)}`
  ).join("\n");

  const userPrompt = `Generate a 6-month outlook for: ${category.replace(/_/g, " ").toUpperCase()}

DEVELOPMENTS (what changed):
${devBlock || "(none)"}

INSIGHTS (what it means):
${insBlock || "(none)"}

Produce a three-tier outlook grounded in this evidence. Be specific — name techniques, actors, or measurable thresholds.
Tier 1 (likely): ≤35 words, specific, contains at least one named anchor.
Tier 2 (plausible): different scenario from Tier 1; escalation_trigger ≥20 chars.
Tier 3 (watchlist): speculative; watch_signals must be specific observables.
what_would_invalidate: specific falsification condition ≥30 chars.
category_specific: set true only if this outlook is unique to ${category.replace(/_/g, " ")}.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let raw;
      try {
        const { result } = await routedLLM(
          attempt === 0 ? OUTLOOK_SYSTEM : OUTLOOK_SYSTEM + "\n\nIMPORTANT: Your Tier 1 forecast MUST name a specific technique, actor type, target sector, or measurable threshold. Generic forecasts using only 'will continue' or 'will grow' are rejected.",
          userPrompt, {
            task: "outlook_generation", requires_json: true, schema: OUTLOOK_SCHEMA,
            logLabel: `outlook-${category}`,
          }
        );
        raw = typeof result === "string" ? JSON.parse(result) : result;
      } catch {
        const text = await callLLM(OUTLOOK_SYSTEM, userPrompt, { schema: OUTLOOK_SCHEMA, json: true });
        raw = typeof text === "string" ? JSON.parse(text) : text;
      }

      const { valid, issues, retryHint } = validateOutlook(raw, category);
      if (!valid && retryHint && attempt === 0) {
        process.stdout.write(`  [L6.5] ${category}: hedge-verb detected in Tier 1 — retrying\n`);
        continue;
      }
      if (!valid && attempt === 0 && retryHint) continue;

      if (!valid) {
        process.stdout.write(`  [L6.5] ${category}: outlook QA issues (${issues.join("; ").slice(0, 80)}) — using fallback\n`);
        if (legacyOutlookFallback) return buildLegacyFallback(category, legacyOutlookFallback);
        return null;
      }

      if (!raw.category_specific) {
        process.stdout.write(`  [L6.5] ${category}: outlook flagged as NOT category-specific — kept but noted\n`);
      }

      // Resolve evidence IDs
      const resolveIds = (ids) => (ids || []).filter(id => id in evidenceIndex);

      process.stdout.write(`  [L6.5] ${category}: outlook generated (likely: ${wordCount(raw.likely.forecast)} words, category_specific: ${raw.category_specific})\n`);

      return {
        outlook_id:    randomUUID(),
        scope:         "category",
        category,
        likely: {
          forecast:        raw.likely.forecast.trim(),
          evidence_basis:  resolveIds(raw.likely.evidence_basis),
          timeline_marker: raw.likely.timeline_marker || "within 6 months",
          confidence:      raw.likely.confidence || "medium",
        },
        plausible_uncertain: {
          forecast:           (raw.plausible_uncertain?.forecast || "").trim(),
          evidence_basis:     resolveIds(raw.plausible_uncertain?.evidence_basis),
          escalation_trigger: (raw.plausible_uncertain?.escalation_trigger || "").trim(),
          confidence:         raw.plausible_uncertain?.confidence || "low",
        },
        watchlist: {
          forecast:      (raw.watchlist?.forecast || "").trim(),
          watch_signals: (raw.watchlist?.watch_signals || []).filter(Boolean),
          confidence:    "low",
        },
        what_would_invalidate: raw.what_would_invalidate.trim(),
        category_specific:     raw.category_specific ?? false,
      };
    } catch (err) {
      if (attempt === 1) {
        process.stdout.write(`  [L6.5] ${category}: outlook generation failed (${err.message.slice(0, 60)})\n`);
        if (legacyOutlookFallback) return buildLegacyFallback(category, legacyOutlookFallback);
        return null;
      }
    }
  }
  return null;
}

// Legacy fallback: wrap the existing synthesis outlook_assessment in the new schema
function buildLegacyFallback(category, legacy) {
  return {
    outlook_id: randomUUID(),
    scope: "category",
    category,
    likely: {
      forecast:        (legacy.likely_next_movement || legacy.observed_basis || "").slice(0, 140).trim(),
      evidence_basis:  [],
      timeline_marker: "within 6 months",
      confidence:      legacy.confidence || "low",
    },
    plausible_uncertain: {
      forecast:           legacy.escalation_trigger || "",
      evidence_basis:     [],
      escalation_trigger: legacy.escalation_trigger || "no escalation trigger provided",
      confidence:         "low",
    },
    watchlist: { forecast: "", watch_signals: [], confidence: "low" },
    what_would_invalidate: legacy.what_would_invalidate || "no falsification condition provided",
    category_specific: false,
    _legacy: true,
  };
}

// ── Overall outlook ───────────────────────────────────────────────────────────

export async function generateOverallOutlook(allOutlooks, allInsights, opts = {}) {
  const { skipLlm = false } = opts;
  const validOutlooks = Object.values(allOutlooks).filter(Boolean);
  if (!validOutlooks.length) return null;

  if (skipLlm) return null;

  // Synthesise cross-category outlook from the top tier-1 forecasts
  const tier1s = validOutlooks.map(o => `[${o.category}] ${o.likely.forecast}`).join("\n");
  const overallInsights = (allInsights?.overall || []).map(ins => ins.insight.slice(0, 100)).join("\n");

  const userPrompt = `Generate an OVERALL 6-month outlook synthesising across all four AI threat categories.

CATEGORY TIER-1 FORECASTS:
${tier1s}

OVERALL STRATEGIC INSIGHTS:
${overallInsights || "(none)"}

Produce a cross-category outlook. The likely.forecast should name a cross-category trend (≤35 words).
escalation_trigger: a cross-category signal that confirms the plausible scenario.
watch_signals: 2-3 cross-category monitoring signals.
what_would_invalidate: cross-category falsification condition.
category_specific: false (this is cross-category by definition).`;

  try {
    const { result } = await routedLLM(OUTLOOK_SYSTEM, userPrompt, {
      task: "outlook_generation", requires_json: true, schema: OUTLOOK_SCHEMA,
      logLabel: "overall-outlook",
    });
    const raw = typeof result === "string" ? JSON.parse(result) : result;
    const { valid } = validateOutlook(raw, "overall");
    if (!valid) return null;
    return {
      outlook_id: randomUUID(),
      scope: "overall",
      category: null,
      ...raw,
      likely:    { ...raw.likely,    forecast: (raw.likely.forecast || "").trim() },
      watchlist: { ...raw.watchlist, confidence: "low" },
    };
  } catch {
    return null;
  }
}

// ── Batch wrapper ─────────────────────────────────────────────────────────────

export async function generateAllOutlooks(allDevelopments, allInsights, categoryAnalyses, evidenceItems, opts = {}) {
  const evidenceIndex = Object.fromEntries((evidenceItems || []).map(ei => [ei.evidence_id, ei]));
  const results = {};

  for (const [category, developments] of Object.entries(allDevelopments.byCategory || {})) {
    const insights = allInsights?.byCategory?.[category] || [];
    const legacyCA = categoryAnalyses.find(ca => ca.category === category);
    const legacyFallback = legacyCA?.outlook_assessment || null;
    results[category] = await generateOutlook(category, developments, insights, evidenceIndex, {
      ...opts,
      legacyOutlookFallback: legacyFallback,
    });
  }

  const overall = await generateOverallOutlook(results, allInsights, opts);
  const generated = Object.values(results).filter(Boolean).length;
  process.stdout.write(`  [L6.5] ${generated}/${Object.keys(results).length} category outlooks generated${overall ? " + overall" : ""}\n`);
  return { byCategory: results, overall };
}
