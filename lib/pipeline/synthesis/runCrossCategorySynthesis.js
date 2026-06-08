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

const SYSTEM_PROMPT = `You are a senior AI cybersecurity intelligence analyst writing a strategic cross-category assessment.

## YOUR TASK
Evaluate the pre-computed cross-category hypothesis candidates below and express them as evidence-backed strategic judgments. Select the strongest, combine overlapping ones, and discard those without sufficient evidence. Do NOT invent new cross-category patterns not grounded in the candidates.

## RULES
1. You may ONLY cite evidence_ids that appear in the category analyses or cross-category candidates provided.
2. A cross-category pattern MUST cite evidence from at least 2 categories (unless explicitly labelled single-category strategic issue).
3. overall_biggest_happenings: select the 3–5 most strategically significant happenings ACROSS ALL categories. Include category field.
4. overall_early_signals: select the 2–4 most significant signals. Prefer cross-category implications.
5. strategic_outlook: 2-3 sentences. Must be grounded in evidence trajectory, not speculation.
6. executive_summary.headline: one declarative sentence capturing the dominant cross-category judgment.
7. key_judgments: 3–5 judgments a CISO needs to know. Each must cite evidence.
8. If cross-category candidates are weak (low confidence), express them as early signals or caveats — not as definitive judgments.
9. Return strict JSON only — no markdown, no preamble.`;

function formatCrossCategoryState(crossState) {
  if (!crossState) return "";

  const lines = [
    "PRE-COMPUTED CROSS-CATEGORY HYPOTHESIS CANDIDATES (evaluate — do not invent new ones):",
    "",
  ];

  for (const cand of (crossState.convergence_clusters || []).slice(0, 5)) {
    const cats = cand.categories?.join(", ") || "?";
    const ceiling = cand.confidence || "low";
    lines.push(`[${cand.pattern_id}] CONVERGENCE: ${cand.pattern_name}`);
    lines.push(`  Categories: ${cats} | Confidence ceiling: ${ceiling}`);
    lines.push(`  Candidate: ${cand.why_it_matters_candidate}`);
    if (cand.caveat_if_any) lines.push(`  ⚠ CAVEAT: ${cand.caveat_if_any}`);
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
    `Reporting period cross-category analysis covering ${categoryAnalyses.length} active categories.`,
    "",
  ];

  // Per-category summary
  for (const analysis of categoryAnalyses) {
    const cat = analysis.category.replace(/_/g, " ").toUpperCase();
    lines.push(`── ${cat} (confidence: ${analysis.analysis_confidence}) ──`);

    if (analysis.category_headline) {
      lines.push(`  Headline: ${analysis.category_headline}`);
    }

    const happenings = (analysis.biggest_happenings || []).slice(0, 3);
    if (happenings.length > 0) {
      lines.push("  Biggest happenings:");
      happenings.forEach((h) => {
        const ids = (h.supporting_evidence_ids || []).slice(0, 2).join(", ");
        lines.push(`    [${ids}] (${h.confidence || "?"}) ${h.happening}`);
        // Show resolved evidence snippets so the synthesis LLM can verify claims
        const ev = (h.resolved_evidence || []).slice(0, 2);
        for (const e of ev) {
          const pub = e.publisher || e.source_title || "";
          const fact = e.fact?.slice(0, 120) || e.display_label || "";
          if (pub || fact) lines.push(`      source: ${pub}${fact ? ` — "${fact}"` : ""}`);
        }
      });
    }

    const insights = (analysis.top_insights || []).slice(0, 3);
    if (insights.length > 0) {
      lines.push("  Top insights:");
      insights.forEach((ins) => {
        const ids = (ins.supporting_evidence_ids || []).slice(0, 2).join(", ");
        lines.push(`    [${ids}] (${ins.confidence || "?"}) ${ins.insight}`);
        if (ins.explanation) lines.push(`      → ${ins.explanation.slice(0, 120)}`);
      });
    }

    const signals = (analysis.early_signals || []).filter((s) => s.qa_pass !== false).slice(0, 2);
    if (signals.length > 0) {
      lines.push("  Early signals:");
      signals.forEach((s) => {
        const ids = (s.supporting_evidence_ids || []).slice(0, 1).join(", ");
        lines.push(`    [${ids}] ${s.signal} → ${s.implication_3_6_months?.slice(0, 120) || ""}`);
      });
    }

    if (analysis.outlook?.statement) {
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

  lines.push("Evaluate the cross-category hypothesis candidates and produce the synthesis. Cite only IDs that appear in the analyses or candidates above.");

  return lines.join("\n");
}

// The four offensive analysis domains (used to validate categories_involved).
const ANALYSIS_CATEGORIES = new Set([
  "traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats",
]);

/**
 * Deterministically enforce the "≥2 categories" rule on cross-category patterns.
 * The LLM is told a convergence pattern must span ≥2 categories, but that was
 * prompt-only. Here we drop any pattern whose distinct, recognised
 * categories_involved is fewer than 2 — a single-category "convergence" is not one.
 */
function enforceCrossCategoryPatterns(result) {
  if (!result || !Array.isArray(result.cross_category_patterns)) return result;
  const kept = [];
  let dropped = 0;
  for (const p of result.cross_category_patterns) {
    const cats = [...new Set((p.categories_involved || []).filter((c) => ANALYSIS_CATEGORIES.has(c)))];
    if (cats.length >= 2) {
      kept.push({ ...p, categories_involved: cats });
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    process.stdout.write(`  [L6-analysis-cross-category] dropped ${dropped} pattern(s) not spanning ≥2 categories\n`);
  }
  return { ...result, cross_category_patterns: kept };
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
      ...enforceCrossCategoryPatterns(result),
      llm_used:   true,
      model_used: llm_metadata?.model_used || "unknown",
    };
  } catch (err) {
    process.stdout.write(`  [L6-analysis-cross-category] Cross-category synthesis failed: ${err.message} — using fallback\n`);
    return deterministicCrossCategorySynthesis(categoryAnalyses);
  }
}
