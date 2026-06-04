/**
 * Cloudflare Workers AI provider — free-tier inference via Cloudflare's REST API.
 *
 * Best for: cheap classification, source filtering, deduplication checks.
 * Not for: structured output (no json_schema), long-form synthesis.
 *
 * Requires:
 *   CLOUDFLARE_ACCOUNT_ID — your Cloudflare account ID
 *   CLOUDFLARE_API_TOKEN  — API token with Workers AI permission
 *
 * Default model: @cf/meta/llama-3.1-8b-instruct
 * Other free options: @cf/qwen/qwen1.5-7b-chat-awq, @hf/google/gemma-7b-it
 */

const DEFAULT_MODEL  = "@cf/meta/llama-3.1-8b-instruct";
const CF_BASE        = "https://api.cloudflare.com/client/v4/accounts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call Cloudflare Workers AI.
 *
 * @param {object} opts
 * @param {string} opts.accountId
 * @param {string} opts.apiToken
 * @param {string} [opts.modelId=DEFAULT_MODEL]
 * @param {string} [opts.label="Cloudflare"]
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} callOpts
 * @param {number}  [callOpts.maxTokens=512]    - Cloudflare AI has conservative limits
 * @param {boolean} [callOpts.json=false]       - Instructs model via prompt to return JSON
 * @param {object}  [callOpts.schema]           - Schema hint added to system prompt (no native support)
 * @param {number}  [callOpts.timeoutMs=30000]  - Shorter timeout; CF AI can be slow
 * @returns {Promise<string>} Raw text response
 */
export async function callCloudflare({ accountId, apiToken, modelId = DEFAULT_MODEL, label = "Cloudflare" }, systemPrompt, userPrompt, callOpts = {}) {
  const { schema = null, json = false, maxTokens = 512, timeoutMs = 30000 } = callOpts;
  const MAX_RETRIES = 2;

  // Cloudflare doesn't support json_schema — add JSON instruction to system prompt
  let effectiveSystem = systemPrompt || "";
  if (schema || json) {
    effectiveSystem = `${effectiveSystem}\n\nIMPORTANT: Return ONLY valid JSON. No markdown, no preamble.`.trim();
  }

  const messages = [];
  if (effectiveSystem) messages.push({ role: "system", content: effectiveSystem });
  messages.push({ role: "user", content: userPrompt });

  const body = { messages, max_tokens: maxTokens };
  // The model id (e.g. "@cf/meta/llama-3.1-8b-instruct") contains path separators
  // that must stay literal — encodeURIComponent would turn "/" into "%2F" and
  // produce "No route for that URI" (CF error 7000). Interpolate it raw.
  const url  = `${CF_BASE}/${accountId}/ai/run/${modelId}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${apiToken}`,
        },
        body:   JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        // CF AI response shape: { result: { response: "..." }, success: true }
        const text = data?.result?.response ?? data?.result ?? "";
        return typeof text === "string" ? text : JSON.stringify(text);
      }

      const bodyText = await response.text().catch(() => "");
      if (response.status === 429 && attempt < MAX_RETRIES) {
        await sleep(3000 * (attempt + 1));
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
