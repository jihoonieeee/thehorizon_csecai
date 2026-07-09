/**
 * Web Discovery — Search Execution (Layer 1B)
 *
 * Runs a single discovery query via the Anthropic web_search tool and returns
 * RAW candidate objects, each grounded against the pages the tool actually
 * opened. This is the only module here that touches the network/LLM.
 *
 * Anti-hallucination is structural: the model is asked to return JSON candidate
 * objects, and the caller (normalizeCandidate) confirms every opened_url against
 * the citations/search_results the tool genuinely retrieved. A URL the tool did
 * not open cannot pass the opened-URL gate, so invented URLs are dropped.
 *
 * Degrades gracefully:
 *   - No ANTHROPIC_API_KEY            → returns { candidates: [], grounded, note }
 *   - web_search unavailable / error  → returns empty with a note (NEVER fabricates)
 */

import { callAnthropicWebSearch, ANTHROPIC_SEARCH_MODEL } from "../../llm/providers/anthropic.js";
import { buildGroundedUrlSet } from "./candidateGates.js";
import { loadPrompt } from "../../prompts/promptLoader.js";

export const WEB_DISCOVERY_VERSION = "web-discovery-v1";

const SYSTEM_PROMPT = loadPrompt("discovery/web-search").system;

function buildUserPrompt(mission, query, missionLabel) {
  return [
    `MISSION: ${mission} (${missionLabel || ""})`,
    `QUERY: ${query}`,
    ``,
    `Find up to 6 fresh, concrete, AI-threat-relevant sources for this query. Prioritise primary/technical sources. Return strict JSON.`,
  ].join("\n");
}

function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/**
 * Run one discovery query.
 *
 * @param {object} params { mission, missionLabel, query, family, source_class_hint }
 * @param {object} [opts] { maxSearches }
 * @returns {Promise<{ candidates, grounded:{citations,search_results}, no_results, note }>}
 */
export async function runDiscoveryQuery({ mission, missionLabel, query, family, source_class_hint }, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "no_anthropic_key" };
  }

  try {
    const { text, citations, search_results } = await callAnthropicWebSearch(
      { apiKey, modelId: ANTHROPIC_SEARCH_MODEL, label: `WebDiscovery/${mission}` },
      SYSTEM_PROMPT,
      buildUserPrompt(mission, query, missionLabel),
      { maxTokens: 4000, maxSearches: opts.maxSearches ?? 4 },
    );

    const parsed = parseJsonLoose(text);
    const rawCandidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];

    // Attach search provenance to each raw candidate.
    const candidates = rawCandidates.map((c) => ({
      ...c,
      discovery_mission: mission,
      search_query: query,
      search_query_family: family,
      source_class: c.source_class || source_class_hint || undefined,
    }));

    return {
      candidates,
      grounded: { citations, search_results },
      no_results: parsed?.no_results === true || candidates.length === 0,
      note: null,
    };
  } catch (err) {
    if (err.webSearchUnavailable) {
      return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "web_search_unavailable" };
    }
    if (err.isQuota || err.isRateLimit) {
      return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "quota_or_rate_limit", error: err.message };
    }
    return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "search_error", error: err.message };
  }
}

/** Expose the grounding-set builder for callers/tests. */
export { buildGroundedUrlSet };
