/**
 * usagePersistence — writes LLM cost events to the llm_cost_log Supabase table
 * and reads historical cost data back for the dashboard.
 *
 * Two event types:
 *   pipeline — flushed once at the end of each /api/refresh ingestion run
 *   agent    — one row per /api/agent chatbot query
 */

import { supabase } from "../storage/supabaseClient.js";
import { getTokenUsageSummary } from "./llmRouter.js";

// Approximate pricing per 1M tokens (USD) — same as api/usage.js
const PRICING = {
  gemini:     { input: 0.075,  output: 0.30  },
  anthropic:  { input: 3.00,   output: 15.00 },
  openai:     { input: 0.15,   output: 0.60  },
  groq:       { input: 0.05,   output: 0.08  },
  cloudflare: { input: 0.011,  output: 0.033 },
  openrouter: { input: 0.10,   output: 0.40  },
  ollama:     { input: 0,      output: 0     },
};

function providerCost(provider, input, output) {
  const p = PRICING[provider.toLowerCase()] || { input: 0, output: 0 };
  return (input / 1_000_000) * p.input + (output / 1_000_000) * p.output;
}

/**
 * Flush the current in-memory pipeline LLM usage to llm_cost_log.
 * Call once at the end of each ingestion run (fire-and-forget safe).
 */
export async function flushPipelineCostToDB(runId) {
  try {
    const usage = getTokenUsageSummary();
    const date  = usage.session_date || new Date().toISOString().slice(0, 10);

    let totalInput = 0, totalOutput = 0, totalCalls = 0, totalCost = 0;
    for (const [provider, stats] of Object.entries(usage.by_provider || {})) {
      totalInput  += stats.input  || 0;
      totalOutput += stats.output || 0;
      totalCalls  += stats.calls  || 0;
      totalCost   += providerCost(provider, stats.input || 0, stats.output || 0);
    }

    if (totalCalls === 0) return;

    await supabase.from("llm_cost_log").insert({
      date,
      context:       "pipeline",
      input_tokens:  totalInput,
      output_tokens: totalOutput,
      calls:         totalCalls,
      cost_usd:      totalCost,
      run_id:        runId || null,
    });
  } catch (err) {
    console.warn("[usagePersistence] flushPipelineCostToDB failed:", err.message);
  }
}

/**
 * Log a single agent chatbot query to llm_cost_log.
 * Uses exact token counts from the Anthropic API response.
 */
export async function logAgentCostToDB({ inputTokens, outputTokens, rounds, costUsd }) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    await supabase.from("llm_cost_log").insert({
      date,
      context:       "agent",
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
 * Read cost history from llm_cost_log (last N days).
 * Returns raw rows ordered newest-first.
 */
export async function getCostHistory(days = 90) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("llm_cost_log")
    .select("date, context, input_tokens, output_tokens, calls, cost_usd, logged_at, run_id")
    .gte("date", since)
    .order("logged_at", { ascending: false });

  if (error) throw error;
  return data || [];
}
