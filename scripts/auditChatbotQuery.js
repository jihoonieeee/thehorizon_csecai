/**
 * auditChatbotQuery.js — end-to-end audit of chatbot retrieval for a given query.
 *
 * Runs: planQuery → retrieveRelevant → getEvidence (via executeTool)
 * Prints every decision point so the temporal window, sources, and evidence
 * can be inspected without needing the HTTP server running.
 *
 * Usage: node scripts/auditChatbotQuery.js
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env manually (no dotenv dependency needed)
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "../.env");
try {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env */ }

import { planQuery } from "../lib/agent/queryPlanner.js";
import { retrieveRelevant, executeTool } from "../lib/agent/agentTools.js";

const QUERY = "Based on developments in 2026 so far, what AI-related threats should CISOs and security leaders prioritise over the next 18 months, and why?";
const TODAY = new Date().toISOString().slice(0, 10);

const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
};

function hr(char = "─", n = 70) { return char.repeat(n); }
function section(title) { console.log(`\n${hr()}\n  ${title}\n${hr()}`); }
function field(k, v) { console.log(`  ${k.padEnd(26)} ${v ?? "(null)"}`); }

console.log(`\n${"═".repeat(70)}`);
console.log(`  CHATBOT RETRIEVAL AUDIT`);
console.log(`  Query : ${QUERY.slice(0, 80)}…`);
console.log(`  Today : ${TODAY}`);
console.log(`${"═".repeat(70)}`);

// ── Step 1: planQuery ────────────────────────────────────────────────────────
section("STEP 1 — Query Plan (Haiku)");
const { plan, usage: planUsage } = await planQuery(QUERY, { today: TODAY });

field("planner_method",    plan.planner_method);
field("is_in_scope",       String(plan.is_in_scope));
field("academic_focus",    String(plan.academic_focus));
field("category",          plan.category || "(cross-category)");
field("needs_trends",      String(plan.needs_trends));
field("needs_judgments",   String(plan.needs_judgments));
console.log(`\n  Search terms: ${plan.search_terms.join(", ")}`);
console.log(`  Taxonomy tags: ${plan.taxonomy_tags.length ? plan.taxonomy_tags.join(", ") : "(none)"}`);
console.log(`  Entities: ${plan.entities.length ? plan.entities.join(", ") : "(none)"}`);
console.log(`\n  ── Temporal ──`);
field("temporal_intent",       plan.temporal.temporal_intent);
field("scope_label",           plan.temporal.scope_label);
field("date_from",             plan.temporal.date_from);
field("date_to",               plan.temporal.date_to ?? "(open — up to today)");
field("requires_fresh_sources",String(plan.temporal.requires_fresh_sources));
field("forecast_horizon",      plan.temporal.forecast_horizon);
field("all_time",              String(plan.temporal.all_time));
console.log(`\n  Haiku usage: ${planUsage.input_tokens} in / ${planUsage.output_tokens} out tokens`);

// Audit: flag if window is narrower than expected for a "2026 so far" question
if (plan.temporal.date_from && plan.temporal.date_from > "2026-01-15") {
  console.log(`\n  ⚠  AUDIT WARN: date_from=${plan.temporal.date_from} — may miss early 2026 sources`);
  console.log(`     Expected: 2026-01-01 for "in 2026 so far"`);
} else if (!plan.temporal.date_from) {
  console.log(`\n  ✓ all_time retrieval — full corpus searched`);
} else {
  console.log(`\n  ✓ Temporal window looks correct for "2026 so far": ${plan.temporal.date_from} → today`);
}

// ── Step 2: retrieveRelevant ─────────────────────────────────────────────────
section("STEP 2 — Source Retrieval");
const ret = await retrieveRelevant(plan, { limit: 12 });

field("verdict",         ret.verdict);
field("relevant_count",  String(ret.relevant_count));
field("surfaced",        String(ret.count));
field("terms_used",      ret.terms_used.join(", "));
field("tags_used",       ret.tags_used.length ? ret.tags_used.join(", ") : "(none)");

// Audit: distribution by date, category, trust, source_type
const dateBuckets = { "before 2026": 0, "2026-Q1": 0, "2026-Q2": 0, "2026-Q3+": 0, "unknown": 0 };
const catCounts = {};
const trustCounts = {};

for (const s of ret.sources) {
  const d = s.date || "";
  if (!d) dateBuckets["unknown"]++;
  else if (d < "2026-01-01") dateBuckets["before 2026"]++;
  else if (d < "2026-04-01") dateBuckets["2026-Q1"]++;
  else if (d < "2026-07-01") dateBuckets["2026-Q2"]++;
  else dateBuckets["2026-Q3+"]++;
  catCounts[s.category] = (catCounts[s.category] || 0) + 1;
  trustCounts[s.trust_tier] = (trustCounts[s.trust_tier] || 0) + 1;
}

console.log(`\n  ── Date distribution ──`);
for (const [b, n] of Object.entries(dateBuckets)) {
  if (n) console.log(`    ${b.padEnd(14)} ${n} source${n !== 1 ? "s" : ""}`);
}
if (dateBuckets["before 2026"] > 0) {
  console.log(`\n  ⚠  AUDIT WARN: ${dateBuckets["before 2026"]} source(s) predate 2026 — temporal filter may not be working`);
} else {
  console.log(`\n  ✓ All retrieved sources are within the 2026 window`);
}

console.log(`\n  ── Category distribution ──`);
for (const [cat, n] of Object.entries(catCounts)) {
  console.log(`    ${(CATEGORY_LABELS[cat] || cat).padEnd(28)} ${n}`);
}

console.log(`\n  ── Trust tier distribution ──`);
for (const [tier, n] of Object.entries(trustCounts)) {
  console.log(`    ${tier.padEnd(14)} ${n}`);
}

// Audit: check for "forward_looking" coverage — sources that discuss future threats
const forwardSignals = ret.sources.filter(s =>
  /priorit|next|outlook|future|forecast|18 month|prepare|emerging|strategic/i.test((s.summary || "") + (s.title || ""))
);
console.log(`\n  ── Forward-looking coverage ──`);
console.log(`    ${forwardSignals.length} of ${ret.count} sources have forward-looking signals`);

console.log(`\n  ── Sources retrieved ──`);
for (const s of ret.sources) {
  const flag = s.date && s.date < "2026-01-01" ? "⚠ " : "  ";
  console.log(`\n  ${flag}[${s.ref}] ${s.title?.slice(0, 65) || "(no title)"}`);
  console.log(`      Publisher : ${s.publisher || "?"}`);
  console.log(`      Date      : ${s.date || "unknown"}`);
  console.log(`      Category  : ${CATEGORY_LABELS[s.category] || s.category}`);
  console.log(`      Trust     : ${s.trust_tier}`);
  console.log(`      URL       : ${s.url || "(no url)"}`);
}

// ── Step 3: Evidence retrieval ───────────────────────────────────────────────
section("STEP 3 — Evidence Retrieval");
const evDateFrom = plan.temporal?.all_time ? undefined : (plan.temporal?.date_from || undefined);
const evDateTo   = plan.temporal?.all_time ? undefined : (plan.temporal?.date_to   || undefined);
const evidenceQuery = plan.search_terms?.length ? plan.search_terms.join(" ") : QUERY;
const evResult = await executeTool("get_evidence", {
  query: evidenceQuery,
  limit: 16,
  date_from: evDateFrom,
  date_to:   evDateTo,
});

if (!evResult.available) {
  console.log(`  ✗ Evidence unavailable: ${evResult.message}`);
} else {
  field("source",          evResult.source);
  field("item_count",      String(evResult.item_count));
  field("date_from_used",  evDateFrom || "(none — all_time)");

  const evDates = { "before 2026": 0, "2026": 0, "no url (untrackable)": 0 };
  for (const ev of (evResult.evidence_items || [])) {
    if (!ev.source_url) evDates["no url (untrackable)"]++;
    // We can't check ev date directly (no date column on evidence), but source_url presence is a proxy
  }

  console.log(`\n  ── Evidence items (up to 16) ──`);
  for (const ev of (evResult.evidence_items || [])) {
    const grounded = ev.quote_grounded ? "✓ grounded" : "  inferred";
    console.log(`\n    [${grounded}] ${ev.fact?.slice(0, 75) || "(no fact)"}…`);
    console.log(`      Source: ${ev.publisher || "?"} — ${ev.source_url?.slice(0, 60) || "(no url)"}`);
    console.log(`      Tags  : ${(ev.technique_tags || []).slice(0, 3).join(", ") || "(none)"}`);
  }
}

// ── Step 4: Analytical judgments ─────────────────────────────────────────────
if (plan.needs_judgments) {
  section("STEP 4 — Analytical Judgments");
  const jdResult = await executeTool("get_judgments", {});
  if (jdResult.available) {
    field("judgment_count", String(jdResult.judgment_count));
    for (const j of (jdResult.judgments || []).slice(0, 5)) {
      console.log(`\n    [${j.category}]`);
      console.log(`    ${j.judgment?.slice(0, 100)}`);
      if (j.short_takeaway) console.log(`    → ${j.short_takeaway?.slice(0, 80)}`);
    }
  } else {
    console.log(`  No pipeline judgments available`);
  }
}

// ── Summary audit ─────────────────────────────────────────────────────────────
section("AUDIT SUMMARY");

const auditIssues = [];
const auditPasses = [];

// Temporal
if (plan.temporal.temporal_intent === "current" || plan.temporal.temporal_intent === "historical") {
  if (plan.temporal.date_from && plan.temporal.date_from <= "2026-01-15") {
    auditPasses.push("Temporal window correctly covers 2026 from Jan 1");
  } else {
    auditIssues.push(`Temporal date_from=${plan.temporal.date_from} — may miss early 2026`);
  }
} else if (plan.temporal.temporal_intent === "forward_looking") {
  auditPasses.push("Query correctly identified as forward_looking — recent context used");
}

if (plan.temporal.requires_fresh_sources) {
  auditPasses.push("requires_fresh_sources=true — recency boost active in scoring");
}

if (plan.temporal.forecast_horizon) {
  auditPasses.push(`Forward horizon captured: "${plan.temporal.forecast_horizon}"`);
} else if (/18 month/i.test(QUERY)) {
  auditIssues.push("Query mentions 18-month horizon but forecast_horizon not captured");
}

// Sources
if (dateBuckets["before 2026"] > 0) {
  auditIssues.push(`${dateBuckets["before 2026"]} pre-2026 source(s) slipped through date filter`);
} else if (ret.count > 0) {
  auditPasses.push("All retrieved sources are within the 2026 temporal window");
}

if (ret.verdict === "none") {
  auditIssues.push("Retrieval verdict=none — no corpus sources matched; response will be general fallback");
} else if (ret.verdict === "thin") {
  auditIssues.push(`Retrieval verdict=thin (${ret.relevant_count} sources) — limited coverage, response flagged`);
} else {
  auditPasses.push(`Retrieval verdict=good (${ret.relevant_count} relevant sources)`);
}

// Category diversity
const uniqueCats = Object.keys(catCounts).length;
if (uniqueCats >= 3) {
  auditPasses.push(`Cross-category coverage: ${uniqueCats} of 4 categories represented`);
} else {
  auditIssues.push(`Narrow category coverage: only ${uniqueCats} categories in results`);
}

// Forward-looking content
if (forwardSignals.length >= 2) {
  auditPasses.push(`${forwardSignals.length} sources contain forward-looking signals (good for 18-month outlook)`);
} else {
  auditIssues.push(`Only ${forwardSignals.length} source(s) with forward-looking signals — 18-month synthesis may be thin`);
}

console.log(`\n  PASSES (${auditPasses.length})`);
for (const p of auditPasses) console.log(`    ✓ ${p}`);

console.log(`\n  ISSUES (${auditIssues.length})`);
if (auditIssues.length === 0) {
  console.log(`    ✓ No issues found`);
} else {
  for (const i of auditIssues) console.log(`    ✗ ${i}`);
}

console.log(`\n${"═".repeat(70)}\n`);
