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
- OBEY the CORPUS REPRESENTATIVENESS block and its CLAIM CONSTRAINTS (if present). A clean-looking corpus can still be biased; respect vendor_heavy / research_heavy / operational_evidence_sparse / single_publisher_dominance constraints. When a constraint blocks a claim, move it to evidence_gaps instead.
- If an ANALYTICAL STATE block is present: treat the hypothesis candidates as the starting point — confirm or refute each against the evidence, do not invent unrelated claims, and never assign a confidence above the stated CONFIDENCE CEILING for the category.

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

export function buildCorpusAuditBlock(ca) {
  if (!ca) return "";
  const flags = [...(ca.source_concentration_flags || []), ...(ca.evidence_gap_flags || [])];
  const lines = [
    `=== CORPUS REPRESENTATIVENESS (governs what you may claim) ===`,
    `analysis_allowed: ${ca.analysis_allowed || "full"}`,
    flags.length ? `flags: ${flags.join(", ")}` : `flags: none`,
  ];
  for (const lim of (ca.analysis_limitations || [])) lines.push(`- ${lim}`);
  // Hard guidance derived from the flags — the deterministic validator enforces these
  // again afterwards, but stating them here keeps the model from over-claiming.
  const guidance = [];
  if (flags.includes("vendor_heavy"))
    guidance.push("Corpus is vendor-dominated: do NOT make strategic assessments without an explicit vendor-bias caveat.");
  if (flags.includes("research_heavy"))
    guidance.push("Corpus is research-dominated: treat findings as CAPABILITY, not real-world adoption; no operational/adoption claims.");
  if (flags.includes("operational_evidence_sparse"))
    guidance.push("No operational evidence: do NOT assert real-world incidents or adversary adoption.");
  if (flags.some((f) => String(f).startsWith("single_publisher_dominance")))
    guidance.push("One publisher dominates: do NOT present trends — perspective diversity is insufficient.");
  if (ca.analysis_allowed === "insufficient")
    guidance.push("Corpus is INSUFFICIENT: only capability (lab), speculative outlook, and cautionary recommendation claims are permitted; everything else must go in evidence_gaps.");
  if (guidance.length) { lines.push(``); lines.push(`CLAIM CONSTRAINTS:`); for (const g of guidance) lines.push(`- ${g}`); }
  lines.push(``);
  return lines.join("\n");
}

export function buildAnalyticalStateBlock(as) {
  if (!as) return "";
  const lines = [
    `=== ANALYTICAL STATE (deterministic — evaluate, don't invent) ===`,
    `CONFIDENCE CEILING for this category: ${as.confidence_ceiling} (no output may exceed this)`,
  ];
  if ((as.hypothesis_candidates || []).length) {
    lines.push(`PRE-COMPUTED HYPOTHESIS CANDIDATES (confirm/refute against the evidence; cite the listed ids):`);
    for (const c of as.hypothesis_candidates) {
      lines.push(
        `- [ceiling=${c.confidence_ceiling}] ${c.candidate_claim}` +
        (c.supporting_evidence_ids?.length ? ` | ids: ${c.supporting_evidence_ids.join(", ")}` : "")
      );
    }
  }
  lines.push(``);
  return lines.join("\n");
}

function buildUserPrompt(cd) {
  return [
    `CATEGORY: ${cd.category}`,
    `SOURCES IN CATEGORY: ${cd.source_count}`,
    `TREND SUPPORT: ${cd.trend_support.item_count} dated items, ${cd.trend_support.distinct_publishers} distinct publishers, ${cd.trend_support.distinct_months} distinct months`,
    `CORPUS CONFIDENCE: ${cd.confidence_assessment}`,
    ``,
    buildCorpusAuditBlock(cd.corpus_audit),
    buildAnalyticalStateBlock(cd.analytical_state),
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
