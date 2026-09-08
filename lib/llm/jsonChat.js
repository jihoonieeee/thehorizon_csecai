/**
 * jsonChat.js — JSON-returning convenience wrapper over the platform seam.
 *
 * Operational scripts used to hand-roll their own vendor callers (a callHaiku
 * reading ANTHROPIC_API_KEY, with a callGemini fallback reading GEMINI_API_KEY).
 * That bypassed platformProvider.js entirely, so those scripts kept working
 * against vendor keys after the rest of the codebase moved to the GovTech
 * platform — and failed silently into deterministic fallbacks once the vendor
 * keys were removed from .env.
 *
 * Everything now goes through platformChat(), which resolves ONE key and ONE
 * provider from PLATFORM_AI_* env. This module only adds the thing every script
 * repeated by hand: strip markdown fences, find the JSON, parse it.
 *
 * Thinking-model note: Gemini 2.5 and the reasoning models count thinking tokens
 * against maxTokens, so a small cap gets consumed before any answer is emitted
 * and you get empty text back. Default here is deliberately generous (1024);
 * callers with big schemas should raise it rather than lower it.
 */

import { platformChat } from "./platformProvider.js";

/** Pull a JSON value out of a model response that may be fenced or prefixed with prose. */
export function parseJsonLoose(text) {
  const clean = String(text || "")
    .replace(/^\s*```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
  if (!clean) throw new Error("empty LLM response");

  try { return JSON.parse(clean); } catch { /* fall through to substring scan */ }

  // Model wrapped the JSON in prose — take the outermost {...} or [...] span.
  const start = clean.search(/[{[]/);
  if (start < 0) throw new Error(`no JSON in response: ${clean.slice(0, 120)}`);
  const open  = clean[start];
  const close = open === "{" ? "}" : "]";
  const end   = clean.lastIndexOf(close);
  if (end <= start) throw new Error(`unterminated JSON in response: ${clean.slice(0, 120)}`);
  return JSON.parse(clean.slice(start, end + 1));
}

/**
 * One JSON call through the platform seam.
 *
 * @param {object}  opts
 * @param {"cheap"|"standard"|"synthesis"} [opts.tier="cheap"]
 * @param {string}  opts.system
 * @param {string}  opts.user
 * @param {object}  [opts.schema]      JSON schema (honoured by providers that support it)
 * @param {number}  [opts.maxTokens=1024]
 * @param {number}  [opts.timeoutMs=60000]
 * @returns {Promise<any>} the parsed JSON value
 */
export async function jsonChat({ tier = "cheap", system, user, schema, maxTokens = 1024, timeoutMs = 60000 }) {
  const res = await platformChat({
    tier, system, user, schema,
    json: true,
    maxTokens,
    timeoutMs,
  });
  if (res.finishReason === "length") {
    throw new Error(`response truncated at maxTokens=${maxTokens} — raise it for this task`);
  }
  return parseJsonLoose(res.text);
}

/** Same call, but returns raw text instead of parsed JSON. */
export async function textChat({ tier = "cheap", system, user, maxTokens = 1024, timeoutMs = 60000 }) {
  const res = await platformChat({ tier, system, user, maxTokens, timeoutMs });
  return String(res.text || "").trim();
}
