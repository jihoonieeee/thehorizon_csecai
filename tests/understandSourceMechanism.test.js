/**
 * Integration tests for understandSource.normalise() with the mechanism-first
 * pipeline (Phase 2). Feeds raw LLM-shaped mechanism JSON through normalise and
 * asserts the deterministic tag/domain assignment + cross-check reconciliation.
 * Pure JS, no API.
 * Run: node --test tests/understandSourceMechanism.test.js
 */
import assert from "node:assert/strict";
import { normalise } from "../lib/pipeline/understandSource.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const SRC = { id: "t1", title: "Test", url: "https://example.com/x", publisher: "p", full_text: "body" };
const base = (over = {}) => ({
  relevant: true, source_type: "research_finding", trust_tier: "high",
  short_summary: "a finding", is_defensive: false, ...over,
});

console.log("\n── mechanism → tag wiring ──");

test("jailbreak mechanism → LLM11 + llm domain", () => {
  const r = normalise(base({
    primary_exploit_mechanism: "jailbreak_safety_bypass",
    primary_consequence: "response_manipulation", affected_layer: "prompt",
    primary_taxonomy_suggestion: "LLM11_jailbreak_safety_bypass",
  }), SRC);
  assert.equal(r.category, "llm_threats");
  assert.deepEqual(r.primary_tags, ["LLM11_jailbreak_safety_bypass"]);
  assert.equal(r.relevant, true);
  assert.equal(r.mechanism_classification.agreement, true);
  assert.equal(r.mechanism_classification.conflict, false);
});

test("injection→tool_execution → ASI02+LLM01, agentic domain", () => {
  const r = normalise(base({
    primary_exploit_mechanism: "prompt_injection",
    primary_consequence: "tool_execution", affected_layer: "agent",
    primary_taxonomy_suggestion: "ASI02_tool_misuse_exploitation",
  }), SRC);
  assert.equal(r.category, "agentic_ai_threats");
  assert.deepEqual(r.primary_tags, ["ASI02_tool_misuse_exploitation", "LLM01_prompt_injection"]);
  assert.equal(r.mechanism_classification.agreement, true);
});

test("cross-check conflict is flagged (LLM suggested wrong tag)", () => {
  const r = normalise(base({
    primary_exploit_mechanism: "rag_knowledge_poisoning",
    primary_consequence: "false_information", affected_layer: "retrieval",
    primary_taxonomy_suggestion: "LLM08_vector_embedding_weakness", // wrong — map says LLM04
  }), SRC);
  assert.deepEqual(r.primary_tags, ["LLM04_data_model_poisoning"]);
  assert.equal(r.mechanism_classification.conflict, true, "should flag map-vs-LLM disagreement");
  assert.equal(r.mechanism_classification.llm_suggestion, "LLM08_vector_embedding_weakness");
});

test("generic software vuln → unclear + not relevant", () => {
  const r = normalise(base({
    primary_exploit_mechanism: "generic_software_vulnerability",
    primary_consequence: "none", affected_layer: "application",
    source_type: "vulnerability",
  }), SRC);
  assert.equal(r.category, "unclear_or_adjacent");
  assert.deepEqual(r.primary_tags, []);
  assert.equal(r.relevant, false);
});

test("defensive source keeps offensive category + defensive tag + flag", () => {
  const r = normalise(base({
    primary_exploit_mechanism: "jailbreak_safety_bypass",
    primary_consequence: "response_manipulation", affected_layer: "prompt",
    mechanism_evidence_role: "defense", is_defensive: true,
    source_type: "defensive_capability",
  }), SRC);
  assert.equal(r.category, "llm_threats");
  assert.ok(r.primary_tags.includes("LLM11_jailbreak_safety_bypass"));
  assert.ok(r.primary_tags.includes("defensive"));
  assert.equal(r.is_defensive, true);
  assert.equal(r.defended_category, "llm_threats");
});

test("out-of-vocab mechanism coerced to unknown → unclear", () => {
  const r = normalise(base({
    primary_exploit_mechanism: "some_made_up_thing",
    primary_consequence: "banana",
  }), SRC);
  assert.equal(r.category, "unclear_or_adjacent");
  assert.equal(r.relevant, false);
});

test("model poisoning → TAI02 traditional", () => {
  const r = normalise(base({
    primary_exploit_mechanism: "model_poisoning",
    primary_consequence: "none", affected_layer: "model",
    primary_taxonomy_suggestion: "TAI02_model_poisoning",
  }), SRC);
  assert.equal(r.category, "traditional_ai_threats");
  assert.deepEqual(r.primary_tags, ["TAI02_model_poisoning"]);
});

test("AI phishing → AE02 ai_enabled", () => {
  const r = normalise(base({
    primary_exploit_mechanism: "ai_social_engineering",
    primary_consequence: "none", affected_layer: "application",
  }), SRC);
  assert.equal(r.category, "ai_enabled_threats");
  assert.deepEqual(r.primary_tags, ["AE02_ai_social_engineering"]);
});

test("mechanism_classification is persisted in result", () => {
  const r = normalise(base({
    primary_exploit_mechanism: "sensitive_info_disclosure",
    primary_consequence: "data_exfiltration", affected_layer: "application",
    mechanism_rationale: "credentials leaked",
  }), SRC);
  const mc = r.mechanism_classification;
  assert.equal(mc.primary_exploit_mechanism, "sensitive_info_disclosure");
  assert.equal(mc.primary_consequence, "data_exfiltration");
  assert.equal(mc.mapped_tag, "LLM02_sensitive_info_disclosure");
  assert.equal(mc.rationale, "credentials leaked");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
