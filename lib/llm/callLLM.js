/**
 * LLM Provider Router — callLLM()
 *
 * Legacy entry point retained for backward compatibility. New code should use
 * routedLLM() from lib/llm/llmRouter.js, which adds task-aware model selection,
 * caching, token tracking, and graceful degradation.
 *
 * ── MIGRATION ─────────────────────────────────────────────────────────────────
 * Old:  await callLLM(sys, usr, { schema, logLabel: "Layer4" })
 * New:  const { result } = await routedLLM(sys, usr, { task: "source_understanding", schema })
 *
 * When opts.task is provided to callLLM(), it delegates to routedLLM() and
 * returns the result directly (unwrapping the { result } wrapper).
 *
 * ── PROVIDER PRIORITY ORDER (legacy path, no task provided) ──────────────────
 * 1. OpenAI        OPENAI_API_KEY      → gpt-4o-mini        (structured output)
 * 2. OpenAI-2      OPENAI_API_KEY_2    → gpt-4o-mini        (structured output)
 * 3. Groq          GROQ_API_KEY        → llama-3.3-70b-versatile  (JSON mode only)
 * 4. Gemini Flash  GEMINI_API_KEY      → gemini-2.0-flash   (structured output)
 * 5. Gemini 2.5    GEMINI_API_KEY      → gemini-2.5-flash   (structured output)
 * 6. Gemini Flash-2 GEMINI_API_KEY_2  → gemini-2.0-flash   (structured output)
 * 7. Gemini 2.5-2  GEMINI_API_KEY_2   → gemini-2.5-flash   (structured output)
 *
 * ── STRUCTURED OUTPUT ─────────────────────────────────────────────────────────
 * Pass { schema: JSON_SCHEMA } to request json_schema structured output.
 * Groq automatically degrades to JSON mode (schema: null, json: true).
 * Gemini uses responseSchema in generationConfig.
 */

const OPENAI_MODEL       = "gpt-4o-mini";
const GROQ_MODEL         = "llama-3.3-70b-versatile";
const GEMINI_FLASH_MODEL = "gemini-2.0-flash";
const GEMINI_MODEL       = "gemini-2.5-flash";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isQuotaExhausted(status, body = "") {
  if (status !== 429) return false;
  return (
    body.includes("insufficient_quota") ||
    body.includes("quota_exceeded") ||
    body.includes("RESOURCE_EXHAUSTED") ||
    body.includes("exceeded your current quota") ||
    body.includes("billing")
  );
}

function isRateLimit(status, body = "") {
  if (status !== 429) return false;
  return body.includes("rate_limit") || body.includes("Rate limit") || body.includes("try again");
}

function retryAfterMs(response, body = "") {
  const header = response.headers?.get?.("retry-after");
  if (header) return Math.min(parseInt(header, 10) * 1000, 30000);
  const match = body.match(/try again in (\d+(?:\.\d+)?)s/i);
  if (match) return Math.min(Math.ceil(parseFloat(match[1]) * 1000) + 500, 30000);
  return 4000;
}

// ── OpenAI-compatible (supports system messages, JSON mode, structured output) ─

async function callOpenAICompat({ baseUrl, apiKey, model, label }, systemPrompt, userPrompt, opts = {}) {
  const { json = false, schema = null } = opts;
  const MAX_RETRIES = 3;

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  let responseFormat;
  if (schema) {
    responseFormat = {
      type: "json_schema",
      json_schema: { name: "response", schema, strict: false },
    };
  } else if (json) {
    responseFormat = { type: "json_object" };
  }

  const body = { model, messages, temperature: 0 };
  if (responseFormat) body.response_format = responseFormat;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const data = await response.json();
      return data.choices?.[0]?.message?.content || "{}";
    }

    const err = await response.json().catch(() => ({}));
    const msg = err?.error?.message || response.statusText || "";

    if (isQuotaExhausted(response.status, msg)) {
      throw Object.assign(new Error(`${label}: quota exhausted`), { isQuota: true });
    }

    if (isRateLimit(response.status, msg) && attempt < MAX_RETRIES) {
      const wait = retryAfterMs(response, msg);
      process.stdout.write(` [${label} rate-limit→wait ${Math.round(wait / 1000)}s]`);
      await sleep(wait);
      continue;
    }

    throw new Error(`${label} LLM call failed: ${response.status} ${msg}`);
  }
}

// ── Gemini ────────────────────────────────────────────────────────────────────

async function callGeminiCompat({ model, apiKey, label }, systemPrompt, userPrompt, opts = {}) {
  const { json = false, schema = null } = opts;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const MAX_RETRIES = 2;

  // Gemini doesn't support separate system messages in generateContent directly
  // for all versions; prepend system to user content
  const fullPrompt = systemPrompt
    ? `${systemPrompt}\n\n---\n\n${userPrompt}`
    : userPrompt;

  const generationConfig = { temperature: 0 };
  if (json || schema) generationConfig.responseMimeType = "application/json";
  if (schema) generationConfig.responseSchema = schema;

  const body = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig,
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    }

    const bodyText = await response.text().catch(() => "");

    if (isQuotaExhausted(response.status, bodyText) || bodyText.includes("RESOURCE_EXHAUSTED")) {
      throw Object.assign(new Error(`${label}: quota exhausted`), { isQuota: true });
    }

    if (isRateLimit(response.status, bodyText) && attempt < MAX_RETRIES) {
      const wait = retryAfterMs(response, bodyText);
      process.stdout.write(` [${label} rate-limit→wait ${Math.round(wait / 1000)}s]`);
      await sleep(wait);
      continue;
    }

    throw new Error(`${label} LLM call failed: ${response.status}`);
  }
}

// ── Session-level quota tracking ──────────────────────────────────────────────
// Once a provider hits quota exhaustion, skip it for the rest of the process.
const _exhaustedProviders = new Set();

// ── Provider list ─────────────────────────────────────────────────────────────

function buildProviders() {
  const providers = [];

  if (process.env.OPENAI_API_KEY) {
    providers.push({
      label: "OpenAI",
      call: (sys, usr, opts) => callOpenAICompat(
        { baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY, model: OPENAI_MODEL, label: "OpenAI" },
        sys, usr, opts
      ),
    });
  }

  if (process.env.OPENAI_API_KEY_2) {
    providers.push({
      label: "OpenAI-2",
      call: (sys, usr, opts) => callOpenAICompat(
        { baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY_2, model: OPENAI_MODEL, label: "OpenAI-2" },
        sys, usr, opts
      ),
    });
  }

  if (process.env.GROQ_API_KEY) {
    providers.push({
      label: "Groq",
      call: (sys, usr, opts) => callOpenAICompat(
        { baseUrl: "https://api.groq.com/openai/v1", apiKey: process.env.GROQ_API_KEY, model: GROQ_MODEL, label: "Groq" },
        // Groq doesn't support structured output schemas, but does support JSON mode.
        // Promote schema: → json: true so we still get JSON back.
        sys, usr, { ...opts, schema: null, json: opts.schema != null || opts.json }
      ),
    });
  }

  if (process.env.GEMINI_API_KEY) {
    providers.push(
      {
        label: "Gemini Flash",
        call: (sys, usr, opts) => callGeminiCompat(
          { model: GEMINI_FLASH_MODEL, apiKey: process.env.GEMINI_API_KEY, label: "Gemini Flash" },
          sys, usr, opts
        ),
      },
      {
        label: "Gemini 2.5",
        call: (sys, usr, opts) => callGeminiCompat(
          { model: GEMINI_MODEL, apiKey: process.env.GEMINI_API_KEY, label: "Gemini 2.5" },
          sys, usr, opts
        ),
      }
    );
  }

  if (process.env.GEMINI_API_KEY_2) {
    providers.push(
      {
        label: "Gemini Flash-2",
        call: (sys, usr, opts) => callGeminiCompat(
          { model: GEMINI_FLASH_MODEL, apiKey: process.env.GEMINI_API_KEY_2, label: "Gemini Flash-2" },
          sys, usr, opts
        ),
      },
      {
        label: "Gemini 2.5-2",
        call: (sys, usr, opts) => callGeminiCompat(
          { model: GEMINI_MODEL, apiKey: process.env.GEMINI_API_KEY_2, label: "Gemini 2.5-2" },
          sys, usr, opts
        ),
      }
    );
  }

  return providers;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call LLM with provider rotation. Returns parsed object if json/schema mode,
 * or raw string otherwise. Throws if all providers fail or are exhausted.
 *
 * When opts.task is provided, delegates to routedLLM() for task-aware routing.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} opts
 * @param {boolean} [opts.json=false]      - Request JSON response (json_object mode)
 * @param {object}  [opts.schema=null]     - JSON schema for structured output
 * @param {boolean} [opts.parseJson=true]  - Auto-parse JSON responses (default true when json/schema set)
 * @param {string}  [opts.logLabel=""]     - Prefix for log messages
 * @param {string}  [opts.task]            - If set, routes via llmRouter.routedLLM()
 */
export async function callLLM(systemPrompt, userPrompt, opts = {}) {
  // Task-aware path: delegate to the model router
  if (opts.task) {
    const { routedLLM } = await import("./llmRouter.js");
    const { result } = await routedLLM(systemPrompt, userPrompt, {
      task:          opts.task,
      requires_json: opts.json || opts.schema != null,
      schema:        opts.schema || null,
      logLabel:      opts.logLabel || "",
    });
    if (result === null) {
      throw new Error(`callLLM(task=${opts.task}): all providers failed`);
    }
    return result;
  }

  const { json = false, schema = null, logLabel = "" } = opts;
  const parseJson = opts.parseJson !== undefined ? opts.parseJson : (json || schema != null);

  const providers = buildProviders();
  if (providers.length === 0) {
    throw new Error("callLLM: no LLM providers configured — set OPENAI_API_KEY or GEMINI_API_KEY");
  }

  const errors = [];

  for (const provider of providers) {
    // Skip providers already known to be quota-exhausted this session
    if (_exhaustedProviders.has(provider.label)) {
      errors.push(`${provider.label}: quota exhausted (cached)`);
      continue;
    }

    try {
      const raw = await provider.call(systemPrompt, userPrompt, { json, schema });

      if (parseJson) {
        try {
          return JSON.parse(raw);
        } catch {
          // Strip markdown fences if present
          const stripped = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
          return JSON.parse(stripped);
        }
      }

      return raw;
    } catch (err) {
      if (err.isQuota) {
        _exhaustedProviders.add(provider.label);
        process.stdout.write(` [${provider.label} quota exhausted — skipping for session]\n`);
        errors.push(`${provider.label}: quota exhausted`);
        continue;
      }
      // Non-quota errors: log and try next provider
      const msg = err.message || String(err);
      process.stdout.write(` [${provider.label} error: ${msg} — trying next]\n`);
      errors.push(`${provider.label}: ${msg}`);
    }
  }

  throw new Error(
    `callLLM${logLabel ? ` (${logLabel})` : ""}: all providers failed.\n${errors.join("\n")}`
  );
}
