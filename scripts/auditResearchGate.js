#!/usr/bin/env node
/**
 * auditResearchGate.js — Run the research gate against live arXiv sources
 * from the database and report the verdict for each.
 *
 * Usage:
 *   node scripts/auditResearchGate.js [--limit N] [--status pass|all] [--verbose]
 *
 *   --limit N        How many sources to sample (default: 20)
 *   --status         "pass" = only currently-passing sources (default)
 *                    "all"  = include rejected sources too
 *   --verbose        Print full reasoning and text excerpt for each source
 */

import "dotenv/config";
import { supabase } from "../lib/storage/supabaseClient.js";
import { routedLLM } from "../lib/llm/llmRouter.js";
import { runResearchGate } from "../lib/pipeline/validation/researchGate.js";

const args   = process.argv.slice(2);
const limit  = parseInt(args[args.indexOf("--limit") + 1] || "20", 10);
const status = args.includes("--status") ? args[args.indexOf("--status") + 1] : "pass";
const verbose = args.includes("--verbose");

// ── Fetch sources ─────────────────────────────────────────────────────────────

async function fetchArxivSources() {
  let q = supabase
    .from("sources")
    .select("id, title, url, publisher, date_published, source_type, full_text, summary, validation_status, main_category, candidate_domain")
    .or("publisher.ilike.%arxiv%,url.ilike.%arxiv.org%")
    .in("source_type", ["research_finding", "benchmark_evaluation", "capability_demonstration"])
    .order("date_published", { ascending: false })
    .limit(limit);

  if (status === "pass") {
    q = q.eq("validation_status", "pass");
  }

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// ── Formatting helpers ────────────────────────────────────────────────────────

const ICONS = {
  pass: { essential: "🟢", recommended: "🔵" },
  reject: "🔴",
};

function icon(result) {
  if (result.verdict === "pass") return ICONS.pass[result.read_value] || "🟢";
  return ICONS.reject;
}

const CONTRIBUTION_LABEL = {
  new_attack_path:        "New attack path",
  new_technique:          "New technique",
  prevalence_signal:      "Prevalence signal",
  capability_acceleration:"Capability acceleration",
  supply_chain_vector:    "Supply chain vector",
  benchmark_only:         "Benchmark only",
  defensive_primary:      "Defensive primary",
  survey_or_sok:          "Survey / SoK",
  incremental_test:       "Incremental test",
};

function truncate(s, n) {
  if (!s) return "(none)";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nFetching ${limit} arXiv research sources (validation_status=${status})…\n`);
  const sources = await fetchArxivSources();
  console.log(`Found ${sources.length} sources. Running research gate…\n`);
  console.log("─".repeat(90));

  const results = [];
  let passed = 0, rejected = 0, errors = 0;

  for (const source of sources) {
    let rg;
    try {
      rg = await runResearchGate(source, { llmFn: routedLLM });
    } catch (err) {
      console.error(`  ERROR on ${source.id}: ${err.message}`);
      errors++;
      continue;
    }

    if (!rg) {
      console.log(`  ⚠️  LLM unavailable for ${source.id} — skipped`);
      errors++;
      continue;
    }

    rg.verdict === "pass" ? passed++ : rejected++;
    results.push({ source, rg });

    // ── Per-source output ──────────────────────────────────────────────────
    const statusChange = source.validation_status !== "pass"
      ? ""
      : rg.verdict === "reject"
        ? "  ⚠️  WAS PASSING — WOULD NOW REJECT"
        : "";

    console.log(`${icon(rg)} [${rg.verdict.toUpperCase()}] ${truncate(source.title, 80)}`);
    console.log(`   Read value:    ${rg.read_value}`);
    console.log(`   Contribution:  ${CONTRIBUTION_LABEL[rg.contribution_type] || rg.contribution_type}`);
    console.log(`   Maturity:      ${rg.maturity}`);
    console.log(`   Reasoning:     ${rg.reasoning}`);
    if (rg.reject_reason) console.log(`   Reject reason: ${rg.reject_reason}`);
    if (statusChange)     console.log(statusChange);
    if (verbose) {
      console.log(`   Excerpt:       ${truncate(source.full_text || source.summary, 300)}`);
    }
    console.log();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("─".repeat(90));
  console.log(`\nSUMMARY  (${sources.length} sources evaluated)`);
  console.log(`  🟢 Essential:    ${results.filter(r => r.rg.verdict === "pass" && r.rg.read_value === "essential").length}`);
  console.log(`  🔵 Recommended:  ${results.filter(r => r.rg.verdict === "pass" && r.rg.read_value === "recommended").length}`);
  console.log(`  🔴 Rejected:     ${rejected}`);
  if (errors) console.log(`  ⚠️  Errors:      ${errors}`);

  // Breakdown of rejection reasons
  const rejectBreakdown = {};
  for (const { rg } of results.filter(r => r.rg.verdict === "reject")) {
    const k = rg.contribution_type || "unknown";
    rejectBreakdown[k] = (rejectBreakdown[k] || 0) + 1;
  }
  if (Object.keys(rejectBreakdown).length) {
    console.log(`\n  Rejection breakdown:`);
    for (const [k, n] of Object.entries(rejectBreakdown).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${CONTRIBUTION_LABEL[k] || k}: ${n}`);
    }
  }

  // Sources that were passing but the gate would now reject
  const wouldReject = results.filter(r => r.source.validation_status === "pass" && r.rg.verdict === "reject");
  if (wouldReject.length) {
    console.log(`\n  ⚠️  ${wouldReject.length} currently-passing source(s) the research gate would REJECT:`);
    for (const { source, rg } of wouldReject) {
      console.log(`    - ${truncate(source.title, 70)} [${rg.contribution_type}]`);
    }
  }

  console.log();
}

main().catch(err => { console.error(err); process.exit(1); });
