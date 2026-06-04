/**
 * Gemini provider — wraps the Gemini generateContent REST API.
 * Supports structured output (responseSchema) and JSON mode.
 *
 * Models used by the router:
 *   gemini-2.0-flash-lite   — very cheap, free tier, simple classification
 *   gemini-2.0-flash        — free tier, medium quality
 *   gemini-2.5-flash        — cheap, good quality, default for extraction/tagging
 *   gemini-2.5-pro          — standard, high quality, final synthesis
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gemini free tier returns 429 + RESOURCE_EXHAUSTED for BOTH per-minute rate
// limits AND daily-quota exhaustion. Misclassifying a transient per-minute limit
// as permanent quota exhaustion makes the router cache the key as dead for the
// whole session — which previously killed all 4 keys on a burst. Only treat it
// as true (daily) exhaustion when the body names a per-DAY quota; per-minute /
// per-second signals (or a short retry hint) are rate limits → back off + retry.
function isPerMinuteRateLimit(body) {
  const b = (body || "");
  if (/per.?day|PerDay|requests per day|RequestsPerDay/i.test(b)) return false;  // daily → not a rate limit
  if (/per.?minute|PerMinute|per.?second|PerSecond|requests per minute/i.test(b)) return true;
  // A short "try again in Ns" retry hint indicates a transient rate limit.
  const m = b.match(/try again in (\d+(?:\.\d+)?)s/i);
  if (m && parseFloat(m[1]) <= 90) return true;
  return false;
}

function isQuotaExhausted(status, body) {
  if (status !== 429) return false;
  if (isPerMinuteRateLimit(body)) return false;   // transient — retryable, not exhausted
  return body.includes("RESOURCE_EXHAUSTED") || body.includes("quota") || body.includes("billing");
}

function isRateLimit(status, body) {
  return status === 429 && !isQuotaExhausted(status, body);
}

function retryAfterMs(body) {
  const match = body.match(/try again in (\d+(?:\.\d+)?)s/i);
  if (match) return Math.min(Math.ceil(parseFloat(match[1]) * 1000) + 500, 30000);
  return 4000;
}

/**
 * Gemini's responseSchema is OpenAPI 3.0, not full JSON Schema.
 * Specifically, `type` must be a single string — array types like ["string","null"]
 * cause an immediate 400. Strip them recursively before sending.
 */
function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out = { ...schema };
  if (Array.isArray(out.type)) {
    out.type = out.type.find((t) => t !== "null") || "string";
  }
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]) => [k, sanitizeSchemaForGemini(v)])
    );
  }
  if (out.items) out.items = sanitizeSchemaForGemini(out.items);
  return out;
}

/**
 * Call a Gemini model via the REST API.
 *
 * @param {object} opts
 * @param {string} opts.modelId   - Gemini model ID (e.g. "gemini-2.5-flash")
 * @param {string} opts.apiKey    - Gemini API key
 * @param {string} opts.label     - Label for logging
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} callOpts
 * @param {object}  [callOpts.schema]     - JSON schema for responseSchema structured output
 * @param {boolean} [callOpts.json=false] - Request JSON MIME type without schema
 * @param {number}  [callOpts.maxTokens]  - Max output tokens
 * @param {number}  [callOpts.timeoutMs=45000]
 * @returns {Promise<string>} Raw response text
 */
export async function callGemini({ modelId, apiKey, label = "Gemini" }, systemPrompt, userPrompt, callOpts = {}) {
  const { schema = null, json = false, maxTokens, timeoutMs = 45000 } = callOpts;
  const MAX_RETRIES = 2;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;
  const generationConfig = { temperature: 0 };
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
  if (json || schema) generationConfig.responseMimeType = "application/json";
  if (schema) generationConfig.responseSchema = sanitizeSchemaForGemini(schema);

  const body = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig,
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller  = new AbortController();
    const timeoutId   = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      }

      const bodyText = await response.text().catch(() => "");
      if (isQuotaExhausted(response.status, bodyText)) {
        throw Object.assign(new Error(`${label}: quota exhausted`), { isQuota: true });
      }
      if (isRateLimit(response.status, bodyText) && attempt < MAX_RETRIES) {
        const wait = retryAfterMs(bodyText);
        process.stdout.write(` [${label} rate-limit→wait ${Math.round(wait / 1000)}s]\n`);
        await sleep(wait);
        continue;
      }
      throw new Error(`${label}: ${response.status} ${bodyText.slice(0, 120)}`);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") throw new Error(`${label}: timeout after ${timeoutMs}ms`);
      throw err;
    }
  }
  throw new Error(`${label}: max retries exceeded`);
}
