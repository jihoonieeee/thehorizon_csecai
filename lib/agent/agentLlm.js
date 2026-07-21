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
import { loadPrompt } from "../prompts/promptLoader.js";

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

// Build a concise, structured text block describing the query plan so the
// selector can act on intent + constraints rather than re-parsing raw text.
function buildPlanBlock(plan) {
  const tf   = plan.temporal || {};
  const lines = [
    `query_type: ${plan.query_type || "general_search"}`,
    `requested_objects: ${(plan.requested_objects || []).join(", ") || "(any)"}`,
    `answer_shape: ${plan.answer_shape || "(any)"}`,
    `exhaustiveness: ${plan.exhaustiveness || "best_evidence"}`,
    `time_field: ${tf.time_field || "either"}`,
  ];
  if (tf.date_from || tf.date_to) {
    lines.push(`period: ${tf.date_from || "open"} → ${tf.date_to || "today"} (${tf.scope_label || ""})`);
  } else {
    lines.push(`period: ${tf.scope_label || "all available data"}`);
  }
  if (plan.entities?.length)      lines.push(`entities: ${plan.entities.join(", ")}`);
  if (plan.taxonomy_tags?.length) lines.push(`taxonomy_tags: ${plan.taxonomy_tags.join(", ")}`);
  if (plan.category)              lines.push(`category: ${plan.category}`);
  if (plan.must_include?.length)  lines.push(`must_include: ${plan.must_include.join(", ")}`);
  if (plan.must_exclude?.length)  lines.push(`must_exclude: ${plan.must_exclude.join(", ")}`);
  return lines.map(l => `  ${l}`).join("\n");
}

/**
 * selectSources — Haiku reads the full candidate pool and the structured query
 * plan, then selects the smallest evidence set that answers the request.
 *
 * Returns { selected, verdict, coverage, missing, usage }.
 * Falls back gracefully when the LLM call fails.
 *
 * @param {string}   query   — original user question
 * @param {object[]} sources — fmtSource-shaped objects from retrieveRelevant
 * @param {object}   [plan]  — normalised query plan from queryPlanner
 */
export async function selectSources(query, sources, plan = {}) {
  const empty = { input_tokens: 0, output_tokens: 0 };
  if (!sources.length) return { selected: [], verdict: "none", coverage: "none", missing: [], usage: empty };

  const system = loadPrompt("agent/selector").system;

  // Each source line: ref + quality metadata on line 1, event/coverage dates on
  // line 2 (when available), summary on line 3. Taxonomy tags are included so the
  // selector can verify technique matches and must_exclude constraints.
  const srcBlock = sources.map(s => {
    const readPart = s.reading_value ? ` | reading: ${s.reading_value}` : "";
    const matPart  = s.maturity      ? ` | maturity: ${s.maturity}`     : "";
    const tagPart  = s.tags?.length  ? `\n  tags: ${s.tags.slice(0, 5).join(", ")}` : "";
    let dateLine = `  pub: ${s.date || "n.d."}`;
    if (s.event_date)     dateLine += ` | event: ${s.event_date}`;
    if (s.coverage)       dateLine += ` | coverage: ${s.coverage}`;
    return [
      `[${s.ref}] TITLE: ${s.title}`,
      `  ${s.publisher || "?"} | trust: ${s.trust_tier || "?"} | type: ${s.source_type || "?"}${readPart}${matPart}`,
      dateLine + tagPart,
      `  ${s.summary || ""}`,
    ].join("\n");
  }).join("\n\n");

  const user = [
    `Question: ${query}`,
    ``,
    `Query plan:`,
    buildPlanBlock(plan),
    ``,
    `Candidate sources:`,
    ``,
    srcBlock,
  ].join("\n");

  // Token budget: larger than before because the plan block + richer source format
  // and the new coverage/missing fields in the response add output length.
  const out = await callHaikuJson({ system, user, maxTokens: 700 });
  const d = out?.data;

  if (!d || !Array.isArray(d.selected)) {
    // Fallback: treat all as selected; compute verdict from count so a large
    // pool is not misleadingly returned as "good".
    const n = sources.length;
    return {
      selected: sources.map(s => s.ref),
      verdict:  n === 0 ? "none" : n <= 2 ? "thin" : "good",
      coverage: "partial",
      missing:  [],
      usage:    out?.usage || empty,
    };
  }

  return {
    selected:  d.selected.filter(r => typeof r === "string"),
    verdict:   ["good","thin","none"].includes(d.verdict) ? d.verdict : "good",
    coverage:  ["complete","partial","none"].includes(d.coverage) ? d.coverage : null,
    missing:   Array.isArray(d.missing) ? d.missing.map(x => String(x || "").trim()).filter(Boolean).slice(0, 5) : [],
    reasoning: typeof d.reasoning === "string" ? d.reasoning.slice(0, 300) : null,
    usage:     out?.usage || empty,
  };
}
