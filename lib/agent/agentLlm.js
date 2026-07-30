/**
 * agentLlm.js — small LLM helpers shared by the chatbot's planning and
 * verification passes.
 *
 * All chatbot LLM access now flows through the swappable platform seam
 * (lib/llm/platformProvider.js). The planner/selector/verifier are cheap,
 * non-streamed JSON calls (the "cheap" tier). The provider does not necessarily
 * honour a json_schema, so we instruct JSON in the prompt and parse it loosely
 * (first {...} to last }).
 */

import { platformChat } from "../llm/platformProvider.js";
import { loadPrompt } from "../prompts/promptLoader.js";

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
 * One cheap-tier JSON call through the platform seam. Never throws — returns
 * { data:null, error } on any failure so callers can fall back to a deterministic
 * path. `data` is the parsed object (or null); `usage` carries token counts for
 * cost accounting.
 *
 * Named callHaikuJson for historical reasons; the concrete model is whatever the
 * platform provider maps the "cheap" tier to (Gemini Flash by default).
 *
 * @param {object} opts
 * @param {string} opts.system   system prompt
 * @param {string} opts.user     user message
 * @param {number} [opts.maxTokens=700]
 * @param {number} [opts.timeoutMs=20000]
 * @returns {Promise<{data:object|null, usage:{input_tokens:number,output_tokens:number}, model?:string, error?:string}>}
 */
export async function callHaikuJson({
  system,
  user,
  maxTokens = 700,
  timeoutMs = 20000,
} = {}) {
  const empty = { input_tokens: 0, output_tokens: 0 };
  try {
    // thinkingBudget: 0 — these are structured-JSON extraction calls on the cheap
    // (Flash) tier with small token caps; thinking would consume the budget and
    // return empty JSON. Disable it for fast, deterministic output.
    const r = await platformChat({ tier: "cheap", system, user, json: true, maxTokens, timeoutMs, thinkingBudget: 0 });
    return {
      data:  parseJsonLoose(r.text),
      usage: { input_tokens: r.inputTokens || 0, output_tokens: r.outputTokens || 0 },
      model: r.model,
    };
  } catch (err) {
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
  if (plan.entity_role)           lines.push(`entity_role: ${plan.entity_role}`);
  return lines.map(l => `  ${l}`).join("\n");
}

/**
 * selectSources — Haiku reads the full candidate pool and the structured query
 * plan, then selects the smallest evidence set that answers the request.
 *
 * Returns { selected, verdict, coverage, missing, usage }.
 * Falls back gracefully when the LLM call fails.
 *
 * @param {string}   query              — original user question
 * @param {object[]} sources            — fmtSource-shaped objects from retrieveRelevant
 * @param {object}   [plan]             — normalised query plan from queryPlanner
 * @param {number}   [totalCandidateCount] — total candidates retrieved before the top-N cap
 */
export async function selectSources(query, sources, plan = {}, totalCandidateCount = null, evidenceBySrcId = {}) {
  const empty = { input_tokens: 0, output_tokens: 0 };
  if (!sources.length) return { selected: [], verdict: "none", coverage: "none", missing: [], usage: empty };

  const system = loadPrompt("agent/selector").system;

  // Each source line: ref + quality metadata on line 1, event/coverage dates on
  // line 2 (when available), summary on line 3. Taxonomy tags are included so the
  // selector can verify technique matches and must_exclude constraints.
  // retrieval_lanes shows whether the source came from keyword, tag, or vector
  // search — vector-only sources may lack keyword overlap but be highly relevant.
  const srcBlock = sources.map(s => {
    const readPart = s.reading_value ? ` | reading: ${s.reading_value}` : "";
    const matPart  = s.maturity      ? ` | maturity: ${s.maturity}`     : "";
    const lanePart = s.retrieval_lanes?.length ? ` | lanes: ${s.retrieval_lanes.join("+")}` : "";
    const tagPart  = s.tags?.length  ? `\n  tags: ${s.tags.slice(0, 5).join(", ")}` : "";
    let dateLine = `  pub: ${s.date || "n.d."}`;
    if (s.event_date)     dateLine += ` | event: ${s.event_date}`;
    if (s.coverage)       dateLine += ` | coverage: ${s.coverage}`;

    // Evidence facts: atomic facts from L5 extraction, beyond the truncated summary.
    // Only present for sources with completed extraction; absent = fall back to summary.
    const evItems  = evidenceBySrcId[s.id] || [];
    const factTexts = evItems
      .map(e => (e.fact || "").slice(0, 120))
      .filter(f => f.length >= 30);
    const factsLine = factTexts.length ? `  facts: ${factTexts.join(" | ")}` : "";

    return [
      `[${s.ref}] TITLE: ${s.title}`,
      `  ${s.publisher || "?"} | trust: ${s.trust_tier || "?"} | type: ${s.source_type || "?"}${readPart}${matPart}${lanePart}`,
      dateLine + tagPart,
      `  ${s.summary || ""}`,
      factsLine,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  // Tell the selector if this is a subset of a larger retrieval pool so it can
  // accurately report coverage: "partial" when more candidates exist beyond what
  // is shown here.
  const poolNote = (totalCandidateCount && totalCandidateCount > sources.length)
    ? `\nPool note: showing top ${sources.length} of ${totalCandidateCount} retrieved candidates. Set coverage "partial" if the pool appears incomplete for the requested scope.\n`
    : "";

  const user = [
    `Question: ${query}`,
    ``,
    `Query plan:`,
    buildPlanBlock(plan),
    poolNote,
    `Candidate sources:`,
    ``,
    srcBlock,
  ].join("\n");

  // Token budget raised to 1200: larger candidate pool (up to 60 sources) + evidence
  // facts lines increase input; output JSON with more selected refs needs headroom.
  // Truncated JSON → parse fails → fallback fires (top 8 only), so headroom matters.
  const out = await callHaikuJson({ system, user, maxTokens: 1200 });
  const d = out?.data;

  if (!d || !Array.isArray(d.selected)) {
    // Fallback: select the top 8 (best-ranked by retrieval scoring) rather than
    // all candidates. Selecting all floods synthesis and produces a misleading
    // "good" verdict when the LLM simply failed to respond.
    const n = sources.length;
    return {
      selected: sources.slice(0, 8).map(s => s.ref),
      verdict:  n === 0 ? "none" : "thin",
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
