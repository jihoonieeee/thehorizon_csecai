/**
 * L6 — Category Synthesis (single strong viewpoints-first LLM call)
 *
 * ONE call per category over the compact 5A/5B/5C evidence dossier. The model
 * identifies analytical VIEWPOINTS first, then produces the analyst outputs and
 * traces each back to evidence_ids from the dossier. It must NOT invent evidence
 * ids or facts. Deterministic validation (validateCategoryAnalysis.js) enforces
 * every constraint afterwards.
 *
 * Routing: task "category_synthesis" → Anthropic Opus (strongest) → Gemini Pro.
 * Returns the parsed contract object, or null when no LLM is available / it fails.
 */

import { routedLLM } from "../../llm/llmRouter.js";

const OUTPUT_ITEM = {
  type: "object",
  required: ["text", "supporting_evidence_ids", "why_this_matters", "confidence", "slide_usefulness"],
  properties: {
    id:                      { type: "string" },
    text:                    { type: "string" },
    output_type:             { type: "string" },
    supporting_evidence_ids: { type: "array", items: { type: "string" } },
    evidence_origins:        { type: "array", items: { type: "string" } },
    why_this_matters:        { type: "string" },
    confidence:              { type: "string", enum: ["high", "medium", "low"] },
    caveat_if_any:           { type: ["string", "null"] },
    slide_usefulness:        { type: "string", enum: ["high", "medium", "low"] },
  },
};

const TREND_ITEM = {
  ...OUTPUT_ITEM,
  properties: {
    ...OUTPUT_ITEM.properties,
    pattern_label: { type: "string", enum: ["trend", "recurring_pattern", "early_signal"] },
  },
};

const SCHEMA = {
  type: "object",
  required: ["top_insights", "top_trends_or_patterns", "top_happenings", "early_signals", "outlook_6_months", "recommendations", "evidence_gaps"],
  properties: {
    top_insights:           { type: "array", items: OUTPUT_ITEM },
    top_trends_or_patterns: { type: "array", items: TREND_ITEM },
    top_happenings:         { type: "array", items: OUTPUT_ITEM },
    early_signals: {
      type: "array",
      items: {
        ...OUTPUT_ITEM,
        properties: { ...OUTPUT_ITEM.properties, why_early: { type: "string" } },
      },
    },
    outlook_6_months: {
      type: "object",
      required: ["observed_basis", "projected_trajectory", "reasoning", "confidence", "supporting_evidence_ids"],
      properties: {
        observed_basis:          { type: "string" },
        projected_trajectory:    { type: "string" },
        reasoning:               { type: "string" },
        confidence:              { type: "string", enum: ["high", "medium", "low"] },
        caveat_if_any:           { type: ["string", "null"] },
        supporting_evidence_ids: { type: "array", items: { type: "string" } },
      },
    },
    recommendations: { type: "array", items: OUTPUT_ITEM },
    evidence_gaps:   { type: "array", items: { type: "string" } },
  },
};

const SYSTEM_PROMPT = `You are a senior AI-threat intelligence analyst writing the analysis for ONE threat category.

You are given a compact EVIDENCE DOSSIER with three origins:
  5A_rawfact  — atomic facts extracted from the collected corpus (each has an evidence_strength and permitted_uses)
  5B_analytics — corpus-level measurements (frequencies, distributions, maturity) — CORPUS-SCOPED, not global
  5C_external — authoritative external statistics / reports / benchmarks

## METHOD — VIEWPOINTS FIRST
1. Read ALL the evidence across 5A/5B/5C.
2. Identify the strongest analytical VIEWPOINTS — interpretations that explain WHY the evidence matters
   (e.g. "agentic risk is shifting from prompt manipulation toward tool-execution abuse").
3. Only then write the outputs, and trace each one back to specific evidence_ids from the dossier.

Evidence becomes important when it supports a strong category viewpoint — never rank evidence in isolation.

## HARD RULES
- Use ONLY evidence_ids that appear in the dossier. NEVER invent an id or a fact not in the dossier.
- Every output item MUST cite supporting_evidence_ids (≥1) and set evidence_origins to the origins of those ids.
- CORPUS-SCOPED language for anything from 5B ("within the collected corpus", "among collected sources"). No global claims unless backed by 5C.
- A "trend" requires ≥3 non-duplicate items from ≥2 distinct sources across separated time windows. If unsure, label it "recurring_pattern" or "early_signal". Never use "surging/exploding/dominant/widespread/accelerating" unless 5B/5C explicitly supports it.
- Do NOT claim real-world adversary ADOPTION unless cited 5A evidence is from an observed source type (incident / threat_intelligence / adversary_adoption_signal). Research/benchmark = capability, not adoption.
- Do NOT use context-only evidence as proof of operational activity.
- outlook_6_months MUST separate observed_basis (what is already in evidence) from projected_trajectory (what may happen). Confidence high only when ≥2 origins converge.
- top_insights ≤3, top_trends_or_patterns ≤3, top_happenings ≤3, early_signals ≤3, recommendations ≤3.
- top_happenings are CONCRETE factual events (incidents, disclosures, releases, benchmark results) — not interpretation.
- If evidence is thin, return fewer items and say so in evidence_gaps. Do not pad.

## PER ITEM
text, supporting_evidence_ids[], evidence_origins[], why_this_matters, confidence (high/medium/low),
caveat_if_any (or null), slide_usefulness (high/medium/low). Trends also: pattern_label.

Return strict JSON matching the schema. No markdown, no preamble.`;

function fmt5A(items) {
  return items.map((e) =>
    `  [${e.evidence_id}] (${e.source_type}/${e.evidence_strength}) ${e.fact}` +
    (e.numbers?.length ? ` | nums: ${e.numbers.join("; ")}` : "") +
    (e.permitted_uses?.length ? ` | uses: ${e.permitted_uses.join(",")}` : "") +
    (e.limitations?.length ? ` | limits: ${e.limitations.join(",")}` : "")
  ).join("\n") || "  (none)";
}
function fmt5B(items) {
  return items.map((e) =>
    `  [${e.evidence_id}] ${e.metric}: ${e.finding || e.value_summary} (n=${e.source_count}, conf=${e.confidence}${e.caveat ? `, caveat: ${e.caveat}` : ""})`
  ).join("\n") || "  (none)";
}
function fmt5C(items) {
  return items.map((e) =>
    `  [${e.evidence_id}] ${e.title} — ${e.claim}` +
    (e.metric_value ? ` | ${e.metric_name || "metric"}: ${e.metric_value}` : "") +
    (e.publisher ? ` [${e.publisher}]` : "")
  ).join("\n") || "  (none)";
}

function buildUserPrompt(cd) {
  return [
    `CATEGORY: ${cd.category}`,
    `SOURCES IN CATEGORY: ${cd.source_count}`,
    `TREND SUPPORT: ${cd.trend_support.item_count} dated items, ${cd.trend_support.distinct_publishers} distinct publishers, ${cd.trend_support.distinct_months} distinct months`,
    `CORPUS CONFIDENCE: ${cd.confidence_assessment}`,
    ``,
    `=== 5A RAWFACT EVIDENCE (corpus facts) ===`,
    fmt5A(cd.evidence_5A),
    ``,
    `=== 5B ANALYTICS EVIDENCE (corpus measurements — corpus-scoped) ===`,
    fmt5B(cd.evidence_5B),
    ``,
    `=== 5C EXTERNAL EVIDENCE (authoritative external) ===`,
    fmt5C(cd.evidence_5C),
    ``,
    cd.evidence_gaps.length ? `KNOWN EVIDENCE GAPS: ${cd.evidence_gaps.join("; ")}` : "",
    ``,
    `Produce the category analysis (viewpoints first), citing only evidence_ids listed above.`,
  ].filter((l) => l !== "").join("\n");
}

/**
 * Run the single category-synthesis LLM call.
 * @param {object}   compactDossier  Output of buildCategoryEvidenceDossier().
 * @param {object}   [opts]
 * @param {Function} [opts.llmFn=routedLLM]  Injectable for tests.
 * @returns {Promise<object|null>} parsed contract (sans validation) or null.
 */
export async function synthesizeCategory(compactDossier, opts = {}) {
  const { llmFn = routedLLM } = opts;
  try {
    const { result, llm_metadata } = await llmFn(SYSTEM_PROMPT, buildUserPrompt(compactDossier), {
      task:          "category_synthesis",
      schema:        SCHEMA,
      requires_json: true,
      logLabel:      `L6-category-synthesis-${compactDossier.category}`,
    });
    if (!result || llm_metadata?.llm_used === false) return null;
    return { ...result, model_used: llm_metadata?.model_used || "category_synthesis" };
  } catch {
    return null;
  }
}

export { SCHEMA as CATEGORY_SYNTHESIS_SCHEMA };
