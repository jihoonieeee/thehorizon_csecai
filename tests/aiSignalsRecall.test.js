/**
 * Recall tests for the expanded AI/cyber signal dictionaries (lib/config/aiSignals.js)
 * and the hasAiSignal() / assessAiRelevance() pre-gate in aiRelevance.js.
 *
 * The pre-gate must be HIGH RECALL: strong AI-security sources that name a product,
 * model format, agent protocol, or attack surface — without saying "AI attack" —
 * should reach the LLM. Governance/marketing noise should still be discarded for free.
 *
 * Deterministic — no network, no LLM. Run with: node tests/aiSignalsRecall.test.js
 */

import assert from "node:assert/strict";

import { hasAiSignal, assessAiRelevance, hasNoveltySignal } from "../lib/pipeline/validation/aiRelevance.js";
import {
  normalizeText, normalizeLight, isTrustedAiSecurityPublisher,
} from "../lib/config/aiSignals.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

const src = (title, full_text = "", extra = {}) => ({ id: "t", title, full_text: full_text || title, ...extra });
const passes = (s) => hasAiSignal(s).has_ai_signal;

// ── Normalization ──────────────────────────────────────────────────────────────
console.log("\nnormalization (acronyms / hyphens / spelling / plurals)");

test("acronym expansion makes MCP match 'model context protocol'", () => {
  assert.ok(normalizeText("A rogue MCP server").includes("model context protocol"));
});
test("hyphen collapse: prompt-injection ↔ prompt injection", () => {
  assert.equal(normalizeText("prompt-injection"), normalizeText("prompt injection"));
});
test("UK→US spelling: behaviour → behavior, authorisation → authorization", () => {
  assert.ok(normalizeText("model behaviour").includes("behavior"));
  assert.ok(normalizeText("authorisation bypass").includes("authorization"));
});
test("plural→singular: vulnerabilities → vulnerability", () => {
  assert.ok(normalizeText("multiple vulnerabilities").includes("vulnerability"));
});
test("normalizeLight leaves acronyms unexpanded (tight novelty windows)", () => {
  assert.ok(!normalizeLight("A rogue MCP server").includes("model context protocol"));
});

// ── SHOULD PASS the pre-gate ─────────────────────────────────────────────────────
console.log("\nshould pass (high recall)");

const SHOULD_PASS = [
  "LiteLLM command injection allows unauthenticated RCE",
  "Poisoned MCP tool descriptions cause agents to exfiltrate credentials",
  "Safetensors metadata triggers code execution during model loading",
  "Deepfake voice used in executive impersonation fraud",
  "Model distillation campaign issued 16 million Claude queries",
  "Malicious ClawHub skills bypass static scanners",
  "Adversarial perturbations break semantic watermark detectors",
  "LangChain vector-store metadata filters vulnerable to SQL injection",
  "Reward-hacking coding agents sabotage tests",
  "Prompt injection hidden in resumes manipulates screening agents",
];
for (const title of SHOULD_PASS) {
  test(`pass: "${title}"`, () => {
    assert.equal(passes(src(title)), true, `signal_strength=${hasAiSignal(src(title)).signal_strength}`);
  });
}

// ── SHOULD FAIL / down-rank ──────────────────────────────────────────────────────
console.log("\nshould fail or down-rank (no threat signal)");

const SHOULD_FAIL = [
  "New generative AI productivity features announced",
  "EU AI Act compliance overview",
  "How to build a chatbot with LangChain",
  "Top AI tools for marketers",
  "AI market expected to grow by 30%",
  "Responsible AI governance framework for enterprises",
];
for (const title of SHOULD_FAIL) {
  test(`down-rank: "${title}"`, () => {
    const gate = hasAiSignal(src(title));
    const rel  = assessAiRelevance(src(title));
    // Either the pre-gate discards it, or it scores below the peripheral floor.
    assert.ok(
      gate.has_ai_signal === false || rel.relevance_tier === "off_topic",
      `expected discard/off_topic but got signal=${gate.signal_strength}, tier=${rel.relevance_tier}`
    );
  });
}

// ── Pair / bypass routing specifics ──────────────────────────────────────────────
console.log("\nrouting specifics");

test("known AI entity ALONE (no cyber signal) does not clear the gate", () => {
  assert.equal(passes(src("Getting started with LangChain and vLLM for serving")), false);
});
test("model artifact + code execution → model_artifact_exec strength", () => {
  const g = hasAiSignal(src("Loading a malicious safetensors checkpoint leads to arbitrary code execution"));
  assert.equal(g.has_ai_signal, true);
  assert.ok(["model_artifact_exec", "high", "entity_cyber", "novelty"].includes(g.signal_strength), g.signal_strength);
});
test("agent ecosystem + supply chain → agent_supply_chain / high", () => {
  const g = hasAiSignal(src("Typosquatting attack poisons an MCP tool in the plugin registry"));
  assert.equal(g.has_ai_signal, true);
});
test("trusted AI-security publisher bypasses the keyword gate", () => {
  // Body deliberately keyword-free; publisher carries the signal.
  const s = src("Quarterly research notes", "General notes about our latest findings and observations.", { publisher: "HiddenLayer" });
  assert.equal(isTrustedAiSecurityPublisher(s), true);
  assert.equal(hasAiSignal(s).signal_strength, "publisher_bypass");
});
test("novelty regex: hidden instructions in a resume manipulate the agent", () => {
  assert.equal(hasNoveltySignal(src("A hidden instruction embedded in the resume makes the screening agent leak data")), true);
});
test("down-rank marketing does NOT fire when a real cyber signal is present", () => {
  // 'responsible ai' + a concrete RCE → not down-ranked; recognized as relevant.
  const rel = assessAiRelevance(src("Responsible AI platform patches an unauthenticated RCE in its model gateway"));
  assert.notEqual(rel.relevance_tier, "off_topic");
});

console.log(`\naiSignals recall: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
