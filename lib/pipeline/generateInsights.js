/**
 * L6.2 — Insight Generation
 *
 * "What does it mean?" — produces 3 ranked Insight objects per category,
 * plus 3 overall insights across all categories.
 *
 * An Insight synthesises across ≥1 development and answers what the change means
 * for defenders. It MUST be pattern-level (applies to a class of attacks, not one event)
 * and MUST name the specific defender assumption that breaks.
 *
 * QA gates:
 *   Deterministic: scope="pattern_level" hard block, broken_assumption ≥30 chars,
 *                  causal_mechanism ≥40 chars, development_ids ≥1, evidence_ids ≥1
 *   LLM second-model (cross-provider — Gemini checks Anthropic):
 *                  "Is this pattern-level or incident-level?" + "Is it a restatement?"
 */

import { randomUUID }          from "crypto";
import { routedLLM }           from "../llm/llmRouter.js";
import { callLLM }             from "../llm/callLLM.js";
import { rateInsightQuality }  from "./analysis/analyticalQualityQa.js";

const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);
const CVE_RE = /\bCVE-\d{4}-\d+\b/i;

// ── System prompt ─────────────────────────────────────────────────────────────

const INSIGHT_SYSTEM = `You are a principal threat intelligence analyst writing INSIGHT entries for a CISO briefing.

An INSIGHT answers: "WHAT DOES THIS CHANGE MEAN for defenders?"

═══ SYNTHESIS, NOT AGGREGATION OR RESTATEMENT ═══
An insight synthesises across ≥1 development. It is NOT:
  ✗ A restatement of a development in different words
  ✗ A list of what happened grouped together
  ✗ An incident-level observation (applies to only one event)

TEST (apply before writing):
  "Does this insight teach a defender something about HOW THE THREAT LANDSCAPE IS SHIFTING,
  independent of any specific incident? Does it name a BROKEN ASSUMPTION?"
  If NO → it is a restatement or aggregation. Rewrite.

AGGREGATION (REJECT):
  ✗ "Model hubs, vendor libraries, and agent stores are all dangerous attack surfaces."
     → Groups observations. Teaches nothing about the shift.
  ✗ "The CVE-2025-1234 disclosure means affected products need patching."
     → Incident-level. Applies only to one event.

SYNTHESIS (WRITE THESE):
  ✓ "AI supply-chain attacks are converging across models, libraries, and registries — organizations
     can no longer govern only software dependencies; AI artifacts must be treated as executable code."
     → Names the shift, the broken assumption, the implication.
  ✓ "Agentic permission models were designed for human-in-the-loop; when applied to autonomous agents,
     they expose an entire class of privilege-escalation vectors that per-action approval cannot address."
     → Pattern-level. Names what broke and why.

═══ SCOPE — HARD REQUIREMENT ═══
scope MUST be "pattern_level":
  pattern_level  — insight applies to a CLASS of attacks or a category of defenders
  incident_level — insight applies ONLY to one specific event (BLOCKED from main output)

═══ REQUIRED FIELDS ═══
broken_assumption (≥30 chars): the specific defender CONTROL or ASSUMPTION this invalidates.
  BAD:  "defenders need to adapt"
  GOOD: "signature-based phishing detection fails because AI-generated emails are unique per recipient"

causal_mechanism (≥40 chars): WHY this is happening now — the technical or economic driver.
  BAD:  "AI is making attacks easier"
  GOOD: "LLMs eliminate per-recipient effort cost, making industrialised spear-phishing economically viable"

═══ EVIDENCE LANGUAGE CALIBRATION ═══
Match language to evidence maturity — do NOT escalate:
  research_demonstration  → "researchers have shown", "lab-demonstrated", "capability exists"
  disclosed_vulnerability → "a vulnerability was disclosed", "CVE confirmed"
  observed_exploitation   → "exploited in active attacks", "observed in the wild"
  adversary_adoption      → "[named actor] has adopted"
  operational_campaign    → "sustained campaign"

═══ CONFIDENCE ═══
High   — ≥2 strong evidence items, high-trust sources, maturity ≥ observed_exploitation
Medium — 1-2 items, high-trust vendor or academic, maturity = disclosed_vulnerability
Low    — single source, research-only, proof-of-concept only

development_ids[]: IDs of the developments that feed this insight (from the input list).
evidence_ids[]: the single best evidence ID that grounds this insight.

Produce EXACTLY 3 insights. Rank 1 = highest strategic importance.
scope MUST be "pattern_level" for every insight. Return ONLY valid JSON.`;

const INSIGHT_SCHEMA = {
  type: "object",
  required: ["insights"],
  properties: {
    insights: {
      type: "array",
      items: {
        type: "object",
        required: ["insight", "broken_assumption", "causal_mechanism", "development_ids", "evidence_ids", "confidence", "scope", "rank_within_category"],
        properties: {
          insight:              { type: "string" },
          broken_assumption:    { type: "string" },
          causal_mechanism:     { type: "string" },
          development_ids:      { type: "array", items: { type: "string" } },
          evidence_ids:         { type: "array", items: { type: "string" } },
          confidence:           { type: "string" },
          scope:                { type: "string" },
          rank_within_category: { type: "number" },
        },
      },
    },
  },
};

// ── Cross-provider second-model QA ────────────────────────────────────────────
// Gemini checks Anthropic output to prevent correlated errors.

const INSIGHT_QA_SYSTEM = `You are reviewing INSIGHT entries for a cybersecurity briefing.

For each insight, determine:
  1. Is it "pattern_level" (applies to a CLASS of attacks / defenders) or "incident_level" (only one event)?
  2. Is it a "restatement" of a development (same information, different words) or genuine synthesis?

Return one verdict per insight:
  "ok"          — pattern-level and genuinely synthesizes across developments
  "incident"    — describes only one specific incident (scope problem)
  "restatement" — restates development(s) without adding interpretive value

Return ONLY JSON: { "verdicts": [{ "index": 0, "verdict": "ok"|"incident"|"restatement", "reason": "..." }] }`;

async function qaInsights(insights, category) {
  if (!insights.length) return insights;
  const userPrompt = `Category: ${category.replace(/_/g, " ").toUpperCase()}

${insights.map((ins, i) => `[${i}] insight: "${ins.insight}"\n  broken_assumption: "${ins.broken_assumption}"`).join("\n\n")}

Assess each. Return: { "verdicts": [{ "index", "verdict", "reason" }] }`;

  try {
    const { result } = await routedLLM(INSIGHT_QA_SYSTEM, userPrompt, {
      task: "insight_qa",  // Gemini-first for cross-provider check
      requires_json: true,
      logLabel: `insight-qa-${category}`,
    });
    const verdicts = (typeof result === "string" ? JSON.parse(result) : result)?.verdicts || [];
    let blocked = 0;
    const filtered = insights.filter((ins, i) => {
      const v = verdicts.find(v => v.index === i);
      if (v && v.verdict !== "ok") {
        process.stdout.write(`  [L6.2 QA] insight ${i} BLOCKED (${v.verdict}): ${(v.reason || "").slice(0, 70)}\n`);
        blocked++;
        return false;
      }
      return true;
    });
    if (blocked) process.stdout.write(`  [L6.2 QA] ${blocked} insights blocked for ${category}\n`);
    return filtered;
  } catch {
    return insights;  // QA failure is non-blocking
  }
}

// ── Deterministic validation ──────────────────────────────────────────────────

function validateInsights(raw, allDevelopmentIds, evidenceIndex) {
  const valid = [];
  for (const ins of raw) {
    // Hard gates
    if (ins.scope === "incident_level") continue;
    if ((ins.broken_assumption || "").length < 30) continue;
    if ((ins.causal_mechanism  || "").length < 40) continue;
    if (!(ins.development_ids || []).length) continue;
    if (!(ins.evidence_ids    || []).length) continue;
    if (!CONFIDENCE_VALUES.has(ins.confidence)) continue;

    // Resolve evidence IDs
    const resolvedEvidence = (ins.evidence_ids || []).filter(id => id in evidenceIndex);
    if (!resolvedEvidence.length) continue;

    // CVE test: if insight TEXT starts with a CVE, likely incident-level
    if (CVE_RE.test((ins.insight || "").slice(0, 40))) continue;

    // Resolve development IDs against known ones
    const resolvedDev = (ins.development_ids || []).filter(id => allDevelopmentIds.has(id));

    // Quality check
    const quality = rateInsightQuality({ ...ins, development_ids: resolvedDev.length ? resolvedDev : ins.development_ids });
    if (quality === "unsupported" || quality === "summary_only") continue;

    valid.push({
      insight_id:           randomUUID(),
      insight:              (ins.insight || "").trim(),
      broken_assumption:    (ins.broken_assumption || "").trim(),
      causal_mechanism:     (ins.causal_mechanism  || "").trim(),
      development_ids:      resolvedDev.length ? resolvedDev : (ins.development_ids || []),
      evidence_ids:         resolvedEvidence,
      confidence:           ins.confidence,
      scope:                "pattern_level",
      rank_within_category: ins.rank_within_category || valid.length + 1,
      _quality:             quality,
    });
  }
  return valid.slice(0, 3);
}

// ── Per-category generation ───────────────────────────────────────────────────

export async function generateInsights(category, developments, evidenceIndex, opts = {}) {
  const { skipLlm = false } = opts;
  if (skipLlm) return [];

  const nonCandidateDev = developments.filter(d => !d._insight_candidate);
  if (!nonCandidateDev.length) {
    process.stdout.write(`  [L6.2] ${category}: no developments to generate insights from\n`);
    return [];
  }

  const allDevelopmentIds = new Set(developments.map(d => d.development_id));

  const devBlock = nonCandidateDev.map((d, i) =>
    `[${d.development_id}] [rank ${d.rank_within_category}] [${d.evidence_maturity}/${d.confidence}]\n  title: ${d.title}\n  what_changed: ${d.what_changed}\n  evidence: ${d.evidence_ids.join(", ")}`
  ).join("\n\n");

  // Include insight candidates from L6.1 QA as additional context
  const candidateBlock = developments.filter(d => d._insight_candidate).length
    ? `\nADDITIONAL INTERPRETATION CANDIDATES (these were flagged as insight-level by L6.1 — they belong here):\n${developments.filter(d => d._insight_candidate).map(d => `  • ${d.what_changed}`).join("\n")}`
    : "";

  const userPrompt = `Generate 3 strategic insights for: ${category.replace(/_/g, " ").toUpperCase()}

DEVELOPMENTS (what changed this period — synthesise ACROSS these):
${devBlock}
${candidateBlock}

For each insight:
  - insight: ≥40 chars, answers "what does this mean for defenders?" at PATTERN LEVEL
  - broken_assumption: ≥30 chars, the specific control/assumption that no longer holds
  - causal_mechanism: ≥40 chars, WHY this is happening now (technical/economic driver)
  - development_ids: which development IDs feed this insight
  - evidence_ids: the best single grounding evidence ID
  - confidence: high/medium/low
  - scope: "pattern_level" always (incident_level insights will be blocked)
  - rank_within_category: 1-3 (1 = highest strategic importance)

Return: { "insights": [ ... ] }`;

  try {
    let raw;
    try {
      const { result } = await routedLLM(INSIGHT_SYSTEM, userPrompt, {
        task: "insight_generation", requires_json: true, schema: INSIGHT_SCHEMA,
        logLabel: `insights-${category}`,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(INSIGHT_SYSTEM, userPrompt, { schema: INSIGHT_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }

    let insights = validateInsights(raw?.insights || [], allDevelopmentIds, evidenceIndex);
    insights = insights.map(ins => ({ ...ins, category }));

    // Cross-provider QA (Gemini checks Anthropic output)
    insights = await qaInsights(insights, category);

    process.stdout.write(`  [L6.2] ${category}: ${insights.length} insights\n`);
    return insights;
  } catch (err) {
    process.stdout.write(`  [L6.2] ${category}: insight generation failed (${err.message.slice(0, 60)})\n`);
    return [];
  }
}

// ── Overall top-3 insights ────────────────────────────────────────────────────

const OVERALL_INSIGHT_SYSTEM = `You are selecting the top 3 OVERALL strategic insights for an executive briefing summary.

From the per-category insights provided, select 3 that together:
  1. Have the highest strategic importance across the full AI threat landscape
  2. Cover different aspects (avoid highly overlapping broken_assumptions)
  3. Are mutually distinct — each teaches something different

Return ONLY the insight_ids of your top 3 selections in ranked order.
Return ONLY valid JSON: { "selected_ids": ["ins-id-1", "ins-id-2", "ins-id-3"] }`;

export async function generateOverallInsights(allCategoryInsights, opts = {}) {
  const { skipLlm = false } = opts;
  const all = Object.values(allCategoryInsights).flat();
  if (all.length <= 3) return all.map((ins, i) => ({ ...ins, scope: "overall", rank: i + 1 }));

  if (skipLlm) {
    const CONF_RANK = { high: 3, medium: 2, low: 1 };
    return all.sort((a, b) => (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0))
      .slice(0, 3).map((ins, i) => ({ ...ins, scope: "overall", rank: i + 1 }));
  }

  const insList = all.map(ins =>
    `[${ins.insight_id}] [${ins.category}] [${ins.confidence}]\n  insight: ${ins.insight.slice(0, 120)}\n  broken_assumption: ${ins.broken_assumption.slice(0, 80)}`
  ).join("\n\n");

  const userPrompt = `Select the top 3 overall strategic insights from across all threat categories.

AVAILABLE INSIGHTS:
${insList}

Return: { "selected_ids": ["id1", "id2", "id3"] }`;

  try {
    const { result } = await routedLLM(OVERALL_INSIGHT_SYSTEM, userPrompt, {
      task: "insight_generation", requires_json: true, logLabel: "overall-insights",
    });
    const r = typeof result === "string" ? JSON.parse(result) : result;
    const selectedIds = new Set(r?.selected_ids || []);
    const selected = all.filter(ins => selectedIds.has(ins.insight_id)).slice(0, 3);
    if (!selected.length) return all.slice(0, 3).map((ins, i) => ({ ...ins, scope: "overall", rank: i + 1 }));
    return selected.map((ins, i) => ({ ...ins, scope: "overall", rank: i + 1 }));
  } catch {
    return all.slice(0, 3).map((ins, i) => ({ ...ins, scope: "overall", rank: i + 1 }));
  }
}

// ── Batch wrapper ─────────────────────────────────────────────────────────────

export async function generateAllInsights(allDevelopments, evidenceItems, opts = {}) {
  const evidenceIndex = Object.fromEntries((evidenceItems || []).map(ei => [ei.evidence_id, ei]));
  const results = {};

  for (const [category, developments] of Object.entries(allDevelopments.byCategory || {})) {
    results[category] = await generateInsights(category, developments, evidenceIndex, opts);
  }

  const overall = await generateOverallInsights(results, opts);
  const total = Object.values(results).flat().length;
  process.stdout.write(`  [L6.2] ${total} total insights; ${overall.length} overall top insights selected\n`);
  return { byCategory: results, overall };
}
