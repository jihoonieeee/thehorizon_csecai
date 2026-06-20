/**
 * GET /api/usage — persistent LLM cost history from the database.
 *
 * Query params:
 *   ?days=N  (default 30) — how many days of history to return
 *
 * Returns aggregated cost data broken down by date, provider, model, and context.
 */

import { getCostHistory } from "../lib/llm/usagePersistence.js";

const PROVIDER_LABELS = {
  anthropic:  "Anthropic",
  gemini:     "Google Gemini",
  openai:     "OpenAI",
  groq:       "Groq",
  cloudflare: "Cloudflare AI",
  openrouter: "OpenRouter",
  ollama:     "Ollama (local)",
  unknown:    "Unknown",
};

const CONTEXT_LABELS = {
  agent:                     "Chatbot (Agent)",
  pipeline:                  "Ingestion Pipeline",
  source_relevance:          "Ingestion — L3 Relevance",
  source_relevance_qa:       "Ingestion — L3 QA",
  source_quality_gate:       "Ingestion — Quality Gate",
  source_understanding:      "Enrichment — L4 Taxonomy",
  evidence_extraction:       "Synthesis — L5 Evidence",
  category_synthesis:        "Synthesis — L6 Category",
  cross_category_synthesis:  "Synthesis — L6 Cross-Category",
  final_qa:                  "Synthesis — QA",
  chatbot_synthesis:         "Chatbot — Answer",
  chatbot_intent:            "Chatbot — Intent",
};

export default async function handler(req, res) {
  try {
    const days = Math.min(Number(req.query.days || 30), 365);
    const { rows, by_provider, by_model, by_context, totals } = await getCostHistory(days);

    // ── Daily series ─────────────────────────────────────────────────────────
    const byDate = {};
    for (const row of rows) {
      const d = row.date;
      if (!byDate[d]) byDate[d] = { date: d, total_cost: 0, total_tokens: 0, by_provider: {} };
      const cost = parseFloat(row.cost_usd) || 0;
      const tok  = (row.input_tokens || 0) + (row.output_tokens || 0);
      byDate[d].total_cost   += cost;
      byDate[d].total_tokens += tok;
      const prov = row.provider || "unknown";
      byDate[d].by_provider[prov] = (byDate[d].by_provider[prov] || 0) + cost;
    }

    const daily_series = Object.values(byDate)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(d => ({ ...d, total_cost: r8(d.total_cost) }));

    // ── This-month slice ─────────────────────────────────────────────────────
    const monthKey  = new Date().toISOString().slice(0, 7);
    const monthCost = rows
      .filter(r => (r.date || "").startsWith(monthKey))
      .reduce((s, r) => s + (parseFloat(r.cost_usd) || 0), 0);

    // ── Today slice ──────────────────────────────────────────────────────────
    const todayKey  = new Date().toISOString().slice(0, 10);
    const todayCost = rows
      .filter(r => r.date === todayKey)
      .reduce((s, r) => s + (parseFloat(r.cost_usd) || 0), 0);

    // ── Provider breakdown — sorted by cost desc ─────────────────────────────
    const provider_breakdown = Object.entries(by_provider)
      .map(([key, v]) => ({
        provider:      key,
        label:         PROVIDER_LABELS[key] || key,
        cost_usd:      r8(v.cost),
        input_tokens:  v.input_tokens,
        output_tokens: v.output_tokens,
        calls:         v.calls,
      }))
      .sort((a, b) => b.cost_usd - a.cost_usd);

    // ── Model breakdown ───────────────────────────────────────────────────────
    const model_breakdown = Object.entries(by_model)
      .map(([key, v]) => ({
        model:         key,
        provider:      v.provider,
        provider_label: PROVIDER_LABELS[v.provider] || v.provider,
        cost_usd:      r8(v.cost),
        input_tokens:  v.input_tokens,
        output_tokens: v.output_tokens,
        calls:         v.calls,
      }))
      .sort((a, b) => b.cost_usd - a.cost_usd);

    // ── Context breakdown ─────────────────────────────────────────────────────
    const context_breakdown = Object.entries(by_context)
      .map(([key, v]) => ({
        context:      key,
        label:        CONTEXT_LABELS[key] || key,
        cost_usd:     r8(v.cost),
        input_tokens: v.input_tokens,
        output_tokens: v.output_tokens,
        calls:        v.calls,
      }))
      .sort((a, b) => b.cost_usd - a.cost_usd);

    return res.status(200).json({
      days_window:        days,
      today_cost_usd:     r8(todayCost),
      month_cost_usd:     r8(monthCost),
      total_cost_usd:     r8(totals.cost),
      total_input_tokens: totals.input_tokens,
      total_output_tokens: totals.output_tokens,
      total_calls:        totals.calls,
      daily_series,
      provider_breakdown,
      model_breakdown,
      context_breakdown,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function r8(n) { return Math.round((n || 0) * 1e8) / 1e8; }
