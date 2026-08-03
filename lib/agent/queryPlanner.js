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

const VALID_QUERY_TYPES = new Set([
  "incident_lookup","incident_enumeration","vulnerability_lookup","campaign_lookup",
  "actor_activity","entity_history","research_lookup","publisher_lookup","timeline",
  "comparison","trend_analysis","strategic_assessment","definition","capability_lookup","general_search",
]);
const VALID_ANSWER_SHAPES    = new Set(["single_answer","list","timeline","comparison","assessment","explanation"]);
const VALID_EXHAUSTIVENESS   = new Set(["best_evidence","representative","all_matching"]);
const VALID_TIME_FIELDS      = new Set(["event_date","publication_date","disclosure_date","effective_date","either"]);
const VALID_REQ_OBJECTS      = new Set(["incident","vulnerability","campaign","research","capability","policy","source","actor_activity"]);

// query_types that imply strategic synthesis — auto-set needs_judgments when the
// model doesn't explicitly flag it so callers don't have to know the mapping.
const JUDGMENT_QUERY_TYPES = new Set(["strategic_assessment","comparison","timeline"]);
const TREND_QUERY_TYPES    = new Set(["trend_analysis"]);

// Deterministic trend signal — phrases like "is X increasing?" and "how has X
// evolved?" are unambiguously trend_analysis regardless of LLM classification.
// Defined at module scope so it fires in both normalizePlan AND fallbackPlan.
const TREND_SIGNAL_RE = /\b(?:is|are|has|have)\b.{1,60}\b(?:increasing|decreasing|growing|declining|rising|falling|escalating|accelerating|spiking|surging)\b|\bhow\s+(?:has|have)\s+.{1,60}\b(?:evolved|changed|shifted|grown|developed)\b|\btrend(?:s|ing)?\b.{0,30}\b(?:direction|growth|decline)\b/i;
function applyTrendOverride(query, queryType) {
  if (TREND_SIGNAL_RE.test(query || "") && (queryType === "general_search" || queryType === "strategic_assessment")) {
    return "trend_analysis";
  }
  return queryType;
}

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
  let entities = clean(raw.entities, 10);
  // Deterministic CVE extraction — parse the raw query for CVE IDs in case the
  // LLM missed them. The NVD lookup tool only fires when entities[] has a CVE ID.
  const cvesFromQuery = (String(query || "").match(/\bCVE-\d{4}-\d{4,}\b/gi) || []).map(c => c.toUpperCase());
  if (cvesFromQuery.length) {
    entities = [...new Set([...entities, ...cvesFromQuery])].slice(0, 10);
  }
  const taxonomy_tags = clean(raw.taxonomy_tags, 5).filter(t => VALID_PRIMARY_TAGS.has(t));

  // Semantic intent fields.
  let query_type       = VALID_QUERY_TYPES.has(raw.query_type) ? raw.query_type : "general_search";
  const answer_shape   = VALID_ANSWER_SHAPES.has(raw.answer_shape) ? raw.answer_shape : null;
  const exhaustiveness = VALID_EXHAUSTIVENESS.has(raw.exhaustiveness) ? raw.exhaustiveness : "best_evidence";
  const requested_objects = clean(raw.requested_objects, 8).filter(o => VALID_REQ_OBJECTS.has(o));
  const source_types   = clean(raw.source_types, 6);

  // Hard constraints from the user's request.
  const must_include = clean(raw.must_include, 10);
  const must_exclude = clean(raw.must_exclude, 10);
  const ambiguities  = clean(raw.ambiguities, 5);

  // Entity role: whether the named entity is the victim, weapon, or unspecified.
  const VALID_ENTITY_ROLES = new Set(["victim", "weapon"]);
  const entity_role = VALID_ENTITY_ROLES.has(raw.entity_role) ? raw.entity_role : null;

  // time_field is set on the temporal object itself.
  const time_field = VALID_TIME_FIELDS.has(raw.temporal?.time_field) ? raw.temporal.time_field : "either";
  // Propagate time_field onto the normalised temporal plan.
  temporal.time_field = time_field;

  query_type = applyTrendOverride(query, query_type);

  // needs_judgments/needs_trends: honour explicit model flags first, then
  // auto-derive from query_type so callers don't need to map types themselves.
  const needs_judgments = raw.needs_judgments === true || JUDGMENT_QUERY_TYPES.has(query_type);
  const needs_trends    = raw.needs_trends    === true || TREND_QUERY_TYPES.has(query_type);

  // Merge must_include terms into search_terms so mandatory constraints affect
  // retrieval even when they don't appear in the model's search_terms list.
  // Skip items that are purely temporal phrases (e.g. "event occurred in July 2026")
  // — temporal constraints are already in plan.temporal and should not pollute tokens.
  const TEMPORAL_NOISE_RE = /^(event|occurred|happened|in|during|between|july|august|january|february|march|april|june|september|october|november|december|20\d\d|\d{4})$/i;
  const mustTokens = must_include
    .filter(item => {
      const words = String(item).toLowerCase().split(/\s+/).filter(w => w.length >= 3);
      // If every meaningful word is a temporal noise word, skip the whole item.
      return words.some(w => !TEMPORAL_NOISE_RE.test(w));
    })
    .flatMap(t => String(t).toLowerCase().split(/\s+/))
    .filter(w => w.length >= 3 && !TEMPORAL_NOISE_RE.test(w));
  const mergedTerms = [...new Set([...finalTerms, ...mustTokens])].slice(0, 16);

  return {
    is_in_scope:    in_scope,
    search_terms:   mergedTerms,
    category,
    temporal,
    academic_focus,
    entities,
    taxonomy_tags,
    query_type,
    answer_shape,
    exhaustiveness,
    requested_objects,
    source_types,
    must_include,
    must_exclude,
    ambiguities,
    needs_judgments,
    needs_trends,
    entity_role,
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
  const temporal    = temporalFallback(query, today);
  const query_type  = applyTrendOverride(query, "general_search");
  const needs_trends = TREND_QUERY_TYPES.has(query_type);
  return {
    is_in_scope:      true,
    search_terms,
    category,
    temporal:         { ...temporal, time_field: "either" },
    academic_focus,
    query_type,
    answer_shape:     null,
    exhaustiveness:   "best_evidence",
    requested_objects: [],
    source_types:     [],
    must_include:     [],
    must_exclude:     [],
    ambiguities:      [],
    needs_judgments:  false,
    needs_trends,
    planner_method:   "deterministic_fallback",
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
 * @param {object} [opts] { today?, history?, llmFn? } — llmFn(opts)→{data,usage} for tests.
 *   history: cleaned prior turns [{role,content}] — last 2 used to resolve follow-up references.
 * @returns {Promise<{plan:object, usage:{input_tokens,output_tokens}}>}
 */
export async function planQuery(query, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const llmFn = opts.llmFn || callHaikuJson;

  // Compress last 2 prior turns into a short prefix so the planner can resolve
  // follow-up references ("that technique", "in the same period"). Hard-capped at
  // 150 chars per turn so prior context never dominates the planner token budget.
  // Framed as optional — the planner must ignore it when the question stands alone.
  const history = Array.isArray(opts.history) ? opts.history : [];
  const priorContext = history.length
    ? history
        .slice(-2)
        .map(m => `${m.role === "user" ? "Q" : "A"}: ${String(m.content || "").slice(0, 150)}`)
        .join("\n")
    : null;
  const userPrompt = priorContext
    ? `Prior conversation (use only if the current question is a follow-up; ignore if it stands alone):\n${priorContext}\n\nCurrent question: ${query}`
    : query;

  let usage = { input_tokens: 0, output_tokens: 0 };
  try {
    const out = await llmFn({
      system:    buildPlannerPrompt(today),
      user:      userPrompt,
      maxTokens: 800,
    });
    usage = out?.usage || usage;
    const plan = normalizePlan(out?.data, query, today);
    if (plan) return { plan, usage };
  } catch {
    /* fall through to deterministic */
  }
  return { plan: fallbackPlan(query, today), usage };
}
