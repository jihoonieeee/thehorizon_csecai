/**
 * GET /api/usage — persistent LLM cost history from the database.
 *
 * Query params:
 *   ?days=N  (default 30) — how many days of history to return
 *
 * Returns aggregated cost data by date and context ('pipeline' | 'agent'),
 * without exposing implementation details (no provider/task names).
 */

import { getCostHistory } from "../lib/llm/usagePersistence.js";

export default async function handler(req, res) {
  try {
    const days = Math.min(Number(req.query.days || 30), 365);
    const rows = await getCostHistory(days);

    // Aggregate by date
    const byDate = {};
    for (const row of rows) {
      const d = row.date;
      if (!byDate[d]) byDate[d] = { date: d, pipeline_cost: 0, agent_cost: 0, total_cost: 0, total_tokens: 0 };
      const cost = parseFloat(row.cost_usd) || 0;
      const tok  = (row.input_tokens || 0) + (row.output_tokens || 0);
      byDate[d].total_cost   += cost;
      byDate[d].total_tokens += tok;
      if (row.context === "pipeline") byDate[d].pipeline_cost += cost;
      if (row.context === "agent")    byDate[d].agent_cost    += cost;
    }

    const dailySeries = Object.values(byDate)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(d => ({
        date:          d.date,
        pipeline_cost: round8(d.pipeline_cost),
        agent_cost:    round8(d.agent_cost),
        total_cost:    round8(d.total_cost),
        total_tokens:  d.total_tokens,
      }));

    // Totals
    const totalPipeline = rows.filter(r => r.context === "pipeline").reduce((s, r) => s + (parseFloat(r.cost_usd) || 0), 0);
    const totalAgent    = rows.filter(r => r.context === "agent")   .reduce((s, r) => s + (parseFloat(r.cost_usd) || 0), 0);
    const totalTokens   = rows.reduce((s, r) => s + (r.input_tokens || 0) + (r.output_tokens || 0), 0);

    // This-month slice
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthKey = monthStart.toISOString().slice(0, 7);
    const thisMonth = rows.filter(r => r.date >= `${monthKey}-01`);
    const monthCost = thisMonth.reduce((s, r) => s + (parseFloat(r.cost_usd) || 0), 0);

    return res.status(200).json({
      days_window:      days,
      total_cost_usd:   round8(totalPipeline + totalAgent),
      pipeline_cost_usd: round8(totalPipeline),
      agent_cost_usd:   round8(totalAgent),
      month_cost_usd:   round8(monthCost),
      total_tokens:     totalTokens,
      daily_series:     dailySeries,
      row_count:        rows.length,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function round8(n) { return Math.round(n * 1e8) / 1e8; }
