/**
 * Layer 5C.4 — Web search execution + provider rotation.
 *
 * Provider order (configurable WEB_EVIDENCE_SEARCH_PROVIDER_ORDER):
 *   1. tavily         — primary recall (returns content)
 *   2. serpapi        — primary recall (SERP breadth; Scholar/News engines)
 *   3. specialized    — arXiv / GitHub / NVD / CISA, chosen by source-class hint
 *   4. gemini_grounding — targeted verification only (off by default)
 *   5. claude_web     — finalist corroboration / hard verification only (off by default)
 *
 * Every adapter normalizes to the shared search-result shape and the combined
 * results are deduped by canonical URL across providers. All adapters take an
 * injectable `fetchImpl` and fail soft (return []), recording failures.
 */

import { normalizeSearchResult, dedupeSearchResults } from "./webEvidenceSchemas.js";
import { serpEngineFor } from "../discovery/providers/serpapi.js";

function tavilyKeys() {
  return [process.env.TAVILY_API_KEY, process.env.TAVILY_API_KEY_2,
          process.env.TAVILY_API_KEY_3, process.env.TAVILY_API_KEY_4].filter(Boolean);
}

// ── Provider adapters (each → normalized results[] | throws) ──────────────────

async function tavilySearch(query, ctx, opts) {
  const key = tavilyKeys()[0];
  if (!key) return [];
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, search_depth: "advanced", max_results: opts.maxResults || 6, include_raw_content: false }),
  });
  if (!res.ok) throw Object.assign(new Error(`tavily_http_${res.status}`), { provider: "tavily", status: res.status });
  const data = await res.json();
  return (data?.results || []).map((r, i) => normalizeSearchResult({
    result_url: r.url, title: r.title, snippet: r.content, published_date: r.published_date,
    source_class_hint: ctx.source_class_hint, raw_provider_metadata: { score: r.score },
  }, "tavily", query, i + 1)).filter(Boolean);
}

async function serpapiSearch(query, ctx, opts) {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) return [];
  const fetchImpl = opts.fetchImpl || fetch;
  const engine = ctx.engine || serpEngineFor(ctx.source_class_hint);
  const params = new URLSearchParams({ engine, q: query, api_key: key, hl: "en" });
  if (engine === "google" || engine === "google_scholar") params.set("num", String(opts.maxResults || 10));
  const res = await fetchImpl(`https://serpapi.com/search.json?${params}`, { method: "GET" });
  if (!res.ok) throw Object.assign(new Error(`serpapi_http_${res.status}`), { provider: "serpapi", status: res.status });
  const data = await res.json();
  if (data?.error) return [];
  const rows = engine === "google_news" ? (data.news_results || []) : (data.organic_results || []);
  return rows.map((r, i) => normalizeSearchResult({
    result_url: r.link, title: r.title, snippet: r.snippet || r.publication_info?.summary,
    published_date: r.date, source_class_hint: ctx.source_class_hint,
    raw_provider_metadata: { engine, position: r.position },
  }, "serpapi", query, i + 1)).filter(Boolean);
}

async function arxivSearch(query, ctx, opts) {
  const fetchImpl = opts.fetchImpl || fetch;
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${opts.maxResults || 6}`;
  const res = await fetchImpl(url, { method: "GET" });
  if (!res.ok) throw Object.assign(new Error(`arxiv_http_${res.status}`), { provider: "arxiv" });
  const xml = await res.text();
  const entries = xml.split(/<entry>/).slice(1);
  return entries.map((e, i) => {
    const pick = (tag) => (e.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1]?.trim() || "";
    return normalizeSearchResult({
      result_url: pick("id"), title: pick("title").replace(/\s+/g, " "),
      snippet: pick("summary").replace(/\s+/g, " ").slice(0, 800), published_date: pick("published")?.slice(0, 10),
      source_class_hint: "research_paper",
    }, "arxiv", query, i + 1);
  }).filter(Boolean);
}

async function githubSearch(query, ctx, opts) {
  const fetchImpl = opts.fetchImpl || fetch;
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=${opts.maxResults || 6}`;
  const res = await fetchImpl(url, { method: "GET", headers });
  if (!res.ok) throw Object.assign(new Error(`github_http_${res.status}`), { provider: "github" });
  const data = await res.json();
  return (data?.items || []).map((r, i) => normalizeSearchResult({
    result_url: r.html_url, title: r.full_name, snippet: r.description, published_date: (r.pushed_at || "").slice(0, 10),
    source_class_hint: "github_poc", raw_provider_metadata: { stars: r.stargazers_count },
  }, "github", query, i + 1)).filter(Boolean);
}

async function nvdSearch(query, ctx, opts) {
  const fetchImpl = opts.fetchImpl || fetch;
  const headers = {};
  if (process.env.NVD_API_KEY) headers.apiKey = process.env.NVD_API_KEY;
  const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(query)}&resultsPerPage=${opts.maxResults || 5}`;
  const res = await fetchImpl(url, { method: "GET", headers });
  if (!res.ok) throw Object.assign(new Error(`nvd_http_${res.status}`), { provider: "nvd" });
  const data = await res.json();
  return (data?.vulnerabilities || []).map((v, i) => {
    const id = v.cve?.id;
    const desc = (v.cve?.descriptions || []).find((d) => d.lang === "en")?.value || "";
    return normalizeSearchResult({
      result_url: id ? `https://nvd.nist.gov/vuln/detail/${id}` : null,
      title: id, snippet: desc, published_date: (v.cve?.published || "").slice(0, 10),
      source_class_hint: "vulnerability_database",
    }, "nvd", query, i + 1);
  }).filter(Boolean);
}

// CISA: kept as a graceful no-op recall provider. CISA advisories are best
// reached via SerpAPI `site:cisa.gov`; a dedicated feed adapter can be added
// here later. Returns [] so the rotation never breaks on it.
async function cisaSearch() { return []; }

// Verification-only providers — NOT used for broad recall. Off unless enabled.
async function geminiGroundingSearch() { return []; }
async function claudeWebSearch() { return []; }

const ADAPTERS = {
  tavily: tavilySearch, serpapi: serpapiSearch,
  arxiv: arxivSearch, github: githubSearch, nvd: nvdSearch, cisa: cisaSearch,
  gemini_grounding: geminiGroundingSearch, claude_web: claudeWebSearch,
};

// Map a source-class hint → which specialized connectors are relevant.
function specializedFor(sourceClassHint) {
  if (["research_paper", "conference_paper", "benchmark_dataset"].includes(sourceClassHint)) return ["arxiv"];
  if (sourceClassHint === "github_poc") return ["github"];
  if (sourceClassHint === "vulnerability_database") return ["nvd"];
  if (sourceClassHint === "government_advisory") return ["cisa"];
  return ["arxiv", "github", "nvd"];   // default specialized sweep
}

function expandProviderOrder(order, ctx, config) {
  const out = [];
  for (const p of order) {
    if (p === "specialized") { out.push(...specializedFor(ctx.source_class_hint)); continue; }
    if (p === "gemini_grounding" && !config.gemini_grounding_enabled) continue;
    if (p === "claude_web" && !config.claude_web_enabled) continue;
    if (p === "tavily" && !config.tavily_enabled) continue;
    if (p === "serpapi" && !config.serpapi_enabled) continue;
    out.push(p);
  }
  return [...new Set(out)];
}

/**
 * Execute a query across the provider rotation until enough results, deduping
 * across providers.
 *
 * @param {string} query
 * @param {object} ctx    { source_class_hint, engine, mission, category }
 * @param {object} opts   { config, fetchImpl, maxResults, minResults }
 * @returns {Promise<{ results, providers_used, failures }>}
 */
export async function executeWebSearch(query, ctx = {}, opts = {}) {
  const config = opts.config || { provider_order: ["tavily", "serpapi", "specialized"], tavily_enabled: true, serpapi_enabled: true, gemini_grounding_enabled: false, claude_web_enabled: false };
  const order = expandProviderOrder(config.provider_order, ctx, config);
  const minResults = opts.minResults ?? 3;

  const all = [];
  const providers_used = [];
  const failures = [];

  for (const provider of order) {
    const adapter = ADAPTERS[provider];
    if (!adapter) continue;
    try {
      const r = await adapter(query, ctx, opts);
      if (r.length > 0) { all.push(...r); providers_used.push(provider); }
      // Stop once we have enough unique results from recall providers.
      if (dedupeSearchResults(all).length >= minResults && ["tavily", "serpapi"].includes(provider)) break;
    } catch (err) {
      failures.push({ provider, query, failure_reason: err.message });
    }
  }

  return { results: dedupeSearchResults(all), providers_used, failures };
}

export { dedupeSearchResults };
