/**
 * Web Discovery — Search Provider Router (Layer 1B)
 *
 * Picks a search backend per query and returns the standard discovery shape
 * `{ candidates, grounded, no_results, note }`. This is the default `searchFn`
 * for runWebDiscovery; tests still inject their own `searchFn`.
 *
 * Provider strategy:
 *
 *   Exa (EVA_API_KEY) — news/incident/campaign/landscape missions explicitly
 *     assigned via `preferred_provider: "exa"` in discoveryMissions.js. Finds
 *     content from publishers with limited Google SEO reach (niche TI vendors,
 *     boutique security blogs). keyword mode for specific entities; neural mode
 *     for landscape/trend queries. Free tier: ~1 000 req/month, used selectively.
 *
 *   Tavily — default for all CVE, technical, and research missions. Keyword
 *     search with full page content extraction. 4-key rotation.
 *
 *   SerpAPI — breadth provider: Google Scholar for research source classes,
 *     Google News for incident source classes. Snippets only (fetch_pending).
 *
 *   Anthropic web_search — fallback of last resort (expensive).
 *
 * Provider selection order per query:
 *   Exa missions:          Exa → Tavily → SerpAPI → Anthropic
 *   Scholar/News classes:  SerpAPI → Tavily → Anthropic
 *   Default (CVE/research): Tavily → SerpAPI → Anthropic
 *
 * A provider that returns a hard error (quota/auth) is retired for the rest
 * of the process run; the next available provider is tried instead.
 *
 * Config (env): TAVILY_API_KEY(_2.._4), EVA_API_KEY (Exa), SERPAPI_API_KEY, ANTHROPIC_API_KEY.
 * Force a single provider: WEB_DISCOVERY_PROVIDER = tavily | exa | serpapi | anthropic.
 */

import { runTavilyQuery, hasTavily } from "./providers/tavily.js";
import { runExaQuery, hasExa } from "./providers/exa.js";
import { runSerpApiQuery, hasSerpApi, serpEngineFor } from "./providers/serpapi.js";
import { runDiscoveryQuery as runAnthropicQuery } from "./webDiscoverySearch.js";
import { MISSION_DEFS } from "../../config/discoveryMissions.js";

const HARD_ERROR_NOTES = new Set([
  "no_tavily_key", "tavily_quota_or_auth", "tavily_rate_limit",
  "no_exa_key", "exa_auth_error", "exa_rate_limit",
  "no_serpapi_key", "serpapi_auth", "serpapi_rate_limit",
  "no_anthropic_key", "quota_or_rate_limit", "web_search_unavailable",
]);

const _disabledProviders = new Set();

/** Is any discovery search provider configured? */
export function hasAnyDiscoveryProvider() {
  return hasTavily() || hasExa() || hasSerpApi() || !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Provider order for one query, resolved in priority order:
 *
 * 1. WEB_DISCOVERY_PROVIDER env var — forces a single provider for all queries.
 * 2. mission's `preferred_provider` field in MISSION_DEFS — explicit per-mission
 *    assignment. Exa-assigned missions are news/incident/campaign/landscape;
 *    all others default to Tavily. See lib/config/discoveryMissions.js.
 * 3. SerpAPI-first for Google Scholar / News source classes (breadth).
 * 4. Tavily as the general default.
 *
 * The preferred provider is tried first; remaining available providers follow
 * as fallbacks in case of quota/auth errors. Anthropic is always last (expensive).
 */
export function providerOrderFor(sourceClassHint, missionName) {
  const forced = process.env.WEB_DISCOVERY_PROVIDER;
  if (forced) return [forced].filter((p) => isAvailable(p));

  // Read explicit mission preference from the mission definition.
  const missionPreferred = missionName ? MISSION_DEFS[missionName]?.preferred_provider : null;

  const engine    = serpEngineFor(sourceClassHint);
  const serpFirst = engine === "google_scholar" || engine === "google_news";

  let base;
  if (missionPreferred === "exa") {
    // Exa-assigned missions: Exa → Tavily → SerpAPI → Anthropic
    base = ["exa", "tavily", "serpapi", "anthropic"];
  } else if (serpFirst) {
    // Google Scholar / News source classes: SerpAPI → Tavily → Anthropic
    base = ["serpapi", "tavily", "anthropic"];
  } else {
    // Default (CVE, technical, research): Tavily → SerpAPI → Anthropic
    base = ["tavily", "serpapi", "anthropic"];
  }

  return base.filter((p) => isAvailable(p) && !_disabledProviders.has(p));
}

function isAvailable(provider) {
  if (provider === "tavily")   return hasTavily();
  if (provider === "exa")      return hasExa();
  if (provider === "serpapi")  return hasSerpApi();
  if (provider === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  return false;
}

async function runProvider(provider, params, opts) {
  if (provider === "tavily")   return runTavilyQuery(params, opts);
  if (provider === "exa")      return runExaQuery(params, opts);
  if (provider === "serpapi")  return runSerpApiQuery(params, opts);
  if (provider === "anthropic") return runAnthropicQuery(params, opts);
  return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "unknown_provider" };
}

/**
 * Route + run one discovery query.
 * @param {object} params { mission, missionLabel, query, family, source_class_hint }
 * @param {object} [opts]
 */
export async function runDiscoverySearch(params, opts = {}) {
  const order = providerOrderFor(params.source_class_hint, params.mission);
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
    tavily:    hasTavily(),
    exa:       hasExa(),
    serpapi:   hasSerpApi(),
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    forced:    process.env.WEB_DISCOVERY_PROVIDER || null,
    disabled:  [..._disabledProviders],
  };
}
