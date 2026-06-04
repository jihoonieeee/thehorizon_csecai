/**
 * Ollama provider — local model via OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Used ONLY as last-resort fallback when all hosted providers are unavailable.
 * Keep it lightweight: qwen2.5:0.5b runs on CPU with <1GB RAM.
 *
 * Requires:
 *   OLLAMA_BASE_URL  — Ollama server base URL (default: http://localhost:11434)
 *   OLLAMA_MODEL     — model name to pull and use (default: qwen2.5:0.5b)
 *
 * Quick-fail strategy: 8-second timeout so a missing local server doesn't
 * block the pipeline for long. If Ollama is unavailable, the router moves on.
 */

const DEFAULT_BASE  = "http://localhost:11434";
const DEFAULT_MODEL = "qwen2.5:0.5b";

/**
 * Check if Ollama is reachable (non-blocking; fails quickly if not running).
 *
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
export async function isOllamaAvailable(baseUrl = DEFAULT_BASE) {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(tid);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Call local Ollama via its OpenAI-compatible endpoint.
 *
 * @param {object} opts
 * @param {string} [opts.baseUrl=DEFAULT_BASE]
 * @param {string} [opts.modelId=DEFAULT_MODEL]
 * @param {string} [opts.label="Ollama"]
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} callOpts
 * @param {boolean} [callOpts.json=false]    - Request JSON via prompt instruction
 * @param {object}  [callOpts.schema]        - JSON instruction added to system prompt
 * @param {number}  [callOpts.maxTokens=512] - Keep short; small model, slow CPU
 * @param {number}  [callOpts.timeoutMs=8000]- Quick timeout; fail fast if not running
 * @returns {Promise<string>} Raw text response
 */
export async function callOllama({ baseUrl = DEFAULT_BASE, modelId = DEFAULT_MODEL, label = "Ollama" }, systemPrompt, userPrompt, callOpts = {}) {
  const { schema = null, json = false, maxTokens = 512, timeoutMs = 8000 } = callOpts;

  let effectiveSystem = systemPrompt || "";
  if (schema || json) {
    effectiveSystem = `${effectiveSystem}\n\nReturn ONLY valid JSON. No markdown, no commentary.`.trim();
  }

  const messages = [];
  if (effectiveSystem) messages.push({ role: "system", content: effectiveSystem });
  messages.push({ role: "user", content: userPrompt });

  const body = {
    model:       modelId,
    messages,
    temperature: 0,
    stream:      false,
    options:     { num_predict: maxTokens },
  };

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      return data.choices?.[0]?.message?.content || "{}";
    }
    const text = await response.text().catch(() => "");
    throw new Error(`${label}: ${response.status} ${text.slice(0, 80)}`);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw Object.assign(new Error(`${label}: not reachable (timeout ${timeoutMs}ms)`), { isUnavailable: true });
    }
    if (err.code === "ECONNREFUSED" || err.cause?.code === "ECONNREFUSED") {
      throw Object.assign(new Error(`${label}: connection refused — is Ollama running?`), { isUnavailable: true });
    }
    throw err;
  }
}
