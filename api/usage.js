/**
 * GET /api/usage — LLM token usage summary for the current server session.
 *
 * Returns token counts broken down by provider and task, plus rough cost
 * estimates based on published pricing. Counts reset when the server restarts
 * (in-memory only; not persisted to DB).
 *
 * Also returns cache stats and exhausted-provider list.
 */

import { getTokenUsageSummary } from "../lib/llm/llmRouter.js";

// ── Approximate pricing per 1M tokens (USD) ──────────────────────────────────
// Prices as of mid-2026; free tiers show $0 for typical small-scale use.
const PRICING = {
  gemini:      { input: 0.075,  output: 0.30,  label: "Gemini (Flash)" },
  anthropic:   { input: 3.00,   output: 15.00, label: "Anthropic (Sonnet)" },
  openai:      { input: 0.15,   output: 0.60,  label: "OpenAI (4o-mini)" },
  groq:        { input: 0.05,   output: 0.08,  label: "Groq (Llama)" },
  cloudflare:  { input: 0.011,  output: 0.033, label: "Cloudflare (Workers AI)" },
  openrouter:  { input: 0.10,   output: 0.40,  label: "OpenRouter" },
  ollama:      { input: 0,      output: 0,     label: "Ollama (local)" },
};

function estimateCost(provider, inputTokens, outputTokens) {
  const p = PRICING[provider.toLowerCase()] || { input: 0, output: 0 };
  return {
    input_usd:  (inputTokens  / 1_000_000) * p.input,
    output_usd: (outputTokens / 1_000_000) * p.output,
    total_usd:  (inputTokens  / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output,
    label:      p.label || provider,
  };
}

export default async function handler(req, res) {
  try {
    const usage = getTokenUsageSummary();

    // Augment each provider entry with cost estimates
    const byProvider = Object.entries(usage.by_provider || {}).map(([provider, stats]) => ({
      provider,
      label:         PRICING[provider.toLowerCase()]?.label || provider,
      calls:         stats.calls,
      input_tokens:  stats.input,
      output_tokens: stats.output,
      total_tokens:  stats.input + stats.output,
      cost:          estimateCost(provider, stats.input, stats.output),
    }));

    const totalCost = byProvider.reduce((sum, p) => sum + p.cost.total_usd, 0);

    const byTask = Object.entries(usage.by_task || {}).map(([task, stats]) => ({
      task,
      calls:        stats.calls,
      input_tokens: stats.input,
      output_tokens: stats.output,
      total_tokens: stats.input + stats.output,
    })).sort((a, b) => b.total_tokens - a.total_tokens);

    return res.status(200).json({
      session_date:        usage.session_date,
      daily_total_tokens:  usage.daily_total,
      daily_budget:        usage.daily_budget,
      daily_budget_pct:    usage.daily_budget_pct,
      total_cost_usd:      totalCost,
      by_provider:         byProvider,
      by_task:             byTask,
      cache:               usage.cache,
      exhausted_providers: usage.exhausted_providers,
      pricing_note:        "Cost estimates use approximate published pricing. Token counts are estimates (chars/4).",
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
