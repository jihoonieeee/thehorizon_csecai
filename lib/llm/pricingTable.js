/**
 * LLM Model Pricing Table — USD per 1M tokens (input / output)
 * Updated June 2026. All prices from published provider pricing pages.
 *
 * Used by usagePersistence.js to compute per-call cost estimates.
 * When a model ID is not found, falls back to provider-level estimates.
 */

// ── Per-model pricing ─────────────────────────────────────────────────────────

export const MODEL_PRICING = {
  // ── Anthropic ───────────────────────────────────────────────────────────────
  "claude-opus-4-8":            { input: 15.00, output:  75.00 },
  "claude-opus-4-7":            { input: 15.00, output:  75.00 },
  "claude-sonnet-4-6":          { input:  3.00, output:  15.00 },
  "claude-sonnet-4-5":          { input:  3.00, output:  15.00 },
  "claude-haiku-4-5-20251001":  { input:  0.80, output:   4.00 },
  "claude-haiku-4-5":           { input:  0.80, output:   4.00 },
  "claude-3-5-sonnet-20241022": { input:  3.00, output:  15.00 },
  "claude-3-5-haiku-20241022":  { input:  0.80, output:   4.00 },
  "claude-3-opus-20240229":     { input: 15.00, output:  75.00 },

  // ── Google Gemini ────────────────────────────────────────────────────────────
  "gemini-2.5-flash":           { input:  0.15, output:   0.60 },  // non-thinking mode
  "gemini-2.5-pro":             { input:  1.25, output:   5.00 },  // ≤200K tokens/request
  "gemini-2.0-flash":           { input:  0.10, output:   0.40 },
  "gemini-2.0-flash-lite":      { input:  0.075, output:  0.30 },
  "gemini-1.5-flash":           { input:  0.075, output:  0.30 },
  "gemini-1.5-pro":             { input:  1.25,  output:  5.00 },

  // ── OpenAI ───────────────────────────────────────────────────────────────────
  "gpt-4o":                     { input:  2.50, output:  10.00 },
  "gpt-4o-mini":                { input:  0.15, output:   0.60 },
  "gpt-4-turbo":                { input: 10.00, output:  30.00 },

  // ── Groq ─────────────────────────────────────────────────────────────────────
  "llama-3.3-70b-versatile":    { input:  0.59, output:   0.79 },
  "llama-3.1-70b-versatile":    { input:  0.59, output:   0.79 },
  "llama-3.1-8b-instant":       { input:  0.05, output:   0.08 },
  "mixtral-8x7b-32768":         { input:  0.24, output:   0.24 },

  // ── Cloudflare Workers AI ────────────────────────────────────────────────────
  "@cf/meta/llama-3.1-8b-instruct": { input: 0, output: 0 },  // free tier

  // ── OpenRouter ───────────────────────────────────────────────────────────────
  "openrouter/auto":            { input:  0.50, output:   1.00 },  // rough average
  "openai/gpt-oss-20b:free":   { input:  0,    output:   0    },
};

// ── Provider-level fallbacks (when model ID not in table) ────────────────────

const PROVIDER_FALLBACK = {
  anthropic:  { input:  3.00, output: 15.00 },  // assume Sonnet
  gemini:     { input:  0.15, output:  0.60 },  // assume Flash
  openai:     { input:  0.15, output:  0.60 },  // assume gpt-4o-mini
  groq:       { input:  0.59, output:  0.79 },
  cloudflare: { input:  0,    output:  0    },
  openrouter: { input:  0.50, output:  1.00 },
  ollama:     { input:  0,    output:  0    },
};

/**
 * Compute estimated cost for one LLM call.
 *
 * @param {string} modelId   - Full model ID (e.g. "claude-sonnet-4-6")
 * @param {string} provider  - Provider key (e.g. "anthropic", "gemini")
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number} Estimated cost in USD
 */
export function estimateCallCost(modelId, provider, inputTokens, outputTokens) {
  const pricing =
    MODEL_PRICING[modelId] ||
    MODEL_PRICING[String(modelId).toLowerCase()] ||
    PROVIDER_FALLBACK[String(provider).toLowerCase()] ||
    { input: 0, output: 0 };

  return (
    (inputTokens  / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}
