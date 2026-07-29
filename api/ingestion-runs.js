import { supabase } from "../lib/storage/supabaseClient.js";
import { requireAuth } from "../lib/api/requireAuth.js";

// Aggregate connector_results arrays across many runs into per-connector totals.
// connector_results can be an array or an object (legacy runs stored an object keyed
// by index). We normalise both.
function aggregateConnectors(runs) {
  const byConnector = {}; // name → { fetched, runs, failed }
  for (const run of runs) {
    let cr = run.connector_results;
    if (!cr) continue;
    if (!Array.isArray(cr)) cr = Object.values(cr);
    for (const c of cr) {
      if (!c?.connector) continue;
      const name = c.connector;
      byConnector[name] ??= { connector: name, trust_tier: c.trust_tier || null, retrieval_method: c.retrieval_method || null, total_fetched: 0, runs_active: 0, runs_failed: 0, last_count: null };
      const entry = byConnector[name];
      if (c.status === "rejected") {
        entry.runs_failed++;
      } else {
        entry.total_fetched += Number(c.count) || 0;
        if ((c.count || 0) > 0) entry.runs_active++;
        if (entry.last_count === null) entry.last_count = c.count || 0; // first = most recent run
      }
    }
  }
  return Object.values(byConnector).sort((a, b) => b.total_fetched - a.total_fetched);
}

// Monthly breakdown of sources in the DB (fetched + pass) for the last 12 months.
async function monthlySourceCounts() {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("sources")
      .select("date_published,validation_status")
      .gte("date_published", "2025-07-01")
      .lte("date_published", "2026-06-30")
      .range(from, from + PAGE - 1);
    if (error) break;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  const months = {};
  for (const r of rows) {
    const mo = r.date_published?.slice(0, 7);
    if (!mo) continue;
    months[mo] ??= { month: mo, total: 0, pass: 0 };
    months[mo].total++;
    if (r.validation_status === "pass") months[mo].pass++;
  }
  return Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
}

// Source type breakdown for the full corpus (pass only).
async function sourceTypeBreakdown() {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("sources")
      .select("source_type")
      .eq("validation_status", "pass")
      .range(from, from + PAGE - 1);
    if (error) break;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  const counts = {};
  for (const r of rows) {
    const t = r.source_type || "unknown";
    counts[t] = (counts[t] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

export default async function handler(req, res) {
  if (!await requireAuth(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const limit = Number(req.query.limit || 30);
    const wantStats = req.query.stats === "1";

    if (wantStats) {
      // Pull more runs for aggregation (up to 200 to get connector-level history).
      const { data: runs, error } = await supabase
        .from("ingestion_runs")
        .select("id,started_at,status,source_count,connector_results")
        .order("started_at", { ascending: false })
        .limit(200);
      if (error) throw error;

      const [monthly, types] = await Promise.all([monthlySourceCounts(), sourceTypeBreakdown()]);
      const connectors = aggregateConnectors(runs || []);

      return res.status(200).json({ connectors, monthly, source_types: types });
    }

    const { data, error } = await supabase
      .from("ingestion_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    return res.status(200).json({ count: data.length, runs: data });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
