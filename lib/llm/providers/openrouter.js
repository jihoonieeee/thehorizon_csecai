/**
 * OpenRouter provider — hosted model marketplace via OpenAI-compatible API.
 *
 * Used as a fallback after Gemini/Groq/Cloudflare and before local Ollama.
 * The `openrouter/free` model routes to whatever free model OpenRouter has
 * available (capacity permitting), making it a zero-cost hosted fallback.
 *
 * Two-key rotation: OPENROUTER_API_KEY (primary), OPENROUTER_API_KEY_2 (secondary).
 * Each is registered as a separate provider entry in llmRouter so quota
 * exhaustion on key 1 automatically rolls over to key 2.
 *
 * Requires:
 *   OPENROUTER_API_KEY      — primary key
 *   OPENROUTER_API_KEY_2    — optional second key
 *   OPENROUTER_BASE_URL     — default: https://openrouter.ai/api/v1
 *
 * Model constants (set via env; see taskProfiles.js for defaults):
 *   OPENROUTER_DEFAULT_MODEL    — openrouter/free
 *   OPENROUTER_CHEAP_MODEL      — openrouter/free
 *   OPENROUTER_REASONING_MODEL  — openai/gpt-oss-20b:free
 */

import OpenAI from "openai";

const BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

// OpenRouter requires these headers to show up in their usage dashboard
const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://thehorizon.security",
  "X-Title":      "The Horizon",
};

function buildClient(apiKey) {
  return new OpenAI({
    baseURL:        BASE_URL,
    apiKey,
    defaultHeaders: OPENROUTER_HEADERS,
  });
}

/**
 * Call OpenRouter via the OpenAI SDK (OpenAI-compatible interface).
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.modelId    - e.g. "openrouter/free" or "openai/gpt-oss-20b:free"
 * @param {string} [opts.label="OpenRouter"]
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} callOpts
 * @param {object}  [callOpts.schema]       - JSON schema hint: OpenRouter free models don't
 *                                            support json_schema; degraded to JSON prompt instruction
 * @param {boolean} [callOpts.json=false]   - Request JSON output via response_format or prompt
 * @param {number}  [callOpts.maxTokens]
 * @param {number}  [callOpts.temperature=0]
 * @param {number}  [callOpts.timeoutMs=45000]
 * @returns {Promise<string>} Raw text response
 */
export async function callOpenRouter({ apiKey, modelId, label = "OpenRouter" }, systemPrompt, userPrompt, callOpts = {}) {
  const { schema = null, json = false, maxTokens, temperature = 0, timeoutMs = 45000 } = callOpts;
  const MAX_RETRIES = 2;

  // Free-tier models rarely support json_schema structured output.
  // Add a JSON instruction to the system prompt as the safe universal approach.
  let effectiveSystem = systemPrompt || "";
  if (schema || json) {
    effectiveSystem = effectiveSystem
      ? `${effectiveSystem}\n\nReturn ONLY valid JSON. No markdown fences, no commentary.`
      : "Return ONLY valid JSON. No markdown fences, no commentary.";
  }

  const messages = [];
  if (effectiveSystem) messages.push({ role: "system", content: effectiveSystem });
  messages.push({ role: "user", content: userPrompt });

  const client = buildClient(apiKey);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();

    try {
      const completion = await client.chat.completions.create(
        {
          model:       modelId,
          messages,
          temperature,
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          // Only use json_object mode — not json_schema (not supported by free models)
          ...(json || schema ? { response_format: { type: "json_object" } } : {}),
        },
        { timeout: timeoutMs }
      );

      const content = completion.choices?.[0]?.message?.content || "{}";
      const usage   = completion.usage || {};

      return content;

    } catch (err) {
      const isQuota     = err?.status === 402 || (err?.status === 429 && String(err?.message).includes("credits"));
      const isRateLimit = err?.status === 429 && !isQuota;
      const isTimeout   = err?.code === "ETIMEDOUT" || err?.name === "APIConnectionTimeoutError";

      if (isQuota) {
        throw Object.assign(
          new Error(`${label}: quota/credits exhausted`),
          { isQuota: true }
        );
      }

      if (isRateLimit && attempt < MAX_RETRIES) {
        const waitMs = (err?.headers?.["retry-after"]
          ? parseInt(err.headers["retry-after"], 10) * 1000
          : 4000 * (attempt + 1));
        process.stdout.write(` [${label} rate-limit→wait ${Math.round(waitMs / 1000)}s]\n`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (isTimeout) {
        throw new Error(`${label}: timeout after ${timeoutMs}ms`);
      }

      // Model unavailable on free tier (503, 529) — treat as transient
      if (err?.status === 503 || err?.status === 529) {
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        throw Object.assign(
          new Error(`${label}: model unavailable (${err.status})`),
          { isUnavailable: true }
        );
      }

      throw new Error(`${label}: ${err?.status ?? "error"} — ${String(err?.message || err).slice(0, 120)}`);
    }
  }

  throw new Error(`${label}: max retries exceeded`);
}
