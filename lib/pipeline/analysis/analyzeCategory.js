/**
 * L6 Step 3 — Category Analysis (LLM call)
 *
 * Takes a pre-built dossier and source index and makes one Sonnet/Opus call
 * to produce up to 3 strategic insights per category.
 *
 * Each insight carries:
 *   - Four mandatory analytical fields (title, what_changed, mechanism, implication)
 *   - Evidence maturity and confidence
 *   - cited_sources[] with source_id copied verbatim from the dossier
 *   - monitoring_signal, technique_tags, caveats
 *
 * Post-call: cited source_ids are validated against the source_index.
 * evidence_item_ids are resolved from L5 evidence items by source_id.
 *
 * Prompt: lib/prompts/analysis/analyze-category.md
 */

import { routedLLM }   from "../../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";
import { randomUUID }  from "crypto";

export const ANALYSIS_VERSION = "analysis-v1.0";

// ── Category scope definitions ────────────────────────────────────────────────

export const CATEGORY_SCOPE = {
  traditional_ai_threats: {
    framing_question: "How are attacks that TARGET machine-learning / AI models themselves evolving in this period?",
    in_scope: "data poisoning, training-data manipulation, model extraction / model theft, model inversion & membership inference, adversarial examples / evasion attacks, model backdoors, attacks on ML supply chain (poisoned weights, malicious models on model hubs).",
    out_of_scope: "AI used AS an attack tool (that is AI-Enabled Threats); prompt injection / jailbreaks (LLM Threats); agent/tool abuse (Agentic); ordinary CVEs in apps that merely happen to use AI.",
    incident_hook: "model theft, weight exfiltration, a poisoned model on a hub, a real evasion attack on a deployed classifier.",
  },
  llm_threats: {
    framing_question: "How are attacks that TARGET large language models and their pipelines evolving in this period?",
    in_scope: "prompt injection (direct & indirect), jailbreaks / guardrail bypass, system-prompt leakage, training-data extraction, RAG poisoning, output-handling exploits against LLM applications.",
    out_of_scope: "autonomous agent / tool-calling abuse (Agentic); AI used to generate malware or phishing (AI-Enabled); classical ML-model attacks (Traditional).",
    incident_hook: "a real indirect-prompt-injection breach, data exfiltration via an LLM app, a guardrail bypass used in the wild.",
  },
  agentic_ai_threats: {
    framing_question: "How are attacks that TARGET AI agents, their tools, and their ecosystems evolving in this period?",
    in_scope: "agent goal hijack, tool/function-call abuse, MCP-server and plugin/skill-marketplace compromise, memory/context poisoning, autonomous-agent privilege escalation, agent supply-chain attacks.",
    out_of_scope: "single-shot prompt injection against a chatbot with no tools (LLM Threats); classical ML-model attacks (Traditional); AI-generated attack content (AI-Enabled).",
    incident_hook: "a malicious agent skill/plugin, an MCP compromise, an agent tricked into a harmful tool call.",
  },
  ai_enabled_threats: {
    framing_question: "How is AI being used AS an offensive tool by attackers in this period?",
    in_scope: "AI-generated phishing / social engineering, deepfakes & voice cloning, AI-assisted malware or exploit generation, AI-scaled disinformation, AI-accelerated reconnaissance.",
    out_of_scope: "attacks ON AI systems (those are the other three categories). The AI must be the attacker's TOOL, evidenced in the source.",
    incident_hook: "a real campaign using AI-built malware, a deepfake fraud, AI-generated phishing at scale.",
  },
};

// ── Output schema ─────────────────────────────────────────────────────────────

const CITED_SOURCE_SCHEMA = {
  type: "object",
  properties: {
    source_id:        { type: "string" },
    quote:            { type: "string" },
    evidence_summary: { type: "string" },
  },
  required: ["source_id", "evidence_summary"],
};

const INSIGHT_SCHEMA = {
  type: "object",
  properties: {
    title:             { type: "string" },
    what_changed:      { type: "string" },
    mechanism:         { type: "string" },
    implication:       { type: "string" },
    evidence_maturity: {
      type: "string",
      enum: ["research_demonstration", "disclosed_vulnerability", "observed_exploitation", "adversary_adoption", "operational_campaign"],
    },
    confidence:   { type: "string", enum: ["high", "medium", "low"] },
    cited_sources:{ type: "array", items: CITED_SOURCE_SCHEMA },
    technique_tags:    { type: "array", items: { type: "string" } },
    monitoring_signal: { type: "string" },
    caveats:           { type: "array", items: { type: "string" } },
  },
  required: ["title", "what_changed", "mechanism", "implication", "evidence_maturity", "confidence", "cited_sources"],
};

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    insights:      { type: "array", items: INSIGHT_SCHEMA },
    coverage_gaps: { type: "array", items: { type: "string" } },
  },
  required: ["insights"],
};

// ── Prompt loading (cached) ───────────────────────────────────────────────────

let _prompts = null;
function getPrompts() {
  if (!_prompts) _prompts = loadPrompt("analysis/analyze-category");
  return _prompts;
}

// ── Critical field validation ─────────────────────────────────────────────────

const CRITICAL_FIELDS = ["title", "what_changed", "mechanism", "implication"];
const MIN_LEN = 20;

function hasCriticalFields(raw) {
  return (raw?.insights || []).every(ins =>
    CRITICAL_FIELDS.every(f => typeof ins[f] === "string" && ins[f].trim().length >= MIN_LEN)
  );
}

function missingFields(raw) {
  const missing = new Set();
  for (const ins of raw?.insights || []) {
    for (const f of CRITICAL_FIELDS) {
      if (!ins[f] || String(ins[f]).trim().length < MIN_LEN) missing.add(f);
    }
  }
  return [...missing];
}

// ── LLM call ─────────────────────────────────────────────────────────────────

async function callAnalysisLLM(category, dossierText, windowLabel, dateFrom, dateTo) {
  const { system, user: userTmpl } = getPrompts();
  const scope = CATEGORY_SCOPE[category] || {};

  const user = interpolate(userTmpl, {
    category:         category.replace(/_/g, " ").toUpperCase(),
    period_label:     windowLabel,
    date_from:        dateFrom,
    date_to:          dateTo,
    framing_question: scope.framing_question || "",
    in_scope:         scope.in_scope || "",
    out_of_scope:     scope.out_of_scope || "",
    incident_hook:    scope.incident_hook || "",
    dossier_text:     dossierText,
  });

  async function attempt(userPrompt) {
    try {
      const { result } = await routedLLM(system, userPrompt, {
        task: "category_synthesis",
        requires_json: true,
        schema: OUTPUT_SCHEMA,
      });
      return typeof result === "string" ? JSON.parse(result) : result;
    } catch (err) {
      // Structured output failed — try without schema
      const { callLLM } = await import("../../llm/callLLM.js");
      const text = await callLLM(system, userPrompt, { schema: OUTPUT_SCHEMA, json: true });
      return typeof text === "string" ? JSON.parse(text) : text;
    }
  }

  let raw = await attempt(user);

  // Retry once if critical fields came back empty
  if (!hasCriticalFields(raw)) {
    const missing = missingFields(raw);
    const retryUser = `${user}

RETRY INSTRUCTION: Your previous response returned empty or placeholder values for: ${missing.join(", ")}.
These fields are MANDATORY and must each contain at least one full sentence of substantive analysis.
${missing.includes("mechanism") ? '"mechanism" must explain WHY this is happening now — the technical or economic root cause. Not a restatement of what_changed.' : ""}
${missing.includes("implication") ? '"implication" must name the specific defender assumption that breaks and what new attack path opens.' : ""}
Do NOT return empty strings or "N/A". Write the actual analytical content.`;

    process.stdout.write(`  [L6] ${category}: critical fields empty (${missing.join(", ")}) — retrying\n`);
    try {
      raw = await attempt(retryUser);
    } catch {
      // Keep original if retry also fails
    }
  }

  return raw;
}

// ── Post-call: validate + enrich cited sources ────────────────────────────────

function validateAndEnrichCitations(insights, sourceIndex, evidenceItems = []) {
  // Build lookup: source_id → evidence items from that source
  const evBySource = {};
  for (const ei of evidenceItems) {
    const sid = ei.source_id || ei.source?.id;
    if (!sid) continue;
    if (!evBySource[sid]) evBySource[sid] = [];
    evBySource[sid].push(ei);
  }

  return insights.map(ins => {
    const validCited = [];
    for (const cs of ins.cited_sources || []) {
      const meta = sourceIndex[cs.source_id];
      if (!meta) continue; // LLM hallucinated an ID — drop it

      validCited.push({
        ...meta,
        quote:            cs.quote || "",
        evidence_summary: cs.evidence_summary || "",
      });
    }

    // Resolve evidence item IDs from cited sources (for slide builder)
    const SPEC = { high: 2, medium: 1, low: 0 };
    const evidenceItemIds = validCited.flatMap(cs => {
      const items = (evBySource[cs.source_id] || [])
        .filter(ei => ei.is_cluster_rep || ei.specificity === "high")
        .sort((a, b) => (SPEC[b.specificity] || 0) - (SPEC[a.specificity] || 0))
        .slice(0, 2);
      return items.map(ei => ei.evidence_id);
    });

    return {
      ...ins,
      insight_id:       randomUUID(),
      cited_sources:    validCited,
      evidence_item_ids: [...new Set(evidenceItemIds)],
    };
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyse one threat category and produce strategic insights.
 *
 * @param {string}   category      - e.g. "llm_threats"
 * @param {string}   dossierText   - From buildDossier()
 * @param {object}   sourceIndex   - From buildDossier(): { [source_id]: meta }
 * @param {object[]} evidenceItems - All L5 evidence items (for evidence_item_ids resolution)
 * @param {object}   windowInfo    - { label, date_from, date_to }
 * @param {object}   [opts]
 * @returns {Promise<object>}       Category analysis result
 */
export async function analyzeCategory(category, dossierText, sourceIndex, evidenceItems, windowInfo, opts = {}) {
  const { skipLlm = false } = opts;
  const { label = "unknown period", date_from = "", date_to = "" } = windowInfo || {};

  if (skipLlm) {
    return {
      category,
      assessment_status: "stub",
      insights: [],
      coverage_gaps: ["LLM disabled — no analysis performed"],
      analysis_version: ANALYSIS_VERSION,
    };
  }

  let raw;
  try {
    raw = await callAnalysisLLM(category, dossierText, label, date_from, date_to);
  } catch (err) {
    return {
      category,
      assessment_status: "error",
      insights: [],
      coverage_gaps: [],
      coverage_assessment: `Analysis failed: ${err.message}`,
      analysis_version: ANALYSIS_VERSION,
      error: err.message,
    };
  }

  const rawInsights = raw?.insights || [];
  const enriched    = validateAndEnrichCitations(rawInsights, sourceIndex, evidenceItems);

  return {
    category,
    assessment_status: enriched.length > 0 ? "assessed" : "thin",
    insights:          enriched,
    coverage_gaps:     raw?.coverage_gaps || [],
    analysis_version:  ANALYSIS_VERSION,
  };
}
