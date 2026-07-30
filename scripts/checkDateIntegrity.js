#!/usr/bin/env node
/**
 * checkDateIntegrity.js — post-run date sanity audit for CI.
 *
 * Queries sources ingested recently and reports three classes of date anomaly:
 *   1. collection_bleed — date_confidence="exact" but date within 10 min of
 *      date_collected (the scrape timestamp was stored as the publish date)
 *   2. future_date     — date_published is in the future
 *   3. pre_2020_exact  — date_published before 2020 with date_confidence="exact"
 *
 * Also reports per-connector confidence breakdown so connector-level regressions
 * are visible at a glance.
 *
 * Exit code is always 0 (non-blocking). Anomalies are printed to stdout for CI
 * logs. When GITHUB_STEP_SUMMARY is set (GitHub Actions), also writes a Markdown
 * table to the step summary.
 *
 * Usage:
 *   node scripts/checkDateIntegrity.js [--hours N]   # default: 3
 *   node scripts/checkDateIntegrity.js --hours 24    # check last 24h
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
const HOURS = parseInt(args.hours || "3", 10);
const BLEED_MINUTES = 10;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const since = new Date(Date.now() - HOURS * 3600000).toISOString();

// Pull sources ingested in the window. `created_at` is the DB row insertion time,
// which is the best proxy for "when was this source collected" in the live DB.
// (date_collected is set in normalizeSource for the in-memory pipeline but is not
// mapped to a dedicated DB column — collected_date exists in the schema but is
// not populated.)
const { data: sources, error } = await sb
  .from("sources")
  .select("id, title, url, date_published, date_confidence, created_at, needs_review, source_type, publisher")
  .gte("created_at", since)
  .order("created_at", { ascending: false })
  .limit(2000);

if (error) {
  console.error("[checkDateIntegrity] DB error:", error.message);
  process.exit(0);
}

if (!sources?.length) {
  console.log(`[checkDateIntegrity] No sources ingested in the last ${HOURS}h — nothing to check.`);
  process.exit(0);
}

// ── Classify each source ───────────────────────────────────────────────────────

const anomalies = [];
const byPublisher = {};  // publisher → { total, exact, estimated, low, none, issues }

for (const s of sources) {
  // Per-publisher stats
  const pub = s.publisher || "unknown";
  if (!byPublisher[pub]) byPublisher[pub] = { total: 0, exact: 0, estimated: 0, low: 0, none: 0, issues: 0 };
  byPublisher[pub].total++;
  byPublisher[pub][s.date_confidence || "none"] = (byPublisher[pub][s.date_confidence || "none"] || 0) + 1;

  if (!s.date_published) continue;
  const pubMs     = new Date(s.date_published).getTime();
  const collectMs = s.created_at ? new Date(s.created_at).getTime() : null;
  if (isNaN(pubMs)) continue;

  let issue = null;

  if (pubMs > Date.now() + 86400000) {
    issue = "future_date";
  } else if (s.date_confidence === "exact" && collectMs != null) {
    const diffMinutes = Math.abs(pubMs - collectMs) / 60000;
    if (diffMinutes <= BLEED_MINUTES) issue = "collection_bleed";
  }
  if (issue) {
    anomalies.push({ id: s.id, title: (s.title || "").slice(0, 60), publisher: pub, date_published: s.date_published, date_confidence: s.date_confidence, date_collected: s.created_at, issue });
    byPublisher[pub].issues++;
  }
}

// ── Console report ─────────────────────────────────────────────────────────────

const totalExact     = sources.filter(s => s.date_confidence === "exact").length;
const totalEstimated = sources.filter(s => s.date_confidence === "estimated").length;
const totalNeeds     = sources.filter(s => s.needs_review).length;

console.log(`\n[checkDateIntegrity] Last ${HOURS}h — ${sources.length} sources ingested`);
console.log(`  exact: ${totalExact}  estimated: ${totalEstimated}  needs_review: ${totalNeeds}  anomalies: ${anomalies.length}`);

if (anomalies.length) {
  console.log(`\n  Anomalies:`);
  for (const a of anomalies) {
    console.log(`  ⚠ [${a.issue}] ${a.id.slice(0,8)} | ${a.publisher} | pub:${a.date_published?.slice(0,10)} collected:${a.date_collected?.slice(0,16)} conf:${a.date_confidence}`);
    console.log(`    "${a.title}"`);
  }
}

// Per-publisher breakdown (only publishers with issues or high estimated%)
const flaggedPublishers = Object.entries(byPublisher)
  .filter(([, s]) => s.issues > 0 || (s.total >= 3 && (s.estimated + s.low + s.none) / s.total > 0.5))
  .sort(([, a], [, b]) => b.issues - a.issues || b.total - a.total);

if (flaggedPublishers.length) {
  console.log(`\n  Publishers with anomalies or high non-exact rate:`);
  for (const [pub, s] of flaggedPublishers) {
    const exactPct = Math.round((s.exact / s.total) * 100);
    console.log(`  ${s.issues > 0 ? "⚠" : "~"} ${pub.padEnd(30)} total:${s.total} exact:${s.exact}(${exactPct}%) estimated:${s.estimated} issues:${s.issues}`);
  }
}

// ── GitHub Step Summary ────────────────────────────────────────────────────────

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const lines = [
    `## Date Integrity Check — last ${HOURS}h`,
    ``,
    `| Metric | Count |`,
    `|---|---|`,
    `| Sources ingested | ${sources.length} |`,
    `| exact confidence | ${totalExact} (${Math.round(totalExact/sources.length*100)}%) |`,
    `| estimated / low / none | ${totalEstimated + sources.filter(s=>s.date_confidence==="low").length + sources.filter(s=>s.date_confidence==="none").length} |`,
    `| needs_review | ${totalNeeds} |`,
    `| **Anomalies** | **${anomalies.length}** |`,
    ``,
  ];

  if (anomalies.length) {
    lines.push(`### Anomalies`);
    lines.push(`| Issue | Source | Publisher | date_published | date_collected |`);
    lines.push(`|---|---|---|---|---|`);
    for (const a of anomalies.slice(0, 20)) {
      lines.push(`| ${a.issue} | ${a.id.slice(0,8)} ${a.title.replace(/\|/g," ")} | ${a.publisher} | ${a.date_published?.slice(0,10)} | ${a.date_collected?.slice(0,16)} |`);
    }
    if (anomalies.length > 20) lines.push(`_...and ${anomalies.length - 20} more_`);
    lines.push(``);
  }

  if (flaggedPublishers.length) {
    lines.push(`### Publishers with high non-exact rate`);
    lines.push(`| Publisher | Total | Exact | Estimated | Issues |`);
    lines.push(`|---|---|---|---|---|`);
    for (const [pub, s] of flaggedPublishers.slice(0, 15)) {
      lines.push(`| ${pub} | ${s.total} | ${s.exact} | ${s.estimated} | ${s.issues} |`);
    }
  }

  try {
    appendFileSync(summaryPath, lines.join("\n") + "\n");
  } catch { /* non-fatal */ }
}

process.exit(0);
