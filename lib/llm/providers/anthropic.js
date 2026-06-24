/**
 * Anthropic Claude provider
 *
 * Frontier-model provider used exclusively for evidence_search and strategic_insight tasks.
 * Not in the default bulk-processing rotation — only activated when ANTHROPIC_API_KEY is set
 * and the task profile lists "anthropic" as a preferred provider.
 *
 * Models: claude-sonnet-4-6 (default), claude-haiku-4-5-20251001 (fallback)
 */

const BASE_URL    = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export const ANTHROPIC_MODELS = {
  sonnet: process.env.ANTHROPIC_MODEL       || "claude-sonnet-4-6",
  haiku:  process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
  opus:   process.env.ANTHROPIC_OPUS_MODEL  || "claude-opus-4-8",
};

// Model used for web-search evidence discovery. Defaults to sonnet for cost;
// set ANTHROPIC_SEARCH_MODEL=claude-opus-4-7 for the strongest search/reasoning.
export const ANTHROPIC_SEARCH_MODEL = process.env.ANTHROPIC_SEARCH_MODEL || ANTHROPIC_MODELS.sonnet;

/**
 * Call Anthropic Claude via the Messages API.
 *
 * @param {{ apiKey, modelId, label }}         config
 * @param {string}                             systemPrompt
 * @param {string}                             userPrompt
 * @param {{ maxTokens?, timeoutMs?, json? }} [opts]
 * @returns {Promise<string>} Raw text content from the response
 */
export async function callAnthropic(config, systemPrompt, userPrompt, opts = {}) {
  const {
    apiKey,
    modelId  = ANTHROPIC_MODELS.sonnet,
    label    = "Anthropic",
  } = config;

  const {
    maxTokens = 4000,
    timeoutMs = 60000,
  } = opts;

  const body = {
    model:      modelId,
    max_tokens: maxTokens,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userPrompt }],
  };

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(BASE_URL, {
      method:  "POST",
      signal:  controller.signal,
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
    });

    clearTimeout(timer);

    if (res.status === 429 || res.status === 529) {
      const err = new Error(`${label} rate limited (HTTP ${res.status})`);
      err.isRateLimit = true;
      throw err;
    }

    if (res.status === 402 || res.status === 403) {
      const err = new Error(`${label} quota/auth error (HTTP ${res.status})`);
      err.isQuota = true;
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data    = await res.json();
    const content = data?.content?.[0]?.text || "";

    if (!content) {
      throw new Error(`${label} returned empty content (stop_reason=${data?.stop_reason})`);
    }

    // Return real token counts alongside text so the router can log accurate
    // costs rather than the character-count estimate fallback.
    return {
      text:          content,
      inputTokens:   data.usage?.input_tokens  ?? null,
      outputTokens:  data.usage?.output_tokens ?? null,
    };

  } catch (err) {
    clearTimeout(timer);

    if (err.name === "AbortError") {
      const e = new Error(`${label} request timed out after ${timeoutMs}ms`);
      e.isUnavailable = true;
      throw e;
    }

    throw err;
  }
}

/**
 * Call Anthropic Claude with the server-side web_search tool enabled.
 *
 * Unlike callAnthropic (which returns just text), this returns the full
 * structured result the evidence layer needs: the model's final text, the
 * REAL citations the model attached (verified URLs + the exact quoted text),
 * and the raw web-search results that were actually retrieved. Grounding
 * evidence URLs against `search_results`/`citations` is what lets the caller
 * tell a genuinely-retrieved URL from a hallucinated one.
 *
 * @param {{ apiKey, modelId, label }} config
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {{ maxTokens?, timeoutMs?, maxSearches? }} [opts]
 * @returns {Promise<{ text, citations, search_results, stop_reason, usage }>}
 *   citations:      [{ url, title, cited_text }]   — spans the model actually cited
 *   search_results: [{ url, title, page_age }]      — pages the tool actually opened
 */
export async function callAnthropicWebSearch(config, systemPrompt, userPrompt, opts = {}) {
  const {
    apiKey,
    modelId = ANTHROPIC_SEARCH_MODEL,
    label   = "Anthropic-web",
  } = config;

  const {
    maxTokens   = 4000,
    // Web search runs several tool round-trips (search → open pages → read →
    // synthesize) inside a single request. 90s was too tight and timed out
    // routinely, dropping the layer into a hallucinating recall fallback.
    // Allow up to 4 minutes; override with ANTHROPIC_WEB_TIMEOUT_MS.
    timeoutMs   = Number(process.env.ANTHROPIC_WEB_TIMEOUT_MS) || 240000,
    maxSearches = 5,
  } = opts;

  const body = {
    model:      modelId,
    max_tokens: maxTokens,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userPrompt }],
    tools:      [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }],
  };

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(BASE_URL, {
      method:  "POST",
      signal:  controller.signal,
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
    });
    clearTimeout(timer);

    if (res.status === 429 || res.status === 529) {
      const err = new Error(`${label} rate limited (HTTP ${res.status})`);
      err.isRateLimit = true;
      throw err;
    }
    if (res.status === 402 || res.status === 403) {
      const err = new Error(`${label} quota/auth error (HTTP ${res.status})`);
      err.isQuota = true;
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // A 400 about an unsupported/disabled tool means web search is unavailable
      // on this account — signal the caller to fall back rather than hard-fail.
      const err = new Error(`${label} HTTP ${res.status}: ${text.slice(0, 200)}`);
      if (res.status === 400 && /tool|web_search/i.test(text)) err.webSearchUnavailable = true;
      throw err;
    }

    const data = await res.json();
    const blocks = Array.isArray(data?.content) ? data.content : [];

    let text = "";
    const citations = [];
    const search_results = [];

    for (const block of blocks) {
      if (block.type === "text") {
        text += block.text || "";
        for (const c of (block.citations || [])) {
          if (c.url) citations.push({ url: c.url, title: c.title || "", cited_text: c.cited_text || "" });
        }
      } else if (block.type === "web_search_tool_result") {
        for (const r of (block.content || [])) {
          if (r.type === "web_search_result" && r.url) {
            search_results.push({ url: r.url, title: r.title || "", page_age: r.page_age || null });
          }
        }
      }
    }

    return {
      text,
      citations,
      search_results,
      stop_reason: data?.stop_reason || null,
      usage:       data?.usage || null,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      const e = new Error(`${label} web search timed out after ${timeoutMs}ms`);
      e.isUnavailable = true;
      throw e;
    }
    throw err;
  }
}
