#!/usr/bin/env node
/**
 * ingestRunSummary.js — post-run health report for CI.
 *
 * Reads the most recent ingestion_run from the DB and emits:
 *   - A compact stdout summary for logs.
 *   - A Markdown table to $GITHUB_STEP_SUMMARY (GitHub Actions step summary panel).
 *
 * Exit code:
 *   0 — run was successful or had acceptable anomalies.
 *   1 — run failed, or a critical connector returned 0 sources.
 *
 * Usage:
 *   node scripts/ingestRunSummary.js
 *   node scripts/ingestRunSummary.js --run-id <uuid>  # specific run
 *   node scripts/ingestRunSummary.js --stage classify  # filter by stage prefix
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { appendFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
    const [k, v] = a.slice(2).split("=");
    return [k, v ?? true];
  })
);
const RUN_ID    = args["run-id"] || null;
const STAGE     = args["stage"]  || null;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Fetch run ─────────────────────────────────────────────────────────────────

let query = sb.from("ingestion_runs").select("*").order("started_at", { ascending: false }).limit(10);
if (RUN_ID) query = sb.from("ingestion_runs").select("*").eq("id", RUN_ID).limit(1);

const { data: runs, error } = await query;
if (error) { console.error("[ingestRunSummary] DB error:", error.message); process.exit(1); }
if (!runs?.length) { console.log("[ingestRunSummary] No ingestion runs found."); process.exit(0); }

// Pick the best match: if --stage given, find the latest run whose stage starts with it
const run = STAGE
  ? runs.find(r => (r.pipeline_counts?.stage || r.stage || "").startsWith(STAGE)) || runs[0]
  : runs[0];

const pc  = run.pipeline_counts || {};
const cr  = run.connector_results || [];
const win = run.reporting_window || {};

// ── Duration ──────────────────────────────────────────────────────────────────

const durationSec = run.finished_at && run.started_at
  ? Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000)
  : null;
const durationStr = durationSec != null
  ? durationSec >= 60 ? `${Math.floor(durationSec/60)}m ${durationSec%60}s` : `${durationSec}s`
  : "—";

// ── Connector breakdown ────────────────────────────────────────────────────────

const connFailed  = cr.filter(c => c.status === "rejected" || c.error).length;
const connTotal   = cr.length;
const connSummary = cr
  .sort((a, b) => (b.count || 0) - (a.count || 0))
  .slice(0, 15)
  .map(c => {
    const flag = c.error ? " ⚠" : c.count === 0 ? " (0)" : "";
    return `${c.connector}: ${c.count ?? "?"}${flag}`;
  });

// ── Stdout summary ─────────────────────────────────────────────────────────────

const statusIcon = run.status === "success" ? "✓" : run.status === "failed" ? "✗" : "~";
console.log(`\n[ingestRunSummary] ${statusIcon} ${run.status?.toUpperCase()} — ${run.id?.slice(0,8)}`);
console.log(`  Window:    ${win.start_utc?.slice(0,10) ?? "?"} → ${win.end_utc?.slice(0,10) ?? "?"}`);
console.log(`  Duration:  ${durationStr}`);
console.log(`  Sources:   ${pc.raw ?? "?"} raw → ${pc.within_publish_date_window ?? "?"} in-window → ${pc.usable ?? run.source_count ?? "?"} accepted`);
console.log(`  Discarded: ${pc.discarded_by_relevance ?? "?"} off-topic  ${pc.rejected ?? "?"} rejected  ${pc.removed_by_publish_date ?? "?"} out-of-window`);
console.log(`  Connectors: ${connTotal} total, ${connFailed} failed`);
if (run.error_message) console.log(`  Error: ${run.error_message.slice(0, 200)}`);

// ── GitHub Step Summary ────────────────────────────────────────────────────────

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const icon = run.status === "success" ? "✅" : run.status === "failed" ? "❌" : "⚠️";
  const lines = [
    `## ${icon} Ingest Run — ${run.status?.toUpperCase()}`,
    ``,
    `**Run ID:** \`${run.id?.slice(0,8)}\` &nbsp; **Duration:** ${durationStr} &nbsp; **Window:** ${win.start_utc?.slice(0,10) ?? "?"} → ${win.end_utc?.slice(0,10) ?? "?"}`,
    ``,
    `### Source funnel`,
    `| Stage | Count |`,
    `|---|---|`,
    `| Raw collected | ${pc.raw ?? "?"} |`,
    `| Within date window | ${pc.within_publish_date_window ?? "?"} |`,
    `| After dedup | ${pc.deduped ?? "?"} |`,
    `| Accepted | ${pc.accepted ?? run.source_count ?? "?"} |`,
    `| Already validated (skipped L3) | ${pc.already_validated_skipped ?? 0} |`,
    `| No date (passed for recovery) | ${pc.no_date_passed_for_recovery ?? 0} |`,
    `| Discarded — off-topic / irrelevant | ${pc.discarded_by_relevance ?? "?"} |`,
    `| Discarded — validity check | ${pc.discarded_by_validity ?? "?"} |`,
    `| Removed — out of window | ${pc.removed_by_publish_date ?? "?"} |`,
    `| Rejected — URL/type filter | ${pc.rejected ?? run.rejected_count ?? "?"} |`,
    ``,
  ];

  if (connTotal > 0) {
    const failed  = cr.filter(c => c.status === "rejected" || c.error);
    const ok      = cr.filter(c => c.status !== "rejected" && !c.error && (c.count ?? 0) > 0);
    const zeroCt  = cr.filter(c => c.status !== "rejected" && !c.error && (c.count ?? 0) === 0);

    lines.push(`### Connectors (${connTotal} total)`);

    if (failed.length) {
      lines.push(`**Failed:**`);
      for (const c of failed) lines.push(`- ⚠ ${c.connector}: ${c.error?.slice(0,100) ?? "error"}`);
    }
    if (zeroCt.length) {
      lines.push(`**Zero sources:** ${zeroCt.map(c => c.connector).join(", ")}`);
    }

    lines.push(`| Connector | Count | Trust | Method |`);
    lines.push(`|---|---|---|---|`);
    for (const c of cr.sort((a,b)=>(b.count||0)-(a.count||0)).slice(0, 20)) {
      const icon2 = c.error ? "⚠ " : (c.count === 0 ? "· " : "");
      lines.push(`| ${icon2}${c.connector} | ${c.count ?? "?"} | ${c.trust_tier ?? ""} | ${c.retrieval_method ?? ""} |`);
    }
    lines.push(``);
  }

  if (run.error_message) {
    lines.push(`### Error`);
    lines.push(`\`\`\``);
    lines.push(run.error_message.slice(0, 500));
    lines.push(`\`\`\``);
  }

  try {
    appendFileSync(summaryPath, lines.join("\n") + "\n");
    console.log(`[ingestRunSummary] Step summary written.`);
  } catch (e) {
    console.warn("[ingestRunSummary] Could not write step summary:", e.message);
  }
}

// ── Exit code ─────────────────────────────────────────────────────────────────
// Fail if the run itself failed, or if connectors ALL returned zero sources
// (likely a network outage rather than a legitimate zero-source day).
const allConnectorsZero = connTotal > 0 && cr.every(c => (c.count ?? 0) === 0 && !c.error);
if (run.status === "failed" || allConnectorsZero) {
  console.log(`[ingestRunSummary] Exiting 1 (run failed or all connectors returned 0)`);
  process.exit(1);
}
process.exit(0);
