/**
 * Web Discovery — Search Provider Router (Layer 1B)
 *
 * Picks a search backend per query and returns the standard discovery shape
 * `{ candidates, grounded, no_results, note }`. This is the default `searchFn`
 * for runWebDiscovery; tests still inject their own `searchFn`.
 *
 * Provider strategy (cheap + high-recall first, frontier last):
 *   - Tavily   — primary general provider; returns extracted content → real quotes.
 *   - SerpAPI  — engine-specialised: Google Scholar for research/benchmark
 *                missions, Google News for incident missions; breadth.
 *   - Anthropic web_search — fallback only (expensive; also used by Layer 5E).
 *
 * Selection is by source-class hint, then availability. A provider that returns a
 * hard error (quota/auth) is retired for the rest of the process and the next
 * available provider is tried — but we do NOT cascade on an ordinary empty result
 * (that would multiply cost); empties are handled by the orchestrator's retry
 * families instead.
 *
 * Config (env): TAVILY_API_KEY(_2.._4), SERPAPI_API_KEY, ANTHROPIC_API_KEY.
 * Force a provider with WEB_DISCOVERY_PROVIDER = tavily | serpapi | anthropic.
 */

import { runTavilyQuery, hasTavily } from "./providers/tavily.js";
import { runSerpApiQuery, hasSerpApi, serpEngineFor } from "./providers/serpapi.js";
import { runDiscoveryQuery as runAnthropicQuery } from "./webDiscoverySearch.js";

const HARD_ERROR_NOTES = new Set([
  "no_tavily_key", "tavily_quota_or_auth", "tavily_rate_limit",
  "no_serpapi_key", "serpapi_auth", "serpapi_rate_limit",
  "no_anthropic_key", "quota_or_rate_limit", "web_search_unavailable",
]);

const _disabledProviders = new Set();

/** Is any discovery search provider configured? */
export function hasAnyDiscoveryProvider() {
  return hasTavily() || hasSerpApi() || !!process.env.ANTHROPIC_API_KEY;
}

/** Provider order for a given source-class hint, filtered to what's available. */
export function providerOrderFor(sourceClassHint) {
  const forced = process.env.WEB_DISCOVERY_PROVIDER;
  if (forced) return [forced].filter((p) => isAvailable(p));

  const engine = serpEngineFor(sourceClassHint);
  const serpFirst = engine === "google_scholar" || engine === "google_news";

  // Scholar/News missions: SerpAPI is better at academic/news breadth → try first.
  const base = serpFirst ? ["serpapi", "tavily", "anthropic"] : ["tavily", "serpapi", "anthropic"];
  return base.filter((p) => isAvailable(p) && !_disabledProviders.has(p));
}

function isAvailable(provider) {
  if (provider === "tavily") return hasTavily();
  if (provider === "serpapi") return hasSerpApi();
  if (provider === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  return false;
}

async function runProvider(provider, params, opts) {
  if (provider === "tavily") return runTavilyQuery(params, opts);
  if (provider === "serpapi") return runSerpApiQuery(params, opts);
  if (provider === "anthropic") return runAnthropicQuery(params, opts);
  return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "unknown_provider" };
}

/**
 * Route + run one discovery query.
 * @param {object} params { mission, missionLabel, query, family, source_class_hint }
 * @param {object} [opts]
 */
export async function runDiscoverySearch(params, opts = {}) {
  const order = providerOrderFor(params.source_class_hint);
  if (order.length === 0) {
    return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "no_provider_available" };
  }

  let last = null;
  for (const provider of order) {
    const res = await runProvider(provider, params, opts);
    res.provider = provider;
    last = res;

    // Hard error (quota/auth/unavailable) → retire provider, try next.
    if (HARD_ERROR_NOTES.has(res.note)) {
      _disabledProviders.add(provider);
      continue;
    }
    // Otherwise return (candidates found, or an ordinary empty for this query).
    return res;
  }
  return last || { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "all_providers_exhausted" };
}

/** Diagnostics for the run header. */
export function discoveryProviderStatus() {
  return {
    tavily: hasTavily(),
    serpapi: hasSerpApi(),
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    forced: process.env.WEB_DISCOVERY_PROVIDER || null,
    disabled: [..._disabledProviders],
  };
}
