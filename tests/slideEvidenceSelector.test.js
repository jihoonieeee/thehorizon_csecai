/**
 * slideEvidenceSelector — verifies the (previously dead) strength ranking now works:
 * it reads evidence_strength from whichever packet shape it receives (triage_data on
 * assembled dossier items, claim_relevance on canonical packets), so strong evidence
 * actually outranks usable, and the significance tie-break applies.
 *
 * Run with: node tests/slideEvidenceSelector.test.js
 */

import assert from "node:assert/strict";
import { selectSlideEvidence } from "../lib/pipeline/slides/slideEvidenceSelector.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

const slide = { slide_type: "critical_claim", category: "llm_threats" };

// Assembled-item shape: fields under triage_data + top-level provenance.
function asm(id, strength, extra = {}) {
  return {
    evidence_id: id, evidence_type: "incident_event",
    triage_data: { evidence_strength: strength, admissibility: strength === "context" ? "context_only" : "passed" },
    entities: ["named-entity"], origin_role: "primary_origin", independence_level: "independent",
    ...extra,
  };
}

console.log("\nStrength ranking (assembled-item shape)");

test("strong evidence outranks usable in main_claim_support (was collapsed before)", () => {
  const packets = [asm("u1", "usable"), asm("s1", "strong"), asm("c1", "context")];
  const sel = selectSlideEvidence(slide, packets, {}, null);
  assert.equal(sel.main_claim_support[0].evidence_id, "s1", "strong must rank first");
  assert.ok(sel.main_claim_support.length >= 2);
});

test("at equal strength, novel materiality outranks confirming", () => {
  const a = asm("conf", "usable", { triage_data: { evidence_strength: "usable", admissibility: "passed", materiality: "confirming" } });
  const b = asm("novel", "usable", { triage_data: { evidence_strength: "usable", admissibility: "passed", materiality: "novel" } });
  const sel = selectSlideEvidence(slide, [a, b], {}, null);
  assert.equal(sel.main_claim_support[0].evidence_id, "novel");
});

console.log("\nCanonical-packet shape is also understood");

test("reads claim_relevance.evidence_strength on a canonical packet", () => {
  const canon = {
    evidence_id: "k1", evidence_type: "incident_report",
    claim_relevance: { evidence_strength: "strong", admissibility: "passed" },
    content: { entities: ["x"] }, entities: ["x"],
    independence: { origin_role: "primary_origin", independence_level: "independent" },
  };
  const weak = asm("w1", "context");
  const sel = selectSlideEvidence(slide, [weak, canon], {}, null);
  assert.equal(sel.main_claim_support[0].evidence_id, "k1");
});

console.log("\nChart eligibility reads method.statistical_use / statistical_use");

test("chart_data only includes chart_allowed packets", () => {
  const chartable = asm("ch", "strong", { statistical_use: "chart_allowed", numbers: ["42%"] });
  const notChartable = asm("nc", "strong", { statistical_use: "context_only", numbers: ["7"] });
  const sel = selectSlideEvidence(slide, [chartable, notChartable], {}, null);
  const ids = sel.chart_data.map((e) => e.evidence_id);
  assert.ok(ids.includes("ch"));
  assert.ok(!ids.includes("nc"), "context_only statistical_use must not be chartable");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
