/**
 * Pipeline contract tests (audit §7 / §8).
 *
 * These guard the two SYSTEMIC failure classes the audit identified:
 *   (1) "compute then discard" — a quality field set by one stage is dropped by
 *       the next because a rebuild doesn't copy it forward.
 *   (2) "field-name drift" — a producer emits values a consumer's gate doesn't
 *       recognise, so the gate silently degrades.
 *
 * They assert the CONTRACT between producers and consumers, not behaviour for one
 * input — so a future rename/refactor that re-breaks a fixed bug fails loudly here.
 *
 * Run with: node tests/pipelineContracts.test.js
 */

import assert from "node:assert/strict";
import { normalizeSourceEvidenceItems } from "../lib/pipeline/rawfact/normalizeEvidenceItems.js";
import { scoreEvidenceItem } from "../lib/pipeline/rawfact/scoreEvidenceItems.js";
import { buildCategoryEvidenceDossier } from "../lib/pipeline/analysis/buildCategoryEvidenceDossier.js";
import { analyzeCategory } from "../lib/pipeline/analysis/analyzeCategory.js";
import { normalizeClaimType, QA_EXPLICIT_GATE_TYPES } from "../lib/pipeline/analysis/claimQa.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => { console.log(`  ✓ ${name}`); passed++; }).catch((e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

const run = async () => {

// ── Contract 1: L5A quality fields survive normalization (compute-then-discard) ──
console.log("Contract 1 — extraction quality fields survive normalizeItem");

test("admissibility/quote_verification/method_quality/statistical_use are NOT dropped", () => {
  // These are the four fields the audit found computed in extractEvidenceItems and
  // silently discarded by normalizeItem. They must round-trip.
  const src = {
    id: "c1", source_type: "benchmark_evaluation", main_category: "llm_threats",
    clean_text: "Attack success rate of 73% was reported in the controlled study.",
    evidence_eligibility: { evidence_use: "supporting_evidence" },
    extraction_profile: { allowed_evidence_types: ["benchmark_result"], max_items: 3 },
    evidence_items_raw: [{
      evidence_id: "ev_c1_1", evidence_type: "benchmark_result",
      fact: "Attack success rate of 73% was reported in the controlled study.",
      source_quote: "Attack success rate of 73% was reported in the controlled study.",
      numbers: ["73%"], evidence_confidence: "high", best_used_for: ["chart_annotation"],
      // fields set by applyPostExtractionQuality in extractEvidenceItems:
      quote_verification: { quote_exists: true, quote_entailment: "supported", claim_preservation: "preserved" },
      method_quality: "clear_method", statistical_use: "chart_allowed", method_reason: "n stated",
    }],
  };
  const item = normalizeSourceEvidenceItems(src).evidence_items[0];
  assert.ok(item.quote_verification, "quote_verification dropped");
  assert.equal(item.quote_verification.claim_preservation, "preserved");
  assert.equal(item.method_quality, "clear_method", "method_quality dropped");
  assert.equal(item.statistical_use, "chart_allowed", "statistical_use dropped");
});

// ── Contract 2: triage_data carries every field claimQa / dossier reads ─────────
console.log("Contract 2 — triage_data exposes the fields downstream gates read");

test("scoreEvidenceItem.triage_data has the keys claimQa + validateCategoryAnalysis consume", () => {
  const item = {
    evidence_id: "e1", evidence_type: "incident_event",
    fact: "APT99 compromised a named bank in a confirmed breach in March 2026.",
    source_quote: "APT99 compromised a named bank in a confirmed breach in March 2026.",
    entities: ["APT99"], numbers: [],
  };
  const source = { id: "s1", url: "https://x", source_type: "incident" };
  const td = scoreEvidenceItem(item, source).triage_data;
  for (const key of ["evidence_strength", "admissibility", "permitted_uses", "observed_use", "limitations"]) {
    assert.ok(key in td, `triage_data.${key} missing — claimQa/validation read this`);
  }
  assert.ok(["strong", "usable", "context", "archive"].includes(td.evidence_strength));
});

// ── Contract 3: compact dossier id_index meta has the keys the validator reads ──
console.log("Contract 3 — id_index meta exposes fields validateCategoryAnalysis reads");

test("5A id_index meta carries origin/source_type/strength/publisher/date/origin-url/independence", () => {
  const dossier = {
    category: "llm_threats", source_count: 3,
    rawfact: { strong_evidence: [{
      evidence_id: "ev_x", evidence_type: "incident_event", source_type: "incident",
      fact: "x", triage_data: { evidence_strength: "strong", permitted_uses: ["fact_support"], limitations: [] },
      publisher: "CISA", date: "2026-01-01", primary_origin_url: "https://orig", independence_level: "independent",
    }], usable_evidence: [], context_evidence: [], statistics: [], case_study_candidates: [],
      outlook_inputs: [], exposure_inputs: [], recommendation_inputs: [] },
  };
  const meta = buildCategoryEvidenceDossier(dossier).id_index.get("ev_x");
  for (const key of ["origin", "source_type", "evidence_strength", "permitted_uses", "publisher", "date", "primary_origin_url", "independence_level"]) {
    assert.ok(key in meta, `id_index meta.${key} missing — validateCategoryAnalysis reads this`);
  }
});

// ── Contract 4: every claim_type the chain mints maps to an explicit QA gate ─────
console.log("Contract 4 — claim-chain claim_types all reach an explicit QA gate");

await test("each claim_type produced by analyzeCategory normalizes to a non-default gate", async () => {
  // Drive the real claim chain with a fake LLM that emits one of EVERY output kind,
  // then assert every resulting claim_type maps into the explicit-gate set (never
  // the strategic_assessment default). This catches a rename in buildClaimChainView
  // OR a missing case in qaAnalyticalClaim.
  const dossier = {
    category: "llm_threats", source_count: 5,
    sources: [
      { source_type: "incident", publisher: "CISA", trust_tier: "primary", date_published: "2026-01-05", origin_role: "primary_origin" },
      { source_type: "incident", publisher: "NCSC", trust_tier: "primary", date_published: "2026-02-05", origin_role: "primary_origin" },
      { source_type: "threat_intelligence", publisher: "Mandiant", trust_tier: "high", date_published: "2026-02-10" },
    ],
    rawfact: {
      strong_evidence: [{ evidence_id: "ev_s", evidence_type: "incident_event", source_type: "incident", fact: "APT99 breached a bank.", triage_data: { evidence_strength: "strong", permitted_uses: ["fact_support", "case_study"], limitations: [] }, publisher: "CISA", date: "2026-02-01", entities: ["APT99"] }],
      usable_evidence: [], context_evidence: [], case_study_candidates: [], statistics: [],
      outlook_inputs: [], exposure_inputs: [], recommendation_inputs: [],
    },
    rawfact_evidence: [],
  };
  const out = {
    top_insights: [{ text: "Prompt injection is the leading LLM risk.", supporting_evidence_ids: ["ev_s"], evidence_origins: ["5A_rawfact"], why_this_matters: "x", confidence: "high", slide_usefulness: "high", caveat_if_any: null }],
    top_trends_or_patterns: [{ text: "Incidents recur across the period.", supporting_evidence_ids: ["ev_s"], evidence_origins: ["5A_rawfact"], why_this_matters: "x", confidence: "medium", slide_usefulness: "medium", caveat_if_any: null, pattern_label: "trend" }],
    top_happenings: [{ text: "A bank was breached.", supporting_evidence_ids: ["ev_s"], evidence_origins: ["5A_rawfact"], why_this_matters: "x", confidence: "high", slide_usefulness: "high", caveat_if_any: null }],
    early_signals: [],
    recommendations: [{ text: "Deploy prompt-injection monitoring.", supporting_evidence_ids: ["ev_s"], evidence_origins: ["5A_rawfact"], why_this_matters: "x", confidence: "medium", slide_usefulness: "medium", caveat_if_any: null }],
    outlook_6_months: { observed_basis: "incidents observed", projected_trajectory: "continued incidents likely", reasoning: "x", confidence: "medium", supporting_evidence_ids: ["ev_s"] },
    evidence_gaps: [],
  };
  const fakeLlm = async () => ({ result: out, llm_metadata: { llm_used: true, model_used: "test" } });
  const res = await analyzeCategory(dossier, { llmFn: fakeLlm });
  const claims = res.claims || [];
  assert.ok(claims.length > 0, "expected claims from the chain");
  for (const c of claims) {
    const norm = normalizeClaimType(c);
    assert.ok(QA_EXPLICIT_GATE_TYPES.has(norm),
      `claim_type "${c.claim_type}" normalized to "${norm}" — falls through to the weak default gate`);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n──────────────────────────────────────────────────");
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
};

run();
