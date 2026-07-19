/**
 * Cross-Category Synthesis — slide concern only.
 *
 * Runs one Sonnet call across all four category analyses to identify
 * convergence patterns spanning multiple threat domains. Output feeds
 * the cross-category slide and the dashboard patterns panel.
 *
 * Input accepts the new CategoryAnalysis[] shape (insights[]) or the
 * legacy shape (judgments[]) for backward compatibility.
 *
 * Prompt: lib/prompts/analysis/synthesize-cross-category.md
 */

import { routedLLM }   from "../../llm/llmRouter.js";
import { callLLM }     from "../../llm/callLLM.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";

const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats (attacks on ML models: data poisoning, model extraction, adversarial evasion)",
  llm_threats:            "LLM Threats (prompt injection, jailbreaks, RAG poisoning, guardrail bypass)",
  agentic_ai_threats:     "Agentic AI Threats (agent hijacking, tool misuse, MCP abuse, memory poisoning)",
  ai_enabled_threats:     "AI-Enabled Threats (AI as attack tool: deepfakes, AI phishing, AI malware)",
};

const CROSS_CAT_SCHEMA = {
  type: "object",
  properties: {
    patterns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:                        { type: "string" },
          title:                     { type: "string" },
          categories_involved:       { type: "array", items: { type: "string" } },
          convergence_mechanism:     { type: "string" },
          compounding_effect:        { type: "string" },
          actionable_recommendation: { type: "string" },
        },
        required: ["title", "categories_involved", "convergence_mechanism", "compounding_effect", "actionable_recommendation"],
      },
    },
    ecosystem_assessment: { type: "string" },
    top_priority:         { type: "string" },
  },
  required: ["patterns", "ecosystem_assessment"],
};

function normalisePatterns(raw) {
  const patterns = (raw?.patterns || []).map(p => ({
    ...p,
    pattern:     p.title || p.pattern || "",
    description: p.convergence_mechanism || p.description || "",
    categories:  p.categories_involved   || p.categories  || [],
    implication: p.actionable_recommendation || p.implication || "",
  }));
  return { ...raw, patterns };
}

// Accepts both new (insights[]) and legacy (judgments[]) shapes
function extractInsightLines(ca) {
  // New shape
  if (ca.insights?.length) {
    return ca.insights.filter(i => !i.blocked).map(ins =>
      `  • ${ins.title} (${ins.evidence_maturity})\n    MECHANISM: ${ins.mechanism}\n    IMPLICATION: ${ins.implication}`
    );
  }
  // Legacy shape
  return (ca.judgments || []).filter(j => !j.blocked).map(j =>
    `  • ${j.judgment || j.title || ""} (${j.evidence_maturity || ""})\n    MECHANISM: ${j.causal_mechanism || ""}\n    IMPLICATION: ${j.why_this_matters || ""}`
  );
}

let _prompts = null;
function getPrompts() {
  if (!_prompts) _prompts = loadPrompt("slides/synthesize-cross-category");
  return _prompts;
}

/**
 * @param {object[]} categoryAnalyses - CategoryAnalysis[] from runAnalysis()
 * @param {object}   [opts]
 * @returns {Promise<object>}  { patterns[], ecosystem_assessment, top_priority }
 */
export async function synthesizeCrossCategory(categoryAnalyses, opts = {}) {
  if (opts.skipLlm) {
    return { patterns: [], ecosystem_assessment: "LLM disabled." };
  }

  const byCategory = {};
  for (const ca of categoryAnalyses) {
    const lines = extractInsightLines(ca);
    if (lines.length) byCategory[ca.category] = lines;
  }

  const totalInsights = Object.values(byCategory).flat().length;
  if (totalInsights < 2) {
    return { patterns: [], ecosystem_assessment: "Insufficient insights for cross-category synthesis." };
  }

  const insightBlock = Object.entries(byCategory).map(([cat, lines]) =>
    `── ${CATEGORY_LABELS[cat] || cat} ──\n${lines.join("\n\n")}`
  ).join("\n\n");

  const { system, user: userTmpl } = getPrompts();
  const user = interpolate(userTmpl, {
    approved_count:    totalInsights,
    category_count:    Object.keys(byCategory).length,
    judgment_block:    insightBlock,
    dev_insight_block: "",
  });

  try {
    let raw;
    try {
      const { result } = await routedLLM(system, user, {
        task: "cross_category_synthesis",
        requires_json: true,
        schema: CROSS_CAT_SCHEMA,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(system, user, { schema: CROSS_CAT_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }
    return normalisePatterns(raw) || { patterns: [], ecosystem_assessment: "No response." };
  } catch (err) {
    return { patterns: [], ecosystem_assessment: `Cross-category synthesis error: ${err.message}` };
  }
}
