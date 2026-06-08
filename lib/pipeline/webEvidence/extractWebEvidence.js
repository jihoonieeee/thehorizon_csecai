/**
 * Layer 5C.6 — Extract candidate web evidence + assess depth/walkthrough.
 *
 * Deterministic depth + walkthrough assessment (the gate that decides what may
 * reach Layer 6), plus an optional cheap-LLM extraction pass. Without an LLM the
 * deterministic path builds a concrete-or-thin object from the opened page's
 * quotes + named entities. Attack steps are NEVER inferred — only steps the
 * source explicitly provides are kept.
 */

import { routedLLM } from "../../llm/llmRouter.js";
import { extractEntities, quoteClaimMatch } from "../discovery/candidateGates.js";
import { makeWebEvidenceObject } from "./webEvidenceSchemas.js";
import { EVIDENCE_EXTRACTION_SCHEMA, EVIDENCE_EXTRACTION_SYSTEM, buildExtractionPrompt } from "./webEvidencePrompts.js";

const VAGUE_PATTERNS = [
  /^ai (increases|is transforming|will transform|changes)/i,
  /threat actors use ai\b/i,
  /agentic systems are vulnerable/i,
  /cyber(security)? teams should prepare/i,
  /ai is (the )?future/i,
];

function isVague(claim) {
  const c = String(claim || "").trim();
  if (c.length < 12) return true;
  return VAGUE_PATTERNS.some((p) => p.test(c));
}

function namedSignals(od = {}) {
  const named = !!(od.affected_system || od.technique ||
    (Array.isArray(od.tools_or_models) && od.tools_or_models.length) ||
    (Array.isArray(od.vulnerabilities_or_weaknesses) && od.vulnerabilities_or_weaknesses.length));
  const hasTechnique = !!od.technique;
  const hasImpact = !!od.impact;
  const hasCveOrMetric =
    (Array.isArray(od.vulnerabilities_or_weaknesses) && od.vulnerabilities_or_weaknesses.length > 0) ||
    !!od.actor;
  return { named, hasTechnique, hasImpact, hasCveOrMetric };
}

/**
 * Walkthrough status from explicitly-provided, grounded steps. Never infers.
 */
export function assessWalkthroughStatus(ev) {
  const steps = ev?.operational_details?.attack_steps || [];
  if (!Array.isArray(steps) || steps.length === 0) return "not_walkthrough";
  const grounded = steps.filter((s) => s && (s.grounded !== false) && (s.quote || s.grounded === true || typeof s === "string"));
  const target = ev?.operational_details?.target || ev?.operational_details?.affected_system;
  const technique = ev?.operational_details?.technique;
  if (steps.length >= 3 && grounded.length === steps.length && target && technique) {
    return "complete_walkthrough";
  }
  if (grounded.length >= 1) return "partial_walkthrough";
  return "not_walkthrough";
}

/**
 * Deterministic evidence depth. Only concrete/detailed/walkthrough_grade enter Layer 6.
 */
export function assessEvidenceDepth(ev) {
  const quotes = ev?.source_grounding?.verbatim_quotes || [];
  const hasQuote = quotes.some((q) => String(q || "").trim().length >= 20);
  const claim = ev?.concrete_claim || "";
  const od = ev?.operational_details || {};
  const { named, hasTechnique, hasImpact, hasCveOrMetric } = namedSignals(od);
  // Always recompute from the (grounded) steps — never trust a stale stored value.
  const walkthrough = assessWalkthroughStatus(ev);

  if (isVague(claim) && !named) return "thin";

  if (walkthrough === "complete_walkthrough" && named && hasTechnique) {
    return "walkthrough_grade";
  }
  if (named && hasTechnique && (hasImpact || hasCveOrMetric) && hasQuote) {
    return "detailed";
  }
  if ((named || hasTechnique) && hasQuote) {
    return "concrete";
  }
  return "thin";
}

// ── Deterministic extraction from an opened page (no LLM) ─────────────────────

function firstAnchoredSentence(text) {
  const sentences = String(text || "").replace(/\s+/g, " ").match(/[^.!?]+[.!?]+/g) || [];
  for (const s of sentences) {
    const t = s.trim();
    if (t.length >= 30 && extractEntities(t).all.length > 0) return t.slice(0, 400);
  }
  return sentences.find((s) => s.trim().length >= 40)?.trim().slice(0, 400) || "";
}

const TECHNIQUE_PATTERNS = [
  "prompt injection", "indirect prompt injection", "tool poisoning", "mcp tool poisoning",
  "data poisoning", "model extraction", "model inversion", "membership inference",
  "rag poisoning", "memory poisoning", "jailbreak", "guardrail bypass", "deepfake",
  "supply chain compromise", "sandbox escape", "goal hijack", "embedding inversion",
];

// Detect explicitly-numbered attack steps the source lays out. Never infers.
function detectAttackSteps(text) {
  const steps = [];
  const re = /step\s*(\d+)\s*[:.)\-]\s*([^.!?\n]{8,200}[.!?])/gi;
  let m;
  while ((m = re.exec(text)) && steps.length < 8) {
    steps.push({ step: m[2].trim(), quote: m[0].trim(), grounded: true });
  }
  return steps;
}

function detectTechnique(text) {
  const t = String(text || "").toLowerCase();
  return TECHNIQUE_PATTERNS.find((p) => t.includes(p)) || null;
}

function detectImpact(text) {
  const s = (String(text || "").match(/[^.!?]*\b(exfiltrat|achiev\w*|success rate|loss(es)?|compromis\w*|breach\w*|\d+(\.\d+)?%)[^.!?]*[.!?]/i) || [])[0];
  return s ? s.trim().slice(0, 200) : null;
}

// Deterministic statistic detection (no-LLM path): sentences carrying a percentage,
// money figure, or large count. The number is the value; the sentence is the quote.
// Crude metric labelling; the validation gate drops anything ungrounded.
const STAT_NUMBER = /(\$\s?[\d.,]+\s?(?:million|billion|thousand|k|m|bn)?|\b\d+(?:\.\d+)?\s?%|\b\d{1,3}(?:,\d{3})+\b)/i;
function detectStatistics(text) {
  const sentences = String(text || "").replace(/\s+/g, " ").match(/[^.!?]+[.!?]+/g) || [];
  const stats = [];
  for (const s of sentences) {
    const t = s.trim();
    if (t.length < 20 || t.length > 260) continue;
    const m = t.match(STAT_NUMBER);
    if (!m) continue;
    const value = m[1].trim();
    const metric = t.slice(0, Math.max(0, m.index)).trim().replace(/[,:;–-]\s*$/, "") || t.slice(0, 80);
    stats.push({ metric: metric.slice(0, 120), value, timeframe: null, source_basis: null, quote: t.slice(0, 240) });
    if (stats.length >= 4) break;
  }
  return stats;
}

function deterministicExtract(opened, ctx) {
  const text = opened.text || opened.snippet || "";
  const quote = (opened.quotes && opened.quotes[0]) || firstAnchoredSentence(text);
  const ents = extractEntities(`${opened.title || ""} ${text}`);
  const attack_steps = detectAttackSteps(text);
  const technique = detectTechnique(`${opened.title || ""} ${text}`);
  const od = {
    affected_system: ents.model[0] || ents.tool[0] || null,
    target: ents.model[0] || ents.tool[0] || null,
    technique,
    tools_or_models: [...ents.model, ...ents.tool].slice(0, 6),
    vulnerabilities_or_weaknesses: ents.cve.slice(0, 4),
    actor: ents.actor[0] || null,
    attack_steps,
    impact: detectImpact(text),
    date_or_timeframe: opened.published_date || null,
  };
  // verbatim quotes: prefer a clear anchored sentence + the impact sentence.
  const quotes = [];
  if (quote) quotes.push(quote);
  if (od.impact && !quotes.includes(od.impact)) quotes.push(od.impact);
  return {
    evidence_label: (opened.title || "").slice(0, 120),
    concrete_claim: firstAnchoredSentence(text) || (opened.title || ""),
    why_this_is_useful: "",
    verbatim_quotes: quotes,
    walkthrough_status: "not_walkthrough",   // re-assessed deterministically downstream
    statistics: detectStatistics(text),
    operational_details: od,
  };
}

/**
 * Extract a candidate web evidence object from an opened source.
 *
 * @param {object} opened  { source_url, opened_url_confirmed, publisher, title, published_date, text, quotes[] }
 * @param {object} ctx     { category, mission, taxonomy_context }
 * @param {object} [opts]  { skipLlm }
 * @returns {Promise<object>} a web evidence object (depth + walkthrough assessed)
 */
export async function extractWebEvidence(opened, ctx = {}, opts = {}) {
  const hasLlm = !opts.skipLlm && !!(
    process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2 ||
    process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY
  );

  let extracted;
  if (hasLlm && (opened.text || "").length > 100) {
    try {
      const { result } = await routedLLM(EVIDENCE_EXTRACTION_SYSTEM, buildExtractionPrompt(opened, ctx), {
        task: "evidence_extraction", schema: EVIDENCE_EXTRACTION_SCHEMA,
        logLabel: `L5C-extract`,
      });
      extracted = result && typeof result === "object" ? result : deterministicExtract(opened, ctx);
    } catch {
      extracted = deterministicExtract(opened, ctx);
    }
  } else {
    extracted = deterministicExtract(opened, ctx);
  }

  const ev = makeWebEvidenceObject({
    evidence_label: extracted.evidence_label,
    concrete_claim: extracted.concrete_claim,
    why_this_is_useful: extracted.why_this_is_useful,
    walkthrough_status: extracted.walkthrough_status,
    statistics: Array.isArray(extracted.statistics) ? extracted.statistics : [],
    operational_details: extracted.operational_details,
    source_grounding: {
      source_url: opened.source_url,
      opened_url_confirmed: opened.opened_url_confirmed === true,
      publisher: opened.publisher || "",
      title: opened.title || "",
      published_date: opened.published_date || null,
      verbatim_quotes: Array.isArray(extracted.verbatim_quotes) ? extracted.verbatim_quotes.filter(Boolean) : [],
    },
    taxonomy_context: ctx.taxonomy_context || {},
    category: ctx.category || null,
    discovery_mission: ctx.mission || null,
  });

  // Deterministic assessment (overrides LLM walkthrough if it overstates).
  ev.walkthrough_status = assessWalkthroughStatus(ev);
  ev.evidence_depth = assessEvidenceDepth(ev);
  // analysis_usefulness mirrors depth bands (refined by QA later).
  ev.analysis_usefulness = ev.evidence_depth === "walkthrough_grade" ? "high"
    : ev.evidence_depth === "detailed" ? "high"
    : ev.evidence_depth === "concrete" ? "medium" : "low";

  return ev;
}
