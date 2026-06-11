/**
 * Branch-typed packet redesign — verifies the canonical EvidencePacket is now a
 * single, complete, branch-discriminated model that carries the full quality axis
 * (source_quality / independence / grounding / method), with branch-specific
 * invariants enforced by validatePacket.
 *
 * Run with: node tests/branchTypedPackets.test.js
 */

import assert from "node:assert/strict";
import {
  makeEvidencePacket, makeAnalyticsEvidencePacket, validatePacket, BRANCH_TYPES,
} from "../lib/schemas/evidencePacketSchema.js";
import {
  normalizeL5AToPacket, normalizeL5CToPacket, normalizeL5BToPacket,
} from "../lib/pipeline/evidence/normalizeToPackets.js";
import { EvidencePacketRegistry } from "../lib/pipeline/evidence/evidencePacketRegistry.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

console.log("\nBranch discriminant");

test("BRANCH_TYPES has the three branches", () => {
  assert.ok(BRANCH_TYPES.has("rawfact") && BRANCH_TYPES.has("analytics") && BRANCH_TYPES.has("web_enrichment"));
});

test("rawfact packet defaults branch_type=rawfact and carries the quality groups", () => {
  const p = makeEvidencePacket({});
  assert.equal(p.branch_type, "rawfact");
  assert.ok(p.source_quality && p.independence && p.grounding && p.method, "quality groups must exist");
});

test("analytics packet is branch_type=analytics", () => {
  const p = makeAnalyticsEvidencePacket({ provenance: { input_evidence_ids: ["x"], computation_method: "count", aggregation_logic: "x" } });
  assert.equal(p.branch_type, "analytics");
});

console.log("\nL5A quality axis propagation");

test("L5A packet carries source_quality / independence / grounding / method from item+source", () => {
  const item = {
    evidence_id: "ev1", fact: "Acme breached.", source_quote: "Acme breached.", entities: ["Acme"],
    evidence_type: "incident_event",
    quote_verification: { quote_exists: true, quote_entailment: "supported", claim_preservation: "preserved" },
    method_quality: "clear_method", statistical_use: "chart_allowed",
    origin_role: "primary_origin", independence_level: "independent", primary_origin_url: "https://orig",
    triage_data: { admissibility: "passed", evidence_strength: "strong", permitted_uses: ["fact_support"], limitations: [], observed_use: true },
  };
  const source = {
    id: "s1", source_type: "incident", url: "https://r.com/a", publisher: "Reuters", main_category: "ai_enabled_threats",
    source_quality_status: "usable", source_quality_reasons: ["incident_report"],
  };
  const p = normalizeL5AToPacket(item, source);
  assert.equal(p.branch_type, "rawfact");
  assert.equal(p.source_quality.status, "usable");
  assert.deepEqual(p.source_quality.reasons, ["incident_report"]);
  assert.equal(p.independence.origin_role, "primary_origin");
  assert.equal(p.independence.independence_level, "independent");
  assert.equal(p.independence.primary_origin_url, "https://orig");
  assert.equal(p.grounding.quote_verification, "exists");
  assert.equal(p.grounding.quote_entailment, "supported");
  assert.equal(p.grounding.claim_preservation, "preserved");
  assert.equal(p.grounding.observed_use, true);
  assert.equal(p.method.method_quality, "clear_method");
  assert.equal(p.method.statistical_use, "chart_allowed");
  assert.deepEqual(validatePacket(p), [], "a fully-grounded passed packet must validate clean");
});

console.log("\nL5C is web_enrichment, never operational");

test("L5C packet is branch_type=web_enrichment + enrichment=true + class external", () => {
  const p = normalizeL5CToPacket({
    external_evidence_id: "ext1", source_quality: "authoritative", confidence: "high",
    finding: "Gov stat.", url: "https://cisa.gov/x", publisher: "CISA",
    source_quote: "Forty percent of organizations reported AI-generated phishing attempts.",
  });
  assert.equal(p.branch_type, "web_enrichment");
  assert.equal(p.enrichment, true);
  assert.equal(p.evidence_class, "external");
  assert.deepEqual(validatePacket(p), [], "valid web_enrichment packet (has url, not operational)");
});

console.log("\nBranch-specific invariants");

test("web_enrichment without url is flagged invalid", () => {
  const p = makeEvidencePacket({ branch_type: "web_enrichment", evidence_type: "external_report_finding", evidence_class: "external", content: { summary: "x" }, claim_relevance: { admissibility: "context_only", evidence_strength: "context" } });
  const errs = validatePacket(p);
  assert.ok(errs.some((e) => /web_enrichment packet must have provenance.url/.test(e)), errs.join("; "));
});

test("web_enrichment labeled operational is flagged invalid", () => {
  const p = makeEvidencePacket({ branch_type: "web_enrichment", evidence_type: "external_report_finding", evidence_class: "operational", content: { summary: "x" }, provenance: { url: "https://x", extraction_layer: "L5C" }, claim_relevance: { admissibility: "context_only", evidence_strength: "context" } });
  const errs = validatePacket(p);
  assert.ok(errs.some((e) => /must not be evidence_class operational/.test(e)));
});

test("passed claim-supporting packet with unsupported quote_entailment is flagged", () => {
  const p = makeEvidencePacket({
    branch_type: "rawfact", source_id: "s", evidence_type: "incident_report", evidence_class: "operational",
    content: { summary: "x", normalized_fact: "x" }, provenance: { url: "https://x" },
    claim_relevance: { admissibility: "passed", evidence_strength: "strong", permitted_uses: ["fact_support"] },
    grounding: { quote_entailment: "unsupported" },
  });
  const errs = validatePacket(p);
  assert.ok(errs.some((e) => /quote_entailment=unsupported/.test(e)), errs.join("; "));
});

console.log("\nRegistry indexes by branch");

test("registry summary reports by_branch and getByBranch resolves", () => {
  const reg = new EvidencePacketRegistry();
  const a = normalizeL5AToPacket(
    { evidence_id: "a", fact: "x breached y.", source_quote: "x breached y.", entities: ["x"], evidence_type: "incident_event",
      triage_data: { admissibility: "passed", evidence_strength: "strong", permitted_uses: ["fact_support"], limitations: [] } },
    { id: "s", source_type: "incident", url: "https://r.com", main_category: "llm_threats" }
  );
  const b = normalizeL5BToPacket({ analytics_evidence_id: "metric_b", metric_type: "frequency_distribution", finding: "f", confidence: "high", source_ids: ["a", "z"], domain: "llm_threats" });
  reg.register([a, b]);
  const s = reg.summary();
  assert.equal(s.by_branch.rawfact, 1);
  assert.equal(s.by_branch.analytics, 1);
  assert.equal(reg.getByBranch("analytics").length, 1);
  assert.equal(reg.getByBranch("rawfact").length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
