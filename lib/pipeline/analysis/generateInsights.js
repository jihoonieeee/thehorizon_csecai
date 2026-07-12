/**
 * L6.2 — Insight Generation
 *
 * "What does it mean?" — derives Insight objects from approved synthesis judgments.
 * A judgment's `judgment` (the strategic claim) + `why_this_matters` (broken control)
 * + `causal_mechanism` (WHY this is happening) together constitute a complete insight.
 *
 * Primary path: derive directly from approved judgments (deterministic, always succeeds).
 * Secondary path: LLM synthesis across developments for overall top-3 insights.
 *
 * The insight scope is always "pattern_level" — judgments that passed analytical QA
 * already meet this bar (they were blocked if they were summary_only or unsupported).
 */

import { randomUUID }  from "crypto";
import { routedLLM }   from "../../llm/llmRouter.js";
import { callLLM }     from "../../llm/callLLM.js";
import { loadPrompt } from "../../prompts/promptLoader.js";

const MATURITY_RANK = {
  operational_campaign: 5, adversary_adoption: 4, observed_exploitation: 3,
  disclosed_vulnerability: 2, research_demonstration: 1,
};

// ── Per-category derivation from judgments ────────────────────────────────────

export function deriveInsightsFromJudgments(category, judgments, developmentsByJudgmentId = {}) {
  const approved = (judgments || [])
    .filter(j => !j.blocked &&
      (j.judgment || "").trim().length >= 20 &&
      (j.why_this_matters || j.causal_mechanism || "").trim().length >= 20
    )
    .sort((a, b) =>
      (MATURITY_RANK[b.evidence_maturity] || 0) - (MATURITY_RANK[a.evidence_maturity] || 0)
    )
    .slice(0, 3);

  return approved.map((j, i) => {
    const dev_id = developmentsByJudgmentId[j.judgment_id];
    return {
      insight_id:           randomUUID(),
      category,
      insight:              (j.judgment || "").trim(),
      broken_assumption:    (j.why_this_matters || "").trim() || "See causal mechanism",
      causal_mechanism:     (j.causal_mechanism || j.what_changed || "").trim(),
      development_ids:      dev_id ? [dev_id] : [],
      evidence_ids:         (j.evidence_for || []).filter(Boolean),
      scope:                "pattern_level",
      rank_within_category: i + 1,
      caveats:              j.caveats || [],
      _derived_from_judgment_id: j.judgment_id,
    };
  });
}

// ── Overall top-3 insights via LLM ───────────────────────────────────────────
// The overall insights DO use an LLM because they synthesise across categories —
// something the per-category judgments don't cover. But this is ONE call, not four.

const OVERALL_INSIGHT_SYSTEM = loadPrompt("analysis/overall-insights").system;

export async function generateOverallInsights(allCategoryInsights, allDevelopments, opts = {}) {
  const { skipLlm = false } = opts;
  const all = Object.values(allCategoryInsights).flat();

  // Deterministic fallback: pick top 3 from all categories (one per category max for diversity)
  const topByCategory = Object.entries(allCategoryInsights)
    .map(([cat, ins]) => ins[0] ? { ...ins[0], category: cat } : null)
    .filter(Boolean)
    .slice(0, 3)
    .map((ins, i) => ({ ...ins, scope: "overall", rank: i + 1 }));

  if (skipLlm || !process.env.ANTHROPIC_API_KEY) return topByCategory;

  // Build context from all per-category insights
  const insBlock = all.map(ins =>
    `[${ins.category}] ${ins.insight.slice(0, 100)}\n  broken_assumption: ${(ins.broken_assumption || "").slice(0, 60)}\n  mechanism: ${(ins.causal_mechanism || "").slice(0, 60)}`
  ).join("\n\n");

  const userPrompt = `Generate 3 CROSS-CUTTING overall insights from the per-category insights below.
Each insight must span ≥2 categories and teach a single strategic lesson.

PER-CATEGORY INSIGHTS:
${insBlock}

Return: { "insights": [{ "insight": "...", "broken_assumption": "...", "causal_mechanism": "...", "categories_spanned": ["cat1","cat2"] }] }`;

  try {
    let raw;
    try {
      const { result } = await routedLLM(OVERALL_INSIGHT_SYSTEM, userPrompt, {
        task: "insight_generation", requires_json: true, logLabel: "overall-insights",
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(OVERALL_INSIGHT_SYSTEM, userPrompt, { json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }

    const overallInsights = (raw?.insights || [])
      .filter(ins => ins.insight && (ins.insight.length >= 30) && (ins.categories_spanned || []).length >= 2)
      .slice(0, 3)
      .map((ins, i) => ({
        insight_id:        randomUUID(),
        category:          "overall",
        insight:           ins.insight.trim(),
        broken_assumption: (ins.broken_assumption || "").trim(),
        causal_mechanism:  (ins.causal_mechanism  || "").trim(),
        development_ids:   [],
        evidence_ids:      [],
        scope:             "overall",
        categories_spanned: ins.categories_spanned || [],
        rank:              i + 1,
      }));

    if (!overallInsights.length) return topByCategory;
    return overallInsights;
  } catch {
    return topByCategory;
  }
}

// ── Batch wrapper ─────────────────────────────────────────────────────────────

export async function generateAllInsights(allDevelopments, evidenceItems, opts = {}, categoryAnalyses = []) {
  const evidenceIndex = Object.fromEntries((evidenceItems || []).map(ei => [ei.evidence_id, ei]));
  const results = {};

  // Build judgment_id → development_id map for linking
  const devByJudgment = {};
  for (const devs of Object.values(allDevelopments.byCategory || {})) {
    for (const d of devs) {
      if (d._derived_from_judgment_id) {
        devByJudgment[d._derived_from_judgment_id] = d.development_id;
      }
    }
  }

  for (const ca of categoryAnalyses) {
    const insights = deriveInsightsFromJudgments(ca.category, ca.judgments || [], devByJudgment);
    results[ca.category] = insights;
    process.stdout.write(`  [L6.2] ${ca.category}: ${insights.length} insights derived from judgments\n`);
  }

  // Fallback coverage
  if (allDevelopments.byCategory) {
    for (const cat of Object.keys(allDevelopments.byCategory)) {
      if (!results[cat]) results[cat] = [];
    }
  }

  const overall = await generateOverallInsights(results, allDevelopments, opts);
  const total   = Object.values(results).flat().length;
  process.stdout.write(`  [L6.2] ${total} total insights; ${overall.length} overall top insights selected\n`);
  return { byCategory: results, overall };
}
