/**
 * agentLlm.js — small Anthropic helpers shared by the chatbot's planning and
 * verification passes.
 *
 * The main synthesis call in api/agent.js talks to Anthropic directly (Sonnet,
 * streamed). The planner and verifier are cheap, non-streamed Haiku calls that
 * return JSON. Anthropic does not honour a json_schema the way OpenAI does, so we
 * instruct JSON in the prompt and parse it loosely (first {...} to last }).
 */

import { ANTHROPIC_MODELS } from "../llm/taskProfiles.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Extract the first JSON object from model text (tolerates ```json fences / prose). */
export function parseJsonLoose(text) {
  if (!text || typeof text !== "string") return null;
  const stripped = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("{");
  const end   = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(stripped.slice(start, end + 1)); }
  catch { return null; }
}

/**
 * One Haiku JSON call. Never throws — returns { data:null, error } on any
 * failure so callers can fall back to a deterministic path. `data` is the parsed
 * object (or null); `usage` carries token counts for cost accounting.
 *
 * @param {object} opts
 * @param {string} opts.system   system prompt
 * @param {string} opts.user     user message
 * @param {number} [opts.maxTokens=700]
 * @param {number} [opts.timeoutMs=20000]
 * @param {string} [opts.model]  defaults to Haiku
 * @returns {Promise<{data:object|null, usage:{input_tokens:number,output_tokens:number}, error?:string}>}
 */
export async function callHaikuJson({
  system,
  user,
  maxTokens = 700,
  timeoutMs = 20000,
  model = ANTHROPIC_MODELS.haiku,
} = {}) {
  const empty = { input_tokens: 0, output_tokens: 0 };
  if (!process.env.ANTHROPIC_API_KEY) return { data: null, usage: empty, error: "no_api_key" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method:  "POST",
      signal:  controller.signal,
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { data: null, usage: empty, error: `HTTP ${res.status}: ${body.slice(0, 150)}` };
    }
    const j = await res.json();
    const text = j.content?.find(b => b.type === "text")?.text || "";
    return {
      data:  parseJsonLoose(text),
      usage: { input_tokens: j.usage?.input_tokens || 0, output_tokens: j.usage?.output_tokens || 0 },
    };
  } catch (err) {
    clearTimeout(timer);
    return { data: null, usage: empty, error: err.name === "AbortError" ? "timeout" : err.message };
  }
}
