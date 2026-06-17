#!/usr/bin/env node
/**
 * debug5diff — Compare two debug5 runs side by side
 *
 * Usage:
 *   node scripts/debug5diff.js --run-a <run_id> --run-b <run_id>
 *   npm run test:debug5:diff -- --run-a <id> --run-b <id>
 *
 * Compares:
 *   - Source routing (pass/review/reject distribution)
 *   - Evidence created/blocked
 *   - Judgments approved/blocked
 *   - Dashboard objects approved/rejected
 *   - Slide QA failures
 *   - Export blockers
 *
 * Output:
 *   docs/testruns/diff_<A>_vs_<B>.md
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTDIR = path.join(ROOT, "docs", "testruns");

const args = process.argv.slice(2);
function getArg(flag, def = null) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const RUN_A = getArg("--run-a");
const RUN_B = getArg("--run-b");

if (!RUN_A || !RUN_B) {
  console.error("Usage: npm run test:debug5:diff -- --run-a <run_id> --run-b <run_id>");
  console.error("\nAvailable runs:");
  try {
    const runs = fs.readdirSync(TESTDIR).filter(d => fs.statSync(path.join(TESTDIR, d)).isDirectory());
    for (const r of runs.sort().reverse().slice(0, 10)) console.error(`  ${r}`);
  } catch { /* ignore */ }
  process.exit(1);
}

function loadCheckpoint(runId, layer) {
  const p = path.join(TESTDIR, runId, "checkpoints", `${layer}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function delta(a, b, label) {
  if (a == null && b == null) return `${label}: N/A`;
  if (a == null) return `${label}: (missing in A) → ${b}`;
  if (b == null) return `${label}: ${a} → (missing in B)`;
  const diff = b - a;
  const sign = diff > 0 ? "+" : diff < 0 ? "" : "±";
  return `${label}: ${a} → ${b} (${sign}${diff})`;
}

function mdTable(headers, rows) {
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.map(c => String(c ?? "–")).join(" | ")} |`);
  return lines.join("\n");
}

function compareSectionTitle(title) {
  return `\n## ${title}\n`;
}

async function main() {
  console.log(`\nComparing debug5 runs:`);
  console.log(`  A: ${RUN_A}`);
  console.log(`  B: ${RUN_B}\n`);

  const dirA = path.join(TESTDIR, RUN_A);
  const dirB = path.join(TESTDIR, RUN_B);

  if (!fs.existsSync(dirA)) { console.error(`Run A not found: ${dirA}`); process.exit(1); }
  if (!fs.existsSync(dirB)) { console.error(`Run B not found: ${dirB}`); process.exit(1); }

  const lines = [];
  lines.push(`# debug5 Run Comparison`);
  lines.push(`\n| | Run A | Run B |`);
  lines.push(`|---|---|---|`);
  lines.push(`| **Run ID** | \`${RUN_A}\` | \`${RUN_B}\` |`);
  lines.push(`| **Generated** | ${new Date().toISOString()} | |`);

  // ── L1: Source selection ─────────────────────────────────────────────────────
  const l1a = loadCheckpoint(RUN_A, "L1");
  const l1b = loadCheckpoint(RUN_B, "L1");
  lines.push(compareSectionTitle("L1 — Source Ingestion"));
  lines.push(mdTable(["Metric", "Run A", "Run B", "Delta"], [
    ["Sources",     l1a?.source_count, l1b?.source_count, delta(l1a?.source_count, l1b?.source_count, "")],
    ["Batch mode",  l1a?.batch,        l1b?.batch,        ""],
    ["Type filter", l1a?.source_type_filter||"none", l1b?.source_type_filter||"none", ""],
  ]));

  // ── L3: Validation ───────────────────────────────────────────────────────────
  const l3a = loadCheckpoint(RUN_A, "L3");
  const l3b = loadCheckpoint(RUN_B, "L3");
  lines.push(compareSectionTitle("L3 — Validation Routing"));
  if (l3a && l3b) {
    lines.push(mdTable(["Status", "Run A", "Run B", "Delta"], [
      ["pass",   l3a.by_status?.pass,   l3b.by_status?.pass,   delta(l3a.by_status?.pass,   l3b.by_status?.pass,   "")],
      ["review", l3a.by_status?.review, l3b.by_status?.review, delta(l3a.by_status?.review, l3b.by_status?.review, "")],
      ["reject", l3a.by_status?.reject, l3b.by_status?.reject, delta(l3a.by_status?.reject, l3b.by_status?.reject, "")],
    ]));
  } else {
    lines.push("L3 checkpoints missing for one or both runs.");
  }

  // ── L4: Taxonomy ─────────────────────────────────────────────────────────────
  const l4a = loadCheckpoint(RUN_A, "L4");
  const l4b = loadCheckpoint(RUN_B, "L4");
  lines.push(compareSectionTitle("L4 — Taxonomy"));
  if (l4a && l4b) {
    const cats = [...new Set([...Object.keys(l4a.by_category||{}), ...Object.keys(l4b.by_category||{})])];
    lines.push(mdTable(["Category", "Run A", "Run B", "Delta"],
      cats.map(c => [c, l4a.by_category?.[c]||0, l4b.by_category?.[c]||0, delta(l4a.by_category?.[c]||0, l4b.by_category?.[c]||0, "")])
    ));
  }

  // ── L5: Evidence ─────────────────────────────────────────────────────────────
  const l5a = loadCheckpoint(RUN_A, "L5");
  const l5b = loadCheckpoint(RUN_B, "L5");
  lines.push(compareSectionTitle("L5 — Evidence Generation"));
  if (l5a && l5b) {
    lines.push(mdTable(["Metric", "Run A", "Run B", "Delta"], [
      ["evidence_cards",  l5a.evidence_cards,  l5b.evidence_cards,  delta(l5a.evidence_cards,  l5b.evidence_cards,  "")],
      ["high_priority",   l5a.high_priority,   l5b.high_priority,   delta(l5a.high_priority,   l5b.high_priority,   "")],
      ["strong items",    l5a.by_strength?.strong,  l5b.by_strength?.strong,  delta(l5a.by_strength?.strong,  l5b.by_strength?.strong, "")],
      ["usable items",    l5a.by_strength?.usable,  l5b.by_strength?.usable,  delta(l5a.by_strength?.usable,  l5b.by_strength?.usable, "")],
      ["context items",   l5a.by_strength?.context, l5b.by_strength?.context, delta(l5a.by_strength?.context, l5b.by_strength?.context,"")],
      ["archive items",   l5a.by_strength?.archive, l5b.by_strength?.archive, delta(l5a.by_strength?.archive, l5b.by_strength?.archive,"")],
    ]));
  }

  // ── L6: Analysis ─────────────────────────────────────────────────────────────
  const l6a = loadCheckpoint(RUN_A, "L6");
  const l6b = loadCheckpoint(RUN_B, "L6");
  lines.push(compareSectionTitle("L6 — Strategic Analysis"));
  if (l6a && l6b) {
    const totalJudgmentsA = (l6a.categories||[]).reduce((n,c) => n + (c.judgment_count||0), 0);
    const totalJudgmentsB = (l6b.categories||[]).reduce((n,c) => n + (c.judgment_count||0), 0);
    const totalBlockedA   = (l6a.categories||[]).reduce((n,c) => n + (c.blocked_count||0), 0);
    const totalBlockedB   = (l6b.categories||[]).reduce((n,c) => n + (c.blocked_count||0), 0);
    lines.push(mdTable(["Metric", "Run A", "Run B", "Delta"], [
      ["Categories assessed", l6a.category_count,  l6b.category_count, delta(l6a.category_count, l6b.category_count, "")],
      ["Total judgments",     totalJudgmentsA,      totalJudgmentsB,   delta(totalJudgmentsA, totalJudgmentsB, "")],
      ["Blocked claims",      totalBlockedA,         totalBlockedB,    delta(totalBlockedA, totalBlockedB, "")],
    ]));
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────────
  const da = loadCheckpoint(RUN_A, "dashboard");
  const db = loadCheckpoint(RUN_B, "dashboard");
  lines.push(compareSectionTitle("Dashboard Intelligence Objects"));
  if (da && db) {
    lines.push(mdTable(["Metric", "Run A", "Run B", "Delta"], [
      ["Total objects",    da.total,                 db.total,                delta(da.total, db.total, "")],
      ["Main panel",       da.approved_main_panel,   db.approved_main_panel,  delta(da.approved_main_panel, db.approved_main_panel, "")],
      ["Chatbot eligible", da.chatbot_eligible,      db.chatbot_eligible,     delta(da.chatbot_eligible, db.chatbot_eligible, "")],
      ["Appendix only",    da.appendix_only,         db.appendix_only,        delta(da.appendix_only, db.appendix_only, "")],
      ["Blocked",          da.blocked,               db.blocked,              delta(da.blocked, db.blocked, "")],
      ["URL trace failures",da.url_trace_failures,   db.url_trace_failures,   delta(da.url_trace_failures, db.url_trace_failures, "")],
    ]));
  }

  // ── L8/L9 QA ─────────────────────────────────────────────────────────────────
  const l8a = loadCheckpoint(RUN_A, "L8");
  const l8b = loadCheckpoint(RUN_B, "L8");
  const l9a = loadCheckpoint(RUN_A, "L9");
  const l9b = loadCheckpoint(RUN_B, "L9");
  lines.push(compareSectionTitle("Slide & Export QA"));
  lines.push(mdTable(["Metric", "Run A", "Run B", "Delta"], [
    ["Slides generated",     l8a?.generated_count,         l8b?.generated_count,         delta(l8a?.generated_count,         l8b?.generated_count, "")],
    ["Content QA issues",    l8a?.content_qa_issues,       l8b?.content_qa_issues,       delta(l8a?.content_qa_issues,       l8b?.content_qa_issues, "")],
    ["Notes QA issues",      l8a?.notes_qa_issues,         l8b?.notes_qa_issues,         delta(l8a?.notes_qa_issues,         l8b?.notes_qa_issues, "")],
    ["L9 overall pass",      l9a?.overall_pass ? "YES" : "NO", l9b?.overall_pass ? "YES" : "NO", ""],
    ["L9 errors",            l9a?.errors,                  l9b?.errors,                  delta(l9a?.errors,                  l9b?.errors, "")],
    ["L9 warnings",          l9a?.warnings,                l9b?.warnings,                delta(l9a?.warnings,                l9b?.warnings, "")],
  ]));

  // ── Write output ──────────────────────────────────────────────────────────────
  const outFile = path.join(TESTDIR, `diff_${RUN_A.slice(-12)}_vs_${RUN_B.slice(-12)}.md`);
  fs.writeFileSync(outFile, lines.join("\n"));
  console.log(`  Diff written: ${outFile}`);
}

main().catch(err => { console.error("diff fatal:", err.message); process.exit(1); });
