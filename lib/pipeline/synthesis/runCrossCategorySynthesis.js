/**
 * L6 — Cross-Category Synthesis
 *
 * Runs ONE frontier-model LLM call after all category analyses are complete.
 * Identifies convergent patterns, overall biggest happenings, overall early signals,
 * and a strategic outlook that span multiple categories.
 *
 * Routing: Claude Sonnet preferred → Gemini 2.5 Pro → Gemini 2.5 Flash → deterministic
 * Called: ONCE per pipeline run.
 *
 * ── EVIDENCE RULES ────────────────────────────────────────────────────────────
 * Only cites evidence_ids that appear in the provided category analyses.
 * No new facts introduced — only cross-category patterns from existing analysis.
 */

import { routedLLM } from "../../llm/llmRouter.js";

const CROSS_CATEGORY_SCHEMA = {
  type: "object",
  required: ["executive_summary", "cross_category_patterns",
             "overall_biggest_happenings", "overall_early_signals", "strategic_outlook"],
  properties: {
    executive_summary: {
      type: "object",
      required: ["headline", "key_judgments"],
      properties: {
        headline:      { type: "string" },
        key_judgments: {
          type: "array", maxItems: 5,
          items: {
            type: "object",
            required: ["judgment", "supporting_evidence_ids", "confidence"],
            properties: {
              judgment:                    { type: "string" },
              supporting_evidence_ids:     { type: "array", items: { type: "string" } },
              confidence:                  { type: "string", enum: ["high", "medium", "low"] },
              recommended_visualization_ids: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },

    cross_category_patterns: {
      type: "array", maxItems: 4,
      items: {
        type: "object",
        required: ["pattern", "categories_involved", "explanation", "supporting_evidence_ids", "confidence"],
        properties: {
          pattern:                     { type: "string" },
          categories_involved:         { type: "array", items: { type: "string" } },
          explanation:                 { type: "string" },
          supporting_evidence_ids:     { type: "array", items: { type: "string" } },
          recommended_visualization_ids: { type: "array", items: { type: "string" } },
          confidence:                  { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },

    overall_biggest_happenings: {
      type: "array", maxItems: 5,
      items: {
        type: "object",
        required: ["happening", "category", "why_it_matters", "supporting_evidence_ids", "confidence"],
        properties: {
          happening:               { type: "string" },
          category:                { type: "string" },
          why_it_matters:          { type: "string" },
          supporting_evidence_ids: { type: "array", items: { type: "string" } },
          confidence:              { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },

    overall_early_signals: {
      type: "array", maxItems: 4,
      items: {
        type: "object",
        required: ["signal", "categories_involved", "implication_3_6_months", "supporting_evidence_ids", "confidence"],
        properties: {
          signal:                      { type: "string" },
          categories_involved:         { type: "array", items: { type: "string" } },
          implication_3_6_months:      { type: "string" },
          supporting_evidence_ids:     { type: "array", items: { type: "string" } },
          recommended_visualization_ids: { type: "array", items: { type: "string" } },
          confidence:                  { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },

    strategic_outlook: {
      type: "object",
      required: ["statement", "time_horizon", "supporting_evidence_ids", "confidence"],
      properties: {
        statement:                   { type: "string" },
        time_horizon:                { type: "string" },
        supporting_evidence_ids:     { type: "array", items: { type: "string" } },
        recommended_visualization_ids: { type: "array", items: { type: "string" } },
        confidence:                  { type: "string", enum: ["high", "medium", "low"] },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a senior AI threat intelligence analyst writing a cross-category strategic assessment.

## YOUR TASK: ECOSYSTEM-LEVEL ANALYSIS

You are given VALIDATED STRATEGIC JUDGMENTS from each individual threat category. Your job is NOT to aggregate these summaries — it is to identify what they reveal COLLECTIVELY about the AI threat ecosystem.

Think like an ecosystem analyst, not a report compiler. Ask:
1. What ECOSYSTEM-LEVEL SHIFTS are visible across categories? (e.g., convergence of technique families, shared enablers, attack surface expansion)
2. Where do multiple categories CONVERGE on the same root cause, enabler, or attack surface?
3. What COMPOUNDING RISKS arise when multiple threats are operationalised simultaneously?
4. Which ASSUMPTIONS are being broken across the ecosystem? (e.g., trust models, isolation assumptions, supply chain assumptions)
5. What SECOND-ORDER EFFECTS span multiple categories?
6. Which STRATEGIC WATCHPOINTS affect multiple categories simultaneously?

## WHAT YOU ARE LOOKING FOR

ECOSYSTEM SHIFTS (most valuable — these are cross-category):
  "Agent frameworks, MCP tooling, and LLM APIs are converging on shared attack surfaces — a single technique (prompt injection) can traverse all three layers"
  "The research-to-weaponization cycle for adversarial ML is accelerating: capability demonstrated in traditional_ai_threats is appearing as adoption signal in llm_threats within the same reporting period"

COMPOUNDING RISKS:
  "Deepfake identity (ai_enabled_threats) combined with agent delegation (agentic_ai_threats) creates autonomous social-engineering chains that require no human attacker in the loop"

BROKEN ASSUMPTIONS:
  "The assumption that LLM safety filters operate independently of tool-call context is broken across both llm_threats and agentic_ai_threats"

NOT valuable (do not produce these):
  "AI threats span multiple categories" (generic)
  "Multiple categories show increased activity" (summary, not insight)
  "Defenders should be aware of developments across all categories" (obvious)

## EVIDENCE RULES
1. You may ONLY cite evidence_ids that appear in the category judgments provided below. Never invent an ID.
2. A cross-category pattern MUST draw on validated judgments from ≥2 DISTINCT categories. Single-category findings go in overall_biggest_happenings with the category field — NOT in cross_category_patterns.
3. Cap confidence at the MINIMUM confidence of the categories contributing to a pattern.
4. If cross-category signals are weak, express them as early signals, not definitive patterns.
5. Return strict JSON only — no markdown, no preamble.`;

function formatCrossCategoryState(crossState) {
  if (!crossState) return "";

  const lines = [
    "CROSS-CATEGORY CONVERGENCE SIGNALS (analytical starting points — identify the ecosystem mechanism, not the signal):",
    "",
  ];

  for (const cand of (crossState.convergence_clusters || []).slice(0, 5)) {
    const cats = cand.categories?.join(", ") || "?";
    const ceiling = cand.confidence || "low";
    // Use signal_description when available (new non-assertive form)
    const desc = cand.signal_description || cand.why_it_matters_candidate || cand.pattern_name;
    lines.push(`[${cand.pattern_id}] CONVERGENCE SIGNAL: ${cand.pattern_name}`);
    lines.push(`  Categories: ${cats} | Confidence ceiling: ${ceiling}`);
    lines.push(`  Signal: ${desc}`);
    if (cand.caveat_if_any) lines.push(`  ⚠ CONSTRAINT: ${cand.caveat_if_any}`);
    lines.push("");
  }

  if ((crossState.global_evidence_gaps || []).length > 0) {
    lines.push("EVIDENCE GAPS ACROSS CORPUS:");
    crossState.global_evidence_gaps.forEach((g) => lines.push(`  - ${g}`));
    lines.push("");
  }

  return lines.join("\n");
}

function buildCrossPrompt(categoryAnalyses, derivedMetrics, vizSpecs, crossCategoryState) {
  const lines = [
    `Cross-category ecosystem analysis. ${categoryAnalyses.length} active categories. Identify ecosystem shifts, convergence, and compounding risks — not category summaries.`,
    "",
    "VALIDATED STRATEGIC JUDGMENTS BY CATEGORY:",
    "(These are approved judgments from per-category synthesis. Use them as inputs to ecosystem analysis — do NOT restate them.)",
    "",
  ];

  // Per-category: show strategic judgments (the new schema) with full reasoning chain
  for (const analysis of categoryAnalyses) {
    const cat = analysis.category.replace(/_/g, " ").toUpperCase();
    lines.push(`── ${cat} (confidence: ${analysis.analysis_confidence}) ──`);

    // Prefer new strategic_judgments over legacy shapes
    const judgments = (analysis.strategic_judgments || []).slice(0, 3);
    if (judgments.length > 0) {
      lines.push("  Strategic judgments:");
      judgments.forEach((j) => {
        const ids = (j.supporting_evidence_ids || []).slice(0, 2).join(", ");
        lines.push(`    [${ids}] (${j.confidence || "?"}, type=${j.judgment_type}) ${j.judgment}`);
        if (j.what_changed)      lines.push(`      changed: ${j.what_changed.slice(0, 120)}`);
        if (j.causal_mechanism)  lines.push(`      cause: ${j.causal_mechanism.slice(0, 120)}`);
        if (j.why_this_matters)  lines.push(`      implies: ${j.why_this_matters.slice(0, 120)}`);
        const soi = (j.second_order_implications || []).slice(0, 1);
        if (soi.length) lines.push(`      2nd order: ${soi[0].slice(0, 100)}`);
      });
    } else {
      // Fallback to legacy shapes for backward compat
      const happenings = (analysis.biggest_happenings || []).slice(0, 2);
      if (happenings.length > 0) {
        lines.push("  Key happenings:");
        happenings.forEach((h) => {
          const ids = (h.supporting_evidence_ids || []).slice(0, 2).join(", ");
          lines.push(`    [${ids}] (${h.confidence || "?"}) ${h.happening}`);
        });
      }
      const insights = (analysis.top_insights || []).slice(0, 2);
      if (insights.length > 0) {
        lines.push("  Insights:");
        insights.forEach((ins) => {
          const ids = (ins.supporting_evidence_ids || []).slice(0, 2).join(", ");
          lines.push(`    [${ids}] (${ins.confidence || "?"}) ${ins.insight}`);
        });
      }
    }

    if (analysis.outlook_6_months?.projected_trajectory) {
      const ids = (analysis.outlook_6_months.supporting_evidence_ids || []).slice(0, 2).join(", ");
      lines.push(`  Outlook: [${ids}] ${analysis.outlook_6_months.projected_trajectory}`);
    } else if (analysis.outlook?.statement) {
      const ids = (analysis.outlook.supporting_evidence_ids || []).slice(0, 2).join(", ");
      lines.push(`  Outlook: [${ids}] ${analysis.outlook.statement}`);
    }

    lines.push("");
  }

  // Derived metrics
  if (derivedMetrics && Object.keys(derivedMetrics).length > 0) {
    lines.push("DERIVED RISK METRICS (metric_* IDs):");
    for (const [name, m] of Object.entries(derivedMetrics)) {
      if (m?.value !== undefined) {
        lines.push(`  [metric_${name}] ${name}: ${m.value} (${m.label})`);
      }
    }
    lines.push("");
  }

  // Available viz IDs
  const availViz = (vizSpecs || []).slice(0, 12).map((s) => `viz_${s.visualization_id}`);
  if (availViz.length > 0) {
    lines.push(`AVAILABLE VISUALIZATION IDs (for recommended_visualization_ids only):`);
    lines.push(`  ${availViz.join(", ")}`);
    lines.push("");
  }

  // Cross-category hypothesis candidates from analytical state
  if (crossCategoryState) {
    lines.push(formatCrossCategoryState(crossCategoryState));
  }

  lines.push("Produce the cross-category ecosystem analysis. Identify ECOSYSTEM SHIFTS, CONVERGENCE, and COMPOUNDING RISKS — not category summaries. Each cross_category_pattern must draw on ≥2 categories and explain the shared mechanism or enabler. Cite only IDs from the judgments above.");

  return lines.join("\n");
}

// The four offensive analysis domains (used to validate categories_involved).
const ANALYSIS_CATEGORIES = new Set([
  "traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats",
]);

const CONF_RANK = { high: 3, medium: 2, low: 1 };
const RANK_TO_CONF = { 3: "high", 2: "medium", 1: "low" };

// Cap a cross-category item's confidence at the MIN confidence of the categories
// it draws from — a cross-category judgment cannot be more certain than its
// least-certain input category.
function capByCategoryConfidence(item, catConf) {
  const cats = item.categories_involved || (item.category ? [item.category] : []);
  let minRank = Infinity;
  for (const c of cats) {
    const cc = catConf[c];
    if (cc) minRank = Math.min(minRank, CONF_RANK[cc] || 1);
  }
  if (!isFinite(minRank)) return item;
  if ((CONF_RANK[item.confidence] || 1) > minRank) {
    return { ...item, confidence: RANK_TO_CONF[minRank] };
  }
  return item;
}

// Drop later items that re-use the exact same supporting-evidence set as an
// earlier one (the same finding restated across cross-category outputs).
function dedupByEvidence(items) {
  const seen = new Set();
  const out = [];
  for (const it of (items || [])) {
    const sig = [...new Set(it.supporting_evidence_ids || [])].sort().join("|");
    if (sig && seen.has(sig)) continue;
    if (sig) seen.add(sig);
    out.push(it);
  }
  return out;
}

/**
 * Deterministic post-processing of the cross-category synthesis:
 *  - drop patterns not spanning ≥2 recognised categories (prompt-only otherwise);
 *  - cap each output's confidence at the MIN of its categories' confidence;
 *  - dedup happenings/signals that cite the identical evidence set.
 */
export function enforceCrossCategoryPatterns(result, categoryAnalyses = []) {
  if (!result) return result;
  const catConf = {};
  for (const a of categoryAnalyses) catConf[a.category] = a.analysis_confidence || "low";

  let kept = result.cross_category_patterns;
  if (Array.isArray(kept)) {
    const filtered = [];
    let dropped = 0;
    for (const p of kept) {
      const cats = [...new Set((p.categories_involved || []).filter((c) => ANALYSIS_CATEGORIES.has(c)))];
      if (cats.length >= 2) filtered.push(capByCategoryConfidence({ ...p, categories_involved: cats }, catConf));
      else dropped++;
    }
    if (dropped > 0) {
      process.stdout.write(`  [L6-analysis-cross-category] dropped ${dropped} pattern(s) not spanning ≥2 categories\n`);
    }
    kept = dedupByEvidence(filtered);
  }

  const happenings = Array.isArray(result.overall_biggest_happenings)
    ? dedupByEvidence(result.overall_biggest_happenings.map((h) => capByCategoryConfidence(h, catConf)))
    : result.overall_biggest_happenings;
  const signals = Array.isArray(result.overall_early_signals)
    ? dedupByEvidence(result.overall_early_signals.map((s) => capByCategoryConfidence(s, catConf)))
    : result.overall_early_signals;

  return {
    ...result,
    cross_category_patterns: kept,
    overall_biggest_happenings: happenings,
    overall_early_signals: signals,
  };
}

function deterministicCrossCategorySynthesis(categoryAnalyses) {
  const allHappenings = categoryAnalyses.flatMap((a) =>
    (a.biggest_happenings || []).slice(0, 2).map((h) => ({ ...h, category: a.category }))
  );

  const allSignals = categoryAnalyses.flatMap((a) =>
    (a.early_signals || []).filter((s) => s.qa_pass !== false).slice(0, 1)
      .map((s) => ({ ...s, categories_involved: [a.category] }))
  );

  const allInsights = categoryAnalyses.flatMap((a) =>
    (a.top_insights || []).slice(0, 1).map((ins) => ({
      judgment:                ins.insight,
      supporting_evidence_ids: ins.supporting_evidence_ids || [],
      confidence:              ins.confidence || "low",
      recommended_visualization_ids: ins.recommended_visualization_ids || [],
    }))
  ).slice(0, 3);

  const allOutlooks = categoryAnalyses
    .filter((a) => a.outlook?.statement)
    .map((a) => a.outlook.statement);

  const topCategoryByCritical = categoryAnalyses
    .sort((a, b) =>
      (b.biggest_happenings?.length || 0) - (a.biggest_happenings?.length || 0)
    )[0]?.category || "";

  return {
    executive_summary: {
      headline: `AI cyber threats span ${categoryAnalyses.length} active categories this reporting period.`,
      key_judgments: allInsights,
    },
    cross_category_patterns: [],
    overall_biggest_happenings: allHappenings.slice(0, 5),
    overall_early_signals: allSignals.slice(0, 4).map((s) => ({
      ...s,
      implication_3_6_months: s.implication_3_6_months || s.implication || "",
    })),
    strategic_outlook: {
      statement:               allOutlooks.slice(0, 2).join(" ") || "Monitor all categories for escalation in the next 3–6 months.",
      time_horizon:            "3-6 months",
      supporting_evidence_ids: categoryAnalyses
        .flatMap((a) => (a.outlook?.supporting_evidence_ids || []).slice(0, 1))
        .slice(0, 4),
      recommended_visualization_ids: [],
      confidence:              "low",
    },
    llm_used: false,
  };
}

/**
 * Run cross-category synthesis after all category analyses are complete (Layer 6.5).
 *
 * @param {object[]} categoryAnalyses    - QA'd category analyses from Layer 8D
 * @param {object}   derivedMetrics      - Derived metric indexes from Layer 5b.6
 * @param {object[]} vizSpecs            - Visualization specs from Layer 5b.8
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @param {object}   [opts.crossCategoryState] - From buildAnalyticalState().cross_category_state
 * @returns {Promise<object>}
 */
export async function runCrossCategorySynthesis(categoryAnalyses, derivedMetrics, vizSpecs, opts = {}) {
  const { skipLlm = false, crossCategoryState = null } = opts;

  if (!categoryAnalyses || categoryAnalyses.length === 0) {
    return deterministicCrossCategorySynthesis([]);
  }

  if (skipLlm || categoryAnalyses.length < 2) {
    return deterministicCrossCategorySynthesis(categoryAnalyses);
  }

  try {
    const { result, llm_metadata } = await routedLLM(
      SYSTEM_PROMPT,
      buildCrossPrompt(categoryAnalyses, derivedMetrics, vizSpecs, crossCategoryState),
      {
        task:          "cross_category_synthesis",
        requires_json: true,
        schema:        CROSS_CATEGORY_SCHEMA,
        logLabel: "L6-cross-category-synthesis",
      }
    );

    if (!result) {
      process.stdout.write(`  [L6-analysis-cross-category] No LLM result for cross-category (${llm_metadata?.error}) — using fallback\n`);
      return deterministicCrossCategorySynthesis(categoryAnalyses);
    }

    process.stdout.write(
      `  [L6-analysis-cross-category] Cross-category synthesis via ${llm_metadata?.provider_used}/${llm_metadata?.model_used}\n`
    );

    return {
      ...enforceCrossCategoryPatterns(result, categoryAnalyses),
      llm_used:   true,
      model_used: llm_metadata?.model_used || "unknown",
    };
  } catch (err) {
    process.stdout.write(`  [L6-analysis-cross-category] Cross-category synthesis failed: ${err.message} — using fallback\n`);
    return deterministicCrossCategorySynthesis(categoryAnalyses);
  }
}
