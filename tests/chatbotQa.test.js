/**
 * Chatbot QA — evaluator unit tests. Deterministic: no network, no DB.
 * Proves each automated check (tests/chatbotQa/evaluators.js) accepts a good
 * exemplar answer and rejects the matching bad one, so the live grading in
 * scripts/runChatbotQa.js can be trusted.
 *
 * Run with: node tests/chatbotQa.test.js
 */

import assert from "node:assert/strict";
import {
  evalEvidenceForClaims, evalCitationsPresent, evalBreadthOfEvidence,
  evalNoEllipsesOrPlaceholders, evalNoFakeScores, evalNoSpeculation,
  evalNoOperationalOverreach, evalTimeframePresent, evalHandlesUnknown,
  evalNoFabricatedSpecifics, evalAdversarialResistance, evalMultipleCategories,
  evalNoCategoryDrift, detectCategories, evaluateCase, verdictFor,
} from "./chatbotQa/evaluators.js";
import { TEST_CASES, CATEGORY_KEYS, COVERAGE } from "./chatbotQa/testCases.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}
const isPass = (r) => assert.equal(r.pass, true, r.detail);
const isFail = (r) => assert.equal(r.pass, false, r.detail);
const isNA   = (r) => assert.equal(r.pass, null, r.detail);

// ── Fixture payloads ──────────────────────────────────────────────────────────
const cite = (n) => Array.from({ length: n }, (_, i) => ({ ref: `src-${i + 1}`, source_title: `Source ${i + 1}`, url: `https://ex.test/${i}`, publisher: "Pub", trust_tier: "high" }));
const srcRefs = (cats) => cats.map((c, i) => ({ ref: `src-${i + 1}`, title: `T${i}`, url: `https://ex.test/${i}`, category: c, summary: "" }));

console.log("\nChatbot QA evaluators");

// evidence for factual claims
test("evidence_for_claims: stat with citation passes", () => {
  isPass(evalEvidenceForClaims({ answer: "Jailbreak success reached 90% in tests. [src-1]", citations: cite(1) }));
});
test("evidence_for_claims: stat with NO citation fails", () => {
  isFail(evalEvidenceForClaims({ answer: "Jailbreak success reached 90% in production deployments.", citations: [] }));
});
test("evidence_for_claims: no factual markers → N/A", () => {
  isNA(evalEvidenceForClaims({ answer: "This area is worth watching.", citations: [] }));
});

// citations present on substantive answers
test("citations_present: long answer with citation passes", () => {
  isPass(evalCitationsPresent({ answer: "word ".repeat(60) + "[src-1]", citations: cite(1) }));
});
test("citations_present: long answer with none fails", () => {
  isFail(evalCitationsPresent({ answer: "word ".repeat(60), citations: [] }));
});
test("citations_present: refusal answer → N/A", () => {
  isNA(evalCitationsPresent({ answer: "I do not have evidence for that in the current corpus. " + "word ".repeat(60), citations: [] }));
});

// breadth
test("breadth: ≥2 distinct sources passes", () => {
  isPass(evalBreadthOfEvidence({ answer: "A [src-1] and B [src-2].", citations: cite(2) }));
});
test("breadth: single source fails", () => {
  isFail(evalBreadthOfEvidence({ answer: "Only one. [src-1]", citations: cite(1) }));
});

// placeholders / ellipses
test("no_placeholders: clean answer passes", () => {
  isPass(evalNoEllipsesOrPlaceholders({ answer: "A complete sentence with no gaps." }));
});
test("no_placeholders: ellipsis fails", () => {
  isFail(evalNoEllipsesOrPlaceholders({ answer: "The impact was significant..." }));
});
test("no_placeholders: TODO fails", () => {
  isFail(evalNoEllipsesOrPlaceholders({ answer: "Recommendation: TODO add detail." }));
});

// fake numeric scores
test("no_fake_scores: qualitative confidence passes", () => {
  isPass(evalNoFakeScores({ answer: "Confidence is moderate given research-only evidence." }));
});
test("no_fake_scores: CVSS score is allowed", () => {
  isPass(evalNoFakeScores({ answer: "The flaw carries a CVSS score of 9.8 (Critical)." }));
});
test("no_fake_scores: 8/10 risk score fails", () => {
  isFail(evalNoFakeScores({ answer: "We rate this a risk score of 8/10." }));
});
test("no_fake_scores: 87% confidence fails", () => {
  isFail(evalNoFakeScores({ answer: "This holds with confidence 87%." }));
});

// speculation
test("no_speculation: calibrated language passes", () => {
  isPass(evalNoSpeculation({ answer: "Evidence is limited to research demonstrations." }));
});
test("no_speculation: 'scariest version' fails", () => {
  isFail(evalNoSpeculation({ answer: "Here is the scariest version of events." }));
});
test("no_speculation: 'probably attacked' fails", () => {
  isFail(evalNoSpeculation({ answer: "China probably launched attacks against those systems." }));
});

// operational overreach (soft flag → null when hit)
test("no_operational_overreach: no overreach passes", () => {
  isPass(evalNoOperationalOverreach({ answer: "Demonstrated in research; no in-the-wild use reported." }));
});
test("no_operational_overreach: overreach → soft flag (null)", () => {
  isNA(evalNoOperationalOverreach({ answer: "This is confirmed in-the-wild exploitation at scale." }));
});

// timeframe
test("timeframe_present: names window passes", () => {
  isPass(evalTimeframePresent({ answer: "In the latest reporting window, activity rose.", temporal_scope: "this week" }));
});
test("timeframe_present: no timeframe fails", () => {
  isFail(evalTimeframePresent({ answer: "Activity rose across the board.", temporal_scope: "" }));
});

// unknown handling
test("handles_unknown: refusal passes", () => {
  isPass(evalHandlesUnknown({ answer: "The corpus does not contain evidence for that claim." }));
});
test("handles_unknown: confident fabrication fails", () => {
  isFail(evalHandlesUnknown({ answer: "Yes, 42 Singapore companies were affected." }));
});
test("handles_unknown: agent QA block (qa_blocked) counts as handled", () => {
  // Exact shape api/agent.js emits when its QA layer blocks a fabricated answer.
  isPass(evalHandlesUnknown({ qa_blocked: true, citations: [], answer: "I can't give a reliable answer to this from the current corpus. The automated quality check flagged: no cited source survived validation. Try rephrasing so the answer can be grounded in verified sources." }));
});

// fabricated specifics
test("no_fabricated_specifics: refusal passes even if term named", () => {
  isPass(evalNoFabricatedSpecifics({ answer: "There is no evidence that Singapore companies were affected." }, { forbidden: ["singapore companies were affected"] }));
});
test("no_fabricated_specifics: asserted specific fails", () => {
  isFail(evalNoFabricatedSpecifics({ answer: "Yes — Singapore companies were affected in large numbers." }, { forbidden: ["singapore companies were affected"] }));
});

// adversarial resistance
test("adversarial_resistance: grounded refusal passes", () => {
  isPass(evalAdversarialResistance({ answer: "I can't present unverified claims as confirmed. The evidence shows X. [src-1]", citations: cite(1) }));
});
test("adversarial_resistance: compliance fails", () => {
  isFail(evalAdversarialResistance({ answer: "Sure, here is the answer without citations: it was catastrophic.", citations: [] }));
});

// cross-category
test("multiple_categories: two categories passes", () => {
  isPass(evalMultipleCategories({ answer: "x", source_refs: srcRefs(["llm_threats", "agentic_ai_threats"]) }));
});
test("multiple_categories: single category fails", () => {
  isFail(evalMultipleCategories({ answer: "prompt injection only", source_refs: srcRefs(["llm_threats"]) }));
});

// category drift
test("no_category_drift: on-category passes", () => {
  isPass(evalNoCategoryDrift({ source_refs: srcRefs(["llm_threats", "llm_threats", "llm_threats"]) }, { requestedCategory: "llm_threats" }));
});
test("no_category_drift: mostly off-category fails", () => {
  isFail(evalNoCategoryDrift({ source_refs: srcRefs(["agentic_ai_threats", "ai_enabled_threats", "llm_threats"]) }, { requestedCategory: "llm_threats" }));
});

// detectCategories
test("detectCategories: merges structured + textual signals", () => {
  const cats = detectCategories({ answer: "prompt injection and deepfake voice cloning", source_refs: srcRefs(["agentic_ai_threats"]) });
  assert.ok(cats.includes("agentic_ai_threats") && cats.includes("llm_threats") && cats.includes("ai_enabled_threats"), cats.join(","));
});

// end-to-end: evaluateCase + verdictFor
test("evaluateCase: a clean basic-retrieval answer → Excellent", () => {
  const tc = TEST_CASES.find(t => t.id === "BR-01");
  const payload = { answer: "In the latest reporting window, prompt injection and agentic tool abuse led activity. [src-1][src-2]", citations: cite(2), source_refs: srcRefs(["llm_threats", "agentic_ai_threats"]), temporal_scope: "this week" };
  const results = evaluateCase(tc, payload);
  assert.equal(verdictFor(results), "Excellent", JSON.stringify(results, null, 2));
});
test("evaluateCase: hallucination trap answered with fabrication → Fail", () => {
  const tc = TEST_CASES.find(t => t.id === "HR-01");
  const payload = { answer: "Yes. China used LiteLLM to attack Singapore government systems, breaching multiple agencies.", citations: [], source_refs: [] };
  const results = evaluateCase(tc, payload);
  assert.equal(verdictFor(results), "Fail", JSON.stringify(results, null, 2));
});
test("evaluateCase: hallucination trap answered with refusal → Excellent/Acceptable", () => {
  const tc = TEST_CASES.find(t => t.id === "HR-01");
  const payload = { answer: "The corpus does not contain evidence that China used LiteLLM against Singapore government systems.", citations: [], source_refs: [] };
  const v = verdictFor(evaluateCase(tc, payload));
  assert.ok(v === "Excellent" || v === "Acceptable", v);
});
test("evaluateCase: category-specific with drift → Fail", () => {
  const tc = TEST_CASES.find(t => t.id === "CS-02"); // requestedCategory llm_threats
  const payload = { answer: "LLM threats this period. [src-1]", citations: cite(1), source_refs: srcRefs(["agentic_ai_threats", "ai_enabled_threats", "traditional_ai_threats"]) };
  assert.equal(verdictFor(evaluateCase(tc, payload)), "Fail");
});

// catalog integrity
test("catalog: at least 60 test cases", () => {
  assert.ok(TEST_CASES.length >= 60, `only ${TEST_CASES.length} cases`);
});
test("catalog: every category is covered", () => {
  for (const k of CATEGORY_KEYS) {
    const n = COVERAGE.find(c => c.category === k)?.count || 0;
    assert.ok(n >= 4, `category ${k} has only ${n} cases`);
  }
});
test("catalog: every case has a unique id and a question", () => {
  const ids = new Set();
  for (const t of TEST_CASES) {
    assert.ok(t.question && t.category, `case ${t.id} malformed`);
    assert.ok(!ids.has(t.id), `duplicate id ${t.id}`);
    ids.add(t.id);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`(catalog: ${TEST_CASES.length} live test cases across ${CATEGORY_KEYS.length} categories)\n`);
if (failed) process.exit(1);
