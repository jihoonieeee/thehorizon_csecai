import crypto from "crypto";
import { supabase } from "./supabaseClient.js";

export async function startIngestionRun() {
  const run = {
    id: crypto.randomUUID(),
    started_at: new Date().toISOString(),
    status: "running",
  };

  const { error } = await supabase.from("ingestion_runs").insert(run);
  if (error) throw error;

  return run.id;
}

/**
 * Idempotency guard for /api/refresh.
 *
 * The daily Vercel cron has been observed firing twice ~5 min apart (e.g. 22:54
 * and 22:59 UTC), producing two full ingestion runs that re-run Layer-3 LLM
 * validation and overwrite the same dated snapshot — wasted spend, no new data.
 *
 * Returns the most recent SUCCESSFUL run whose reporting window spans the same
 * number of days and that finished within `withinMinutes`, or null if none.
 * Window span (not wall-clock alone) is matched so a daily run never suppresses
 * a legitimately different weekly/monthly run that happens to land nearby.
 */
export async function findRecentSuccessfulRun({ days, withinMinutes = 20 }) {
  const since = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("ingestion_runs")
    .select("id, finished_at, reporting_window, source_count, status")
    .eq("status", "success")
    .gte("finished_at", since)
    .order("finished_at", { ascending: false })
    .limit(5);

  if (error || !data) return null;

  for (const run of data) {
    const w = run.reporting_window || {};
    if (!w.start_utc || !w.end_utc) continue;
    const spanDays =
      (new Date(w.end_utc).getTime() - new Date(w.start_utc).getTime()) / 86400000;
    if (Math.round(spanDays) === Math.round(days)) return run;
  }

  return null;
}

export async function finishIngestionRun(runId, snapshot) {
  const { error } = await supabase
    .from("ingestion_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: "success",
      reporting_window: snapshot.reporting_window,
      source_count: snapshot.count || 0,
      rejected_count: snapshot.rejected_count || 0,
      discarded_count: snapshot.discarded_count || 0,
      connector_results: snapshot.connector_results || [],
      pipeline_counts: snapshot.pipeline_counts || {},
    })
    .eq("id", runId);

  if (error) throw error;
}

export async function failIngestionRun(runId, errorObject) {
  const { error } = await supabase
    .from("ingestion_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: "failed",
      error_message: errorObject?.message || String(errorObject),
    })
    .eq("id", runId);

  if (error) throw error;
}
