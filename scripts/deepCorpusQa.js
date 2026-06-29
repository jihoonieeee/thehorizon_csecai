#!/usr/bin/env node
/**
 * deepCorpusQa.js — Deep QA audit of the entire `sources` corpus.
 *
 * Read-only by default. Loads every row and runs a battery of integrity checks,
 * prints a human-readable report, writes a JSON artifact, and exits non-zero when
 * a CRITICAL issue is found (so a CI run surfaces it). It does NOT mutate the DB —
 * remediation is delegated to the dedicated scripts it names in its findings:
 *   - unprocessed sources        → scripts/processUnvalidated.js
 *   - recoverable operational    → scripts/revalidateBacklog.js
 *   - missing enrichment         → scripts/understandCorpus.js
 *
 * Checks
 *   1. Status distribution + UNPROCESSED (null/pending) sources         [CRITICAL if >0]
 *   2. Composition vs diversity targets (pass corpus)                   [WARN, see corpusComposition]
 *   3. Recovery backlog: high/primary operational held in review/null   [INFO]
 *   4. Enrichment coverage of pass sources (short_summary/intelligence) [WARN if low]
 *   5. Field integrity (unknown source_type, null main_category on pass)[WARN]
 *
 * Usage:
 *   node scripts/deepCorpusQa.js                 # audit + report + JSON artifact
 *   node scripts/deepCorpusQa.js --out report.json
 *   node scripts/deepCorpusQa.js --no-exit-code  # always exit 0 (report only)
 */

import "dotenv/config";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { buildCorpusComposition, formatCompositionReport, bucketForSourceType } from "../lib/pipeline/corpusComposition.js";

const args   = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const hasFlag = (f) => args.includes(f);
const OUT     = getArg("--out", "corpus_qa_report.json");
const EXIT_CODE = !hasFlag("--no-exit-code");

const OPERATIONAL_TYPES = new Set([
  "incident", "incident_report", "threat_intelligence", "threat_intel",
  "threat_intelligence_report", "vulnerability", "exploit_disclosure",
  "adversary_adoption_signal", "governance_signal", "government_advisory",
]);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

console.log("════════════════════════════════════════════════════════════");
console.log("  Deep Corpus QA  —  " + new Date().toISOString());
console.log("════════════════════════════════════════════════════════════\n");

// Load the whole corpus.
let all = [], from = 0; const page = 1000;
while (true) {
  const r = await sb.from("sources")
    .select("id,validation_status,trust_tier,source_type,main_category,publisher,full_text,short_summary,analyst_brief,intelligence,claim_extraction_status,relevance_tier,date_published")
    .range(from, from + page - 1);
  if (r.error) { console.error("DB load failed:", r.error.message); process.exit(2); }
  if (!r.data.length) break;
  all = all.concat(r.data);
  if (r.data.length < page) break;
  from += page;
}

const findings = [];
const add = (severity, code, message, data) => findings.push({ severity, code, message, ...(data ? { data } : {}) });
const dist = (rows, key) => rows.reduce((m, r) => { const k = r[key] || "null"; m[k] = (m[k] || 0) + 1; return m; }, {});

const pass = all.filter((r) => r.validation_status === "pass");

// ── Check 1: status distribution + unprocessed ───────────────────────────────
const statusDist = dist(all, "validation_status");
const unprocessed = all.filter((r) => !r.validation_status || r.validation_status === "pending");
console.log("1. Status distribution");
for (const [k, v] of Object.entries(statusDist).sort((a, b) => b[1] - a[1])) console.log(`     ${k.padEnd(8)} ${v}`);
console.log(`   Total: ${all.length}\n`);
if (unprocessed.length > 0) {
  add("critical", "unprocessed_sources",
    `${unprocessed.length} source(s) have no validation_status — never gated. Run: node scripts/processUnvalidated.js`,
    { count: unprocessed.length, sample: unprocessed.slice(0, 5).map((s) => s.id) });
}

// ── Check 2: composition vs targets ──────────────────────────────────────────
const composition = buildCorpusComposition(pass);
console.log("2. " + formatCompositionReport(composition).replace(/\n/g, "\n   ") + "\n");
for (const w of composition.warnings) {
  add(w.severity === "critical" ? "critical" : w.severity === "warning" ? "warning" : "info",
    `composition_${w.code}`, w.message);
}

// ── Check 3: recovery backlog (operational held in review/null) ───────────────
const recoverable = all.filter((r) =>
  (r.validation_status === "review" || !r.validation_status) &&
  ["high", "primary"].includes(r.trust_tier) &&
  OPERATIONAL_TYPES.has((r.source_type || "").toLowerCase()) &&
  (r.full_text || "").length >= 300);
console.log(`3. Recovery backlog (high/primary operational in review/null): ${recoverable.length}`);
const recByBucket = recoverable.reduce((m, r) => { const b = bucketForSourceType(r.source_type); m[b] = (m[b] || 0) + 1; return m; }, {});
console.log(`   by bucket: ${JSON.stringify(recByBucket)}\n`);
if (recoverable.length >= 20) {
  add("info", "recovery_backlog",
    `${recoverable.length} high/primary operational sources held in review/null may be recoverable. Run: node scripts/revalidateBacklog.js`,
    { count: recoverable.length, by_bucket: recByBucket });
}

// ── Check 4: enrichment coverage of pass sources ─────────────────────────────
const missingSummary = pass.filter((r) => !(r.short_summary || r.analyst_brief));
const missingIntel   = pass.filter((r) => !r.intelligence || (typeof r.intelligence === "object" && Object.keys(r.intelligence).length === 0));
const summaryGapPct  = pass.length ? (missingSummary.length / pass.length * 100) : 0;
console.log(`4. Enrichment coverage (pass corpus, n=${pass.length})`);
console.log(`     missing short_summary/analyst_brief: ${missingSummary.length} (${summaryGapPct.toFixed(1)}%)`);
console.log(`     missing intelligence:                ${missingIntel.length}\n`);
if (summaryGapPct >= 15) {
  add("warning", "enrichment_gap",
    `${missingSummary.length} pass sources (${summaryGapPct.toFixed(0)}%) lack a summary. Run: node scripts/understandCorpus.js`,
    { missing_summary: missingSummary.length, missing_intelligence: missingIntel.length });
}

// ── Check 5: field integrity on pass corpus ──────────────────────────────────
const unknownType    = pass.filter((r) => !r.source_type || r.source_type === "unknown");
const nullCategory   = pass.filter((r) => !r.main_category);
const nullRelevance  = pass.filter((r) => !r.relevance_tier);
console.log("5. Field integrity (pass corpus)");
console.log(`     source_type unknown/null: ${unknownType.length}`);
console.log(`     main_category null:        ${nullCategory.length}`);
console.log(`     relevance_tier null:       ${nullRelevance.length}\n`);
if (unknownType.length >= 10) add("warning", "unknown_source_type", `${unknownType.length} pass sources have unknown/null source_type — composition buckets understated.`, { count: unknownType.length });
if (nullCategory.length >= 10) add("warning", "null_main_category", `${nullCategory.length} pass sources have null main_category — excluded from category analysis.`, { count: nullCategory.length });

// ── Summary ──────────────────────────────────────────────────────────────────
const bySeverity = findings.reduce((m, f) => { m[f.severity] = (m[f.severity] || 0) + 1; return m; }, {});
console.log("────────────────────────────────────────────────────────────");
console.log("  QA Findings");
if (findings.length === 0) {
  console.log("  ✓ No issues — corpus is clean.");
} else {
  for (const f of findings) {
    const tag = f.severity === "critical" ? "✖ CRITICAL" : f.severity === "warning" ? "⚠ WARN" : "· info";
    console.log(`  ${tag}  [${f.code}] ${f.message}`);
  }
}
console.log(`  Severity: ${JSON.stringify(bySeverity)}`);

const report = {
  generated_at:   new Date().toISOString(),
  total_sources:  all.length,
  status_distribution: statusDist,
  pass_count:     pass.length,
  composition:    { research_share: composition.research_share, top2_publisher_share: composition.top2_publisher_share, balanced: composition.balanced, distribution: composition.distribution.map((d) => ({ bucket: d.bucket, pct: d.pct, count: d.count, status: d.status })) },
  recovery_backlog: recoverable.length,
  findings,
  by_severity:    bySeverity,
};
try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log(`\n  Report written: ${OUT}`); } catch (e) { console.log(`  ! could not write ${OUT}: ${e.message}`); }

const hasCritical = findings.some((f) => f.severity === "critical");
if (EXIT_CODE && hasCritical) { console.log("\n  Exiting non-zero (CRITICAL findings present)."); process.exit(1); }
