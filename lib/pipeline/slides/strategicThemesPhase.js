/**
 * L7 Phase 3 — Strategic Theme Extraction
 *
 * Identifies 4–6 cross-cutting strategic themes from all category analyses.
 * Each theme is a pattern that spans ≥2 categories or represents the most
 * important signal in one category.
 *
 * Uses routedLLM (task: "strategic_themes") — falls back to empty array when
 * skipLlm=true or no LLM keys are available.
 */

import { routedLLM } from "../../llm/llmRouter.js";

// ── JSON schema for strategic themes response ─────────────────────────────────

const THEMES_SCHEMA = {
  type: "object",
  required: ["themes"],
  properties: {
    themes: {
      type: "array",
      minItems: 0,
      maxItems: 8,
      items: {
        type: "object",
        required: [
          "theme_id", "theme_title", "theme_summary",
          "categories_involved", "evidence_maturity", "confidence",
          "confidence_reason", "slides_recommended",
        ],
        properties: {
          theme_id:            { type: "string" },
          theme_title:         { type: "string" },
          theme_summary:       { type: "string" },
          categories_involved: { type: "array", items: { type: "string" } },
          key_evidence_urls:   { type: "array", items: { type: "string" } },
          evidence_maturity:   {
            type: "string",
            enum: ["disclosed_vulnerability", "demonstrated_capability", "early_signal", "research_only", "operational"],
          },
          confidence:          { type: "string", enum: ["low", "medium", "high"] },
          confidence_reason:   { type: "string" },
          slides_recommended:  { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior AI threat intelligence analyst. Your task is to identify the 4–6 most important STRATEGIC THEMES from a multi-category AI security horizon scan.

A strategic theme is:
- A cross-cutting pattern that appears in ≥2 threat categories (preferred), OR
- The single most important signal in one category if it has major strategic significance

Each theme must:
1. Have an analytical title that communicates the finding, not the category (e.g., "Agent Trust Boundaries Are Failing" not "Agentic AI Threats")
2. Be grounded in the evidence provided — do not extrapolate beyond the evidence
3. Specify which categories it spans
4. Carry an honest confidence rating (low/medium/high) with a brief reason

## EVIDENCE MATURITY LEVELS
disclosed_vulnerability — a specific CVE or named vulnerability exists
demonstrated_capability — a research team has shown an attack works (lab/controlled)
early_signal — emerging pattern but limited or mixed evidence
research_only — academic findings not yet seen in the wild
operational — confirmed real-world adversary use

## OUTPUT FORMAT
Return strict JSON only — { "themes": [ ... ] } — no markdown, no preamble.
Return 4–6 themes. If evidence is very thin across all categories, return fewer rather than inventing themes.`;

// ── User prompt builder ───────────────────────────────────────────────────────

function buildThemesPrompt(categoryAnalyses, claimChainResults, presentationPacket, feedSources) {
  const lines = [
    `STRATEGIC ANALYSIS INPUT`,
    `Total sources in corpus: ${feedSources?.length || 0}`,
    ``,
  ];

  // Per-category summary
  for (const analysis of (categoryAnalyses || [])) {
    const cat = analysis.category;
    const chain = claimChainResults?.[cat] || {};
    const criticalClaims = (chain.claims || []).filter((c) => c.claim_priority === "critical");
    const highClaims     = (chain.claims || []).filter((c) => c.claim_priority === "high");

    lines.push(`## ${cat.replace(/_/g, " ").toUpperCase()}`);
    lines.push(`Analysis confidence: ${analysis.analysis_confidence || "unknown"}`);
    if (analysis.category_headline) lines.push(`Headline: ${analysis.category_headline}`);
    if (analysis.overview) lines.push(`Overview: ${analysis.overview.slice(0, 200)}`);

    if (criticalClaims.length > 0) {
      lines.push(`Critical claims (${criticalClaims.length}):`);
      criticalClaims.slice(0, 2).forEach((c) => {
        lines.push(`  [CRITICAL] ${c.claim_text}`);
        if (c.caveat_if_any) lines.push(`    caveat: ${c.caveat_if_any}`);
      });
    }

    if (highClaims.length > 0) {
      lines.push(`High claims (${highClaims.length}):`);
      highClaims.slice(0, 2).forEach((c) => lines.push(`  [HIGH] ${c.claim_text}`));
    }

    const signals = (analysis.early_signals || []).filter((s) => s.qa_pass !== false).slice(0, 2);
    if (signals.length > 0) {
      lines.push(`Early signals:`);
      signals.forEach((s) => lines.push(`  → ${s.signal}`));
    }

    lines.push("");
  }

  // Cross-category patterns from presentation packet
  const cc = presentationPacket?.cross_category;
  if (cc?.patterns?.length > 0) {
    lines.push("## CROSS-CATEGORY PATTERNS (from synthesis)");
    cc.patterns.slice(0, 5).forEach((p) => {
      lines.push(`  - ${p.pattern || p.signal || ""}`);
      if (p.implication) lines.push(`    → ${p.implication}`);
    });
    lines.push("");
  }

  lines.push("Identify the 4–6 most important strategic themes. Return strict JSON: { \"themes\": [ ... ] }");

  return lines.join("\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract strategic themes from category analyses and claim chain results.
 *
 * @param {object} params
 * @param {object[]} params.category_analyses       - From runSynthesisLayer
 * @param {object}   params.claim_chain_results     - From runClaimChainAllCategories
 * @param {object}   params.presentation_packet     - From buildPresentationPacket
 * @param {object[]} params.feed_sources            - All enriched sources
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @returns {Promise<object[]>}  Array of theme objects (empty if LLM unavailable)
 */
export async function extractStrategicThemes(
  { category_analyses = [], claim_chain_results = {}, presentation_packet = null, feed_sources = [] },
  opts = {}
) {
  const { skipLlm = false } = opts;

  const hasLlm = !skipLlm && !!(
    process.env.OPENAI_API_KEY    || process.env.OPENAI_API_KEY_2  ||
    process.env.GEMINI_API_KEY    || process.env.GEMINI_API_KEY_2  ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENROUTER_API_KEY
  );

  if (!hasLlm || category_analyses.length === 0) {
    return [];
  }

  const userPrompt = buildThemesPrompt(
    category_analyses,
    claim_chain_results,
    presentation_packet,
    feed_sources
  );

  try {
    const { result: raw } = await routedLLM(SYSTEM_PROMPT, userPrompt, {
      task:          "strategic_themes",   // falls back to "synthesis" in task registry
      requires_json: true,
      schema:        THEMES_SCHEMA,
      logLabel:      "L7-strategic-themes",
    });

    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const themes = Array.isArray(parsed?.themes) ? parsed.themes : [];

    // Basic validation: ensure required fields present
    const valid = themes.filter((t) =>
      t.theme_id && t.theme_title && t.theme_summary &&
      Array.isArray(t.categories_involved) && t.confidence
    );

    if (valid.length < themes.length) {
      process.stdout.write(
        `  [L7-strategic-themes] WARN: ${themes.length - valid.length} theme(s) dropped — missing required fields\n`
      );
    }

    process.stdout.write(`  [L7-strategic-themes] ${valid.length} strategic themes extracted\n`);
    return valid;
  } catch (err) {
    process.stdout.write(`  [L7-strategic-themes] LLM failed: ${err.message} — using empty themes\n`);
    return [];
  }
}
