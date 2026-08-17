/**
 * plannerHistory.test.js — unit tests for the planner history compression changes.
 *
 * Tests three things added in the agent quality improvements:
 *   1. planQuery receives prior conversation history and builds the right prompt
 *   2. compressTurn logic (Assessment extraction, marker stripping, no user truncation)
 *   3. QA_STOPWORDS no longer strips security-domain terms
 *
 * No network, no DB. Run with: node tests/plannerHistory.test.js
 */

import assert from "node:assert/strict";
import { planQuery } from "../lib/agent/queryPlanner.js";
import { qaContentTokens } from "../api/agent.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

// ── Helper: mock llmFn that captures the user prompt ─────────────────────────

function captureLlm() {
  let captured = null;
  const fn = async ({ user }) => {
    captured = user;
    return { data: null, usage: { input_tokens: 0, output_tokens: 0 } };
  };
  fn.get = () => captured;
  return fn;
}

const TODAY = "2026-08-03";

// Realistic assistant answer (structured, with citation markers)
const GROUNDED_ANSWER = `Assessment: Prompt injection attacks are escalating, with 3 confirmed production incidents in the past 90 days [src-1].

1. A supply chain attack targeted a RAG pipeline at a major financial institution [src-2].
  - Attackers injected instructions via poisoned documents [src-2].
  - The attack bypassed guardrails and exfiltrated customer PII [src-2].

2. New jailbreak variants exploit multi-turn context accumulation [src-1][src-3].

So what: Defenders should audit RAG pipeline input validation as a priority.`;

const GENERAL_ANSWER = `I don't have sources in the corpus that match this question, so I can't ground an answer in our data. Here's a general, best-effort answer from background knowledge — treat it as general context, not a corpus-verified finding.

Prompt injection is a class of attack where...`;

// ── Section 1: no-history path ────────────────────────────────────────────────

console.log("\nplanQuery — no history");

await testAsync("no history → user prompt is the bare query", async () => {
  const llm = captureLlm();
  await planQuery("What LLM jailbreaks happened this month?", { today: TODAY, llmFn: llm });
  assert.equal(llm.get(), "What LLM jailbreaks happened this month?");
});

await testAsync("empty history array → bare query (no prior context prefix)", async () => {
  const llm = captureLlm();
  await planQuery("Tell me about deepfakes", { today: TODAY, history: [], llmFn: llm });
  assert.equal(llm.get(), "Tell me about deepfakes");
});

// ── Section 2: history compression ───────────────────────────────────────────

console.log("\nplanQuery — history compression");

await testAsync("user+assistant turn: Q is full question, A is Assessment line only", async () => {
  const llm = captureLlm();
  await planQuery("Tell me more about the first point", {
    today: TODAY,
    history: [
      { role: "user",      content: "What LLM jailbreaks happened this month?" },
      { role: "assistant", content: GROUNDED_ANSWER },
    ],
    llmFn: llm,
  });
  const prompt = llm.get();
  // Must include the assessment line
  assert.ok(prompt.includes("Prompt injection attacks are escalating"), `missing assessment: ${prompt}`);
  // Must NOT include sub-bullet prose from the body
  assert.ok(!prompt.includes("supply chain attack"), `leaked body prose: ${prompt}`);
  // Must NOT include citation markers
  assert.ok(!prompt.includes("[src-"), `leaked [src-N] markers: ${prompt}`);
  // Q: must be the full prior question
  assert.ok(prompt.includes("Q: What LLM jailbreaks happened this month?"), `missing Q: ${prompt}`);
  // Must carry the "ignore if standalone" framing
  assert.ok(prompt.includes("ignore if it stands alone"), `missing framing: ${prompt}`);
  // Current question appended at the end
  assert.ok(prompt.endsWith("Current question: Tell me more about the first point"), `missing current question: ${prompt}`);
});

await testAsync("[src-N] markers stripped from assistant content before sending to planner", async () => {
  const llm = captureLlm();
  await planQuery("What about agentic risks?", {
    today: TODAY,
    history: [
      { role: "user",      content: "Summarise LLM threats" },
      { role: "assistant", content: GROUNDED_ANSWER },
    ],
    llmFn: llm,
  });
  assert.ok(!llm.get().includes("[src-"), `[src-N] should be stripped but found in: ${llm.get()}`);
});

await testAsync("user question is NOT truncated (old code cut at 150 chars)", async () => {
  const longQuestion =
    "What AI-enabled phishing attacks have targeted financial institutions in Southeast Asia and what techniques were used to bypass email security filters?";
  // 151 chars — old code would have cut this
  assert.ok(longQuestion.length > 150, "test question must be >150 chars");
  const llm = captureLlm();
  await planQuery("Tell me more", {
    today: TODAY,
    history: [
      { role: "user",      content: longQuestion },
      { role: "assistant", content: GROUNDED_ANSWER },
    ],
    llmFn: llm,
  });
  assert.ok(llm.get().includes(longQuestion), `long question was truncated: ${llm.get()}`);
});

await testAsync("only last 2 turns used when history is longer", async () => {
  const llm = captureLlm();
  await planQuery("What about the EU AI Act?", {
    today: TODAY,
    history: [
      { role: "user",      content: "Tell me about data poisoning"      },
      { role: "assistant", content: "Assessment: Data poisoning is a TAI threat."    },
      { role: "user",      content: "What about adversarial examples?"  },
      { role: "assistant", content: GROUNDED_ANSWER                     },
      // 5th message — if 3 turns were used, "data poisoning" from turn 1 would appear
    ],
    llmFn: llm,
  });
  const prompt = llm.get();
  // Last 2 turns only — turn 3 and 4
  assert.ok(prompt.includes("What about adversarial examples?"), `missing turn 3 Q: ${prompt}`);
  assert.ok(prompt.includes("Prompt injection attacks are escalating"), `missing turn 4 A: ${prompt}`);
  // Turn 1 should NOT appear
  assert.ok(!prompt.includes("data poisoning"), `turn 1 leaked into prompt: ${prompt}`);
});

await testAsync("general-fallback answer (no Assessment:) falls back to first 200 chars with markers stripped", async () => {
  const llm = captureLlm();
  await planQuery("What else?", {
    today: TODAY,
    history: [
      { role: "user",      content: "Tell me about deepfakes" },
      { role: "assistant", content: GENERAL_ANSWER },
    ],
    llmFn: llm,
  });
  const prompt = llm.get();
  // Should include start of general answer (no Assessment line)
  assert.ok(prompt.includes("I don't have sources"), `missing fallback content: ${prompt}`);
  // Should be trimmed to ~200 chars
  const aLine = prompt.split("\n").find(l => l.startsWith("A:")) || "";
  assert.ok(aLine.length <= 210, `fallback too long (${aLine.length} chars): ${aLine}`);
});

await testAsync("topic pivot: prior context included but framed optional", async () => {
  const llm = captureLlm();
  await planQuery("How is AI being used in state-sponsored espionage?", {
    today: TODAY,
    history: [
      { role: "user",      content: "Tell me about LLM jailbreaks" },
      { role: "assistant", content: GROUNDED_ANSWER },
    ],
    llmFn: llm,
  });
  const prompt = llm.get();
  // Framing must tell planner to ignore if question stands alone
  assert.ok(prompt.includes("ignore if it stands alone"), `missing pivot framing: ${prompt}`);
  // Current question still appended correctly
  assert.ok(prompt.includes("How is AI being used in state-sponsored espionage?"), `current question missing: ${prompt}`);
});

// ── Section 3: QA_STOPWORDS no longer strips security-domain terms ────────────

console.log("\nqaContentTokens — security terms no longer stripped");

test("'threat' is now a content token (was in stopwords)", () => {
  const tokens = qaContentTokens("AI threat landscape");
  assert.ok(tokens.has("threat"), "expected 'threat' to be a token");
});

test("'attack' is now a content token", () => {
  const tokens = qaContentTokens("adversarial attack on model");
  assert.ok(tokens.has("attack"), "expected 'attack' to be a token");
});

test("'model' is now a content token", () => {
  const tokens = qaContentTokens("language model vulnerability");
  assert.ok(tokens.has("model"), "expected 'model' to be a token");
});

test("'security' is now a content token", () => {
  const tokens = qaContentTokens("LLM security guardrail bypass");
  assert.ok(tokens.has("security"), "expected 'security' to be a token");
});

test("'system' is now a content token", () => {
  const tokens = qaContentTokens("AI agent system abuse");
  assert.ok(tokens.has("system"), "expected 'system' to be a token");
});

test("'risk' is now a content token", () => {
  const tokens = qaContentTokens("agentic AI risk posture");
  assert.ok(tokens.has("risk"), "expected 'risk' to be a token");
});

test("'data' is now a content token", () => {
  const tokens = qaContentTokens("training data poisoning");
  assert.ok(tokens.has("data"), "expected 'data' to be a token");
});

test("grammatical stopwords still stripped ('the', 'and', 'with')", () => {
  const tokens = qaContentTokens("the attack and model with risk");
  assert.ok(!tokens.has("the"),  "'the' should still be stripped");
  assert.ok(!tokens.has("and"),  "'and' should still be stripped");
  assert.ok(!tokens.has("with"), "'with' should still be stripped");
});

test("short tokens (<4 chars) still excluded by regex", () => {
  const tokens = qaContentTokens("an AI LLM CVE bug");
  assert.ok(!tokens.has("an"), "'an' too short");
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
