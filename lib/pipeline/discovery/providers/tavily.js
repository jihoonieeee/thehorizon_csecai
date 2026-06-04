/**
 * Web Discovery — Tavily search provider (Layer 1B)
 *
 * Tavily is an LLM/RAG-oriented search API: it returns real URLs PLUS extracted
 * page content, so we can build grounded candidates (real URL + a verbatim
 * sentence from the page) WITHOUT driving a frontier model per query. This is
 * the cheap, high-recall path that the `searchFn` seam in runWebDiscovery was
 * built for.
 *
 * Returns the standard discovery search shape:
 *   { candidates, grounded: { citations, search_results }, no_results, note }
 *
 * Anti-hallucination: every candidate URL comes straight from Tavily's response,
 * so it passes the opened-URL gate by construction. The verbatim_quote is a real
 * sentence from Tavily's extracted content (added to `citations.cited_text` so it
 * grounds the quote-verification check). We do NOT assert a `candidate_claim`
 * here — the claim is established later by triage/Layer 4, so the quote–claim
 * gate is correctly deferred rather than satisfied with a fabricated claim.
 *
 * Key rotation: TAVILY_API_KEY, TAVILY_API_KEY_2..4. A key disabled by a quota /
 * auth error is skipped for the rest of the process.
 */

const TAVILY_URL = "https://api.tavily.com/search";

function tavilyKeys() {
  return [
    process.env.TAVILY_API_KEY,
    process.env.TAVILY_API_KEY_2,
    process.env.TAVILY_API_KEY_3,
    process.env.TAVILY_API_KEY_4,
  ].filter(Boolean);
}

const _disabledKeys = new Set();

export function hasTavily() {
  return tavilyKeys().some((k) => !_disabledKeys.has(k));
}

// First substantial sentence from extracted content → a real verbatim quote.
function firstSentence(text, min = 40, max = 400) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length < min) return clean.length >= 20 ? clean : "";
  const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];
  for (const s of sentences) {
    const t = s.trim();
    if (t.length >= min) return t.slice(0, max);
  }
  return clean.slice(0, max);
}

function mapResults(data, { mission, query, family, source_class_hint }) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const candidates = [];
  const citations = [];
  const search_results = [];

  for (const r of results) {
    const url = (r.url || "").trim();
    if (!url) continue;
    const content = r.raw_content || r.content || "";
    const quote = firstSentence(content);

    search_results.push({ url, title: r.title || "", page_age: r.published_date || null });
    if (quote) citations.push({ url, title: r.title || "", cited_text: quote });

    candidates.push({
      opened_url: url,
      title: r.title || "",
      publisher: null,                       // normalizeCandidate derives from host
      published_date: r.published_date || null,
      event_date: null,
      last_updated: null,
      source_class: source_class_hint || undefined,
      source_type_hint: "unknown",
      candidate_claim: "",                   // no asserted claim yet (set by triage/L4)
      verbatim_quote: quote,
      summary: (r.content || "").slice(0, 600),
      fetch_pending: quote ? false : true,   // no usable quote → fetch+clean in Layer 2
      discovery_mission: mission,
      search_query: query,
      search_query_family: family,
      provider: "tavily",
    });
  }

  return { candidates, citations, search_results };
}

/**
 * Run one discovery query through Tavily.
 *
 * @param {object} params { mission, query, family, source_class_hint }
 * @param {object} [opts] { maxResults=6, timeRange, fetchImpl }
 */
export async function runTavilyQuery({ mission, query, family, source_class_hint }, opts = {}) {
  const { maxResults = 6, timeRange = "year", fetchImpl = fetch } = opts;
  const keys = tavilyKeys().filter((k) => !_disabledKeys.has(k));
  if (keys.length === 0) {
    return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: "no_tavily_key" };
  }

  let lastNote = "tavily_error";
  for (const key of keys) {
    try {
      const res = await fetchImpl(TAVILY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: JSON.stringify({
          query,
          search_depth: "advanced",
          max_results: maxResults,
          include_raw_content: true,
          include_answer: false,
          topic: "general",
          time_range: timeRange,
        }),
      });

      if (res.status === 401 || res.status === 403 || res.status === 432 || res.status === 433 || res.status === 429) {
        _disabledKeys.add(key);   // quota/auth — retire this key, try next
        lastNote = res.status === 429 ? "tavily_rate_limit" : "tavily_quota_or_auth";
        continue;
      }
      if (!res.ok) {
        lastNote = `tavily_http_${res.status}`;
        continue;
      }

      const data = await res.json();
      const { candidates, citations, search_results } = mapResults(data, { mission, query, family, source_class_hint });
      return {
        candidates,
        grounded: { citations, search_results },
        no_results: candidates.length === 0,
        note: null,
      };
    } catch (err) {
      lastNote = `tavily_error:${err.message}`;
    }
  }
  return { candidates: [], grounded: { citations: [], search_results: [] }, no_results: true, note: lastNote };
}
