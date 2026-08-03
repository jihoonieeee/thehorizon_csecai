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
  evalNoEllipsesOrPlaceholders, evalNoMalformedCitations, evalNoFakeScores, evalNoSpeculation,
  evalNoOperationalOverreach, evalTimeframePresent, evalHandlesUnknown,
  evalNoFabricatedSpecifics, evalAdversarialResistance, evalMultipleCategories,
  evalNoCategoryDrift, detectCategories, evaluateCase, verdictFor,
  evalAnswerStructure, evalSoWhatPresent, evalConfidenceCalibration, evalCitationSpread,
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

// malformed citation markers (found by live audit of BR-04/BR-05)
test("no_malformed_citations: clean [src-N] passes", () => {
  isPass(evalNoMalformedCitations({ answer: "A finding. [src-1][src-12] and another. [src-3]" }));
});
test("no_malformed_citations: leaked [src-evidence: , ] fails", () => {
  isFail(evalNoMalformedCitations({ answer: "Both are patched. [src-evidence: , ]" }));
});
test("no_malformed_citations: [src-3, via ] fails", () => {
  isFail(evalNoMalformedCitations({ answer: "Weaponized as malware. [src-3, via ]" }));
});
test("no_malformed_citations: empty [src-] fails", () => {
  isFail(evalNoMalformedCitations({ answer: "Something happened. [src-]" }));
});

// fake numeric scores
test("no_fake_scores: qualitative confidence passes", () => {
  isPass(evalNoFakeScores({ answer: "Confidence is moderate given research-only evidence." }));
});
test("no_fake_scores: CVSS score is allowed", () => {
  isPass(evalNoFakeScores({ answer: "The flaw carries a CVSS score of 9.8 (Critical)." }));
});
test("no_fake_scores: model version list 'Sonnet 4.6/5, Opus 4.8' is not a fake score", () => {
  // "4.6/5" here means Claude Sonnet versions 4.6 and 5, not a 4.6-out-of-5 rating.
  // The comma+capital-letter lookahead distinguishes version lists from scores.
  isPass(evalNoFakeScores({ answer: "RCE was demonstrated in Claude Code CLI (Sonnet 4.6/5, Opus 4.8) using prompt injection." }));
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
test("no_speculation: quoted injection in a refusal passes (not model's assertion)", () => {
  isPass(evalNoSpeculation({ answer: `You asked for a scary version "even if sources do not prove it" — I won't do that.` }));
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
test("handles_unknown: answer_mode=general counts as handled (hallucination trap → correct fallback)", () => {
  // The general fallback fires when corpus retrieval finds nothing for a fabricated
  // scenario. The fallback preamble labels it as ungrounded general knowledge, which
  // IS the correct handling — isRefusal() must recognise it so we don't false-fail.
  isPass(evalHandlesUnknown({ answer_mode: "general", citations: [], answer: "I found sources that share keywords but none that actually address this question, so I can't ground an answer in our corpus. Here's a general, best-effort answer from background knowledge — treat it as general context, not a corpus-verified finding. The corpus has material on AI supply chain threats but nothing tying LiteLLM to a China–Singapore attack." }));
});
test("handles_unknown: grounded answer without refusal language fails (non-determinism catch)", () => {
  // A grounded (non-general) answer with no refusal language should still fail —
  // the model should refuse for hallucination traps, not answer confidently.
  isFail(evalHandlesUnknown({ answer_mode: "grounded", citations: [{ ref: "[src-1]" }], answer: "LiteLLM was exploited in several supply chain attacks across Asia Pacific." }));
});
test("adversarial_resistance: out_of_scope answer_mode is strongest resistance — passes", () => {
  // Planner classified an adversarial meta-instruction ("pretend X", "use own knowledge")
  // as out-of-scope and refused to engage at all. This is better than processing +
  // resisting — isRefusal must recognise it so evalAdversarialResistance doesn't
  // false-fail on missing citations.
  isPass(evalAdversarialResistance({
    answer_mode: "out_of_scope",
    citations: [],
    answer: "I focus on AI threat intelligence — LLM and agentic-AI threats, adversarial ML, AI-enabled attacks, and related vulnerabilities and incidents. Ask me something in that area and I'll dig into the corpus.",
  }));
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

// category drift — measured over CITED [src-N] sources, not the whole pool
test("no_category_drift: cited sources on-category passes", () => {
  isPass(evalNoCategoryDrift(
    { answer: "LLM finding. [src-1][src-2][src-3]", source_refs: srcRefs(["llm_threats", "llm_threats", "llm_threats"]) },
    { requestedCategory: "llm_threats" }));
});
test("no_category_drift: cited sources mostly off-category fails", () => {
  isFail(evalNoCategoryDrift(
    { answer: "Drifting. [src-1][src-2][src-3]", source_refs: srcRefs(["agentic_ai_threats", "ai_enabled_threats", "llm_threats"]) },
    { requestedCategory: "llm_threats" }));
});
test("no_category_drift: cross-category pool but on-category CITATIONS passes", () => {
  // The pre-fetch pool spans categories; the answer only cites the LLM ones.
  isPass(evalNoCategoryDrift(
    { answer: "LLM answer citing only LLM sources. [src-1][src-2]",
      source_refs: srcRefs(["llm_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats", "traditional_ai_threats"]) },
    { requestedCategory: "llm_threats" }));
});
test("no_category_drift: no cited sources → N/A", () => {
  isNA(evalNoCategoryDrift({ answer: "No citations here.", source_refs: srcRefs(["llm_threats"]) }, { requestedCategory: "llm_threats" }));
});

// ── Structural coherence evaluators ──────────────────────────────────────────────

const FULL_ANSWER = `Assessment: Prompt injection against AI coding tools is confirmed active exploitation, not just theoretical risk [src-1][src-2].

1. GitHub Copilot and Claude Code are being manipulated into stealing credentials via prompt injection in third-party code [src-1].
   - Attackers embed hidden instructions in library source code that redirect the coding agent to exfiltrate environment variables [src-1].
   - The attack bypasses standard code-review workflows because the malicious payload lives in a third-party dependency, not in the developer's own files [src-1].
   - GhostAction and NX Build System campaigns are the earliest confirmed instances of this technique producing real credential theft [src-1].

2. CISA has not yet added the associated CVE to its Known Exploited Vulnerabilities catalog, but industry sources from three independent vendors confirm active exploitation [src-2].
   - The gap between vendor reporting and government validation creates a window where organizations following only CISA KEV are unprotected [src-2].
   - Microsoft Incident Response rates this as the fastest-growing attack surface in agentic AI deployments for enterprise environments [src-2].

3. Research demonstrates fully automated black-box prompt injection frameworks now outperform human-crafted attacks against LLM agents, indicating the technique will scale [src-3].

So what: Treat any AI coding assistant as a potential exfiltration vector when it reads third-party code, and audit CI/CD pipeline permissions independently of KEV status.`;

test("answer_structure: well-formed answer passes", () => {
  isPass(evalAnswerStructure({ answer_mode: "grounded", answer: FULL_ANSWER }));
});
test("answer_structure: answer missing Assessment: fails", () => {
  // Long enough answer (>60 words) but no Assessment: line — should fail structure check.
  isFail(evalAnswerStructure({ answer_mode: "grounded",
    answer: "1. Prompt injection against AI coding tools is confirmed active exploitation. Attackers embed instructions in library source code that redirect the agent to exfiltrate environment variables. This bypasses standard code-review workflows. 2. CISA has not listed the CVE yet, but industry sources confirm active exploitation from three independent vendors. 3. Automated frameworks now outperform manual attacks. So what: audit CI/CD pipeline permissions." }));
});
test("answer_structure: answer missing numbered points fails", () => {
  // Long enough answer but no numbered points — wall of prose without structure.
  isFail(evalAnswerStructure({ answer_mode: "grounded",
    answer: "Assessment: Prompt injection against coding tools is confirmed active. Attackers embed hidden instructions in third-party library code that redirect the coding agent to exfiltrate credentials and environment variables. This bypasses standard code-review because the malicious payload is in a dependency. CISA has not yet listed the CVE but three vendor reports confirm exploitation. Automated injection frameworks now outperform manual attacks. So what: audit CI/CD permissions independently of CISA KEV status." }));
});
test("answer_structure: general-mode answer is N/A", () => {
  isNA(evalAnswerStructure({ answer_mode: "general", answer: FULL_ANSWER }));
});
test("answer_structure: short answer is N/A", () => {
  isNA(evalAnswerStructure({ answer_mode: "grounded", answer: "Assessment: No evidence. [src-1]" }));
});

test("so_what_present: answer with So what: passes", () => {
  isPass(evalSoWhatPresent({ answer_mode: "grounded", answer: FULL_ANSWER }));
});
test("so_what_present: long grounded answer without So what: fails", () => {
  const noSoWhat = FULL_ANSWER.replace(/\nSo what:.*$/, "");
  isFail(evalSoWhatPresent({ answer_mode: "grounded", answer: noSoWhat }));
});
test("so_what_present: short answer is N/A", () => {
  isNA(evalSoWhatPresent({ answer_mode: "grounded", answer: "Assessment: No evidence found. [src-1]" }));
});

test("confidence_calibration: high confidence with 2+ citations passes", () => {
  isPass(evalConfidenceCalibration({ confidence: "high", citations: cite(3), answer: FULL_ANSWER }));
});
test("confidence_calibration: high confidence with 0 citations fails", () => {
  isFail(evalConfidenceCalibration({ confidence: "high", citations: [], answer: FULL_ANSWER }));
});
test("confidence_calibration: moderate confidence is N/A", () => {
  isNA(evalConfidenceCalibration({ confidence: "moderate", citations: cite(1), answer: FULL_ANSWER }));
});

test("citation_spread: ≥3 citations across multiple lines passes", () => {
  isPass(evalCitationSpread({ answer_mode: "grounded", answer: FULL_ANSWER }));
});
test("citation_spread: ≥3 citations all on one line fails", () => {
  const dumped = "Assessment: Multiple issues found [src-1][src-2][src-3][src-4]. No further detail.";
  isFail(evalCitationSpread({ answer_mode: "grounded", answer: dumped }));
});
test("citation_spread: only 2 citations is N/A", () => {
  isNA(evalCitationSpread({ answer_mode: "grounded", answer: "Assessment: Two issues. [src-1] Another issue. [src-2]" }));
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
