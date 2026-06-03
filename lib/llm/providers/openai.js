/**
 * OpenAI provider — gpt-4o-mini via the OpenAI Chat Completions API.
 *
 * OpenAI-compatible (same shape as Groq). Used for bulk per-source tasks
 * (source_understanding, taxonomy_tagging, evidence_extraction) where a cheap,
 * capable, JSON-reliable model clears the backlog faster than the free tiers.
 *
 * Two keys (OPENAI_API_KEY, OPENAI_API_KEY_2) are rotated by the router: when
 * key 1 is quota-exhausted the router falls through to the key-2 executor.
 *
 * Default model: gpt-4o-mini (override with OPENAI_MODEL).
 */

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL   = "gpt-4o-mini";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429 can mean either a per-minute rate limit (retry) or a hard quota/billing
// exhaustion (skip provider). Distinguish by error type/code/message.
function isQuotaExhausted(status, type, code, msg) {
  if (status === 402) return true;
  if (status !== 429) return false;
  return (
    type === "insufficient_quota" ||
    code === "insufficient_quota" ||
    msg.includes("insufficient_quota") ||
    msg.includes("exceeded your current quota") ||
    msg.includes("billing")
  );
}

function retryAfterMs(response, body) {
  const header = response.headers?.get?.("retry-after");
  if (header) return Math.min(parseInt(header, 10) * 1000, 30000);
  const match = body.match(/try again in (\d+(?:\.\d+)?)s/i);
  if (match) return Math.min(Math.ceil(parseFloat(match[1]) * 1000) + 500, 30000);
  return 5000;
}

/**
 * Call OpenAI Chat Completions.
 *
 * @param {{apiKey, modelId?, label?}} config
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {{schema?, json?, maxTokens?, timeoutMs?}} [callOpts]
 * @returns {Promise<string>} Raw text content
 */
export async function callOpenAI({ apiKey, modelId = DEFAULT_MODEL, label = "OpenAI" }, systemPrompt, userPrompt, callOpts = {}) {
  const { schema = null, json = false, maxTokens, timeoutMs = 45000 } = callOpts;
  const MAX_RETRIES = 3;

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  const body = {
    model:       modelId,
    messages,
    temperature: 0,
  };
  // JSON-object mode (reliable, model-agnostic). The prompts already say
  // "Return strict JSON only", which satisfies the json_object requirement.
  if (schema || json) body.response_format = { type: "json_object" };
  if (maxTokens) body.max_tokens = maxTokens;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${apiKey}`,
        },
        body:   JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        return data.choices?.[0]?.message?.content || "{}";
      }

      const err  = await response.json().catch(() => ({}));
      const msg  = err?.error?.message || response.statusText || "";
      const type = err?.error?.type || "";
      const code = err?.error?.code || "";

      if (isQuotaExhausted(response.status, type, code, msg)) {
        throw Object.assign(new Error(`${label}: quota exhausted`), { isQuota: true });
      }
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const wait = retryAfterMs(response, msg);
        process.stdout.write(` [${label} rate-limit→wait ${Math.round(wait / 1000)}s]\n`);
        await sleep(wait);
        continue;
      }
      throw new Error(`${label}: ${response.status} ${msg}`);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") throw new Error(`${label}: timeout after ${timeoutMs}ms`);
      throw err;
    }
  }
  throw new Error(`${label}: max retries exceeded`);
}
