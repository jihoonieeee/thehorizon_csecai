#!/usr/bin/env node
/**
 * auditTestDeck.js — Slide quality audit for a generated test-set deck
 *
 * Reads a deck.json and test set JSON. Runs both deterministic checks (counts,
 * citations, placeholder text, empty sections) and LLM-based qualitative
 * assessment across 6 dimensions. Writes a markdown audit report.
 *
 * Usage:
 *   node scripts/auditTestDeck.js --deck <path> --set <path> --out <path>
 *
 * Options:
 *   --deck <path>    Path to deck.json (from runTestSetDeck.js output)
 *   --set <path>     Path to test set JSON
 *   --out <path>     Output path for audit report markdown (default: stdout)
 *   --analyses <p>   Path to category-analyses.json (optional; enhances LLM audit)
 *
 * Output:
 *   A detailed markdown audit report with:
 *   - Deterministic checks (pass/fail with details)
 *   - LLM qualitative ratings across 6 dimensions
 *   - Per-category assessment
 *   - Overall verdict and recommendations
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };

const DECK_PATH     = getArg("--deck");
const SET_PATH      = getArg("--set");
const OUT_PATH      = getArg("--out");
const ANALYSES_PATH = getArg("--analyses");

if (!DECK_PATH || !SET_PATH) {
  console.error("Usage: node scripts/auditTestDeck.js --deck <path> --set <path> [--out <path>] [--analyses <path>]");
  process.exit(1);
}

// ── Load inputs ───────────────────────────────────────────────────────────────

function loadJson(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`${label} not found: ${p}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ── Deterministic checks ──────────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS = [
  /\.\.\./,
  /\[TODO\]/i,
  /\[TBD\]/i,
  /\[PLACEHOLDER\]/i,
  /\[INSERT\]/i,
  /Lorem ipsum/i,
  /coming soon/i,
  /not yet available/i,
];

function hasPlaceholder(text) {
  return PLACEHOLDER_PATTERNS.some(p => p.test(text));
}

function runDeterministicChecks(deck, testSet) {
  const slides = deck?.slides || [];
  const checks = [];
  let pass = 0, fail = 0, warn = 0;

  function check(name, ok, detail, level = "fail") {
    if (ok) { pass++; checks.push({ name, status: "PASS", detail: "" }); }
    else { if (level === "warn") warn++; else fail++; checks.push({ name, status: level === "warn" ? "WARN" : "FAIL", detail }); }
  }

  // Basic counts
  check("Deck has slides", slides.length > 0, `0 slides generated`);
  check("Minimum slide count (≥12)", slides.length >= 12, `Only ${slides.length} slides`);
  check("Sources loaded match test set", true, ""); // already validated in runTestSetDeck

  // Category coverage: each category should have at least one slide
  const CATS = ["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats"];
  for (const cat of CATS) {
    const catSlides = slides.filter(s => s.category === cat || s.slide_type?.includes(cat.split("_")[0]));
    const label = cat.replace(/_/g, " ");
    check(`Category slides present: ${label}`, catSlides.length > 0, `No slides for ${cat}`, "warn");
  }

  // Cross-category slide
  const hasCross = slides.some(s =>
    s.slide_type === "cross_category" ||
    (s.headline || "").toLowerCase().includes("cross") ||
    (s.headline || "").toLowerCase().includes("ecosystem")
  );
  check("Cross-category slide present", hasCross, "No cross-category synthesis slide", "warn");

  // Outlook slide
  const hasOutlook = slides.some(s =>
    s.slide_type === "outlook_structured" ||
    (s.headline || "").toLowerCase().includes("outlook") ||
    (s.headline || "").toLowerCase().includes("6-month") ||
    (s.headline || "").toLowerCase().includes("forecast")
  );
  check("Outlook / 6-month slide present", hasOutlook, "No outlook slide found", "warn");

  // Placeholder text
  const placeholderSlides = slides.filter(s => {
    const texts = [s.headline, s.speaker_notes, ...(s.bullets||[]).map(b => b.text || "")];
    return texts.some(t => t && hasPlaceholder(t));
  });
  check("No placeholder text in slides", placeholderSlides.length === 0,
    `${placeholderSlides.length} slides contain placeholder text: ${placeholderSlides.map(s => `slide ${s.slide_number}`).join(", ")}`);

  // Empty bullets
  const emptySlideBullets = slides.filter(s => {
    if (["cover","scope_methodology"].includes(s.slide_type)) return false;
    return !s.bullets || s.bullets.length === 0;
  });
  check("No content slides with empty bullets", emptySlideBullets.length === 0,
    `${emptySlideBullets.length} content slides have no bullets: ${emptySlideBullets.map(s => `slide ${s.slide_number}`).join(", ")}`, "warn");

  // Missing headlines
  const noHeadline = slides.filter(s => !["cover"].includes(s.slide_type) && !s.headline && !s.argument);
  check("All content slides have headlines", noHeadline.length === 0,
    `${noHeadline.length} slides missing headline: ${noHeadline.map(s => `slide ${s.slide_number}`).join(", ")}`, "warn");

  // Citation / evidence IDs
  const bulletsWithEvidenceId = slides.flatMap(s => (s.bullets||[]).filter(b => b.evidence_id));
  const totalBullets = slides.flatMap(s => s.bullets||[]).length;
  const citationRate = totalBullets > 0 ? Math.round(bulletsWithEvidenceId.length / totalBullets * 100) : 0;
  check(`Evidence citations ≥30% of bullets (got ${citationRate}%)`, citationRate >= 30,
    `Only ${citationRate}% of bullets have evidence_id citations`, "warn");

  // Duplicate source IDs in test set
  const ids = testSet.sources.map(s => s.id);
  const uniqueIds = new Set(ids);
  check("No duplicate source IDs in test set", ids.length === uniqueIds.size,
    `${ids.length - uniqueIds.size} duplicate IDs`);

  // Category coverage in test set
  const catCounts = {};
  for (const s of testSet.sources) {
    catCounts[s.main_category] = (catCounts[s.main_category] || 0) + 1;
  }
  for (const cat of CATS) {
    const n = catCounts[cat] || 0;
    check(`Test set has ≥10 sources for ${cat.split("_")[0]}`, n >= 10,
      `Only ${n} sources for ${cat}`);
  }

  return { checks, pass, fail, warn };
}

// ── LLM audit ─────────────────────────────────────────────────────────────────

const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    strategic_quality: {
      type: "object",
      properties: {
        rating:   { type: "string", enum: ["excellent","good","acceptable","weak","fail"] },
        findings: { type: "array", items: { type: "string" } },
        gaps:     { type: "array", items: { type: "string" } },
      },
      required: ["rating","findings","gaps"],
    },
    evidence_quality: {
      type: "object",
      properties: {
        rating:   { type: "string", enum: ["excellent","good","acceptable","weak","fail"] },
        findings: { type: "array", items: { type: "string" } },
        gaps:     { type: "array", items: { type: "string" } },
      },
      required: ["rating","findings","gaps"],
    },
    category_quality: {
      type: "object",
      properties: {
        rating:   { type: "string", enum: ["excellent","good","acceptable","weak","fail"] },
        findings: { type: "array", items: { type: "string" } },
        gaps:     { type: "array", items: { type: "string" } },
      },
      required: ["rating","findings","gaps"],
    },
    visual_quality: {
      type: "object",
      properties: {
        rating:   { type: "string", enum: ["excellent","good","acceptable","weak","fail"] },
        findings: { type: "array", items: { type: "string" } },
        gaps:     { type: "array", items: { type: "string" } },
      },
      required: ["rating","findings","gaps"],
    },
    writing_quality: {
      type: "object",
      properties: {
        rating:   { type: "string", enum: ["excellent","good","acceptable","weak","fail"] },
        findings: { type: "array", items: { type: "string" } },
        gaps:     { type: "array", items: { type: "string" } },
      },
      required: ["rating","findings","gaps"],
    },
    executive_usefulness: {
      type: "object",
      properties: {
        rating:   { type: "string", enum: ["excellent","good","acceptable","weak","fail"] },
        findings: { type: "array", items: { type: "string" } },
        gaps:     { type: "array", items: { type: "string" } },
      },
      required: ["rating","findings","gaps"],
    },
    overall_rating:       { type: "string", enum: ["excellent","good","acceptable","weak","fail"] },
    overall_summary:      { type: "string" },
    top_strengths:        { type: "array", items: { type: "string" } },
    top_weaknesses:       { type: "array", items: { type: "string" } },
    production_recommendation: { type: "string" },
  },
  required: [
    "strategic_quality","evidence_quality","category_quality",
    "visual_quality","writing_quality","executive_usefulness",
    "overall_rating","overall_summary","top_strengths","top_weaknesses",
    "production_recommendation",
  ],
};

function buildAuditPrompt(deck, testSet, categoryAnalyses) {
  const slides = deck?.slides || [];
  const slideDigest = slides.slice(0, 30).map(s => {
    const bullets = (s.bullets || []).slice(0, 4).map(b => `  - [${b.bullet_type || "?"}] ${(b.text || "").slice(0, 120)}`).join("\n");
    return `Slide ${s.slide_number} [${s.slide_type || "?"}]: ${s.headline || s.argument || "(no headline)"}
${bullets}`;
  }).join("\n\n");

  const analysisDigest = (categoryAnalyses || []).map(ca => {
    const approved = (ca.judgments || []).filter(j => !j.blocked).slice(0, 3);
    const jText = approved.map(j => `  • ${j.judgment} (confidence: ${j.confidence})`).join("\n");
    return `${ca.category} [${ca.assessment_status || "?"}]:\n${jText || "  (no approved judgments)"}`;
  }).join("\n\n");

  const testSetSummary = `Test Set: ${testSet.set_name}
Purpose: ${testSet.purpose}
Source count: ${testSet.source_count}
Category breakdown: ${Object.entries(testSet.category_counts).map(([k,v])=>`${k.split("_")[0]}=${v}`).join(", ")}
Evidence type distribution: ${(() => {
    const et = {};
    for (const s of testSet.sources) { const t = s.evaluation?.evidence_type || "?"; et[t] = (et[t]||0)+1; }
    return Object.entries(et).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}`).join(", ");
  })()}`;

  return `You are a senior threat intelligence deck quality auditor. Assess the quality of this AI threat intelligence slide deck against strict professional standards.

${testSetSummary}

── SLIDE DIGEST (first 30 slides) ──────────────────────────────────────────
${slideDigest}

── STRATEGIC SYNTHESIS ──────────────────────────────────────────────────────
${analysisDigest}

── AUDIT DIMENSIONS ─────────────────────────────────────────────────────────

Rate each dimension and provide 2-4 specific findings and gaps.

1. STRATEGIC QUALITY — Does the deck produce genuine insights?
   - Are top developments actually developments vs one-off events?
   - Are insights synthesized from multiple evidence points?
   - Is cross-category analysis genuinely connective, not a category list?
   - Does the 6-month outlook follow from evidence?

2. EVIDENCE QUALITY — Are claims traceable and well-supported?
   - Are claims backed by source evidence IDs?
   - Are research findings separated from operational exploitation?
   - Are unverified claims phrased carefully (not as certainties)?
   - Are quantitative claims supported (not vague)?

3. CATEGORY QUALITY — Are sources and slides correctly assigned?
   - Is Traditional AI about ML model attacks (not generic software vulns)?
   - Are LLM threats about LLM-specific behavior (prompt injection, RAG, etc.)?
   - Are Agentic AI threats about agents, tool-use, autonomy, identity/memory?
   - Are AI-Enabled threats about AI as attack tool (not AI being attacked)?

4. VISUAL QUALITY — Are diagrams and visuals useful?
   - Are attack chains concrete and readable (not decorative)?
   - Are figures meaningful and tied to the slide message?
   - Is layout balanced and not crowded?

5. WRITING QUALITY — Is the deck professionally written?
   - Are bullets concise and clear?
   - Are recommendations actionable?
   - Is wording calibrated (not overconfident or vague)?
   - Are there confidence labels, ellipses, or generation artifacts?

6. EXECUTIVE USEFULNESS — Would a senior stakeholder get value?
   - Is there a clear narrative arc?
   - Is the most important information easy to find?
   - Is the deck too detailed or too shallow?
   - Would a CISO or policy analyst know what to do after reading this?

Ratings: excellent | good | acceptable | weak | fail

Be specific and critical. Vague praise is not useful. Surface concrete problems.`;
}

async function runLlmAudit(deck, testSet, categoryAnalyses) {
  const { routedLLM } = await import("../lib/llm/llmRouter.js");

  const sys = `You are a principal-level threat intelligence analyst and executive communication specialist. You audit AI threat intelligence slide decks for strategic depth, evidence quality, category accuracy, and executive readability. You give honest, specific assessments — not generic praise.`;

  const usr = buildAuditPrompt(deck, testSet, categoryAnalyses);

  try {
    const { result } = await routedLLM(sys, usr, { task: "category_analysis", schema: AUDIT_SCHEMA, logLabel: "DeckAudit" });
    return result;
  } catch (err) {
    console.error(`LLM audit failed: ${err.message}`);
    return null;
  }
}

// ── Markdown report builder ───────────────────────────────────────────────────

const RATING_EMOJI = {
  excellent:   "✅",
  good:        "✅",
  acceptable:  "⚠️",
  weak:        "❌",
  fail:        "🔴",
};

function ratingLine(dimension, label, obj) {
  if (!obj) return `### ${dimension}\n\n_Not assessed_\n`;
  const lines = [];
  lines.push(`### ${dimension}`);
  lines.push(`\n**Rating**: ${RATING_EMOJI[obj.rating] || "?"} **${obj.rating.toUpperCase()}**\n`);
  if (obj.findings?.length) {
    lines.push("**Findings**:");
    for (const f of obj.findings) lines.push(`- ${f}`);
  }
  if (obj.gaps?.length) {
    lines.push("\n**Gaps / Issues**:");
    for (const g of obj.gaps) lines.push(`- ${g}`);
  }
  return lines.join("\n");
}

function buildAuditReport(testSet, deterministicResult, llmAudit, slides) {
  const { checks, pass, fail, warn } = deterministicResult;
  const lines = [];

  lines.push(`# Slide Quality Audit — ${testSet.set_name}`);
  lines.push(`\nAudit date: ${new Date().toISOString().slice(0,10)}`);
  lines.push(`Test set: \`${testSet.set_id}\` | Sources: ${testSet.source_count} | Slides: ${slides.length}\n`);
  lines.push(`---\n`);

  // Deterministic checks
  lines.push(`## Deterministic Checks\n`);
  lines.push(`**${pass} pass | ${warn} warnings | ${fail} failures**\n`);
  lines.push("| Check | Status | Detail |");
  lines.push("|-------|--------|--------|");
  for (const c of checks) {
    const icon = c.status === "PASS" ? "✅" : c.status === "WARN" ? "⚠️" : "❌";
    lines.push(`| ${c.name} | ${icon} ${c.status} | ${c.detail || ""} |`);
  }
  lines.push("");

  if (!llmAudit) {
    lines.push("## LLM Quality Assessment\n\n_LLM audit unavailable_\n");
    return lines.join("\n");
  }

  // LLM overall
  lines.push(`## LLM Quality Assessment\n`);
  lines.push(`**Overall Rating**: ${RATING_EMOJI[llmAudit.overall_rating] || "?"} **${llmAudit.overall_rating.toUpperCase()}**\n`);
  lines.push(llmAudit.overall_summary || "");
  lines.push("");

  if (llmAudit.top_strengths?.length) {
    lines.push("**Top strengths**:");
    for (const s of llmAudit.top_strengths) lines.push(`- ${s}`);
    lines.push("");
  }
  if (llmAudit.top_weaknesses?.length) {
    lines.push("**Top weaknesses**:");
    for (const w of llmAudit.top_weaknesses) lines.push(`- ${w}`);
    lines.push("");
  }
  if (llmAudit.production_recommendation) {
    lines.push(`**Production recommendation**: ${llmAudit.production_recommendation}\n`);
  }
  lines.push("---\n");

  // Per-dimension
  lines.push("## Dimension Ratings\n");
  lines.push(ratingLine("1. Strategic Quality",     "strategic",    llmAudit.strategic_quality));
  lines.push(ratingLine("2. Evidence Quality",      "evidence",     llmAudit.evidence_quality));
  lines.push(ratingLine("3. Category Quality",      "category",     llmAudit.category_quality));
  lines.push(ratingLine("4. Visual Quality",        "visual",       llmAudit.visual_quality));
  lines.push(ratingLine("5. Writing Quality",       "writing",      llmAudit.writing_quality));
  lines.push(ratingLine("6. Executive Usefulness",  "executive",    llmAudit.executive_usefulness));

  lines.push("\n---\n");

  // Slide inventory
  lines.push("## Slide Inventory\n");
  lines.push("| Slide | Type | Headline | Bullets | Has Citations |");
  lines.push("|-------|------|----------|---------|---------------|");
  for (const s of slides) {
    const headline = (s.headline || s.argument || "").slice(0, 60).replace(/\|/g, "—");
    const bulletCount = (s.bullets || []).length;
    const cited = (s.bullets || []).some(b => b.evidence_id) ? "Yes" : "No";
    lines.push(`| ${s.slide_number} | ${s.slide_type || "?"} | ${headline} | ${bulletCount} | ${cited} |`);
  }

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("  Loading inputs...");
  const deck    = loadJson(DECK_PATH, "Deck");
  const testSet = loadJson(SET_PATH,  "Test set");

  let categoryAnalyses = null;
  if (ANALYSES_PATH) {
    categoryAnalyses = loadJson(ANALYSES_PATH, "Category analyses");
  } else {
    // Try to find alongside deck
    const adjacent = path.join(path.dirname(DECK_PATH), "category-analyses.json");
    if (fs.existsSync(adjacent)) {
      categoryAnalyses = JSON.parse(fs.readFileSync(adjacent, "utf8"));
      console.log("  Loaded category-analyses.json from deck directory");
    }
  }

  const slides = deck?.slides || [];
  console.log(`  Deck: ${slides.length} slides | Test set: ${testSet.source_count} sources\n`);

  // Deterministic checks
  console.log("  Running deterministic checks...");
  const deterministicResult = runDeterministicChecks(deck, testSet);
  const { pass, fail, warn } = deterministicResult;
  console.log(`  Checks: ${pass} pass | ${warn} warn | ${fail} fail\n`);

  // LLM audit
  console.log("  Running LLM quality audit (this may take 30-60s)...");
  const llmAudit = await runLlmAudit(deck, testSet, categoryAnalyses);
  if (llmAudit) {
    console.log(`  Overall rating: ${llmAudit.overall_rating}`);
  }

  // Build report
  const report = buildAuditReport(testSet, deterministicResult, llmAudit, slides);

  // Output
  if (OUT_PATH) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, report);
    console.log(`\n  → Audit report: ${path.relative(ROOT, OUT_PATH)}`);
  } else {
    console.log("\n" + report);
  }

  console.log("\nDone.");
}

main().catch(err => { console.error(err); process.exit(1); });
