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

export const WEB_DISCOVERY_VERSION = "web-discovery-v1";

const SYSTEM_PROMPT = `You are a discovery analyst for an AI-threat intelligence pipeline. Use web_search to find FRESH, concrete, AI-threat-relevant sources for the given mission and query.

RULES (strict):
1. Only report sources from pages you actually opened in this session. Never invent URLs, titles, publishers, dates, or quotes.
2. Prefer primary/technical sources: research papers, vendor threat research, government advisories, vulnerability databases, GitHub PoCs, conference papers, benchmark datasets, incident write-ups, technical blogs. Do not let news summaries dominate.
3. For each source, copy a VERBATIM quote from the opened page that supports the candidate_claim. If the page is a PDF/repo whose text you cannot quote, leave verbatim_quote empty (do not paraphrase as a quote).
4. Record the real published_date if the page shows one; otherwise null. If the source describes an older event, set event_date.
5. If the query returns nothing reliable, return an empty candidates array — do NOT pad with weak matches.

Return STRICT JSON only:
{
  "candidates": [
    {
      "opened_url": "<exact URL you opened>",
      "title": "<page title>",
      "publisher": "<organisation>",
      "author": "<author or null>",
      "published_date": "<YYYY-MM-DD | YYYY | null>",
      "event_date": "<YYYY-MM-DD | null>",
      "last_updated": "<YYYY-MM-DD | null>",
      "source_class": "research_paper|vendor_research|government_advisory|vulnerability_database|github_poc|incident_writeup|benchmark_dataset|technical_blog|conference_paper|standards_or_framework|news_report|unknown",
      "source_type_hint": "research_finding|incident|exploit_disclosure|benchmark_evaluation|threat_intelligence|vulnerability|capability_demonstration|governance_signal|unknown",
      "candidate_claim": "<one concrete claim the source supports>",
      "verbatim_quote": "<exact sentence copied from the page, or empty>",
      "summary": "<2 sentences>"
    }
  ],
  "no_results": <true if nothing reliable was found>
}`;

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
