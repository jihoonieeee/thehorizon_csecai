/**
 * Significance axis — materiality + uniqueness (separate from reliability).
 * Verifies the deterministic derivation in triage and its propagation to the
 * canonical packet, plus the materiality tie-break in coverage selection.
 *
 * Run with: node tests/significanceAxis.test.js
 */

import assert from "node:assert/strict";
import { triageEvidenceItem } from "../lib/pipeline/evidenceTriage/evidenceTriage.js";
import { normalizeL5AToPacket } from "../lib/pipeline/evidence/normalizeToPackets.js";
import { buildCategoryEvidenceDossier } from "../lib/pipeline/analysis/buildCategoryEvidenceDossier.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

const src = (o = {}) => ({ id: "s", url: "https://e.com/a", source_type: "research_finding", ...o });
const baseItem = (o = {}) => ({
  evidence_id: "ev1", fact: "CVE-2025-1 enables model extraction in the Acme RAG connector.",
  source_quote: "CVE-2025-1 enables model extraction in the Acme RAG connector.",
  quote_verified: true, is_atomic: true, entities: ["CVE-2025-1", "Acme"], numbers: [],
  evidence_type: "vulnerability_fact", ...o,
});

console.log("\nUniqueness derivation");

test("no cluster → sole_support", () => {
  const r = triageEvidenceItem(baseItem(), src(), {});
  assert.equal(r.uniqueness, "sole_support");
});
test("multi-source representative cluster → corroborated", () => {
  const r = triageEvidenceItem(baseItem({ evidence_cluster: { is_multi_source: true, is_representative: true } }), src(), {});
  assert.equal(r.uniqueness, "corroborated");
});
test("non-representative cluster member → duplicative", () => {
  const r = triageEvidenceItem(baseItem({ evidence_cluster: { is_multi_source: true, is_representative: false } }), src(), {});
  assert.equal(r.uniqueness, "duplicative");
});

console.log("\nMateriality derivation");

test("duplicative → redundant", () => {
  const r = triageEvidenceItem(baseItem({ evidence_cluster: { is_representative: false } }), src(), {});
  assert.equal(r.materiality, "redundant");
});
test("emerging_unmapped source → novel", () => {
  const r = triageEvidenceItem(baseItem(), src({ taxonomy_validation_status: "emerging_unmapped" }), {});
  assert.equal(r.materiality, "novel");
});
test("novelty_signal relevance_path → novel", () => {
  const r = triageEvidenceItem(baseItem(), src({ relevance_path: "novelty_signal" }), {});
  assert.equal(r.materiality, "novel");
});
test("capability_delta → escalating", () => {
  const r = triageEvidenceItem(baseItem({ evidence_type: "capability_delta" }), src(), {});
  assert.equal(r.materiality, "escalating");
});
test("routine vulnerability fact → confirming", () => {
  const r = triageEvidenceItem(baseItem(), src(), {});
  assert.equal(r.materiality, "confirming");
});

console.log("\nCanonical packet propagation");

test("packet.claim_relevance carries materiality + uniqueness", () => {
  const item = {
    evidence_id: "ev_x", fact: "Model extraction recovered weights.", source_quote: "Model extraction recovered weights.",
    entities: ["x"], evidence_type: "capability_delta",
    triage_data: { admissibility: "passed", evidence_strength: "usable", permitted_uses: ["fact_support"], limitations: [], materiality: "escalating", uniqueness: "sole_support" },
  };
  const p = normalizeL5AToPacket(item, { id: "s", source_type: "research_finding", url: "https://e.com" });
  assert.equal(p.claim_relevance.materiality, "escalating");
  assert.equal(p.claim_relevance.uniqueness, "sole_support");
});

console.log("\nMateriality tie-break in coverage selection");

test("at equal strength, a novel item outranks a confirming item in the same vector", () => {
  const mk = (id, materiality) => ({
    evidence_id: id, fact: "An indirect prompt injection bypassed the guardrail.", source_type: "research_finding",
    evidence_type: "research_result",
    triage_data: { evidence_strength: "usable", permitted_uses: ["fact_support"], limitations: [], materiality },
    publisher: id, date: "2026-01-01", entities: ["x"], numbers: [],
  });
  // Same vector + same strength; only materiality differs. The novel one must sort first.
  const cd = buildCategoryEvidenceDossier({
    category: "llm_threats", source_count: 2,
    rawfact: {
      strong_evidence: [], usable_evidence: [mk("confirming_one", "confirming"), mk("novel_one", "novel")],
      context_evidence: [], statistics: [], case_study_candidates: [], outlook_inputs: [], exposure_inputs: [], recommendation_inputs: [],
    },
  });
  const order = cd.evidence_5A.map((e) => e.evidence_id);
  assert.ok(order.indexOf("novel_one") < order.indexOf("confirming_one"),
    `novel should precede confirming; got ${order.join(", ")}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
