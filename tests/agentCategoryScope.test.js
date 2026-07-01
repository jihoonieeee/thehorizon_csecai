/**
 * detectCategoryInQuery — scopes an answer to a single threat category when the
 * question names that category OR a technique the taxonomy files under exactly
 * one category, and stays unscoped (null) for cross-cutting/ambiguous questions.
 * No network. Run with: node tests/agentCategoryScope.test.js
 *
 * detectCategoryInQuery is module-internal (not exported), so it's loaded by
 * evaluating its source block — this keeps api/agent.js's public surface small.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "../api/agent.js"), "utf8");
const block = src.slice(src.indexOf("const CATEGORY_NAME_MATCHERS"), src.indexOf("// ── System prompt builder"));
let detectCategoryInQuery;
eval(block.replace("function detectCategoryInQuery", "detectCategoryInQuery = function detectCategoryInQuery"));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}
const eq = (q, exp) => assert.equal(detectCategoryInQuery(q), exp, `"${q}" → ${detectCategoryInQuery(q)}, expected ${exp}`);

console.log("\ndetectCategoryInQuery — category NAME");
test("names one category → scopes to it", () => {
  eq("What are the top developments in LLM Threats?", "llm_threats");
  eq("top developments in Traditional AI Threats", "traditional_ai_threats");
  eq("top developments in Agentic AI Threats", "agentic_ai_threats");
  eq("top developments in AI-Enabled Threats", "ai_enabled_threats");
  eq("agentic AI risks most relevant to enterprise", "agentic_ai_threats");
});
test("names two+ categories (cross-cutting) → null", () => {
  eq("patterns across Traditional AI, LLM, Agentic AI, and AI-Enabled threats", null);
});

console.log("\ndetectCategoryInQuery — TECHNIQUE (the residual fix)");
test("data poisoning + model backdoors → Traditional AI", () => {
  eq("What is changing in data poisoning and model backdoors?", "traditional_ai_threats");
});
test("RAG poisoning → LLM (specific phrase, not 'data poisoning')", () => {
  eq("Tell me about RAG poisoning", "llm_threats");
});
test("prompt injection → LLM", () => {
  eq("whats new with prompt injection", "llm_threats");
});
test("deepfakes → AI-Enabled", () => {
  eq("how bad are deepfakes now?", "ai_enabled_threats");
});
test("adversarial examples → Traditional AI", () => {
  eq("adversarial examples against classifiers", "traditional_ai_threats");
});

console.log("\ndetectCategoryInQuery — false-positive guards (must stay null)");
test("a technique applied to another category's context → null", () => {
  eq("data poisoning in agentic AI systems", null);   // agentic name + traditional technique
});
test("two techniques from different categories → null", () => {
  eq("prompt injection and data poisoning", null);     // llm + traditional
});
test("technique + generic AI-agent target stays cross → null", () => {
  eq("backdoors in AI agents", null);
});
test("specific incident (no category/technique) → null", () => {
  eq("What happened with LiteLLM?", null);
});
test("ambiguous / generic → null", () => {
  eq("What is the biggest threat?", null);
  eq("Is this bad?", null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
