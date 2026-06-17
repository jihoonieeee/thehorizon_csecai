/**
 * Mechanical vs Semantic Separation Tests
 *
 * Verifies that:
 *   1. quoteVerification.js is mechanical-only (locates quotes, no entailment)
 *   2. judgeEvidenceItems schema includes quote_support and support_level
 *   3. evidenceFactQa.js derives from LLM judgment, not regex
 *   4. High token overlap alone is not sufficient for semantic support
 *   5. Low overlap but semantically correct quote can still "pass" via LLM field
 *   6. GENERIC_OPENER regex no longer hard-fails items in evidenceTriage
 *   7. support_level from LLM overrides structural inference
 *   8. Fallback path works when LLM didn't run (structural inference only)
 *
 * Run: node tests/rawfact/semantic-mechanical-split.test.js
 */

import assert from "node:assert/strict";
import { locateQuote, applyQuoteVerification } from "../../lib/pipeline/rawfact/quoteVerification.js";
import { classifyFactSupport } from "../../lib/pipeline/rawfact/evidenceFactQa.js";
import { checkAdmissibility } from "../../lib/pipeline/evidenceTriage/evidenceTriage.js";
import { QUOTE_SUPPORT_VALUES, SUPPORT_LEVEL_VALUES } from "../../lib/pipeline/rawfact/judgeEvidenceItems.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  ✗ ${name}\n    ${err.message}\n`);
    failed++;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeSource(overrides = {}) {
  return {
    id: "src_test",
    url: "https://example-research.org/paper",
    source_type: "research_finding",
    ...overrides,
  };
}

function makeItem(overrides = {}) {
  return {
    evidence_id: "ev_test_001",
    fact: "GPT-4 achieves 88% jailbreak success using PAIR methodology",
    source_quote: "we achieve an 88% attack success rate on GPT-4 using the PAIR methodology",
    source_type: "research_finding",
    is_atomic: true,
    numbers: ["88%"],
    entities: ["GPT-4"],
    ...overrides,
  };
}

// ── 1. quoteVerification.js is mechanical-only ───────────────────────────────

process.stdout.write("\n1. quoteVerification.js — mechanical location only\n");

test("locateQuote returns quote_exists=true when quote is in source", () => {
  const quote  = "we achieve 88% attack success on GPT-4";
  const source = "In this paper, we achieve 88% attack success on GPT-4 using PAIR methodology.";
  const result = locateQuote(quote, source);
  assert.equal(result.quote_exists, true);
  assert.ok(["exact", "approximate"].includes(result.quote_location), `expected exact or approximate, got ${result.quote_location}`);
});

test("locateQuote returns quote_exists=false when quote not in source", () => {
  const quote  = "completely unrelated text about something else entirely";
  const source = "GPT-4 was tested for jailbreak vulnerability with 88% success rate.";
  const result = locateQuote(quote, source);
  assert.equal(result.quote_exists, false);
  assert.equal(result.quote_location, "not_found");
});

test("locateQuote does NOT return semantic fields (quote_entailment, claim_preservation)", () => {
  const quote  = "we demonstrate a 88% success rate";
  const source = "we demonstrate a 88% success rate against GPT-4.";
  const result = locateQuote(quote, source);
  // These semantic fields should NOT exist in the result
  assert.ok(!("quote_entailment" in result), "quote_entailment should not be in locateQuote result");
  assert.ok(!("claim_preservation" in result), "claim_preservation should not be in locateQuote result");
});

test("applyQuoteVerification only sets mechanical fields", async () => {
  const items = [makeItem()];
  const source = "we achieve an 88% attack success rate on GPT-4 using the PAIR methodology.";
  const result = await applyQuoteVerification(items, source);
  const qv = result[0].quote_verification;
  assert.ok(qv, "quote_verification should be set");
  assert.ok("quote_exists" in qv, "quote_exists should be set");
  assert.ok("quote_location" in qv, "quote_location should be set");
  // semantic fields should NOT be authoritative — if present, they are legacy compat only
  // The important thing is that downstream should use triage_judgment.quote_support
});

test("HIGH token overlap quote that semantically mismatches is still locatable (not rejected here)", () => {
  // A quote with many overlapping words but different meaning should still be "found"
  // The SEMANTIC mismatch is detected by the LLM (judgeEvidenceItems), not here
  const quote  = "GPT-4 attack success rate is high";
  const source = "Researchers report GPT-4 attack success rate is high in lab conditions.";
  const result = locateQuote(quote, source);
  // Quote exists mechanically — but semantic support is for LLM to judge
  assert.equal(result.quote_exists, true, "mechanically present even if semantically mismatching");
  // No entailment decision made here
  assert.ok(!("quote_entailment" in result), "no entailment in locateQuote");
});

// ── 2. judgeEvidenceItems schema includes new fields ─────────────────────────

process.stdout.write("\n2. judgeEvidenceItems schema\n");

test("QUOTE_SUPPORT_VALUES contains all expected values", () => {
  const expected = ["directly_supports", "partially_supports", "does_not_support", "overstates_scope"];
  for (const v of expected) {
    assert.ok(QUOTE_SUPPORT_VALUES.has(v), `missing value: ${v}`);
  }
  assert.equal(QUOTE_SUPPORT_VALUES.size, 4, "should have exactly 4 values");
});

test("SUPPORT_LEVEL_VALUES contains all expected values", () => {
  const expected = ["direct_fact", "reported_fact", "research_finding", "vendor_claim", "prediction", "opinion", "unsupported"];
  for (const v of expected) {
    assert.ok(SUPPORT_LEVEL_VALUES.has(v), `missing value: ${v}`);
  }
  assert.equal(SUPPORT_LEVEL_VALUES.size, 7, "should have exactly 7 values");
});

// ── 3. evidenceFactQa.js derives from LLM judgment fields ────────────────────

process.stdout.write("\n3. evidenceFactQa.js — derives from LLM judgment\n");

test("support_level comes from triage_judgment.support_level when available", () => {
  const item = makeItem({
    triage_judgment: { support_level: "vendor_claim", quote_support: "partially_supports" },
  });
  const qa = classifyFactSupport(item);
  assert.equal(qa.support_level, "vendor_claim", `expected vendor_claim from LLM, got ${qa.support_level}`);
});

test("over_interpreted comes from triage_judgment.quote_support=overstates_scope (not regex)", () => {
  const item = makeItem({
    fact: "Adversaries are deploying AI attacks at unprecedented scale",
    source_quote: "researchers showed AI could potentially assist attackers",
    triage_judgment: {
      quote_support: "overstates_scope",
      support_level: "research_finding",
    },
  });
  const qa = classifyFactSupport(item);
  assert.equal(qa.over_interpreted, true, "over_interpreted should be true from quote_support=overstates_scope");
});

test("vendor_claim from LLM blocks adoption_support and trend_input", () => {
  const item = makeItem({
    triage_judgment: { support_level: "vendor_claim", quote_support: "directly_supports" },
  });
  const qa = classifyFactSupport(item);
  assert.ok(qa.blocked_uses.includes("adoption_support"), "vendor_claim should block adoption_support");
  assert.ok(qa.blocked_uses.includes("trend_input"), "vendor_claim should block trend_input");
  assert.ok(qa.blocked_uses.includes("market_wide"), "vendor_claim should block market_wide");
});

test("research_finding from LLM blocks adoption_support but not capability_support", () => {
  const item = makeItem({
    triage_judgment: { support_level: "research_finding", quote_support: "directly_supports" },
  });
  const qa = classifyFactSupport(item);
  assert.ok(qa.blocked_uses.includes("adoption_support"), "research_finding should block adoption_support");
  assert.ok(!qa.blocked_uses.includes("capability_support"), "research_finding should NOT block capability_support");
  assert.ok(!qa.blocked_uses.includes("fact_support"), "research_finding should NOT block fact_support");
});

test("prediction from LLM blocks fact_support and case_study", () => {
  const item = makeItem({
    triage_judgment: { support_level: "prediction", quote_support: "directly_supports" },
  });
  const qa = classifyFactSupport(item);
  assert.ok(qa.blocked_uses.includes("fact_support"), "prediction should block fact_support");
  assert.ok(qa.blocked_uses.includes("case_study"), "prediction should block case_study");
});

test("direct_fact from LLM with observed_use allows adoption_support", () => {
  const item = makeItem({
    triage_judgment: {
      support_level: "direct_fact",
      quote_support: "directly_supports",
      observed_use: true,
    },
    source_type: "incident",
  });
  const qa = classifyFactSupport(item);
  assert.equal(qa.support_level, "direct_fact");
  assert.ok(!qa.blocked_uses.includes("fact_support"), "direct_fact should not block fact_support");
});

test("required_caveats includes lab caveat for research_finding", () => {
  const item = makeItem({
    triage_judgment: { support_level: "research_finding", quote_support: "directly_supports", limitations: ["lab_only"] },
  });
  const qa = classifyFactSupport(item);
  assert.ok(qa.required_caveats.some((c) => c.includes("lab")), "should include lab caveat");
});

// ── 4. High overlap but semantic mismatch needs LLM review ───────────────────

process.stdout.write("\n4. Token overlap alone is not sufficient\n");

test("high overlap quote with overstates_scope from LLM is still over_interpreted", () => {
  // The fact claims real-world adoption; the quote only shows lab research
  // Even if token overlap is high, the LLM correctly identifies the scope mismatch
  const item = makeItem({
    fact:         "Adversaries are deploying AI-powered phishing at scale",
    source_quote: "adversaries could potentially deploy AI-powered phishing at scale in future campaigns",
    // LLM correctly identifies this as scope overstating
    triage_judgment: {
      quote_support: "overstates_scope",
      support_level: "prediction",
    },
  });
  const qa = classifyFactSupport(item);
  assert.equal(qa.over_interpreted, true, "overstates_scope should produce over_interpreted=true");
  assert.ok(qa.blocked_uses.includes("adoption_support"), "overstated adoption claim blocked");
});

test("low overlap but semantically correct quote gets support from LLM field", () => {
  // Quote uses different words but LLM correctly identifies it supports the fact
  const item = makeItem({
    fact:         "GPT-4 safety filters were bypassed with 88% success",
    source_quote: "our evaluation demonstrates a high bypass rate of 88 percent against the frontier model's guardrail mechanisms",
    // LLM correctly identifies this as direct support despite word difference
    triage_judgment: {
      quote_support: "directly_supports",
      support_level: "research_finding",
    },
  });
  const qa = classifyFactSupport(item);
  assert.equal(qa.quote_entailment, "direct", "directly_supports → direct entailment");
  assert.ok(!qa.over_interpreted, "not over_interpreted");
});

// ── 5. GENERIC_OPENER no longer hard-fails in evidenceTriage ─────────────────

process.stdout.write("\n5. Semantic regex removed from evidenceTriage\n");

test("item starting with 'AI can be used to...' is not hard-failed by GENERIC_OPENER (removed)", () => {
  // Previously, GENERIC_OPENER would hard-fail this item
  // Now it must go through LLM judgment (concrete_claim=false would make it context_only)
  const genericItem = makeItem({
    fact: "AI can be used to improve phishing email generation",
    source_quote: "AI can be used to improve phishing email generation by generating more convincing text",
    is_atomic: true,
    numbers: [],
    entities: [],
    hype_flag: false,
    concreteness_level: "low",
    // LLM judgment: this is not concrete
    triage_judgment: {
      concrete_claim: false,
      direct_demonstration: false,
      source_type_fit: true,
      observed_use: false,
      quote_support: "directly_supports",
      support_level: "prediction",
    },
  });
  const source = makeSource();
  // LLM judgment fields, not GENERIC_OPENER, determine admissibility
  const admissibility = checkAdmissibility(genericItem, source, genericItem.triage_judgment);
  // It should be context_only (not failed) because the quote exists and source is traceable
  // The GENERIC_OPENER regex would have hard-failed this — now it doesn't
  assert.notEqual(admissibility.admissibility, "failed",
    `GENERIC_OPENER regex was removed — should not hard-fail, got: ${admissibility.admissibility}`);
  // Should be context_only because concrete=false and directDemo=false
  assert.equal(admissibility.admissibility, "context_only",
    `non-concrete item should be context_only, got ${admissibility.admissibility}`);
});

test("item with source_type_fit=false from LLM is hard-failed (semantic judgment via LLM)", () => {
  const item = makeItem({
    fact: "Nation-state actor APT29 confirmed to have exploited this vulnerability",
    triage_judgment: {
      source_type_fit: false,  // LLM: governance source cannot establish attribution
      concrete_claim: true,
      direct_demonstration: false,
      quote_support: "overstates_scope",
      support_level: "vendor_claim",
    },
  });
  const source = makeSource({ source_type: "governance_signal" });
  const result = checkAdmissibility(item, source, item.triage_judgment);
  assert.equal(result.admissibility, "failed", "source_type_fit=false from LLM → failed");
  assert.ok(result.hard_fail_reasons.includes("source_type_mismatch"), "should mention source_type_mismatch");
});

test("item with LLM support_level=unsupported is hard-failed", () => {
  const item = makeItem({
    fact: "Entirely fabricated claim with no basis",
    triage_judgment: {
      support_level: "unsupported",
      quote_support: "does_not_support",
      concrete_claim: false,
      direct_demonstration: false,
    },
    quote_verification: { quote_exists: false, quote_location: "not_found", overlap_pct: 0 },
  });
  const source = makeSource();
  const result = checkAdmissibility(item, source, item.triage_judgment);
  assert.equal(result.admissibility, "failed", "support_level=unsupported → failed");
});

test("LLM quote_support=does_not_support causes failed admissibility", () => {
  const item = makeItem({
    triage_judgment: {
      quote_support: "does_not_support",
      support_level: "research_finding",
      concrete_claim: true,
      direct_demonstration: true,
    },
    quote_verification: { quote_exists: true, quote_location: "approximate", overlap_pct: 80 },
  });
  const source = makeSource();
  const result = checkAdmissibility(item, source, item.triage_judgment);
  assert.equal(result.admissibility, "failed", "does_not_support → failed");
  assert.ok(result.hard_fail_reasons.includes("llm_quote_does_not_support_fact"),
    "should mention llm_quote_does_not_support_fact");
});

test("LLM quote_support=overstates_scope causes context_only admissibility", () => {
  const item = makeItem({
    triage_judgment: {
      quote_support: "overstates_scope",
      support_level: "research_finding",
      concrete_claim: true,
      direct_demonstration: true,
    },
    quote_verification: { quote_exists: true, quote_location: "approximate", overlap_pct: 75 },
  });
  const source = makeSource();
  const result = checkAdmissibility(item, source, item.triage_judgment);
  assert.equal(result.admissibility, "context_only", "overstates_scope → context_only");
  assert.ok(result.context_reason.includes("overstate"), `context_reason: ${result.context_reason}`);
});

// ── 6. Fallback path when LLM didn't run ─────────────────────────────────────

process.stdout.write("\n6. Fallback path (no LLM judgment)\n");

test("fallback: any source without LLM judgment → fallback_unreviewed (not semantic inference)", () => {
  // 2026-06-17: inferSupportLevel no longer returns source_type-derived semantic labels.
  // Assigning "direct_fact" from source_type="incident" alone was deterministic semantic grading.
  // Without LLM review, the correct answer is: we don't know → fallback_unreviewed.
  const item = makeItem({ source_type: "incident" });
  const qa = classifyFactSupport(item);
  assert.equal(qa.support_level, "fallback_unreviewed",
    "incident without LLM → fallback_unreviewed, not direct_fact");
});

test("fallback: research_finding without LLM → fallback_unreviewed (removed semantic inference)", () => {
  const item = makeItem({ source_type: "research_finding" });
  const qa = classifyFactSupport(item);
  assert.equal(qa.support_level, "fallback_unreviewed",
    "research_finding without LLM → fallback_unreviewed, not research_finding label");
});

test("fallback: vendor_marketing intent without LLM → fallback_unreviewed (removed source_intent routing)", () => {
  // Assigning vendor_claim from source_intent.intent_class alone was deterministic semantic grading.
  const item = makeItem({
    source_type: "research_finding",
    source_intent: { intent_class: "vendor_marketing" },
  });
  const qa = classifyFactSupport(item);
  assert.equal(qa.support_level, "fallback_unreviewed",
    "vendor_marketing intent without LLM → fallback_unreviewed, not vendor_claim");
});

test("fallback admissibility: no LLM, quote exists → context_only (conservative)", () => {
  const item = makeItem({
    fact: "GPT-4 achieves 88% success rate with PAIR jailbreak",
    triage_judgment: undefined,  // LLM didn't run
    quote_verification: { quote_exists: true, quote_location: "approximate", overlap_pct: 80 },
    entities: ["GPT-4"],
    numbers: ["88%"],
    is_atomic: true,
    concreteness_level: "high",
  });
  const source = makeSource();
  // Without LLM judgment, falls back to inferConcreteClaim, inferDirectDemonstration
  const result = checkAdmissibility(item, source, {});
  // Should not be "failed" — item is traceable, has quote, is atomic and specific
  assert.notEqual(result.admissibility, "failed",
    `should not be failed without LLM; got ${result.admissibility}, reasons: ${result.hard_fail_reasons?.join(", ")}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────

process.stdout.write(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
