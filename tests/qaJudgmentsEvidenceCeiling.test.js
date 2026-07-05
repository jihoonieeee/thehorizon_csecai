import { test } from "node:test";
import assert from "node:assert/strict";
import { qaJudgments } from "../lib/pipeline/qaJudgments.js";

// A well-formed analytical judgment (change + cause + implication) so it passes the
// quality gate and we can observe the confidence ceiling in isolation.
function judgment(overrides = {}) {
  return {
    judgment_id: "j1",
    judgment: "Prompt injection is escalating into remote code execution against coding agents.",
    what_changed: "Injection now reaches code execution, not just data leakage.",
    causal_mechanism: "Agents execute tool output without provenance checks.",
    why_this_matters: "A single poisoned web page can compromise a developer machine.",
    confidence: "high",
    evidence_for: ["ev-1"],
    ...overrides,
  };
}

const evIndex = (source_type) => ({
  "ev-1": { evidence_id: "ev-1", fact: "…", source_type, trust_tier: "high" },
  "ev-2": { evidence_id: "ev-2", fact: "…", source_type: "incident", trust_tier: "high" },
});

test("high-confidence claim backed only by research is capped to low", async () => {
  const { judgments } = await qaJudgments([judgment()], evIndex("research_finding"), "llm_threats", { skipLlmQa: true });
  const j = judgments[0];
  assert.equal(j.blocked, false);
  assert.equal(j.confidence, "low");
  assert.ok((j.qa_issues || []).some(x => x.includes("evidence_reality:research")), "records the ceiling reason");
});

test("high-confidence claim backed by a proven PoC is capped to medium", async () => {
  const { judgments } = await qaJudgments([judgment()], evIndex("capability_demonstration"), "llm_threats", { skipLlmQa: true });
  assert.equal(judgments[0].confidence, "medium");
});

test("high-confidence claim backed by a realized incident keeps high (with 2 sources)", async () => {
  // two evidence items so the single-source cap doesn't fire; strongest is realized
  const j = judgment({ evidence_for: ["ev-1", "ev-2"] });
  const { judgments } = await qaJudgments([j], evIndex("incident"), "ai_enabled_threats", { skipLlmQa: true });
  assert.equal(judgments[0].confidence, "high");
  assert.ok(!(judgments[0].qa_issues || []).some(x => x.includes("evidence_reality")), "no ceiling issue when realized");
});

test("ceiling never blocks — only lowers confidence", async () => {
  const { judgments, qa_report } = await qaJudgments([judgment()], evIndex("research_finding"), "llm_threats", { skipLlmQa: true });
  assert.equal(judgments[0].blocked, false);
  assert.equal(qa_report.evidence_ceiling_applied, 1);
});
