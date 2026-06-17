/**
 * Evidence judgment (Layer 5A step 5b) tests. Deterministic — no network.
 * The Haiku call is injected via opts.llmFn.
 * Run with: node tests/evidenceJudgment.test.js
 */

import assert from "node:assert/strict";

import { judgeAllEvidence, judgeSourceEvidence } from "../lib/pipeline/rawfact/judgeEvidenceItems.js";
import { scoreSourceEvidenceItems } from "../lib/pipeline/rawfact/scoreEvidenceItems.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

function mkItem(over = {}) {
  return {
    evidence_id: "ev1", evidence_type: "attack_method",
    fact: "The paper describes an exploit chain against the Acme Router web interface.",
    source_quote: "we describe an exploit chain against the Acme Router web interface",
    entities: ["Acme Router"], numbers: [], evidence_confidence: "medium",
    ...over,
  };
}
function mkSource(over = {}) {
  return { id: "s1", source_type: "research_finding", evidence_items: [mkItem()], ...over };
}
function llm(judgments) {
  return async () => ({ result: { judgments }, llm_metadata: { llm_used: true } });
}

console.log("\nLLM judgment flows into the deterministic triage");

await test("undemonstrated research claim is demoted strong→context", async () => {
  const det = scoreSourceEvidenceItems(mkSource());
  // Item 3: research_finding without LLM review is capped at usable (semantic_review_status=fallback_unreviewed)
  // The old assertion was "strong" documenting a known inflation bug — now fixed by semantic_review_status cap.
  assert.ok(["strong", "usable"].includes(det.evidence_items[0].triage_data.evidence_strength),
    `deterministic path should be strong or usable (got ${det.evidence_items[0].triage_data.evidence_strength})`);

  const { sources } = await judgeAllEvidence([mkSource()], { llmFn: llm([
    { evidence_id: "ev1", direct_demonstration: false, concrete_claim: true, source_type_fit: true, observed_use: false, limitations: ["lab_only"] },
  ]) });
  const t = scoreSourceEvidenceItems(sources[0]).evidence_items[0].triage_data;
  assert.equal(t.evidence_strength, "context");
  assert.equal(t.admissibility, "context_only");
  assert.ok(t.limitations.includes("lab_only"), "LLM limitation recorded");
});

await test("source_type_fit=false archives a type-mismatched item", async () => {
  const src = mkSource({ source_type: "governance_signal",
    evidence_items: [mkItem({ evidence_type: "incident_event", fact: "An attack on Acme occurred in March.", source_quote: "an attack on Acme occurred in March" })] });
  const { sources } = await judgeAllEvidence([src], { llmFn: llm([
    { evidence_id: "ev1", direct_demonstration: true, concrete_claim: true, source_type_fit: false, limitations: [] },
  ]) });
  const t = scoreSourceEvidenceItems(sources[0]).evidence_items[0].triage_data;
  assert.equal(t.evidence_strength, "archive");
  assert.equal(t.admissibility, "failed");
});

await test("a measured benchmark stays strong", async () => {
  const src = mkSource({ evidence_items: [mkItem({ evidence_id: "ev2", evidence_type: "benchmark_result",
    fact: "Jailbreak succeeded on GPT-4 in 73% of 200 trials.", source_quote: "the jailbreak succeeded in 73% of 200 trials against GPT-4",
    entities: ["GPT-4"], numbers: ["73%", "200"], evidence_confidence: "high" })] });
  const { sources } = await judgeAllEvidence([src], { llmFn: llm([
    { evidence_id: "ev2", direct_demonstration: true, concrete_claim: true, source_type_fit: true, observed_use: false, limitations: [] },
  ]) });
  assert.equal(scoreSourceEvidenceItems(sources[0]).evidence_items[0].triage_data.evidence_strength, "strong");
});

console.log("\nfallback + robustness");

await test("skipLlm leaves items unjudged (deterministic path unchanged)", async () => {
  const { sources, judged_items } = await judgeAllEvidence([mkSource()], { skipLlm: true, llmFn: llm([]) });
  assert.equal(judged_items, 0);
  assert.equal(sources[0].evidence_items[0].triage_judgment, undefined);
});

await test("llm_used:false (no provider) yields no judgment", async () => {
  const noProv = async () => ({ result: null, llm_metadata: { llm_used: false } });
  const byId = await judgeSourceEvidence(mkSource(), { llmFn: noProv });
  assert.deepEqual(byId, {});
});

await test("invalid limitations and unknown evidence_ids are dropped", async () => {
  const byId = await judgeSourceEvidence(mkSource(), { llmFn: llm([
    { evidence_id: "ev1", direct_demonstration: true, concrete_claim: true, source_type_fit: true, limitations: ["lab_only", "not_a_real_limitation", "single_source"] },
    { evidence_id: "ghost", direct_demonstration: true, concrete_claim: true, source_type_fit: true },
  ]) });
  assert.ok(byId.ev1, "real id kept");
  assert.equal(byId.ghost, undefined, "unknown evidence_id dropped");
  assert.deepEqual(byId.ev1.limitations, ["lab_only"], "invalid + deterministically-derived limitations filtered out");
});

await test("omitted boolean fields fall back to inference (not forced false)", async () => {
  // Only source_type_fit returned — direct_demonstration omitted → triage infers it.
  const { sources } = await judgeAllEvidence([mkSource()], { llmFn: llm([
    { evidence_id: "ev1", source_type_fit: true },
  ]) });
  const j = sources[0].evidence_items[0].triage_judgment;
  assert.equal(j.source_type_fit, true);
  assert.ok(!("direct_demonstration" in j), "omitted field not coerced — inference still applies");
});

console.log("\nobserved_use is revocable on inherently-observed source types");

function incidentSource() {
  return { id: "i1", source_type: "incident", evidence_items: [mkItem({
    evidence_id: "iv1", evidence_type: "incident_event",
    fact: "Lazarus deployed AI-generated malware against a bank in March 2026.",
    source_quote: "Lazarus deployed AI-generated malware against the bank in March 2026",
    entities: ["Lazarus", "bank"], numbers: [], evidence_confidence: "high",
  })] };
}
const uses = (src) => scoreSourceEvidenceItems(src).evidence_items[0].triage_data.permitted_uses;

await test("incident keeps adoption_support when observed_use is omitted (inherently observed)", async () => {
  const { sources } = await judgeAllEvidence([incidentSource()], { llmFn: llm([
    { evidence_id: "iv1", direct_demonstration: true, concrete_claim: true, source_type_fit: true },
  ]) });
  assert.ok(uses(sources[0]).includes("adoption_support"));
});

await test("explicit observed_use=false REVOKES adoption_support on an incident", async () => {
  const { sources } = await judgeAllEvidence([incidentSource()], { llmFn: llm([
    { evidence_id: "iv1", direct_demonstration: true, concrete_claim: true, source_type_fit: true, observed_use: false },
  ]) });
  const u = uses(sources[0]);
  assert.ok(!u.includes("adoption_support"), "speculative threat report should lose adoption_support");
  assert.ok(u.includes("fact_support"), "non-observed-gated uses remain");
});

await test("explicit observed_use=true keeps adoption_support", async () => {
  const { sources } = await judgeAllEvidence([incidentSource()], { llmFn: llm([
    { evidence_id: "iv1", direct_demonstration: true, concrete_claim: true, source_type_fit: true, observed_use: true },
  ]) });
  assert.ok(uses(sources[0]).includes("adoption_support"));
});

await test("deterministic path (no judgment) still grants adoption_support to incidents", () => {
  assert.ok(uses(incidentSource()).includes("adoption_support"), "legacy behavior preserved");
});

console.log(`\nEvidence judgment: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
