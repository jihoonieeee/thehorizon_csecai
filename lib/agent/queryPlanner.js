/**
 * queryPlanner.js — turn a free-text question into a structured retrieval plan.
 *
 * The old chatbot searched the corpus with a raw `ilike %word%` over the user's
 * own words, so a question phrased differently from the source text ("models
 * fooled by tweaked inputs" vs "adversarial examples") retrieved nothing. This
 * planner runs ONE cheap Haiku call that:
 *   • rewrites the question into the domain's real terminology (synonyms),
 *   • maps it to taxonomy tag IDs,
 *   • pulls out named entities (CVEs, tools, actors),
 *   • interprets the timeframe,
 *   • decides whether trend / strategic-judgment data is even needed,
 *   • judges whether the question is in scope at all.
 *
 * Everything is validated and clamped. If the LLM call fails, we fall back to the
 * deterministic term extractor + regex temporal parser so retrieval still runs.
 */

import { callHaikuJson } from "./agentLlm.js";
import { normalizeTemporalOutput, temporalFallback } from "./temporal.js";
import { extractSearchTerms } from "./agentTools.js";
import { VALID_PRIMARY_TAGS } from "../config/taxonomyRegistry.js";
import { loadPrompt, interpolate } from "../prompts/promptLoader.js";

const CATEGORIES = ["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats"];

// Detect when the user is explicitly asking for academic literature.
// When true, we preserve the user's own vocabulary in search terms (Haiku
// translates it into practitioner language, losing the academic phrasing that
// arXiv paper titles actually use) and boost research source types in scoring.
const ACADEMIC_INTENT_RE = /\bpapers?\b|\bstud(?:y|ies)\b|\bacademic\b|\barxiv\b|\bpreprint\b|\bjournal\b|\bconference\b|\bpublished\b|\bmethodolog|\blimitations?\b|\bfindings?\b|\bliterature\b/i;

export function detectAcademicIntent(query) {
  return ACADEMIC_INTENT_RE.test(query || "");
}

// Deterministic category hints for the fallback path (no LLM).
const CATEGORY_NAME_MATCHERS = {
  traditional_ai_threats: [/\btraditional ai\b/, /\bdata poisoning\b/, /\badversarial example/, /\bmodel extraction\b/, /\bmodel inversion\b/, /\bmembership inference\b/, /\bevasion\b/],
  llm_threats:            [/\bllm\b/, /\bprompt injection\b/, /\bjailbreak/, /\brag poisoning\b/, /\bguardrail/, /\bsystem[- ]prompt/],
  agentic_ai_threats:     [/\bagentic\b/, /\bmcp\b/, /\btool[- ](?:poisoning|call)/, /\bagent hijack/, /\bautonomous agent/],
  ai_enabled_threats:     [/\bdeepfake/, /\bvoice clon/, /\bai[- ]?(?:generated |enabled )?phish/, /\bai[- ]?malware\b/, /\bdisinformation\b/],
};

// System prompt lives in lib/prompts/agent/planner.md (edit the prose there).
function buildPlannerPrompt(today) {
  return interpolate(loadPrompt("agent/planner").system, {
    today,
    categories: CATEGORIES.join(", "),
    tags:       [...VALID_PRIMARY_TAGS].join(", "),
  });
}

/** Coerce/validate the LLM object into a clean plan. Returns null if unusable. */
function normalizePlan(raw, query, today) {
  if (!raw || typeof raw !== "object") return null;

  const clean = (arr, max) =>
    Array.isArray(arr)
      ? [...new Set(arr.map(x => String(x || "").trim()).filter(Boolean))].slice(0, max)
      : [];

  // Cap 14 to match the planner prompt's 6–14 term budget: lexical variants and
  // acronym/expansion pairs need the headroom — a 10 cap silently dropped them.
  const search_terms = clean(raw.search_terms, 14).map(t => t.toLowerCase());
  const in_scope     = raw.in_scope !== false;

  if (in_scope && !search_terms.length) return null;

  const category = CATEGORIES.includes(raw.category) ? raw.category : null;

  const rawTemporal = raw.temporal || (raw.timeframe ? _legacyTimeframe(raw.timeframe) : null);
  const temporal = normalizeTemporalOutput(rawTemporal, today, query);

  // Preserve academic intent detection so arXiv terms get injected into search.
  const academic_focus = detectAcademicIntent(query);
  let finalTerms = search_terms;
  if (academic_focus) {
    const userTerms = extractSearchTerms(query, 8);
    finalTerms = [...new Set([...search_terms, ...userTerms, "arxiv", "paper"])].slice(0, 14);
  }

  // Pass through new planner fields — validate and clamp each.
  const entities      = clean(raw.entities, 10);
  const taxonomy_tags = clean(raw.taxonomy_tags, 5).filter(t => VALID_PRIMARY_TAGS.has(t));
  const needs_judgments = raw.needs_judgments === true;
  const needs_trends    = raw.needs_trends    === true;

  return {
    is_in_scope:    in_scope,
    search_terms:   finalTerms,
    category,
    temporal,
    academic_focus,
    entities,
    taxonomy_tags,
    needs_judgments,
    needs_trends,
    planner_method: "llm",
  };
}

/** Deterministic fallback when the Haiku call fails — keeps retrieval alive. */
function fallbackPlan(query, today) {
  const q = (query || "").toLowerCase();
  const category =
    Object.entries(CATEGORY_NAME_MATCHERS).find(([, res]) => res.some(re => re.test(q)))?.[0] || null;
  const academic_focus = detectAcademicIntent(query);
  const baseTerms = extractSearchTerms(query, 8);
  const search_terms = academic_focus
    ? [...new Set([...baseTerms, "arxiv", "paper"])].slice(0, 12)
    : baseTerms;
  const temporal = temporalFallback(query, today);
  return {
    is_in_scope:    true,
    search_terms,
    category,
    temporal,
    academic_focus,
    planner_method: "deterministic_fallback",
  };
}

// Convert old-style `timeframe` object (type/date_from/date_to/label) to the
// new `temporal` schema so normalizeTemporalOutput can validate it.
function _legacyTimeframe(tf) {
  if (!tf || typeof tf !== "object") return null;
  if (tf.type === "all_time") {
    return { temporal_intent: "none", start_date: null, end_date: null,
             requires_fresh_sources: false, forecast_horizon: null, reasoning_summary: tf.label || "" };
  }
  const intentMap = { range: "bounded_period", relative: "recent", none: "none" };
  return {
    temporal_intent:       intentMap[tf.type] || "recent",
    start_date:            tf.date_from || null,
    end_date:              tf.date_to   || null,
    requires_fresh_sources: false,
    forecast_horizon:      null,
    reasoning_summary:     tf.label || "",
  };
}

/**
 * Build a retrieval plan for a question.
 * @param {string} query
 * @param {object} [opts] { today?, llmFn? } — llmFn(opts)→{data,usage} for tests.
 * @returns {Promise<{plan:object, usage:{input_tokens,output_tokens}}>}
 */
export async function planQuery(query, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const llmFn = opts.llmFn || callHaikuJson;

  let usage = { input_tokens: 0, output_tokens: 0 };
  try {
    const out = await llmFn({
      system:    buildPlannerPrompt(today),
      user:      query,
      maxTokens: 500,
    });
    usage = out?.usage || usage;
    const plan = normalizePlan(out?.data, query, today);
    if (plan) return { plan, usage };
  } catch {
    /* fall through to deterministic */
  }
  return { plan: fallbackPlan(query, today), usage };
}
