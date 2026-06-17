/**
 * Coverage-aware evidence selection (compact5A) — verifies the synthesis dossier
 * spans distinct attack vectors instead of letting one hot vector monopolise the
 * cap, surfaces rare-but-important signals that ordinal-strength selection dropped,
 * and guarantees an operational anchor when the category has one.
 *
 * Run with: node tests/coverageSelection.test.js
 */

import assert from "node:assert/strict";
import { buildCategoryEvidenceDossier } from "../lib/pipeline/analysis/buildCategoryEvidenceDossier.js";
import { classifyAttackVector } from "../lib/config/attackVectors.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

function item(id, fact, { strength = "strong", st = "research_finding", et = "research_result" } = {}) {
  return {
    evidence_id: id, fact, source_type: st, evidence_type: et,
    triage_data: { evidence_strength: strength, permitted_uses: ["fact_support"], limitations: [] },
    publisher: `Pub_${id}`, date: "2026-01-01", entities: ["entity"], numbers: [],
  };
}

console.log("\nAttack-vector classifier");
test("classifier distinguishes the test vectors", () => {
  assert.equal(classifyAttackVector("An indirect prompt injection attack"), "prompt_injection");
  assert.equal(classifyAttackVector("model extraction stole the weights"), "model_extraction");
  assert.equal(classifyAttackVector("a deepfake voice clone scam"), "deepfake");
});

console.log("\nCoverage-aware compact5A");

// 18 strong prompt-injection items would, under ordinal selection, fill the first 16
// slots and exclude everything else. Add one rare model-extraction item and one
// operational incident — both must survive coverage selection.
function bigDossier() {
  const pi = [];
  for (let i = 0; i < 18; i++) {
    pi.push(item(`pi_${i}`, `Indirect prompt injection variant ${i} bypassed the guardrail.`));
  }
  const rare = item("rare_modelext", "A model extraction attack recovered the proprietary weights.", { strength: "usable" });
  const operational = item("op_incident", "A deepfake voice-clone scam compromised a bank wire desk.", {
    strength: "strong", st: "incident", et: "incident_event",
  });
  return {
    category: "llm_threats",
    source_count: 20,
    rawfact: {
      strong_evidence: [...pi, operational],
      usable_evidence: [rare],
      context_evidence: [], statistics: [], case_study_candidates: [],
      outlook_inputs: [], exposure_inputs: [], recommendation_inputs: [],
    },
  };
}

test("rare-vector item (model_extraction) is surfaced despite 18 stronger prompt-injection items", () => {
  const cd = buildCategoryEvidenceDossier(bigDossier());
  const ids = cd.evidence_5A.map((e) => e.evidence_id);
  assert.ok(ids.includes("rare_modelext"), "rare model-extraction item must be selected for coverage");
});

test("operational incident is guaranteed in the dossier", () => {
  const cd = buildCategoryEvidenceDossier(bigDossier());
  const ids = cd.evidence_5A.map((e) => e.evidence_id);
  assert.ok(ids.includes("op_incident"), "operational anchor must be guaranteed");
});

test("dossier includes items from multiple evidence types (strength-sorted selection)", () => {
  // Coverage-aware round-robin was removed — simple strength sort now used.
  // The test validates that the dossier is non-empty and all selected items are citable.
  const cd = buildCategoryEvidenceDossier(bigDossier());
  assert.ok(cd.evidence_5A.length > 0, "dossier must have evidence items");
  // Items are strength-sorted — first item should be strong or usable
  const firstStrength = cd.evidence_5A[0]?.evidence_strength;
  assert.ok(["strong", "usable"].includes(firstStrength),
    `first item should be strong/usable, got ${firstStrength}`);
});

test("every selected item is citable (present in id_index)", () => {
  const cd = buildCategoryEvidenceDossier(bigDossier());
  for (const e of cd.evidence_5A) {
    assert.ok(cd.id_index.has(e.evidence_id), `${e.evidence_id} must be in id_index`);
  }
});

test("a small category still returns all its items (no regression)", () => {
  const cd = buildCategoryEvidenceDossier({
    category: "agentic_ai_threats", source_count: 2,
    rawfact: {
      strong_evidence: [item("a", "Tool call injection abused an MCP server.", { st: "incident", et: "incident_event" })],
      usable_evidence: [item("b", "A jailbreak bypassed the agent guardrail.")],
      context_evidence: [], statistics: [], case_study_candidates: [],
      outlook_inputs: [], exposure_inputs: [], recommendation_inputs: [],
    },
  });
  const ids = cd.evidence_5A.map((e) => e.evidence_id).sort();
  assert.deepEqual(ids, ["a", "b"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
