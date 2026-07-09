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
import { parseTemporalIntent } from "./temporal.js";
import { extractSearchTerms } from "./agentTools.js";
import { VALID_PRIMARY_TAGS } from "../config/taxonomyRegistry.js";

const CATEGORIES = ["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats"];

// Deterministic category hints for the fallback path (no LLM).
const CATEGORY_NAME_MATCHERS = {
  traditional_ai_threats: [/\btraditional ai\b/, /\bdata poisoning\b/, /\badversarial example/, /\bmodel extraction\b/, /\bmodel inversion\b/, /\bmembership inference\b/, /\bevasion\b/],
  llm_threats:            [/\bllm\b/, /\bprompt injection\b/, /\bjailbreak/, /\brag poisoning\b/, /\bguardrail/, /\bsystem[- ]prompt/],
  agentic_ai_threats:     [/\bagentic\b/, /\bmcp\b/, /\btool[- ](?:poisoning|call)/, /\bagent hijack/, /\bautonomous agent/],
  ai_enabled_threats:     [/\bdeepfake/, /\bvoice clon/, /\bai[- ]?(?:generated |enabled )?phish/, /\bai[- ]?malware\b/, /\bdisinformation\b/],
};

function buildPlannerPrompt(today) {
  return `You are the query-understanding module of an AI-security threat-intelligence search engine. Today is ${today}.

Given a user question, return ONLY a JSON object (no prose) with this shape:
{
  "in_scope": boolean,            // true if the question is about AI/ML security: LLM threats, agentic-AI threats, AI-enabled attacks, adversarial ML, or related vulnerabilities/incidents. false for general chit-chat, unrelated tech, or nonsense.
  "search_terms": string[],      // 3-8 keywords that would literally appear in the TITLE or SUMMARY of a relevant article. CRITICAL: translate the user's phrasing into the terminology security writers actually use. If they say "models fooled by tweaked inputs" output ["adversarial examples","evasion","perturbation"], NOT their words. Include close synonyms and singular forms.
  "taxonomy_tags": string[],     // 0-4 tag IDs from the ALLOWED list below that match the question. [] if none clearly apply.
  "entities": string[],          // named CVEs (CVE-2026-1234), products/tools (LangChain, Ollama, Copilot), or threat actors mentioned. [] if none.
  "category": string|null,       // exactly one of ${CATEGORIES.join(", ")} if the question is clearly about one; else null.
  "timeframe": {
    "type": "all_time"|"range"|"relative"|"none",
    "date_from": "YYYY-MM-DD"|null,   // resolve relative phrases against today. "over the summer" -> that range. "recently" -> ~last 90 days.
    "date_to": "YYYY-MM-DD"|null,     // set BOTH bounds for a closed period (a specific month/quarter). null = up to today.
    "label": string                   // short human label, e.g. "May 2026", "last 30 days", "all available data"
  },
  "needs_trend_analysis": boolean,       // true only if the question is about change over time: increasing/decreasing/spike/trend/"getting more common".
  "needs_strategic_judgments": boolean   // true only if the question asks what is most important / what to prioritize / top findings / what defenders should watch.
}

ALLOWED taxonomy_tags (use these IDs exactly, or []):
${[...VALID_PRIMARY_TAGS].join(", ")}

Return the JSON object only.`;
}

/** Coerce/validate the LLM object into a clean plan. Returns null if unusable. */
function normalizePlan(raw, query, today) {
  if (!raw || typeof raw !== "object") return null;

  const clean = (arr, max) =>
    Array.isArray(arr)
      ? [...new Set(arr.map(x => String(x || "").trim()).filter(Boolean))].slice(0, max)
      : [];

  const search_terms  = clean(raw.search_terms, 10).map(t => t.toLowerCase());
  const entities      = clean(raw.entities, 8);
  const taxonomy_tags = clean(raw.taxonomy_tags, 4).filter(t => VALID_PRIMARY_TAGS.has(t));
  const in_scope      = raw.in_scope !== false;

  // An out-of-scope verdict is a VALID plan — the handler declines without
  // retrieving, so empty search terms are expected and fine. Only an IN-SCOPE
  // plan with nothing to search on is unusable → fall back to the keyword path.
  if (in_scope && !search_terms.length && !taxonomy_tags.length && !entities.length) return null;

  const category = CATEGORIES.includes(raw.category) ? raw.category : null;

  // ── Timeframe: deterministic regex WINS when it matched an explicit phrase
  // (exact + predictable); the LLM only fills the gap when the regex fell back
  // to its 90-day default (e.g. "over the summer", "recently").
  const det = parseTemporalIntent(query);
  let temporal;
  const detIsExplicit = det.scope_label !== "last 90 days (default)";
  const tf = raw.timeframe || {};
  const isoOk = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

  if (detIsExplicit) {
    temporal = det;
  } else if (tf.type === "all_time") {
    temporal = { date_from: null, date_to: null, scope_label: tf.label || "all available data", all_time: true };
  } else if ((tf.type === "range" || tf.type === "relative") && isoOk(tf.date_from)) {
    temporal = {
      date_from: tf.date_from,
      date_to:   isoOk(tf.date_to) ? tf.date_to : null,
      scope_label: tf.label || "custom window",
      all_time: false,
    };
  } else {
    temporal = det; // default 90 days
  }

  return {
    is_in_scope:     in_scope,
    search_terms,
    taxonomy_tags,
    entities,
    category,
    temporal,
    needs_trends:    raw.needs_trend_analysis === true,
    needs_judgments: raw.needs_strategic_judgments === true,
    planner_method:  "llm",
  };
}

/** Deterministic fallback when the Haiku call fails — keeps retrieval alive. */
function fallbackPlan(query) {
  const q = (query || "").toLowerCase();
  const category =
    Object.entries(CATEGORY_NAME_MATCHERS).find(([, res]) => res.some(re => re.test(q)))?.[0] || null;
  const entities = [...new Set((query.match(/CVE-\d{4}-\d{4,7}/gi) || []).map(s => s.toUpperCase()))];
  return {
    is_in_scope:     true,               // don't gate out on a fallback — let synthesis judge
    search_terms:    extractSearchTerms(query, 8),
    taxonomy_tags:   [],
    entities,
    category,
    temporal:        parseTemporalIntent(query),
    needs_trends:    /\btrend|increas|decreas|spike|more common|over time|growing\b/.test(q),
    needs_judgments: /\bmost important|prioriti|top (?:finding|threat|risk)|should (?:i|we) watch|biggest\b/.test(q),
    planner_method:  "deterministic_fallback",
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
  return { plan: fallbackPlan(query), usage };
}
