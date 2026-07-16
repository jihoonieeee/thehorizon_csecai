/**
 * Web Discovery — Exa search provider (Layer 1B)
 *
 * Exa (exa.ai) finds content that Tavily misses — particularly incident
 * writeups, campaign reports, and vendor intelligence from publishers with
 * limited Google SEO reach (niche security blogs, smaller TI vendors,
 * boutique research firms). It is the primary provider for all news/incident/
 * campaign missions; Tavily remains primary for CVE/technical/research missions.
 *
 * Mission assignment is controlled by `preferred_provider: "exa"` in
 * lib/config/discoveryMissions.js. Do not add Exa to technical/CVE missions —
 * Tavily keyword search performs better there and Exa quota is limited.
 *
 * Provider profile:
 *   - Returns full page text when available; falls back gracefully when Exa's
 *     crawler gets bot-detection pages or nav chrome from vendor blogs.
 *   - fetch_pending is set to true whenever contentQualityOk() fails on the
 *     extracted text — runWebDiscovery.enrichCandidatesWithText() will then
 *     re-fetch the real page before triage runs.
 *   - keyword mode for operational/incident queries; neural for landscape/trend
 *   - Category "news" for incident missions; no category for landscape reports
 *   - Free tier: ~1 000 requests/month — used only for Exa-assigned missions
 *   - Env var: EVA_API_KEY (key format: UUID e.g. 4d0e7c51-8b37-4834-8ec1-…)
 *
 * Returns the standard discovery search shape:
 *   { candidates, grounded: { citations, search_results }, no_results, note }
 */

import { contentQualityOk } from "../fetchCandidateText.js";

const EXA_URL = "https://api.exa.ai/search";

// Domains excluded from Exa results post-fetch. Exa's "news" category doesn't
// filter social media — these appear as candidates, waste triage LLM calls, and
// are correctly rejected but only after spending tokens.
const SOCIAL_DENY_DOMAINS = new Set([
  "instagram.com", "facebook.com", "linkedin.com", "twitter.com", "x.com",
  "tiktok.com", "youtube.com", "reddit.com", "pinterest.com", "threads.net",
  "medium.com",   // dominated by low-signal personal posts; high-value Medium
                  // authors (MITRE ATT&CK, etc.) publish on their own domains
]);

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export function hasExa() {
  return !!process.env.EVA_API_KEY;
}

// Strip Google-style exclusion operators before sending to Exa.
// buildDiscoveryQueries appends query_composition.exclusions as -"phrase" and
// -word tokens for Tavily/SerpAPI, but Exa's API (keyword or neural mode) does
// not support this syntax and returns very few results when they're present.
function stripExclusionOperators(q) {
  return q
    .replace(/-"[^"]*"/g, "")   // remove -"quoted phrase"
    .replace(/-\S+/g, "")       // remove -word
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Recency families that benefit from Exa's neural (semantic) mode.
// For these, a thematic query ("AI threat landscape annual report") benefits
// from finding semantically similar content. For everything else, keyword mode
// with the specific entity names in the query (JADEPUFFER, TeamPCP, CVE-2026-…)
// is more precise.
const NEURAL_FAMILIES = new Set(["landscape"]);

// Landscape/trend missions: no category filter (finds both reports and news).
// All other Exa missions: "news" to filter to news/blog content.
const NO_CATEGORY_FAMILIES = new Set(["landscape"]);

function exaSearchType(family) {
  return NEURAL_FAMILIES.has(family) ? "neural" : "keyword";
}

function exaCategory(family) {
  return NO_CATEGORY_FAMILIES.has(family) ? null : "news";
}

function startDateFor(family) {
  const now = new Date();
  if (family === "operational") {
    now.setDate(now.getDate() - 7);
  } else if (family === "seed" || family === "entity_seeded") {
    now.setMonth(now.getMonth() - 1);
  } else if (family === "landscape") {
    // Landscape reports are typically annual — search the last 18 months so we
    // catch both the current year's report and last year's if it published late.
    now.setMonth(now.getMonth() - 18);
  } else {
    now.setFullYear(now.getFullYear() - 1);
  }
  return now.toISOString().slice(0, 10);
}

function mapResults(results, { mission, query, family, source_class_hint }) {
  const candidates = [];
  const citations = [];
  const search_results = [];

  for (const r of results) {
    const url = (r.url || "").trim();
    if (!url) continue;
    if (SOCIAL_DENY_DOMAINS.has(domainOf(url))) continue;

    const content = r.text || "";
    const page_text = String(content).replace(/\s+/g, " ").trim().slice(0, 8000);
    const quote = page_text.slice(0, 400).trim();
    // Exa's crawler sometimes returns bot-detection pages or nav chrome instead
    // of article content. Signal fetch_pending so enrichCandidatesWithText
    // re-fetches the real page before triage evaluates the candidate.
    const textOk = contentQualityOk(page_text);

    search_results.push({ url, title: r.title || "", page_age: r.publishedDate || null });
    if (quote) citations.push({ url, title: r.title || "", cited_text: quote });

    candidates.push({
      opened_url:          url,
      title:               r.title        || "",
      publisher:           r.author        || null,
      published_date:      r.publishedDate || null,
      event_date:          null,
      last_updated:        null,
      source_class:        source_class_hint || undefined,
      source_type_hint:    "unknown",
      candidate_claim:     "",
      verbatim_quote:      textOk ? quote : "",
      page_text:           textOk ? page_text : "",
      summary:             textOk ? page_text.slice(0, 600) : "",
      fetch_pending:       !textOk,   // re-fetch when Exa returned nav chrome or bot-detection page
      discovery_mission:   mission,
      search_query:        query,
      search_query_family: family,
      provider:            "exa",
    });
  }

  return { candidates, citations, search_results };
}

/**
 * Run one discovery query through Exa.
 *
 * @param {object} params { mission, query, family, source_class_hint }
 * @param {object} [opts] { numResults, fetchImpl, startDate }
 */
export async function runExaQuery({ mission, query, family, source_class_hint }, opts = {}) {
  const key = process.env.EVA_API_KEY;
  if (!key) {
    return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "no_exa_key" };
  }

  const { numResults = 6, fetchImpl = fetch } = opts;
  const type      = exaSearchType(family);
  const category  = exaCategory(family);
  const startDate = opts.startDate || startDateFor(family);
  // Strip Google-style exclusion operators — Exa doesn't support them and
  // returns near-zero results when they're present in the query string.
  const cleanQuery = stripExclusionOperators(query);

  const body = {
    query: cleanQuery,
    numResults,
    type,
    startPublishedDate: startDate,
    contents: {
      text: { maxCharacters: 8000 },
    },
  };
  if (category) body.category = category;

  try {
    const res = await fetchImpl(EXA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key":    key,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401 || res.status === 403) {
      return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "exa_auth_error" };
    }
    if (res.status === 429) {
      return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "exa_rate_limit" };
    }
    if (!res.ok) {
      return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: `exa_http_${res.status}` };
    }

    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    const { candidates, citations, search_results } = mapResults(results, { mission, query, family, source_class_hint });

    return {
      candidates,
      grounded: { citations, search_results },
      no_results: candidates.length === 0,
      note:       null,
    };
  } catch (err) {
    return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: `exa_error:${err.message}` };
  }
}
