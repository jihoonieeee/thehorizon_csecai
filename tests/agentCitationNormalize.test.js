/**
 * normalizeCitationMarkers — repairs malformed [src-N …] markers the model
 * sometimes emits, so only clean [src-N] reaches the user and the citation
 * extractor. Cases are the real malformed markers found by the live chatbot QA
 * audit (docs/chatbot_qa_test_cases.md). No network.
 *
 * Run with: node tests/agentCitationNormalize.test.js
 */

import assert from "node:assert/strict";
import { normalizeCitationMarkers as N } from "../api/agent.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

console.log("\nnormalizeCitationMarkers");

// Clean markers must be untouched (idempotent).
test("clean [src-N] is preserved", () => {
  assert.equal(N("A finding. [src-1][src-12] and more. [src-3]"), "A finding. [src-1][src-12] and more. [src-3]");
});

// Recover numbered markers with trailing prose inside the bracket (real audit cases).
test("[src-3, via ] → [src-3]", () => {
  assert.equal(N("A finding [src-3, via ] here."), "A finding [src-3] here.");
});
test("[src-4 in evidence] → [src-4]", () => {
  assert.equal(N("New [src-4 in evidence] this week."), "New [src-4] this week.");
});
test("[src-3 note: from evidence on Dify] → [src-3]", () => {
  assert.equal(N("Dify [src-3 note: from evidence on Dify] ok."), "Dify [src-3] ok.");
});
test("[src-6 context; evidence from ] → [src-6]", () => {
  assert.equal(N("Agents [src-6 context; evidence from ] matter."), "Agents [src-6] matter.");
});
test("adjacent malformed markers each recover", () => {
  assert.equal(N("Cross [src-4 in evidence][src-8 in evidence] cut."), "Cross [src-4][src-8] cut.");
});
test("mixed clean + malformed recover independently", () => {
  assert.equal(N("Mixed [src-3][src-4 in evidence] cite."), "Mixed [src-3][src-4] cite.");
});
test("[src- 3] with a space recovers", () => {
  assert.equal(N("Spaced [src- 3] ref."), "Spaced [src-3] ref.");
});

// Strip numberless markers entirely (nothing to link to), leaving no orphan gap.
test("[src-evidence: , ] at end → removed cleanly", () => {
  assert.equal(N("Both are patched. [src-evidence: , ]"), "Both are patched.");
});
test("[src-evidence] mid-sentence → removed with no double space", () => {
  assert.equal(N("Mid [src-evidence] sentence continues."), "Mid sentence continues.");
});

// Does not touch unrelated bracketed text.
test("non-citation brackets are left alone", () => {
  assert.equal(N("An array like [1, 2, 3] stays."), "An array like [1, 2, 3] stays.");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
