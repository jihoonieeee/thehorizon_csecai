/**
 * Audit-fix regression tests (round 3) — second wave:
 *   - analytical_state delivered + deterministic confidence-ceiling enforcement
 *   - L5C external evidence is never evidence_class "operational"
 *   - chatbot corpus-composition guard (research-only corpus → no real-world narration)
 *   - 2-outlet amplification closed (≥2 publishers citing one origin → circular_reporting_risk)
 *
 * Run with: node tests/auditFixesV3.test.js
 */

import assert from "node:assert/strict";

import { validateCategoryAnalysis } from "../lib/pipeline/analysis/validateCategoryAnalysis.js";
import { buildAnalyticalStateBlock } from "../lib/pipeline/analysis/synthesizeCategory.js";
import { normalizeL5CToPacket } from "../lib/pipeline/evidence/normalizeToPackets.js";
import { assessOverclaim } from "../lib/agent/answerGrounding.js";
import {
  inferOriginRole, resetCircularRegistry, prepopulateCircularRegistry,
} from "../lib/pipeline/validation/originTracking.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

// ── 1. Analytical state confidence ceiling ────────────────────────────────────
console.log("\nAnalytical state confidence ceiling");

function compactWith(ceiling) {
  return {
    category: "llm_threats",
    // Two distinct origins so the pre-existing single-origin gate doesn't cap to
    // medium on its own — isolating the ceiling behaviour under test.
    id_index: new Map([
      ["e1", { origin: "5A_rawfact", source_type: "incident", evidence_strength: "strong",
               permitted_uses: ["fact_support"], limitations: [], publisher: "A", date: "2026-01-01" }],
      ["e2", { origin: "5A_rawfact", source_type: "incident", evidence_strength: "strong",
               permitted_uses: ["fact_support"], limitations: [], publisher: "B", date: "2026-02-01" }],
    ]),
    analytical_state: { confidence_ceiling: ceiling },
  };
}
function rawHighConfidence() {
  return {
    top_insights: [{ text: "A notable development in LLM threats.", supporting_evidence_ids: ["e1", "e2"],
                     why_this_matters: "x", confidence: "high", slide_usefulness: "high" }],
    top_trends_or_patterns: [], top_happenings: [], early_signals: [], recommendations: [],
    outlook_6_months: { observed_basis: "x", projected_trajectory: "y", reasoning: "z",
                        confidence: "high", supporting_evidence_ids: ["e1", "e2"] },
    evidence_gaps: [],
  };
}

test("ceiling=low caps a high-confidence insight to low with a caveat", () => {
  const v = validateCategoryAnalysis(rawHighConfidence(), compactWith("low"));
  assert.equal(v.top_insights[0].confidence, "low");
  assert.ok(/ceiling/.test(v.top_insights[0].caveat_if_any || ""), "must annotate the cap");
  assert.equal(v.outlook_6_months.confidence, "low");
});

test("ceiling=high leaves a high-confidence insight unchanged", () => {
  const v = validateCategoryAnalysis(rawHighConfidence(), compactWith("high"));
  assert.equal(v.top_insights[0].confidence, "high");
});

test("ceiling=none floors confidence at low", () => {
  const v = validateCategoryAnalysis(rawHighConfidence(), compactWith("none"));
  assert.equal(v.top_insights[0].confidence, "low");
});

test("buildAnalyticalStateBlock renders ceiling and candidates", () => {
  const block = buildAnalyticalStateBlock({
    confidence_ceiling: "medium",
    hypothesis_candidates: [{ candidate_claim: "Prompt injection shifting to RAG.", confidence_ceiling: "medium", supporting_evidence_ids: ["e1", "e2"] }],
  });
  assert.ok(/CONFIDENCE CEILING/.test(block));
  assert.ok(/medium/.test(block));
  assert.ok(/RAG/.test(block));
  assert.ok(/e1, e2/.test(block));
});

// ── 2. L5C evidence_class is never operational ────────────────────────────────
console.log("\nL5C external class");

test("authoritative L5C packet is evidence_class=external, not operational", () => {
  const p = normalizeL5CToPacket({
    external_evidence_id: "ext1", source_quality: "authoritative", confidence: "high",
    finding: "Gov report: 40% of orgs saw AI phishing.", url: "https://cisa.gov/x",
    source_title: "CISA report", publisher: "CISA", source_quote: "Forty percent of organizations reported AI-generated phishing attempts in 2026.",
  });
  assert.equal(p.evidence_class, "external");
  assert.notEqual(p.evidence_class, "operational");
});

// ── 3. Chatbot corpus-composition guard ───────────────────────────────────────
console.log("\nChatbot research-only corpus guard");

test("research-only corpus triggers the capability-not-adoption guard even without keywords", () => {
  const ctx = { claims: [
    { source_type: "research_finding", publisher: "arXiv" },
    { source_type: "benchmark_evaluation", publisher: "MIT" },
  ] };
  const g = assessOverclaim("what is the situation with prompt injection", ctx);
  assert.equal(g.must_guard, true);
  assert.ok(/research/i.test(g.caveat || ""));
  assert.equal(g.confidence_cap, "moderate");
});

test("corpus with an operational source does NOT trip the research-only guard", () => {
  const ctx = { claims: [
    { source_type: "incident", publisher: "Reuters" },
    { source_type: "research_finding", publisher: "arXiv" },
  ] };
  const g = assessOverclaim("what is the situation with prompt injection", ctx);
  assert.equal(g.must_guard, false);
});

// ── 4. 2-outlet amplification ─────────────────────────────────────────────────
console.log("\n2-outlet amplification → circular_reporting_risk");

test("two distinct publishers citing the same origin → circular_reporting_risk", () => {
  resetCircularRegistry();
  const mk = (id, pub) => ({
    id, publisher: pub, source_type: "incident", title: "Bank breach reported",
    summary: "According to Mandiant the attackers compromised a regional bank.",
    url: `https://${pub}.example.com/story`,
  });
  const s1 = mk("1", "outleta");
  const s2 = mk("2", "outletb");
  prepopulateCircularRegistry([s1, s2]);
  const r1 = inferOriginRole(s1);
  assert.equal(r1.independence_level, "circular_reporting_risk",
    `expected circular_reporting_risk, got ${r1.independence_level}`);
  resetCircularRegistry();
});

test("a single publisher citing an origin is NOT circular", () => {
  resetCircularRegistry();
  const s1 = {
    id: "1", publisher: "soleoutlet", source_type: "incident", title: "Bank breach",
    summary: "According to Mandiant the attackers compromised a regional bank.",
    url: "https://soleoutlet.example.com/story",
  };
  prepopulateCircularRegistry([s1]);
  const r1 = inferOriginRole(s1);
  assert.notEqual(r1.independence_level, "circular_reporting_risk");
  resetCircularRegistry();
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
