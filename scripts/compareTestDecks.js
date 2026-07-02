#!/usr/bin/env node
/**
 * compareTestDecks.js — Cross-deck comparison report
 *
 * Reads the three audit reports and test set JSONs produced by auditTestDeck.js,
 * uses LLM judgment to compare the decks across strategic quality, evidence
 * quality, category fit, visual quality, writing quality, and executive
 * usefulness, and produces a consolidated comparison report with production
 * strategy recommendations.
 *
 * Usage:
 *   node scripts/compareTestDecks.js [--out <path>]
 *
 * Expects these files to already exist:
 *   data/test_sets/horizon_q_testset_operational.json
 *   data/test_sets/horizon_q_testset_balanced.json
 *   data/test_sets/horizon_q_testset_emerging.json
 *   outputs/test_decks/horizon_q_testset_operational/  (deck + audit files)
 *   outputs/test_decks/horizon_q_testset_balanced/
 *   outputs/test_decks/horizon_q_testset_emerging/
 *
 * Output:
 *   outputs/test_decks/testset_comparison_report.md
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };

const OUT_PATH = getArg("--out", path.join(ROOT, "outputs/test_decks/testset_comparison_report.md"));

// ── File paths ────────────────────────────────────────────────────────────────

const SET_IDS = [
  "horizon_q_testset_operational",
  "horizon_q_testset_balanced",
  "horizon_q_testset_emerging",
];

const SET_NAMES = {
  horizon_q_testset_operational: "Test Set A — Operationally Weighted",
  horizon_q_testset_balanced:    "Test Set B — Strategic Balanced",
  horizon_q_testset_emerging:    "Test Set C — Emerging-Signals Weighted",
};

function findAuditFile(setId) {
  // Look for audit file in the test deck output directory
  const dir = path.join(ROOT, "outputs/test_decks", setId);
  const candidates = [
    path.join(ROOT, "outputs/test_decks", `${setId}_audit.md`),
    path.join(dir, "audit.md"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function findRunSummary(setId) {
  const dir = path.join(ROOT, "outputs/test_decks", setId);
  const p = path.join(dir, "run-summary.json");
  return fs.existsSync(p) ? p : null;
}

function findAnalysesFile(setId) {
  const dir = path.join(ROOT, "outputs/test_decks", setId);
  const p = path.join(dir, "category-analyses.json");
  return fs.existsSync(p) ? p : null;
}

function loadIfExists(p, label) {
  if (!p || !fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    if (p.endsWith(".json")) return JSON.parse(raw);
    return raw;
  } catch {
    console.warn(`  Warning: could not load ${label}: ${p}`);
    return null;
  }
}

// ── LLM comparison ────────────────────────────────────────────────────────────

const COMPARE_SCHEMA = {
  type: "object",
  properties: {
    best_strategic_insights: {
      type: "object",
      properties: {
        winner: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["winner","reasoning"],
    },
    best_attack_chains: {
      type: "object",
      properties: {
        winner: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["winner","reasoning"],
    },
    most_reliable_claims: {
      type: "object",
      properties: {
        winner: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["winner","reasoning"],
    },
    strongest_outlook: {
      type: "object",
      properties: {
        winner: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["winner","reasoning"],
    },
    best_visual_quality: {
      type: "object",
      properties: {
        winner: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["winner","reasoning"],
    },
    best_category_fit: {
      type: "object",
      properties: {
        winner: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["winner","reasoning"],
    },
    ratings_by_dimension: {
      type: "object",
      description: "For each comparison dimension, a rating per set: excellent/good/acceptable/weak/fail",
      properties: {
        strategic_quality:    { type: "object", properties: { operational: { type: "string" }, balanced: { type: "string" }, emerging: { type: "string" } }, required: ["operational","balanced","emerging"] },
        attack_chains:        { type: "object", properties: { operational: { type: "string" }, balanced: { type: "string" }, emerging: { type: "string" } }, required: ["operational","balanced","emerging"] },
        claim_reliability:    { type: "object", properties: { operational: { type: "string" }, balanced: { type: "string" }, emerging: { type: "string" } }, required: ["operational","balanced","emerging"] },
        outlook_quality:      { type: "object", properties: { operational: { type: "string" }, balanced: { type: "string" }, emerging: { type: "string" } }, required: ["operational","balanced","emerging"] },
        visual_quality:       { type: "object", properties: { operational: { type: "string" }, balanced: { type: "string" }, emerging: { type: "string" } }, required: ["operational","balanced","emerging"] },
        category_fit:         { type: "object", properties: { operational: { type: "string" }, balanced: { type: "string" }, emerging: { type: "string" } }, required: ["operational","balanced","emerging"] },
      },
      required: ["strategic_quality","attack_chains","claim_reliability","outlook_quality","visual_quality","category_fit"],
    },
    source_count_adequate: { type: "boolean" },
    source_count_observation: { type: "string" },
    ideal_source_mix: {
      type: "object",
      properties: {
        total_recommended: { type: "string" },
        traditional_ai_threats: { type: "string" },
        llm_threats: { type: "string" },
        agentic_ai_threats: { type: "string" },
        ai_enabled_threats: { type: "string" },
        evidence_type_preference: { type: "string" },
      },
      required: ["total_recommended","traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats","evidence_type_preference"],
    },
    production_recommendations: {
      type: "array",
      items: { type: "string" },
    },
    curated_vs_full_corpus: { type: "string" },
    overall_winner: { type: "string" },
    conclusion: { type: "string" },
  },
  required: [
    "best_strategic_insights","best_attack_chains","most_reliable_claims",
    "strongest_outlook","best_visual_quality","best_category_fit",
    "ratings_by_dimension","source_count_adequate","source_count_observation",
    "ideal_source_mix","production_recommendations",
    "curated_vs_full_corpus","overall_winner","conclusion",
  ],
};

function buildComparePrompt(datasets) {
  const parts = datasets.map(({ setId, setName, setData, auditText, runSummary, analyses }) => {
    const counts = setData?.category_counts || {};
    const catLine = Object.entries(counts).map(([k,v]) => `${k.split("_")[0]}=${v}`).join(", ");

    const analysisDigest = (analyses || []).slice(0,4).map(ca => {
      const approved = (ca.judgments || []).filter(j => !j.blocked).slice(0,2);
      return `${ca.category} [${ca.assessment_status || "?"}]: ${approved.map(j => j.judgment?.slice(0,100) || "").join(" | ")}`;
    }).join("\n");

    const runCounts = runSummary?.counts || {};
    const statsLine = `sources=${runCounts.sources_input || "?"}, evidence=${runCounts.evidence_items || "?"}, judgments_approved=${runCounts.judgments_approved || "?"}/${runCounts.judgments_total || "?"}`;

    let block = `══ ${setName} ══
Purpose: ${setData?.purpose || "?"}
Category distribution: ${catLine}
Pipeline stats: ${statsLine}

Strategic analyses:
${analysisDigest || "(none available)"}`;

    if (auditText) {
      const auditExcerpt = auditText.slice(0, 2000);
      block += `\n\nAudit excerpt:\n${auditExcerpt}`;
    }

    return block;
  });

  return `You are a senior threat intelligence program manager comparing three AI threat intelligence slide decks generated from different curated source sets.

Your job is to compare the decks across six dimensions and make production strategy recommendations. Use qualitative ratings only: excellent | good | acceptable | weak | fail.

${parts.join("\n\n")}

── COMPARISON TASK ─────────────────────────────────────────────────────────────

Compare all three sets across these dimensions:

1. STRATEGIC QUALITY: Which produced the best synthesized insights?
2. ATTACK CHAINS: Which best illustrated concrete attack techniques?
3. CLAIM RELIABILITY: Which produced the most evidence-grounded claims?
4. OUTLOOK QUALITY: Which produced the strongest 6-month outlook?
5. VISUAL QUALITY: Which had the most useful diagrams and layout?
6. CATEGORY FIT: Which had the best source-to-category assignment quality?

For each, name a winner (operational | balanced | emerging | tie) and explain why.

Also address:
- Is 50 sources per set adequate? Too many? Too few?
- What is the ideal source mix by category and evidence type?
- Should slides be generated from curated sets instead of the full corpus?
- What should remain in the full corpus vs the curated slide set?

Production recommendations: what would you tell an analyst team building the next deck?`;
}

async function runComparison(datasets) {
  const { routedLLM } = await import("../lib/llm/llmRouter.js");

  const sys = `You are a principal-level threat intelligence program manager with expertise in structured analytical writing and executive presentation. You evaluate intelligence products for strategic depth, analytical rigor, and executive usefulness.`;

  const usr = buildComparePrompt(datasets);

  try {
    const { result } = await routedLLM(sys, usr, { task: "category_analysis", schema: COMPARE_SCHEMA, logLabel: "DeckComparison" });
    return result;
  } catch (err) {
    console.error(`LLM comparison failed: ${err.message}`);
    return null;
  }
}

// ── Markdown report ───────────────────────────────────────────────────────────

const RATING_EMOJI = { excellent: "✅", good: "✅", acceptable: "⚠️", weak: "❌", fail: "🔴" };
const re = (r) => r ? `${RATING_EMOJI[r] || "?"} ${r}` : "–";

function buildComparisonReport(datasets, comparison) {
  const lines = [];
  lines.push("# Test Set Comparison Report");
  lines.push(`\nGenerated: ${new Date().toISOString().slice(0,10)}\n`);
  lines.push("Compares three curated source test sets and the decks generated from them.\n");
  lines.push("---\n");

  // Summary table
  lines.push("## Test Sets Overview\n");
  lines.push("| | Set A — Operational | Set B — Balanced | Set C — Emerging |");
  lines.push("|---|---|---|---|");
  const rows = [
    ["Purpose focus", "Incidents, CVEs, TI", "Mix of all types", "Research, PoCs, signals"],
    ["Total sources", datasets[0].setData?.source_count || "?", datasets[1].setData?.source_count || "?", datasets[2].setData?.source_count || "?"],
    ...["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"].map(cat => [
      CAT_LABELS[cat],
      datasets[0].setData?.category_counts?.[cat] ?? "?",
      datasets[1].setData?.category_counts?.[cat] ?? "?",
      datasets[2].setData?.category_counts?.[cat] ?? "?",
    ]),
  ];
  for (const row of rows) {
    lines.push(`| **${row[0]}** | ${row[1]} | ${row[2]} | ${row[3]} |`);
  }

  if (!comparison) {
    lines.push("\n## LLM Comparison\n\n_LLM comparison unavailable — run without --no-llm_\n");
    return lines.join("\n");
  }

  // Dimension ratings table
  lines.push("\n## Dimension Ratings\n");
  const dims = comparison.ratings_by_dimension || {};
  lines.push("| Dimension | Set A — Operational | Set B — Balanced | Set C — Emerging |");
  lines.push("|-----------|--------------------|--------------------|------------------|");
  const dimRows = [
    ["Strategic quality",   dims.strategic_quality],
    ["Attack chains",       dims.attack_chains],
    ["Claim reliability",   dims.claim_reliability],
    ["Outlook quality",     dims.outlook_quality],
    ["Visual quality",      dims.visual_quality],
    ["Category fit",        dims.category_fit],
  ];
  for (const [label, dim] of dimRows) {
    if (!dim) { lines.push(`| ${label} | – | – | – |`); continue; }
    lines.push(`| ${label} | ${re(dim.operational)} | ${re(dim.balanced)} | ${re(dim.emerging)} |`);
  }

  // Winner columns
  lines.push("\n## Winners by Dimension\n");
  const winners = [
    { dim: "Best strategic insights",  data: comparison.best_strategic_insights },
    { dim: "Best attack chains",       data: comparison.best_attack_chains },
    { dim: "Most reliable claims",     data: comparison.most_reliable_claims },
    { dim: "Strongest 6-month outlook",data: comparison.strongest_outlook },
    { dim: "Best visual quality",      data: comparison.best_visual_quality },
    { dim: "Best category fit",        data: comparison.best_category_fit },
  ];
  for (const { dim, data } of winners) {
    if (!data) continue;
    const winnerLabel = { operational: "Set A", balanced: "Set B", emerging: "Set C", tie: "Tie" }[data.winner] || data.winner;
    lines.push(`### ${dim}`);
    lines.push(`\n**Winner**: ${winnerLabel}\n`);
    lines.push(data.reasoning || "");
    lines.push("");
  }

  // Overall
  if (comparison.overall_winner) {
    const winnerLabel = { operational: "Set A — Operationally Weighted", balanced: "Set B — Strategic Balanced", emerging: "Set C — Emerging-Signals", tie: "Tie" }[comparison.overall_winner] || comparison.overall_winner;
    lines.push(`---\n\n## Overall Winner\n\n**${winnerLabel}**\n\n${comparison.conclusion || ""}\n`);
  }

  // Source count adequacy
  lines.push("---\n");
  lines.push("## Source Count Assessment\n");
  lines.push(`**50 sources per set is adequate?** ${comparison.source_count_adequate ? "Yes" : "No"}\n`);
  lines.push(comparison.source_count_observation || "");
  lines.push("");

  // Ideal mix
  lines.push("## Ideal Source Mix for Production\n");
  const mix = comparison.ideal_source_mix;
  if (mix) {
    lines.push(`| Parameter | Recommendation |`);
    lines.push(`|-----------|----------------|`);
    lines.push(`| Total sources | ${mix.total_recommended} |`);
    lines.push(`| Traditional AI Threats | ${mix.traditional_ai_threats} |`);
    lines.push(`| LLM Threats | ${mix.llm_threats} |`);
    lines.push(`| Agentic AI Threats | ${mix.agentic_ai_threats} |`);
    lines.push(`| AI-Enabled Threats | ${mix.ai_enabled_threats} |`);
    lines.push(`| Evidence type preference | ${mix.evidence_type_preference} |`);
  }

  // Curated vs full corpus
  if (comparison.curated_vs_full_corpus) {
    lines.push(`\n## Curated Set vs Full Corpus\n\n${comparison.curated_vs_full_corpus}\n`);
  }

  // Production recommendations
  lines.push("## Production Recommendations\n");
  for (const rec of (comparison.production_recommendations || [])) {
    lines.push(`- ${rec}`);
  }
  lines.push("");

  // Test set source tables
  lines.push("---\n\n## Appendix: Test Set Source Lists\n");
  for (const { setName, setData } of datasets) {
    if (!setData?.sources) continue;
    lines.push(`\n### ${setName}\n`);
    lines.push("| # | Category | Title | Publisher | Date | Evidence Type |");
    lines.push("|---|----------|-------|-----------|------|---------------|");
    setData.sources.forEach((s, i) => {
      const title = (s.title || "").replace(/\|/g, "—").slice(0,65);
      const pub   = (s.publisher || "").slice(0,22);
      const date  = (s.date_published || "").slice(0,10);
      const et    = s.evaluation?.evidence_type || "?";
      const cat   = CAT_LABELS[s.main_category]?.split(" ")[0] || s.main_category;
      lines.push(`| ${i+1} | ${cat} | ${title} | ${pub} | ${date} | ${et} |`);
    });
  }

  return lines.join("\n");
}

const CAT_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const banner = "═".repeat(64);
  console.log(`\n${banner}`);
  console.log(`  Test Deck Comparison`);
  console.log(`${banner}\n`);

  // Load all datasets
  const datasets = [];
  for (const setId of SET_IDS) {
    const setPath      = path.join(ROOT, "data/test_sets", `${setId}.json`);
    const auditPath    = findAuditFile(setId);
    const summaryPath  = findRunSummary(setId);
    const analysesPath = findAnalysesFile(setId);

    const setData   = loadIfExists(setPath,      `${setId} test set`);
    const auditText = loadIfExists(auditPath,     `${setId} audit`);
    const runSummary = loadIfExists(summaryPath,  `${setId} run summary`);
    const analyses   = loadIfExists(analysesPath, `${setId} analyses`);

    if (!setData) {
      console.warn(`  Warning: test set not found for ${setId} — skipping`);
      continue;
    }

    console.log(`  ${SET_NAMES[setId]}: ${setData.source_count || "?"} sources | audit: ${auditPath ? "found" : "missing"}`);
    datasets.push({ setId, setName: SET_NAMES[setId], setData, auditText, runSummary, analyses });
  }

  if (datasets.length < 2) {
    console.error("  Need at least 2 test sets + audits to compare. Run buildTestSets.js, runTestSetDeck.js, and auditTestDeck.js first.");
    process.exit(1);
  }

  console.log(`\n  Running LLM comparison (this may take 60-90s)...`);
  const comparison = await runComparison(datasets);
  if (comparison) {
    console.log(`  Overall winner: ${comparison.overall_winner}`);
  }

  const report = buildComparisonReport(datasets, comparison);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, report);
  console.log(`\n  → ${path.relative(ROOT, OUT_PATH)}`);
  console.log("\nDone.");
}

main().catch(err => { console.error(err); process.exit(1); });
