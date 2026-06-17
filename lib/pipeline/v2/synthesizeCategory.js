/**
 * v2 — synthesizeCategory()
 *
 * Replaces the L6 analysis stack (22 files: buildAnalyticalState 34K,
 * synthesizeCategory 29K, claimQa 41K, validateCategoryAnalysis 18K, …)
 * with a 3-step pipeline:
 *
 *   Step 1  buildDossier()       deterministic — packages evidence for the LLM
 *   Step 2  callSynthesis()      ONE Opus/Sonnet call → strategic judgments
 *   Step 3  evaluateJudgments()  deterministic rubric — blocks hollow outputs
 *
 * The LLM forms its own analytical state. We do not pre-compute signals,
 * confidence ceilings, or claim permissions before the call.
 */

import { routedLLM }  from "../../llm/llmRouter.js";
import { callLLM }    from "../../llm/callLLM.js";
import { DOMAIN_RULES, buildTaxonomyPromptBlock } from "./taxonomy.js";
import { randomUUID } from "crypto";

export const SYNTHESIS_VERSION = "synthesis-v2.0";

// ── Step 1: Build dossier ─────────────────────────────────────────────────────
// Packages evidence into a clean text block the LLM can reason over.
// No pre-analysis, no signal mapping, no confidence ceilings.

function buildDossier(category, pack, sources, corpusSummary) {
  const allItems = [...pack.strong, ...pack.usable, ...pack.context];

  if (allItems.length === 0) {
    return { dossier_text: "(no evidence for this category)", evidence_index: {} };
  }

  const evidence_index = {};
  const lines = [
    `CATEGORY: ${category.replace(/_/g, " ").toUpperCase()}`,
    `DOMAIN RULE: ${DOMAIN_RULES[category] || ""}`,
    "",
    `CORPUS COVERAGE:`,
    `  Sources: ${corpusSummary.source_count_by_category?.[category] || 0} of ${corpusSummary.total_sources} total`,
    `  Date range: ${corpusSummary.date_range || "unknown"}`,
    `  Trust tiers present: ${corpusSummary.trust_by_category?.[category] || "unknown"}`,
    "",
    `EVIDENCE (${allItems.length} items, ${pack.strong.length} strong / ${pack.usable.length} usable / ${pack.context.length} context):`,
    "",
  ];

  for (const ei of allItems) {
    evidence_index[ei.evidence_id] = {
      fact:        ei.fact,
      source_id:   ei.source_id,
      source_url:  ei.source_url,
      trust_tier:  ei.trust_tier,
      specificity: ei.specificity,
    };

    const tier   = ei.is_cluster_rep ? "[STRONG]" : "[CONTEXT]";
    const grnd   = ei.quote_grounded ? "✓grounded" : "~inferred";
    lines.push(`[${ei.evidence_id}] ${tier} ${grnd} (${ei.evidence_type}, ${ei.specificity} specificity)`);
    lines.push(`  FACT: ${ei.fact}`);
    if (ei.quote && ei.quote_grounded) {
      lines.push(`  QUOTE: "${ei.quote}"`);
    }
    lines.push(`  SOURCE: ${ei.source_title || ei.source_url || ei.source_id} [${ei.trust_tier}]`);
    if (ei.technique_tags?.length) {
      lines.push(`  TAGS: ${ei.technique_tags.join(", ")}`);
    }
    lines.push("");
  }

  return { dossier_text: lines.join("\n"), evidence_index };
}

// ── Step 2: Synthesis LLM call ────────────────────────────────────────────────

const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    judgments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          judgment:           { type: "string" },
          what_changed:       { type: "string" },
          why_this_matters:   { type: "string" },
          causal_mechanism:   { type: "string" },
          confidence:         { type: "string", enum: ["high", "medium", "low"] },
          evidence_for:       { type: "array", items: { type: "string" } },
          evidence_against:   { type: "array", items: { type: "string" } },
          caveats:            { type: "array", items: { type: "string" } },
          short_takeaway:     { type: "string" },
          technique_focus:    { type: "array", items: { type: "string" } },
          monitoring_signals: { type: "array", items: { type: "string" } },
          recommended_action: { type: "string" },
        },
        required: [
          "judgment", "what_changed", "why_this_matters",
          "confidence", "evidence_for", "caveats", "short_takeaway",
        ],
      },
    },
    coverage_assessment: { type: "string" },
    evidence_gaps:       { type: "array", items: { type: "string" } },
  },
  required: ["judgments", "coverage_assessment"],
};

function buildSynthesisSystem() {
  return `You are a principal threat intelligence analyst writing a strategic assessment for a cybersecurity leadership briefing.

Your job is to produce 2-4 strategic judgments for the assigned threat category. Each judgment must:

1. ANALYTICAL, NOT DESCRIPTIVE
   Bad: "Threat actors are increasingly using AI for phishing"
   Good: "Spear-phishing success rates have increased ~3× since LLM integration because personalisation at scale overcomes the attention filters defenders trained users to apply"

2. CAUSAL, NOT CORRELATIONAL
   Explain the mechanism: WHY is this happening? What changed that makes it possible now?

3. EVIDENCE-GROUNDED
   Every judgment must cite specific evidence IDs from the dossier.
   Confidence must match the evidence strength:
   - high = multiple strong/usable items from high-trust sources, consistent findings
   - medium = 1-2 usable items or some inconsistency
   - low = context-only evidence or single source

4. HONEST ABOUT LIMITS
   If there is only weak evidence, say so in caveats. Do not fabricate confidence.

5. ACTIONABLE
   End with what a defender or analyst should monitor or do next.

short_takeaway must be ≤15 words and capture the single most important point.

${buildTaxonomyPromptBlock()}

Return ONLY valid JSON in this EXACT format (no markdown, no preamble):

{
  "judgments": [
    {
      "judgment": "full analytical statement (2-3 sentences)",
      "what_changed": "specific change that is new or different",
      "why_this_matters": "consequence for defenders or the ecosystem",
      "causal_mechanism": "the mechanism that makes this happen",
      "confidence": "high | medium | low",
      "evidence_for": ["ev-xxx-1", "ev-xxx-2"],
      "evidence_against": [],
      "caveats": ["limitation or uncertainty"],
      "short_takeaway": "≤15 words headline",
      "technique_focus": ["TAI01_data_poisoning"],
      "monitoring_signals": ["what to watch for"],
      "recommended_action": "one specific action"
    }
  ],
  "coverage_assessment": "brief note on corpus quality",
  "evidence_gaps": ["what evidence is missing"]
}

CRITICAL: evidence_for MUST contain exact evidence IDs (e.g., "ev-fixture--1") from the dossier above. Copy them verbatim.`;
}

function buildSynthesisUser(category, dossier_text) {
  return `Produce strategic judgments for: ${category.replace(/_/g, " ").toUpperCase()}

${dossier_text}

Generate 2-4 judgments. For each judgment, populate evidence_for[] with the exact evidence IDs shown in brackets above (e.g., "ev-fixture--1", "ev-abc123-2"). These IDs appear at the START of each evidence block like: [ev-fixture--1].
If the corpus is too thin for confident assessment, produce 1 judgment at low confidence and identify evidence gaps.`;
}

async function callSynthesis(category, dossier_text, opts) {
  if (opts.skipLlm) {
    return {
      judgments: [{
        judgment:         `Stub judgment for ${category} (LLM disabled)`,
        what_changed:     "LLM disabled",
        why_this_matters: "N/A",
        causal_mechanism: "N/A",
        confidence:       "low",
        evidence_for:     [],
        evidence_against: [],
        caveats:          ["LLM calls disabled — deterministic stub"],
        short_takeaway:   "LLM disabled",
        technique_focus:  [],
        monitoring_signals: [],
        recommended_action: "Enable LLM for real synthesis",
      }],
      coverage_assessment: "LLM disabled",
      evidence_gaps: [],
    };
  }

  const sys = buildSynthesisSystem();
  const usr = buildSynthesisUser(category, dossier_text);

  let raw;
  try {
    const { result } = await routedLLM(sys, usr, {
      task: "category_synthesis",
      requires_json: true,
      schema: SYNTHESIS_SCHEMA,
    });
    raw = typeof result === "string" ? JSON.parse(result) : result;
  } catch {
    const text = await callLLM(sys, usr, { schema: SYNTHESIS_SCHEMA, json: true });
    raw = typeof text === "string" ? JSON.parse(text) : text;
  }
  return raw;
}

// ── Step 3: Evaluate judgments ────────────────────────────────────────────────
// Deterministic rubric. Blocks hollow outputs. No 41K of rule-based claim QA.

function evaluateJudgments(judgments, evidence_index) {
  return judgments.map(j => {
    const issues = [];

    // Hard block: no evidence cited
    const resolvedEvIds = (j.evidence_for || []).filter(id => id in evidence_index);
    if (resolvedEvIds.length === 0) {
      issues.push("no_evidence_cited");
    }

    // Hard block: judgment is descriptive not analytical
    const analytical = j.what_changed?.length > 20 && j.why_this_matters?.length > 20;
    if (!analytical) {
      issues.push("descriptive_not_analytical");
    }

    // Soft flag: confidence overreach
    if (j.confidence === "high" && resolvedEvIds.length < 2) {
      issues.push("confidence_overreach");
    }

    // Soft flag: no caveats on low evidence
    if ((j.caveats || []).length === 0 && j.confidence !== "high") {
      issues.push("missing_caveats");
    }

    const blocked = issues.includes("no_evidence_cited") || issues.includes("descriptive_not_analytical");

    return {
      ...j,
      judgment_id:          randomUUID(),
      evidence_for:         resolvedEvIds,
      qa_issues:            issues,
      blocked:              blocked,
      approved_for_dashboard: !blocked,
      approved_for_slides:    !blocked,
      approved_for_chatbot:   !blocked && j.confidence !== "low",
    };
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Synthesize strategic analysis for a single threat category.
 *
 * @param {string}   category       - Threat category ID
 * @param {object}   pack           - Evidence pack from assembleEvidencePacks()
 * @param {object[]} sources        - All understood sources (for corpus summary)
 * @param {object}   corpusSummary  - Aggregated corpus stats
 * @param {object}   [opts]
 * @returns {Promise<object>}        Category analysis result
 */
export async function synthesizeCategory(category, pack, sources, corpusSummary, opts = {}) {
  const { dossier_text, evidence_index } = buildDossier(category, pack, sources, corpusSummary);

  const allItems = [...(pack?.strong || []), ...(pack?.usable || []), ...(pack?.context || [])];
  if (allItems.length === 0) {
    return {
      category,
      assessment_status: "insufficient_evidence",
      judgments: [],
      evidence_ids: [],
      evidence_gaps: [`No evidence found for ${category}`],
      coverage_assessment: "No evidence in corpus for this category.",
      synthesis_version: SYNTHESIS_VERSION,
    };
  }

  let raw;
  try {
    raw = await callSynthesis(category, dossier_text, opts);
  } catch (err) {
    return {
      category,
      assessment_status: "synthesis_error",
      judgments: [],
      evidence_ids: [],
      evidence_gaps: [],
      coverage_assessment: `Synthesis failed: ${err.message}`,
      synthesis_version: SYNTHESIS_VERSION,
      error: err.message,
    };
  }

  const evaluated = evaluateJudgments(raw.judgments || [], evidence_index);
  const approved  = evaluated.filter(j => !j.blocked);

  return {
    category,
    assessment_status: approved.length > 0 ? "assessed" : "insufficient_quality",
    judgments: evaluated,
    approved_judgment_count: approved.length,
    blocked_judgment_count:  evaluated.length - approved.length,
    evidence_ids:      Object.keys(evidence_index),
    evidence_gaps:     raw.evidence_gaps || [],
    coverage_assessment: raw.coverage_assessment || "",
    synthesis_version: SYNTHESIS_VERSION,
  };
}

/**
 * Synthesize all categories from evidence packs.
 *
 * @param {object[]} packs         - From extractAllEvidence()
 * @param {object[]} sources       - Understood sources
 * @param {object}   corpusSummary - From buildCorpusSummary()
 * @param {object}   [opts]
 * @returns {Promise<object[]>}    Array of category analyses
 */
export async function synthesizeAllCategories(packs, sources, corpusSummary, opts = {}) {
  const analyses = [];
  for (const pack of packs) {
    process.stdout.write(`  [L6] synthesizing ${pack.category}... `);
    try {
      const analysis = await synthesizeCategory(pack.category, pack, sources, corpusSummary, opts);
      analyses.push(analysis);
      process.stdout.write(`${analysis.approved_judgment_count || 0} judgments approved\n`);
    } catch (err) {
      process.stdout.write(`ERROR: ${err.message}\n`);
      analyses.push({
        category: pack.category,
        assessment_status: "error",
        judgments: [],
        error: err.message,
        synthesis_version: SYNTHESIS_VERSION,
      });
    }
  }
  return analyses;
}

// ── Cross-category synthesis ──────────────────────────────────────────────────

const CROSS_CAT_SCHEMA = {
  type: "object",
  properties: {
    patterns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pattern:       { type: "string" },
          description:   { type: "string" },
          categories:    { type: "array", items: { type: "string" } },
          evidence_ids:  { type: "array", items: { type: "string" } },
          implication:   { type: "string" },
        },
        required: ["pattern", "description", "categories", "implication"],
      },
    },
    ecosystem_assessment: { type: "string" },
    top_priority:         { type: "string" },
  },
  required: ["patterns", "ecosystem_assessment"],
};

/**
 * Run a cross-category synthesis pass (one call) to find convergence patterns.
 */
export async function synthesizeCrossCategory(categoryAnalyses, opts = {}) {
  const approved = categoryAnalyses.flatMap(ca =>
    (ca.judgments || []).filter(j => !j.blocked).map(j => ({
      category: ca.category,
      judgment: j.judgment,
      judgment_id: j.judgment_id,
      evidence_ids: j.evidence_for || [],
      confidence: j.confidence,
    }))
  );

  if (approved.length === 0 || opts.skipLlm) {
    return { patterns: [], ecosystem_assessment: "Insufficient approved judgments for cross-category synthesis." };
  }

  const judgmentBlock = approved.map(j =>
    `[${j.category}] ${j.judgment} (confidence: ${j.confidence}, evidence: ${j.evidence_ids.join(", ")})`
  ).join("\n");

  const sys = `You are a senior threat intelligence analyst identifying cross-domain patterns across the AI threat landscape.`;
  const usr = `Identify 1-3 cross-category convergence patterns from these approved judgments:

${judgmentBlock}

Look for:
- Techniques that appear across multiple categories (e.g., prompt injection enabling agent compromise)
- Trends with ecosystem-wide implications
- Compounding risks (where multiple threats interact)

Return JSON only.`;

  try {
    let raw;
    try {
      const { result } = await routedLLM(sys, usr, {
        task: "cross_category_synthesis",
        requires_json: true,
        schema: CROSS_CAT_SCHEMA,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const text = await callLLM(sys, usr, { schema: CROSS_CAT_SCHEMA, json: true });
      raw = typeof text === "string" ? JSON.parse(text) : text;
    }
    return raw;
  } catch (err) {
    return { patterns: [], ecosystem_assessment: `Cross-category synthesis error: ${err.message}` };
  }
}
