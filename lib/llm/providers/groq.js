/**
 * Groq provider — free hosted Llama via Groq's OpenAI-compatible API.
 *
 * Limitations:
 *   - JSON mode only (no json_schema structured output)
 *   - schema option is silently downgraded to json:true
 *   - Strict rate limits on free tier (30 req/min, 6000 tokens/min)
 *
 * Default model: llama-3.3-70b-versatile
 * Good for: taxonomy tagging, filtering, evidence extraction drafts
 */

const GROQ_BASE_URL  = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL  = "llama-3.3-70b-versatile";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isQuotaExhausted(status, msg) {
  if (status !== 429) return false;
  const m = msg || "";
  // Per-minute (TPM/RPM) rate limit → transient, retry; not daily exhaustion.
  // Only the per-day (TPD/RPD) message is true exhaustion. A short "try again in
  // Ns" hint also signals a transient rate limit (the billing URL appears in both
  // messages, so it can't be the sole discriminator).
  if (/per.?day|\bTPD\b|\bRPD\b/i.test(m)) return true;
  if (/per.?minute|\bTPM\b|\bRPM\b|try again in \d/i.test(m)) return false;
  return m.includes("insufficient_quota") || m.includes("exceeded your current quota") || m.includes("billing");
}

function retryAfterMs(response, body) {
  const header = response.headers?.get?.("retry-after");
  if (header) return Math.min(parseInt(header, 10) * 1000, 30000);
  const match = body.match(/try again in (\d+(?:\.\d+)?)s/i);
  if (match) return Math.min(Math.ceil(parseFloat(match[1]) * 1000) + 500, 30000);
  return 5000;
}

/**
 * Call Groq with JSON mode (degrades schema→json).
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.modelId=DEFAULT_MODEL]
 * @param {string} [opts.label="Groq"]
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} callOpts
 * @param {object}  [callOpts.schema]    - Groq doesn't support json_schema; treated as json:true
 * @param {boolean} [callOpts.json]
 * @param {number}  [callOpts.maxTokens]
 * @param {number}  [callOpts.timeoutMs=45000]
 * @returns {Promise<string>} Raw text response
 */
export async function callGroq({ apiKey, modelId = DEFAULT_MODEL, label = "Groq" }, systemPrompt, userPrompt, callOpts = {}) {
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
  // Groq: json_schema → json_object mode
  if (schema || json) body.response_format = { type: "json_object" };
  if (maxTokens) body.max_tokens = maxTokens;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
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
        return {
          text:         data.choices?.[0]?.message?.content || "{}",
          inputTokens:  data.usage?.prompt_tokens     ?? null,
          outputTokens: data.usage?.completion_tokens ?? null,
        };
      }

      const err = await response.json().catch(() => ({}));
      const msg = err?.error?.message || response.statusText || "";

      if (isQuotaExhausted(response.status, msg)) {
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
