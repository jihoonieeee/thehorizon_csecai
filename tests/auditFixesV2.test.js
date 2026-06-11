/**
 * Audit-fix regression tests (round 2) — locks in the fixes implemented from the
 * three deep audits:
 *   - evidence-type vocabulary reconciliation (incident_event/exploit_chain etc.)
 *   - canonical packet permitted-use unification (canSupportClaim works for L5A)
 *   - claim-scoped claimQa (trend gate measures the CLAIM's own evidence)
 *   - no-judgment admissibility (un-judged generic fact → context_only)
 *   - analytics packet honours computed confidence (no hardcoded passed/usable)
 *   - corpus_audit delivered into the synthesis prompt
 *
 * Run with: node tests/auditFixesV2.test.js
 */

import assert from "node:assert/strict";

import {
  CASE_STUDY_TYPES, isCaseStudyType, caseStudyTypeRank, DIAGRAM_TYPES,
} from "../lib/config/evidenceTypeVocabulary.js";
import { gateCaseStudyCandidates } from "../lib/pipeline/slides/selectSlideArgumentForm.js";
import {
  normalizeL5AToPacket, normalizeL5BToPacket,
} from "../lib/pipeline/evidence/normalizeToPackets.js";
import { canSupportClaim } from "../lib/schemas/evidencePacketSchema.js";
import { qaAnalyticalClaim, qaAllClaims } from "../lib/pipeline/analysis/claimQa.js";
import { triageEvidenceItem } from "../lib/pipeline/evidenceTriage/evidenceTriage.js";
import { buildCorpusAuditBlock } from "../lib/pipeline/analysis/synthesizeCategory.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

// ── 1. Evidence-type vocabulary ───────────────────────────────────────────────
console.log("\nEvidence-type vocabulary reconciliation");

test("incident_event and exploit_chain are case-study types", () => {
  assert.ok(isCaseStudyType("incident_event"), "incident_event must be a case-study type");
  assert.ok(isCaseStudyType("exploit_chain"), "exploit_chain must be a case-study type");
  assert.ok(CASE_STUDY_TYPES.has("threat_actor_activity"));
});

test("incident outranks capability in case-study rank", () => {
  assert.ok(caseStudyTypeRank("incident_event") > caseStudyTypeRank("capability_delta"));
  assert.ok(caseStudyTypeRank("incident_event") > caseStudyTypeRank("exploit_chain"));
});

test("DIAGRAM_TYPES recognises exploit_chain and incident_event", () => {
  assert.ok(DIAGRAM_TYPES.has("exploit_chain"));
  assert.ok(DIAGRAM_TYPES.has("incident_event"));
  assert.ok(DIAGRAM_TYPES.has("attack_method"));
});

test("gateCaseStudyCandidates accepts a real incident_event case study", () => {
  const claim = { claim_id: "claim_1", claim_priority: "critical", supporting_evidence_ids: ["ev_a"] };
  const cs = {
    evidence_id: "ev_a", claim_id: "claim_1", evidence_type: "incident_event",
    entities: ["ACME Corp", "ransomware group"], confidence: "high",
    fact: "Ransomware group breached ACME Corp via an AI-generated phishing campaign.",
  };
  const pool = gateCaseStudyCandidates([cs], [claim]);
  assert.equal(pool.length, 1, "incident_event case study must pass the gate (was excluded by vocabulary drift)");
});

// ── 2. Canonical packet: type preservation + claim-support ────────────────────
console.log("\nCanonical packet vocabulary");

function l5aItem(overrides = {}) {
  return {
    evidence_id: "ev_x_1", source_id: "src_x", evidence_type: "incident_event",
    fact: "Attackers compromised three banks using model-extraction.",
    source_quote: "Attackers compromised three banks using model-extraction.",
    entities: ["three banks"], numbers: ["3"],
    triage_data: {
      admissibility: "passed", evidence_strength: "strong",
      permitted_uses: ["fact_support", "case_study", "trend_input"], limitations: [],
    },
    ...overrides,
  };
}
const l5aSource = { id: "src_x", source_type: "incident", title: "T", publisher: "Reuters", url: "https://r.com/a", main_category: "ai_enabled_threats" };

test("incident_event no longer collapses to background_context in the canonical packet", () => {
  const p = normalizeL5AToPacket(l5aItem(), l5aSource);
  assert.equal(p.evidence_type, "incident_report", `expected incident_report, got ${p.evidence_type}`);
});

test("attack_method / threat_actor_activity / research_result map to real types", () => {
  assert.equal(normalizeL5AToPacket(l5aItem({ evidence_type: "attack_method" }), l5aSource).evidence_type, "attack_method");
  assert.equal(normalizeL5AToPacket(l5aItem({ evidence_type: "threat_actor_activity" }), l5aSource).evidence_type, "threat_actor_activity");
  assert.equal(normalizeL5AToPacket(l5aItem({ evidence_type: "research_result" }), l5aSource).evidence_type, "research_finding");
  assert.equal(normalizeL5AToPacket(l5aItem({ evidence_type: "governance_action" }), l5aSource).evidence_type, "policy_or_governance");
});

test("canSupportClaim is TRUE for a passed L5A fact_support packet (was structurally false)", () => {
  const p = normalizeL5AToPacket(l5aItem(), l5aSource);
  assert.ok(p.claim_relevance.permitted_uses.includes("fact_support"), "fact_support must be preserved, not dropped");
  assert.ok(canSupportClaim(p), "a passed, usable/strong, fact_support packet must be able to support a claim");
});

test("context_only packet strips claim-supporting uses", () => {
  const p = normalizeL5AToPacket(
    l5aItem({ triage_data: { admissibility: "context_only", evidence_strength: "context", permitted_uses: ["fact_support"], limitations: [] } }),
    l5aSource
  );
  assert.ok(!canSupportClaim(p), "context_only packet must not support a claim");
  assert.ok(!p.claim_relevance.permitted_uses.some((u) => ["fact_support", "claim_support"].includes(u)));
});

// ── 3. Analytics packet honours confidence ────────────────────────────────────
console.log("\nAnalytics packet confidence");

test("low-confidence analytics packet is context_only/archive, not passed/usable", () => {
  const p = normalizeL5BToPacket({
    analytics_evidence_id: "metric_1", metric_type: "coverage_gap",
    finding: "Only 2 sources mention prompt injection.", confidence: "low",
    supports_claim_types: ["evidence_gap"], source_ids: ["raw_1", "raw_2"],
  });
  assert.equal(p.claim_relevance.admissibility, "context_only", "low-confidence analytics must be context_only");
  assert.notEqual(p.claim_relevance.evidence_strength, "usable");
});

test("high-confidence analytics is usable but never strong", () => {
  const p = normalizeL5BToPacket({
    analytics_evidence_id: "metric_2", metric_type: "frequency_distribution",
    finding: "Prompt injection in 8/12 LLM sources.", confidence: "high",
    supports_claim_types: ["frequency_claim"], source_ids: ["raw_1", "raw_2", "raw_3"],
  });
  assert.equal(p.claim_relevance.admissibility, "passed");
  assert.equal(p.claim_relevance.evidence_strength, "usable");
});

test("analytics packet carries chart-safety metadata (denominator, population, caveat, prevalence flag)", () => {
  const p = normalizeL5BToPacket({
    analytics_evidence_id: "metric_3", metric_type: "frequency_distribution",
    finding: "Prompt injection in 8/12 LLM sources.", confidence: "high",
    supports_claim_types: ["frequency_claim"], source_ids: ["raw_1", "raw_2", "raw_3", "raw_4"],
  });
  const am = p.analytics_meta;
  assert.ok(am, "analytics_meta must exist");
  assert.equal(am.prevalence_interpretation_allowed, false, "corpus counts cannot claim prevalence");
  assert.equal(am.publication_vs_threat_activity, "publication_activity");
  assert.equal(am.source_population, 4);
  assert.equal(am.denominator, 4, "a count metric's denominator is its population");
  assert.ok(am.metric_definition.length > 0);
  assert.ok(am.chart_caveat.length > 0);
  assert.equal(am.chart_allowed, true);
});

test("low-confidence analytics is not chart_allowed", () => {
  const p = normalizeL5BToPacket({
    analytics_evidence_id: "metric_4", metric_type: "coverage_gap",
    finding: "thin", confidence: "low", source_ids: ["raw_1"],
  });
  assert.equal(p.analytics_meta.chart_allowed, false);
});

// ── 4. No-judgment admissibility ──────────────────────────────────────────────
console.log("\nNo-judgment admissibility");

const traceableSource = { id: "s", url: "https://e.com/a", source_type: "research_finding" };

test("un-judged generic fact with no entities/numbers → context_only, not passed", () => {
  const item = {
    evidence_id: "ev_g", fact: "Prompt injection remains a broad area of ongoing security research interest.",
    source_quote: "Prompt injection remains a broad area of ongoing security research interest.",
    quote_verified: true, is_atomic: true, entities: [], numbers: [], evidence_type: "research_result",
  };
  const r = triageEvidenceItem(item, traceableSource, {}); // no LLM judgment
  assert.equal(r.admissibility, "context_only", `expected context_only, got ${r.admissibility}`);
});

test("un-judged concrete fact (entity + demonstrable type) still passes", () => {
  const item = {
    evidence_id: "ev_c", fact: "CVE-2025-1234 allows prompt injection in the Acme RAG connector.",
    source_quote: "CVE-2025-1234 allows prompt injection in the Acme RAG connector.",
    quote_verified: true, is_atomic: true, entities: ["CVE-2025-1234", "Acme"], numbers: [],
    evidence_type: "vulnerability_fact",
  };
  const r = triageEvidenceItem(item, { id: "s", url: "https://e.com/a", source_type: "vulnerability" }, {});
  assert.equal(r.admissibility, "passed");
});

// ── 5. Claim-scoped claimQa ───────────────────────────────────────────────────
console.log("\nClaim-scoped claimQa");

function pkt(id, { month, pub, origin } = {}) {
  return {
    evidence_id: id, evidence_type: "incident", source_type: "incident",
    triage_data: { evidence_strength: "usable", admissibility: "passed", permitted_uses: ["fact_support", "trend_input"], limitations: [] },
    date_published: `2026-${month || "01"}-15`, publisher: pub || "Pub", primary_origin_url: origin || null,
    entities: ["actor"],
  };
}

test("trend claim with only 1 supporting item is overgeneralized (claim-scoped)", () => {
  const claim = { claim_type: "trend_claim", claim_text: "Prompt injection is increasingly used.", supporting_evidence_ids: ["e1"] };
  const own = [pkt("e1", { month: "01", pub: "A" })]; // only 1 item
  const r = qaAnalyticalClaim(claim, own, { analysis_allowed: "full" });
  assert.equal(r.claim_support_status, "overgeneralized");
  assert.equal(r.allowed_to_proceed, false);
});

test("trend claim with 3 items / 2 origins / 2 months is supported", () => {
  const claim = { claim_type: "trend_claim", claim_text: "Prompt injection is increasingly used.", supporting_evidence_ids: ["e1", "e2", "e3"] };
  const own = [
    pkt("e1", { month: "01", pub: "A" }),
    pkt("e2", { month: "02", pub: "B" }),
    pkt("e3", { month: "03", pub: "C" }),
  ];
  const r = qaAnalyticalClaim(claim, own, { analysis_allowed: "full" });
  assert.equal(r.claim_support_status, "supported");
});

test("qaAllClaims with per-claim resolver blocks a single-source trend even when the category pool is large", () => {
  const claims = [{ claim_id: "c1", claim_type: "trend_claim", claim_text: "X is rising.", supporting_evidence_ids: ["e1"] }];
  // Resolver returns ONLY the claim's own evidence (1 item) — the category may have many more.
  const resolver = (c) => (c.claim_id === "c1" ? [pkt("e1", { month: "01", pub: "A" })] : []);
  const { passing, blocked } = qaAllClaims(claims, resolver, { analysis_allowed: "full" });
  assert.equal(passing.length, 0, "single-source trend must be blocked");
  assert.equal(blocked.length, 1);
});

// ── 6. Corpus audit delivered to the synthesis prompt ─────────────────────────
console.log("\nCorpus audit in synthesis prompt");

test("buildCorpusAuditBlock renders vendor_heavy / research_heavy constraints", () => {
  const block = buildCorpusAuditBlock({
    analysis_allowed: "limited",
    source_concentration_flags: ["vendor_heavy"],
    evidence_gap_flags: ["research_heavy", "operational_evidence_sparse"],
    analysis_limitations: ["Vendor-heavy corpus — commercial bias may affect claims"],
  });
  assert.ok(/CORPUS REPRESENTATIVENESS/.test(block));
  assert.ok(/vendor-bias caveat/i.test(block), "must instruct vendor caveat");
  assert.ok(/CAPABILITY, not real-world adoption/i.test(block), "research_heavy must block adoption");
  assert.ok(/do NOT assert real-world incidents/i.test(block), "operational_evidence_sparse constraint");
});

test("buildCorpusAuditBlock is empty when no audit provided", () => {
  assert.equal(buildCorpusAuditBlock(null), "");
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
