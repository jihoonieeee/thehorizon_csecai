/**
 * usagePersistence — persists LLM cost events to llm_cost_log in Supabase.
 *
 * Every LLM call goes through persistCallCost() which buffers and flushes
 * to DB every 10 calls or 5 seconds — whichever comes first.
 * This replaces the previous session-end flush approach which lost data on crash
 * and had no per-model or per-task breakdown.
 *
 * Schema (llm_cost_log):
 *   date, context (task name), provider, model,
 *   input_tokens, output_tokens, calls, cost_usd, run_id, logged_at
 */

import { createClient } from "@supabase/supabase-js";
import { estimateCallCost } from "./pricingTable.js";

function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── Call buffer ───────────────────────────────────────────────────────────────

const _buffer = [];
let _flushTimer = null;
const FLUSH_EVERY_N = 10;
const FLUSH_DELAY_MS = 5000;

let _currentRunId = null;

/** Set a run_id that will be attached to all buffered calls until changed. */
export function setCurrentRunId(runId) {
  _currentRunId = runId || null;
}

/**
 * Buffer one LLM call for persistent logging.
 * Called by llmRouter after every successful call — fire-and-forget safe.
 *
 * @param {object} opts
 * @param {string} opts.task         - Task profile key (e.g. "source_relevance")
 * @param {string} opts.provider     - Provider key (e.g. "anthropic", "gemini")
 * @param {string} opts.model        - Model ID (e.g. "claude-haiku-4-5-20251001")
 * @param {number} opts.inputTokens
 * @param {number} opts.outputTokens
 */
export function persistCallCost({ task, provider, model, inputTokens, outputTokens, cacheReadTokens = 0, cacheCreationTokens = 0 }) {
  const cost = estimateCallCost(model, provider, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);
  _buffer.push({
    logged_at:     new Date().toISOString(),
    date:          new Date().toISOString().slice(0, 10),
    context:       task     || "unknown",
    provider:      provider || "unknown",
    model:         model    || "unknown",
    input_tokens:  inputTokens  || 0,
    output_tokens: outputTokens || 0,
    calls:         1,
    cost_usd:      cost,
    run_id:        _currentRunId,
  });

  if (_buffer.length >= FLUSH_EVERY_N) {
    _flushBuffer().catch(() => {});
  } else if (!_flushTimer) {
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      _flushBuffer().catch(() => {});
    }, FLUSH_DELAY_MS);
  }
}

async function _flushBuffer() {
  if (!_buffer.length) return;
  const batch = _buffer.splice(0, _buffer.length);
  const sb = getSupabase();
  if (!sb) return; // no credentials — skip silently (dev without DB)

  try {
    await sb.from("llm_cost_log").insert(batch);
  } catch {
    // Put items back so they can be retried on next flush
    _buffer.unshift(...batch);
  }
}

/** Force-flush any buffered calls (call at end of long-running scripts). */
export async function flushCostBuffer() {
  clearTimeout(_flushTimer);
  _flushTimer = null;
  await _flushBuffer();
}

// ── Legacy helpers (agent call — still used by api/agent.js) ─────────────────

/**
 * Log a single agent chatbot query. Uses exact token counts from Anthropic API.
 */
export async function logAgentCostToDB({ inputTokens, outputTokens, rounds, costUsd }) {
  const sb = getSupabase();
  if (!sb) return;
  try {
    await sb.from("llm_cost_log").insert({
      logged_at:     new Date().toISOString(),
      date:          new Date().toISOString().slice(0, 10),
      context:       "agent",
      provider:      "anthropic",
      model:         process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      input_tokens:  inputTokens  || 0,
      output_tokens: outputTokens || 0,
      calls:         rounds       || 1,
      cost_usd:      costUsd      || 0,
      run_id:        null,
    });
  } catch (err) {
    console.warn("[usagePersistence] logAgentCostToDB failed:", err.message);
  }
}

/**
 * Legacy: flush accumulated in-memory pipeline stats to DB.
 * Still called by api/refresh.js at end of ingestion run.
 * Now a thin wrapper — the per-call buffer covers most cases.
 */
export async function flushPipelineCostToDB(runId) {
  await flushCostBuffer();
}

// ── Read helpers ──────────────────────────────────────────────────────────────

/**
 * Read cost history broken down by date, context, provider, and model.
 * Returns { rows, by_provider, by_model, by_context, totals }
 */
export async function getCostHistory(days = 90) {
  const sb = getSupabase();
  if (!sb) return { rows: [], by_provider: {}, by_model: {}, by_context: {}, totals: {} };

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("llm_cost_log")
    .select("date,context,provider,model,input_tokens,output_tokens,calls,cost_usd,logged_at")
    .gte("date", since)
    .order("logged_at", { ascending: false });

  if (error) throw error;
  const rows = data || [];

  // Aggregate breakdowns
  const by_provider = {};
  const by_model    = {};
  const by_context  = {};
  let total_cost = 0, total_input = 0, total_output = 0, total_calls = 0;

  for (const r of rows) {
    const cost = parseFloat(r.cost_usd) || 0;
    const inp  = parseInt(r.input_tokens)  || 0;
    const out  = parseInt(r.output_tokens) || 0;
    const calls = parseInt(r.calls) || 0;
    total_cost   += cost;
    total_input  += inp;
    total_output += out;
    total_calls  += calls;

    const prov = r.provider || "unknown";
    by_provider[prov] = by_provider[prov] || { cost: 0, input_tokens: 0, output_tokens: 0, calls: 0 };
    by_provider[prov].cost          += cost;
    by_provider[prov].input_tokens  += inp;
    by_provider[prov].output_tokens += out;
    by_provider[prov].calls         += calls;

    const mod = r.model || "unknown";
    by_model[mod] = by_model[mod] || { provider: prov, cost: 0, input_tokens: 0, output_tokens: 0, calls: 0 };
    by_model[mod].cost          += cost;
    by_model[mod].input_tokens  += inp;
    by_model[mod].output_tokens += out;
    by_model[mod].calls         += calls;

    const ctx = r.context || "unknown";
    by_context[ctx] = by_context[ctx] || { cost: 0, input_tokens: 0, output_tokens: 0, calls: 0 };
    by_context[ctx].cost          += cost;
    by_context[ctx].input_tokens  += inp;
    by_context[ctx].output_tokens += out;
    by_context[ctx].calls         += calls;
  }

  return {
    rows,
    by_provider,
    by_model,
    by_context,
    totals: { cost: total_cost, input_tokens: total_input, output_tokens: total_output, calls: total_calls },
  };
}
