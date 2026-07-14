/**
 * Integration tests for understandSource.normalise() with the LLM-ASSIGNED
 * taxonomy (v2). The LLM now emits main_category + primary_tag directly; normalise
 * validates them against the registry (tag must exist AND belong to the category),
 * records a guardrail_flag on mismatch, applies the three-way disposition, and the
 * defensive invariant. No mechanism-first mapping. Pure JS, no API.
 * Run: node tests/understandSourceMechanism.test.js
 */
import assert from "node:assert/strict";
import { normalise } from "../lib/pipeline/understand/understandSource.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const SRC = { id: "t1", title: "Test", url: "https://example.com/x", publisher: "p", full_text: "body" };
const base = (over = {}) => ({
  relevant: true, scope: "offensive_finding", source_type: "research_finding",
  trust_tier: "high", short_summary: "a finding", is_defensive: false, ...over,
});

console.log("\n── LLM-assigned taxonomy: happy paths ──");

test("valid category + tag are used as-is", () => {
  const r = normalise(base({ main_category: "llm_threats", primary_tag: "LLM11_jailbreak_safety_bypass" }), SRC);
  assert.equal(r.category, "llm_threats");
  assert.deepEqual(r.primary_tags, ["LLM11_jailbreak_safety_bypass"]);
  assert.equal(r.relevant, true);
  assert.equal(r.mechanism_classification.guardrail_flag, null);
});

test("primary + valid secondary tags are kept in order", () => {
  const r = normalise(base({
    main_category: "agentic_ai_threats",
    primary_tag: "ASI05_unexpected_code_execution",
    secondary_tags: ["LLM01_prompt_injection"],
  }), SRC);
  assert.deepEqual(r.primary_tags, ["ASI05_unexpected_code_execution", "LLM01_prompt_injection"]);
});

test("boundary_rationale is persisted on the record", () => {
  const r = normalise(base({
    main_category: "ai_enabled_threats", primary_tag: "AE05_ai_malware_dev",
    boundary_rationale: "AI hub abused as a malware channel; no ML model attacked",
  }), SRC);
  assert.match(r.mechanism_classification.boundary_rationale, /malware channel/);
  assert.equal(r.mechanism_classification.assigned_by, "llm");
});

console.log("\n── guardrails ──");

test("tag from a different domain is dropped + flagged (category kept)", () => {
  const r = normalise(base({
    main_category: "agentic_ai_threats", primary_tag: "LLM01_prompt_injection",
  }), SRC);
  assert.equal(r.category, "agentic_ai_threats");
  assert.deepEqual(r.primary_tags, []);
  assert.match(r.mechanism_classification.guardrail_flag, /tag_domain_mismatch/);
});

test("off-domain primary is dropped but a valid secondary survives", () => {
  const r = normalise(base({
    main_category: "agentic_ai_threats", primary_tag: "LLM01_prompt_injection",
    secondary_tags: ["ASI05_unexpected_code_execution"],
  }), SRC);
  assert.deepEqual(r.primary_tags, ["ASI05_unexpected_code_execution"]);
});

test("unknown tag id is dropped + flagged", () => {
  const r = normalise(base({ main_category: "llm_threats", primary_tag: "LLM99_made_up" }), SRC);
  assert.deepEqual(r.primary_tags, []);
  assert.match(r.mechanism_classification.guardrail_flag, /unknown_tag/);
});

test("invalid main_category coerces to unclear_or_adjacent", () => {
  const r = normalise(base({ main_category: "banana", primary_tag: "LLM01_prompt_injection", scope: "adjacent_context", relevant: false }), SRC);
  assert.equal(r.category, "unclear_or_adjacent");
});

console.log("\n── disposition + defensive invariant ──");

test("scope=off_topic → discarded (keep=false, relevant=false)", () => {
  const r = normalise(base({ main_category: "llm_threats", primary_tag: "LLM01_prompt_injection", scope: "off_topic", relevant: false }), SRC);
  assert.equal(r.keep, false);
  assert.equal(r.relevant, false);
});

test("scope=adjacent_context → kept as reference in unclear", () => {
  const r = normalise(base({ main_category: "unclear_or_adjacent", primary_tag: null, scope: "adjacent_context", relevant: false }), SRC);
  assert.equal(r.disposition, "adjacent");
  assert.equal(r.keep, true);
  assert.equal(r.category, "unclear_or_adjacent");
});

test("defensive source keeps defended domain + defensive tag + is_defensive", () => {
  const r = normalise(base({
    main_category: "llm_threats", primary_tag: "LLM11_jailbreak_safety_bypass",
    is_defensive: true, defended_category: "llm_threats", source_type: "defensive_capability",
  }), SRC);
  assert.equal(r.category, "llm_threats");
  assert.ok(r.primary_tags.includes("LLM11_jailbreak_safety_bypass"));
  assert.ok(r.primary_tags.includes("defensive"));
  assert.equal(r.is_defensive, true);
  assert.equal(r.defended_category, "llm_threats");
});

test("HuggingFace fake-model dropper lands ai_enabled, not traditional", () => {
  const r = normalise(base({
    main_category: "ai_enabled_threats", primary_tag: "AE05_ai_malware_dev",
    source_type: "incident", short_summary: "A fake model on HF installed a password stealer.",
  }), { ...SRC, title: "Fake OpenAI model on Hugging Face, 200k downloads" });
  assert.equal(r.category, "ai_enabled_threats");
  assert.notEqual(r.category, "traditional_ai_threats");
  assert.deepEqual(r.primary_tags, ["AE05_ai_malware_dev"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
