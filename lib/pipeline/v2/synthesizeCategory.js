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
          evidence_maturity:  { type: "string", enum: [
            "research_demonstration",
            "disclosed_vulnerability",
            "observed_exploitation",
            "adversary_adoption",
            "operational_campaign",
          ]},
          evidence_for:       { type: "array", items: { type: "string" } },
          evidence_against:   { type: "array", items: { type: "string" } },
          caveats:            { type: "array", items: { type: "string" } },
          short_takeaway:     { type: "string" },
          technique_focus:    { type: "array", items: { type: "string" } },
          monitoring_signals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                signal:               { type: "string" },
                why_it_matters:       { type: "string" },
                current_evidence:     { type: "string" },
                escalation_trigger:   { type: "string" },
                monitoring_source_type: { type: "string" },
              },
              required: ["signal", "why_it_matters", "escalation_trigger"],
            },
          },
          recommended_action: { type: "string" },
        },
        required: [
          "judgment", "what_changed", "why_this_matters",
          "confidence", "evidence_maturity", "evidence_for", "caveats", "short_takeaway",
        ],
      },
    },
    outlook_assessment: {
      type: "object",
      properties: {
        observed_basis:        { type: "string" },
        likely_next_movement:  { type: "string" },
        escalation_trigger:    { type: "string" },
        confidence:            { type: "string", enum: ["high", "medium", "low"] },
        what_would_invalidate: { type: "string" },
      },
      required: ["observed_basis", "likely_next_movement", "escalation_trigger", "confidence", "what_would_invalidate"],
    },
    coverage_assessment: { type: "string" },
    evidence_gaps:       { type: "array", items: { type: "string" } },
  },
  required: ["judgments", "coverage_assessment"],
};

function buildSynthesisSystem() {
  return `You are a principal threat intelligence analyst writing a strategic assessment for a cybersecurity leadership briefing.

Your job is to produce 2-4 strategic judgments and a structured outlook for the assigned threat category.

═══ EVIDENCE MATURITY — REQUIRED for every judgment ═══
Assign exactly one maturity level. These are strict definitions:
  research_demonstration   — Lab-proven feasibility. No real-world deployment confirmed.
  disclosed_vulnerability  — A CVE, advisory, or researcher disclosure confirms an exploitable flaw.
  observed_exploitation    — Incident reporting or threat intelligence confirms in-the-wild exploitation.
  adversary_adoption       — A named threat actor or criminal group is confirmed using this technique.
  operational_campaign     — Sustained, attributed campaign across multiple incidents.

RULES:
  ✗ NEVER write "operational use" unless evidence_maturity is adversary_adoption or operational_campaign.
  ✗ A CVE alone = disclosed_vulnerability, NOT observed_exploitation.
  ✗ A research paper alone = research_demonstration, regardless of how convincing the results.
  ✓ When maturity is research_demonstration or disclosed_vulnerability, write:
    "Exploitable attack surface is visible; adversary adoption remains unconfirmed."
  ✓ When only one source supports a claim, add caveat: "single-source signal — treat as early indicator."

═══ ANALYTICAL QUALITY — REQUIRED ═══
1. ANALYTICAL, NOT DESCRIPTIVE
   BAD:  "Attackers are using AI for phishing."
   GOOD: "AI-generated spear-phishing now bypasses attention-based filters at scale because per-recipient personalisation previously required human effort that LLMs eliminate. [research_demonstration — adversary adoption unconfirmed]"

2. CAUSAL, NOT CORRELATIONAL
   State the mechanism — WHY is this happening? What changed that makes it possible NOW?

3. EACH JUDGMENT must answer:
   - What happened or was demonstrated?
   - Why does the existing control assumption break?
   - What new attack path or blast radius opens up?
   - What would defenders miss if they only tracked conventional threats?

4. CONFIDENCE must match evidence strength:
   high   = 2+ strong items from high-trust sources, consistent findings, evidence_maturity ≥ observed_exploitation
   medium = 1-2 usable items, some inconsistency, or maturity = disclosed_vulnerability
   low    = context-only, single source, or maturity = research_demonstration only

5. MONITORING SIGNALS — structured objects, not plain strings:
   Each signal must include: what to look for (signal), why it matters (why_it_matters),
   what evidence currently exists (current_evidence), what would confirm escalation
   (escalation_trigger), and what data source to watch (monitoring_source_type).

6. OUTLOOK — produce one outlook_assessment for the category:
   observed_basis:        What do we actually see in the evidence right now?
   likely_next_movement:  Where is this heading, and why?
   escalation_trigger:    What specific event would move this to the next maturity level?
   confidence:            high / medium / low
   what_would_invalidate: What would prove this outlook wrong?
   Do NOT write generic outlooks like "threats may increase." Every outlook must be specific.

short_takeaway: ≤15 words. The single most important point. No vague language.

${buildTaxonomyPromptBlock()}

Return ONLY valid JSON. No markdown, no preamble.

CRITICAL: evidence_for MUST contain exact evidence IDs (e.g., "ev-fixture--1") from the dossier. Copy verbatim.`;
}

function buildSynthesisUser(category, dossier_text) {
  return `Produce strategic judgments and outlook for: ${category.replace(/_/g, " ").toUpperCase()}

${dossier_text}

Generate 2-4 judgments. Requirements:
- evidence_for[]: exact IDs from the dossier (e.g. "ev-abc123-2"). Copy verbatim from [brackets] at start of each evidence block.
- evidence_maturity: assign the correct level — do not over-classify (a CVE ≠ observed_exploitation).
- monitoring_signals: structured objects with signal/why_it_matters/current_evidence/escalation_trigger/monitoring_source_type.
- outlook_assessment: one structured forward-looking assessment for the whole category.
- If corpus is thin: 1 judgment at low confidence + full evidence_gaps list. Do not inflate confidence.`;
}

async function callSynthesis(category, dossier_text, opts) {
  if (opts.skipLlm) {
    return {
      judgments: [{
        judgment:           `Stub judgment for ${category} (LLM disabled)`,
        what_changed:       "LLM disabled",
        why_this_matters:   "N/A",
        causal_mechanism:   "N/A",
        confidence:         "low",
        evidence_maturity:  "research_demonstration",
        evidence_for:       [],
        evidence_against:   [],
        caveats:            ["LLM calls disabled — deterministic stub"],
        short_takeaway:     "LLM disabled",
        technique_focus:    [],
        monitoring_signals: [],
        recommended_action: "Enable LLM for real synthesis",
      }],
      outlook_assessment: {
        observed_basis:        "LLM disabled — no assessment",
        likely_next_movement:  "Unknown",
        escalation_trigger:    "Unknown",
        confidence:            "low",
        what_would_invalidate: "Unknown",
      },
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
    evidence_ids:        Object.keys(evidence_index),
    evidence_gaps:       raw.evidence_gaps || [],
    coverage_assessment: raw.coverage_assessment || "",
    outlook_assessment:  raw.outlook_assessment || null,
    synthesis_version:   SYNTHESIS_VERSION,
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
