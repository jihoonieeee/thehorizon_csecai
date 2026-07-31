/**
 * platformProvider.js — the single swappable LLM seam.
 *
 * Every LLM call that used to talk to a specific vendor directly (the chatbot's
 * synthesis + planner/selector/verifier) now goes through platformChat(), which
 * resolves ONE key and ONE provider from the environment:
 *
 *   PLATFORM_AI_API_KEY   — the one key
 *   PLATFORM_AI_PROVIDER  — "gemini" | "openai-compatible" | "anthropic"  (default: gemini)
 *   PLATFORM_AI_BASE_URL  — base URL for openai-compatible gateways
 *
 * Swapping providers later (item 4) is a config change: set PLATFORM_AI_PROVIDER
 * + PLATFORM_AI_API_KEY (+ base URL), re-run scripts/checkLlmProvider.js, done.
 * No consumer code changes.
 *
 * ── TIERS ─────────────────────────────────────────────────────────────────────
 * Callers ask for an ABSTRACT tier, not a model name:
 *   cheap     — planner / selector / verifier / brief lookups
 *   standard  — mid-weight tasks
 *   synthesis — the final grounded answer
 * The tier → concrete-model table is per provider and overridable via env
 * (PLATFORM_MODEL_CHEAP / _STANDARD / _SYNTHESIS).
 *
 * ── RETURN SHAPE ──────────────────────────────────────────────────────────────
 *   { text, inputTokens, outputTokens, model, provider }
 * When stream:true, text deltas are delivered via onText(delta) as they arrive and
 * the full text is also returned.
 */

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_PROVIDER = "gemini";

const MODEL_TIERS = {
  gemini: {
    cheap:     process.env.PLATFORM_MODEL_CHEAP     || "gemini-2.5-flash",
    standard:  process.env.PLATFORM_MODEL_STANDARD  || "gemini-2.5-flash",
    synthesis: process.env.PLATFORM_MODEL_SYNTHESIS || "gemini-2.5-pro",
  },
  anthropic: {
    cheap:     process.env.PLATFORM_MODEL_CHEAP     || "claude-haiku-4-5-20251001",
    standard:  process.env.PLATFORM_MODEL_STANDARD  || "claude-sonnet-4-6",
    synthesis: process.env.PLATFORM_MODEL_SYNTHESIS || "claude-sonnet-4-6",
  },
  "openai-compatible": {
    cheap:     process.env.PLATFORM_MODEL_CHEAP     || "gpt-4o-mini",
    standard:  process.env.PLATFORM_MODEL_STANDARD  || "gpt-4o",
    synthesis: process.env.PLATFORM_MODEL_SYNTHESIS || "gpt-4o",
  },
};

// USD per 1M tokens — used for cost accounting. Keyed by model id prefix so a
// swapped-in model still gets a sensible estimate. Unknown models → 0 (logged).
const PRICING = {
  "gemini-2.5-pro":         { input:  1.25, output: 10.00 },
  "gemini-2.5-flash":       { input:  0.30, output:  2.50 },
  "gemini-2.5-flash-lite":  { input:  0.10, output:  0.40 },
  "gemini-2.0-flash":       { input:  0.10, output:  0.40 },
  "claude-opus":            { input: 15.00, output: 75.00 },
  "claude-sonnet":          { input:  3.00, output: 15.00 },
  "claude-haiku":           { input:  1.00, output:  5.00 },
  "gpt-4o-mini":            { input:  0.15, output:  0.60 },
  "gpt-4o":                 { input:  2.50, output: 10.00 },
};

export function platformConfig() {
  // Hard lock: LLM_ONLY_GEMINI pins the chatbot to Gemini regardless of
  // PLATFORM_AI_PROVIDER, so nothing can route to another vendor while it's set.
  const onlyGemini = /^(1|true|yes)$/i.test(process.env.LLM_ONLY_GEMINI || "");
  const provider = onlyGemini ? "gemini" : (process.env.PLATFORM_AI_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
  // Pick the provider-native key first so PLATFORM_AI_API_KEY (which may hold
  // a non-Gemini key) doesn't shadow GEMINI_API_KEY when provider=gemini.
  const apiKey =
    (provider === "gemini"            ? process.env.GEMINI_API_KEY    : null) ||
    (provider === "anthropic"         ? process.env.ANTHROPIC_API_KEY : null) ||
    (provider === "openai-compatible" ? process.env.PLATFORM_AI_API_KEY || process.env.OPENAI_API_KEY : null) ||
    process.env.PLATFORM_AI_API_KEY ||
    null;
  const baseUrl =
    process.env.PLATFORM_AI_BASE_URL ||
    (provider === "openai-compatible" ? "https://api.openai.com/v1" : null);
  return { provider, apiKey, baseUrl };
}

export function modelForTier(tier, provider) {
  const table = MODEL_TIERS[provider] || MODEL_TIERS[DEFAULT_PROVIDER];
  return table[tier] || table.standard;
}

/** USD cost estimate for a completed call. Matches on the longest pricing-key prefix. */
export function estimateCostUsd({ model, inputTokens = 0, outputTokens = 0 }) {
  if (!model) return 0;
  let match = null;
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key) && (!match || key.length > match.length)) match = key;
  }
  if (!match) return 0;
  const p = PRICING[match];
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}

// ── Message normalisation ─────────────────────────────────────────────────────

/** Flatten a system prompt (string OR array of {text}/string blocks) to a string. */
function systemToString(system) {
  if (!system) return "";
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === "string" ? b : b?.text || "")).filter(Boolean).join("\n\n");
  }
  return String(system);
}

/** Normalise {system, user, messages} into a messages array (user roles only support). */
function normalizeMessages({ user, messages }) {
  if (Array.isArray(messages) && messages.length) return messages;
  if (user != null) return [{ role: "user", content: String(user) }];
  return [];
}

// ── Transports ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gemini's responseSchema is OpenAPI 3.0, not full JSON Schema: type must be a
// single string. Strip array types recursively (mirrors providers/gemini.js).
function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out = { ...schema };
  if (Array.isArray(out.type)) out.type = out.type.find((t) => t !== "null") || "string";
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]) => [k, sanitizeSchemaForGemini(v)])
    );
  }
  if (out.items) out.items = sanitizeSchemaForGemini(out.items);
  return out;
}

async function geminiChat(cfg, model, { system, messages, json, schema, maxTokens, timeoutMs, stream, onText, thinkingBudget }) {
  const contents = messages.map((m) => ({
    role:  m.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof m.content === "string" ? m.content : systemToString(m.content) }],
  }));
  const generationConfig = { temperature: 0 };
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
  if (json || schema) generationConfig.responseMimeType = "application/json";
  if (schema) generationConfig.responseSchema = sanitizeSchemaForGemini(schema);
  // Gemini 2.5 models are thinking models: thinking tokens count against
  // maxOutputTokens, so a small cap gets consumed by thinking → empty answer.
  // Callers pass thinkingBudget to control it. 0 disables thinking (Flash only;
  // Pro has a 128-token floor and cannot be fully disabled — clamp up).
  if (thinkingBudget != null) {
    const budget = (thinkingBudget === 0 && /pro/.test(model)) ? 128 : thinkingBudget;
    generationConfig.thinkingConfig = { thinkingBudget: budget };
  }

  const body = { contents, generationConfig };
  const sysText = systemToString(system);
  if (sysText) body.systemInstruction = { parts: [{ text: sysText }] };

  const base = `https://generativelanguage.googleapis.com/v1beta/models/${model}`;
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (stream) {
        const res = await fetch(`${base}:streamGenerateContent?alt=sse&key=${cfg.apiKey}`, {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          // 503 on the stream endpoint — retry with backoff (same logic as buffered path)
          if (res.status === 503 && attempt < MAX_RETRIES) {
            clearTimeout(timer);
            const wait = (attempt + 1) * 5000;
            process.stdout.write(` [Gemini stream 503→retry in ${wait / 1000}s]\n`);
            await sleep(wait);
            continue;
          }
          throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 200)}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "", full = "", inputTokens = null, outputTokens = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            let evt; try { evt = JSON.parse(data); } catch { continue; }
            const delta = evt.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (delta) { full += delta; if (onText) onText(delta); }
            if (evt.usageMetadata) {
              inputTokens  = evt.usageMetadata.promptTokenCount     ?? inputTokens;
              outputTokens = evt.usageMetadata.candidatesTokenCount ?? outputTokens;
            }
          }
        }
        clearTimeout(timer);
        return { text: full, inputTokens, outputTokens, model, provider: "gemini" };
      }

      const res = await fetch(`${base}:generateContent?key=${cfg.apiKey}`, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      clearTimeout(timer);
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        // 503 Service Unavailable — Gemini API transient overload; retry with backoff
        if (res.status === 503 && attempt < MAX_RETRIES) {
          const wait = (attempt + 1) * 5000;
          process.stdout.write(` [Gemini 503→retry in ${wait / 1000}s]\n`);
          await sleep(wait);
          continue;
        }
        throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 200)}`);
      }
      const data = await res.json();
      const meta = data.usageMetadata || {};
      return {
        text:         data.candidates?.[0]?.content?.parts?.[0]?.text || "",
        inputTokens:  meta.promptTokenCount     ?? null,
        outputTokens: meta.candidatesTokenCount ?? null,
        model, provider: "gemini",
      };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") throw new Error(`Gemini: timeout after ${timeoutMs}ms`);
      throw err;
    }
  }
  throw new Error(`Gemini: max retries exceeded (503)`);
}

async function openaiChat(cfg, model, { system, messages, json, schema, maxTokens, timeoutMs, stream, onText }) {
  const msgs = [];
  const sysText = systemToString(system);
  if (sysText) msgs.push({ role: "system", content: sysText });
  for (const m of messages) {
    msgs.push({ role: m.role, content: typeof m.content === "string" ? m.content : systemToString(m.content) });
  }
  const body = { model, messages: msgs, temperature: 0 };
  if (maxTokens) body.max_tokens = maxTokens;
  if (schema) body.response_format = { type: "json_schema", json_schema: { name: "response", schema, strict: false } };
  else if (json) body.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${cfg.baseUrl}/chat/completions`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` };

  try {
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
      const res = await fetch(url, { method: "POST", signal: controller.signal, headers, body: JSON.stringify(body) });
      if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`OpenAI HTTP ${res.status}: ${t.slice(0, 200)}`); }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", full = "", inputTokens = null, outputTokens = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let evt; try { evt = JSON.parse(data); } catch { continue; }
          const delta = evt.choices?.[0]?.delta?.content || "";
          if (delta) { full += delta; if (onText) onText(delta); }
          if (evt.usage) { inputTokens = evt.usage.prompt_tokens ?? inputTokens; outputTokens = evt.usage.completion_tokens ?? outputTokens; }
        }
      }
      clearTimeout(timer);
      return { text: full, inputTokens, outputTokens, model, provider: "openai-compatible" };
    }

    const res = await fetch(url, { method: "POST", signal: controller.signal, headers, body: JSON.stringify(body) });
    clearTimeout(timer);
    if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`OpenAI HTTP ${res.status}: ${t.slice(0, 200)}`); }
    const data = await res.json();
    return {
      text:         data.choices?.[0]?.message?.content || "",
      inputTokens:  data.usage?.prompt_tokens     ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      model, provider: "openai-compatible",
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error(`OpenAI: timeout after ${timeoutMs}ms`);
    throw err;
  }
}

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

async function anthropicChat(cfg, model, { system, messages, maxTokens, timeoutMs, stream, onText }) {
  // Anthropic keeps the system as-is (array with cache_control preserved).
  const msgs = messages.map((m) => ({ role: m.role, content: m.content }));
  const body = { model, max_tokens: maxTokens || 2048, system, messages: msgs };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "Content-Type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": ANTHROPIC_VERSION };

  try {
    if (stream) {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: "POST", signal: controller.signal, headers, body: JSON.stringify({ ...body, stream: true }),
      });
      if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`Anthropic HTTP ${res.status}: ${t.slice(0, 200)}`); }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", full = "", inputTokens = 0, outputTokens = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let evt; try { evt = JSON.parse(data); } catch { continue; }
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") { full += evt.delta.text; if (onText) onText(evt.delta.text); }
          else if (evt.type === "message_start") inputTokens = evt.message?.usage?.input_tokens || 0;
          else if (evt.type === "message_delta") outputTokens = evt.usage?.output_tokens || outputTokens;
        }
      }
      clearTimeout(timer);
      return { text: full, inputTokens, outputTokens, model, provider: "anthropic" };
    }

    const res = await fetch(ANTHROPIC_API_URL, { method: "POST", signal: controller.signal, headers, body: JSON.stringify(body) });
    clearTimeout(timer);
    if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`Anthropic HTTP ${res.status}: ${t.slice(0, 200)}`); }
    const data = await res.json();
    return {
      text:         data.content?.find((b) => b.type === "text")?.text || "",
      inputTokens:  data.usage?.input_tokens  ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
      model, provider: "anthropic",
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error(`Anthropic: timeout after ${timeoutMs}ms`);
    throw err;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * The one entry point. Resolves provider + key from env, maps tier → model, and
 * dispatches to the right transport.
 *
 * @param {object} opts
 * @param {"cheap"|"standard"|"synthesis"} [opts.tier="standard"]
 * @param {string|Array} [opts.system]     system prompt (string, or array of blocks)
 * @param {string}   [opts.user]           convenience single user message
 * @param {Array}    [opts.messages]       full message array ({role, content}); wins over user
 * @param {boolean}  [opts.json=false]     request JSON output
 * @param {object}   [opts.schema=null]    JSON schema for structured output
 * @param {boolean}  [opts.stream=false]   stream deltas via onText
 * @param {function} [opts.onText]         (delta) => void, called during streaming
 * @param {number}   [opts.maxTokens]
 * @param {number}   [opts.timeoutMs=90000]
 * @param {number}   [opts.thinkingBudget]  Gemini only: 0 disables thinking (Flash);
 *                                          omit for dynamic thinking. Ignored by other providers.
 * @returns {Promise<{text, inputTokens, outputTokens, model, provider}>}
 */
export async function platformChat(opts = {}) {
  const { tier = "standard", system, json = false, schema = null, stream = false, onText, maxTokens, timeoutMs = 90000, thinkingBudget } = opts;
  const cfg = platformConfig();
  if (!cfg.apiKey) throw new Error("platformChat: no API key — set PLATFORM_AI_API_KEY (or a provider-specific key)");
  const model = modelForTier(tier, cfg.provider);
  const messages = normalizeMessages(opts);
  const args = { system, messages, json, schema, maxTokens, timeoutMs, stream, onText, thinkingBudget };

  switch (cfg.provider) {
    case "gemini":            return geminiChat(cfg, model, args);
    case "openai-compatible": return openaiChat(cfg, model, args);
    case "anthropic":         return anthropicChat(cfg, model, args);
    default: throw new Error(`platformChat: unknown PLATFORM_AI_PROVIDER "${cfg.provider}"`);
  }
}

export { PRICING as PLATFORM_PRICING };