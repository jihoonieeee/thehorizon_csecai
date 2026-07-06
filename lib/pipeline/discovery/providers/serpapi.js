/**
 * Web Discovery — SerpAPI search provider (Layer 1B)
 *
 * SerpAPI returns the real search-engine results page (Google / Scholar / News):
 * title, link, snippet, date. It does NOT read the full page, so candidates come
 * back with the snippet as `summary` and NO verbatim quote — they are flagged
 * `fetch_pending` so Layer 2 fetches + cleans the page and Layer 4/5 extract a
 * real quote. This is the documented "quote gate adjustment before Layer 2".
 *
 * SerpAPI's strength is breadth + specialised engines: Google Scholar for
 * research/benchmark missions, Google News for incident missions.
 *
 * Returns the standard discovery search shape:
 *   { candidates, grounded: { citations, search_results }, no_results, note }
 *
 * Anti-hallucination: every URL is a real engine result (passes the opened-URL
 * gate). No quote is asserted (so nothing to fabricate); the quote is required
 * later for evidence/early-signal use.
 */

const SERPAPI_URL = "https://serpapi.com/search.json";

// Recency window per query family (see tavily.recencyForFamily) — operational →
// last week, seed/entity → month, research/taxonomy → year. Local copy to avoid
// coupling the two provider modules.
function recencyForFamily(family) {
  if (family === "operational") return "week";
  if (family === "seed" || family === "entity_seeded") return "month";
  return "year";
}

export function hasSerpApi() {
  return !!process.env.SERPAPI_API_KEY;
}

// Route a mission/source-class to the most useful engine.
export function serpEngineFor(sourceClassHint) {
  if (["research_paper", "benchmark_dataset", "conference_paper"].includes(sourceClassHint)) return "google_scholar";
  if (["incident_writeup", "news_report"].includes(sourceClassHint)) return "google_news";
  return "google";
}

function looksLikeDate(s) {
  return typeof s === "string" && /\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s);
}

function mapResults(data, engine, { mission, query, family, source_class_hint }) {
  let rows = [];
  if (engine === "google_news") rows = Array.isArray(data?.news_results) ? data.news_results : [];
  else rows = Array.isArray(data?.organic_results) ? data.organic_results : [];

  const candidates = [];
  const search_results = [];

  for (const r of rows) {
    const url = (r.link || "").trim();
    if (!url) continue;
    const snippet = r.snippet || r.publication_info?.summary || "";
    const publisher = r.source?.name || r.source || null;
    // SERP `date` is often relative ("3 days ago"); keep only if it looks datey.
    const published_date = looksLikeDate(r.date) ? r.date : null;

    search_results.push({ url, title: r.title || "", page_age: published_date });

    candidates.push({
      opened_url: url,
      title: r.title || "",
      publisher,
      published_date,
      event_date: null,
      last_updated: null,
      source_class: source_class_hint || undefined,
      source_type_hint: "unknown",
      candidate_claim: "",                 // no asserted claim yet
      verbatim_quote: "",                  // snippet only → no page-verified quote
      summary: String(snippet).slice(0, 600),
      fetch_pending: true,                 // page not read → fetch+clean in Layer 2
      discovery_mission: mission,
      search_query: query,
      search_query_family: family,
      provider: "serpapi",
    });
  }

  return { candidates, search_results };
}

/**
 * Run one discovery query through SerpAPI.
 *
 * @param {object} params { mission, query, family, source_class_hint }
 * @param {object} [opts] { num=10, engine, fetchImpl }
 */
export async function runSerpApiQuery({ mission, query, family, source_class_hint }, opts = {}) {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) {
    return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "no_serpapi_key" };
  }

  const { num = 10, fetchImpl = fetch } = opts;
  const engine = opts.engine || serpEngineFor(source_class_hint);

  const params = new URLSearchParams({ engine, q: query, api_key: key, hl: "en" });
  if (engine === "google" || engine === "google_scholar") params.set("num", String(num));
  // Recency: bias fresh families to the last week/month (Google `tbs=qdr`) so
  // re-runs surface NEW operational content, not the same old already-ingested hits.
  const qdr = { week: "qdr:w", month: "qdr:m", year: "qdr:y" }[opts.recency || recencyForFamily(family)];
  if (qdr && (engine === "google" || engine === "google_news")) params.set("tbs", qdr);

  try {
    const res = await fetchImpl(`${SERPAPI_URL}?${params.toString()}`, { method: "GET" });
    if (res.status === 401) return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "serpapi_auth" };
    if (res.status === 429) return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "serpapi_rate_limit" };
    if (!res.ok) return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: `serpapi_http_${res.status}` };

    const data = await res.json();
    // SerpAPI can return 200 with an `error` field (e.g. ran out of searches).
    if (data?.error) {
      const note = /run out|hasn't returned any results|no results/i.test(data.error) ? "serpapi_no_results" : "serpapi_error";
      return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note };
    }

    const { candidates, search_results } = mapResults(data, engine, { mission, query, family, source_class_hint });
    return {
      candidates,
      grounded: { citations: [], search_results },   // no cited_text — quotes pending Layer 2
      no_results: candidates.length === 0,
      note: null,
    };
  } catch (err) {
    return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: `serpapi_error:${err.message}` };
  }
}
