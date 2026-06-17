/**
 * Regression tests for P3 hardening from docs/audits/layers-4-6-critical-audit.md.
 *
 *   5A.4 — no observed-by-default in no-LLM runs: an inherently-observed source
 *          type still needs an observed signal (named actor / observation verb)
 *          before it grants adoption_support when the LLM judgment is absent.
 *
 * (5A.3 second-model QA budgeting needs a live 2nd-model key; 4.3/4.4 taxonomy
 *  grounding live inside the LLM-only understandSource path — both are covered by
 *  the full suite staying green and the §7 contract test rather than here.)
 *
 * Run with: node tests/p3AuditFixes.test.js
 */

import assert from "node:assert/strict";
import { triageEvidenceItem } from "../lib/pipeline/evidenceTriage/evidenceTriage.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

const incidentSource = { id: "s1", url: "https://x", source_type: "incident" };

console.log("5A.4 — observed-use floor when no LLM judgment");

test("inherently-observed incident WITHOUT an observed signal does NOT auto-grant adoption_support", () => {
  // No entities, no observation verb, no LLM judgment ({}).
  const item = {
    evidence_id: "e1", evidence_type: "incident_event",
    fact: "A vulnerability of moderate severity affects a class of web systems generally.",
    source_quote: "a vulnerability of moderate severity affects a class of web systems generally",
    entities: [], numbers: [],
  };
  const t = triageEvidenceItem(item, incidentSource, {});
  assert.equal(t.observed_use, false);
  assert.ok(!t.permitted_uses.includes("adoption_support"),
    `should not grant adoption_support without an observed signal. Got: ${t.permitted_uses}`);
});

test("incident WITH a named actor regains observed_use + adoption_support (no LLM judgment)", () => {
  const item = {
    evidence_id: "e2", evidence_type: "incident_event",
    fact: "APT99 compromised a named bank in a confirmed breach in March 2026.",
    source_quote: "APT99 compromised a named bank in a confirmed breach in March 2026.",
    entities: ["APT99"], numbers: [],
  };
  const t = triageEvidenceItem(item, incidentSource, {});
  assert.equal(t.observed_use, true);
  assert.ok(t.permitted_uses.includes("adoption_support"));
});

test("incident WITH an observation verb (no entities) still counts as observed", () => {
  const item = {
    evidence_id: "e3", evidence_type: "incident_event",
    fact: "Ransomware was observed actively deployed against production banking systems.",
    source_quote: "ransomware was observed actively deployed against production banking systems",
    entities: [], numbers: [],
  };
  const t = triageEvidenceItem(item, incidentSource, {});
  assert.equal(t.observed_use, true);
});

test("explicit LLM observed_use=false still overrides everything (authoritative)", () => {
  const item = {
    evidence_id: "e4", evidence_type: "incident_event",
    fact: "APT99 may in future adopt this technique against banks.",
    source_quote: "APT99 may in future adopt this technique against banks",
    entities: ["APT99"], numbers: [],
  };
  const t = triageEvidenceItem(item, incidentSource, { observed_use: false });
  assert.equal(t.observed_use, false);
  assert.ok(!t.permitted_uses.includes("adoption_support"));
});

console.log("\n──────────────────────────────────────────────────");
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
