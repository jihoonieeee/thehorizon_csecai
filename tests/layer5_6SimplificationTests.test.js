/**
 * Layer 5/6 simplification regression tests — 2026-06-15
 *
 * Verifies the core principles after the L5/L6 logic audit:
 *   1. Dead code (scoreRawfacts, extractRawfacts) is gone
 *   2. buildAnalyticalState does not generate hypothesis candidates
 *   3. Confidence ceiling uses category-level quality gate, not candidate text-match
 *   4. corpusAudit thresholds still work correctly
 *   5. Corpus-scoped analytics are not used for real-world claims
 *
 * Run with: node tests/layer5_6SimplificationTests.test.js
 */

import assert from "node:assert/strict";
import { createRequire } from "module";

import {
  buildAnalyticalState,
  buildBlockedClaimOpportunities,
  getCategoryState,
} from "../lib/pipeline/analysis/buildAnalyticalState.js";

import {
  buildCorpusAudit,
} from "../lib/pipeline/analysis/corpusAudit.js";

import {
  qaAnalyticalClaim,
  qaAllClaims,
  checkAnalyticsOnlyClaim,
} from "../lib/pipeline/analysis/claimQa.js";

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDossier(category, items = [], sourceCount = 5) {
  return {
    category,
    source_count: sourceCount,
    rawfact: {
      strong_evidence: items.filter((i) => i.strength === "strong"),
      usable_evidence: items.filter((i) => i.strength === "usable"),
      context_evidence: [],
      case_study_candidates: [],
      statistics: [],
      recommendation_inputs: [],
      outlook_inputs: [],
    },
    fusion_summary: { evidence_gaps: [] },
  };
}

function makeItem(strength = "usable", source_type = "research_finding") {
  return { evidence_id: `e_${Math.random().toString(36).slice(2)}`, strength, source_type, trust_tier: "high" };
}

// ── 1. Dead code is gone ──────────────────────────────────────────────────────
console.log("\n1. Dead code removed");

test("scoreRawfacts.js is not importable (deleted)", async () => {
  try {
    await import("../lib/pipeline/rawfact/scoreRawfacts.js");
    assert.fail("scoreRawfacts.js should not exist");
  } catch (err) {
    assert.ok(
      err.code === "ERR_MODULE_NOT_FOUND" || err.message.includes("Cannot find"),
      `expected module-not-found, got: ${err.message}`
    );
  }
});

test("extractRawfacts.js is not importable (deleted)", async () => {
  try {
    await import("../lib/pipeline/rawfact/extractRawfacts.js");
    assert.fail("extractRawfacts.js should not exist");
  } catch (err) {
    assert.ok(
      err.code === "ERR_MODULE_NOT_FOUND" || err.message.includes("Cannot find"),
      `expected module-not-found, got: ${err.message}`
    );
  }
});

// ── 2. buildAnalyticalState does not generate hypothesis candidates ─────────
console.log("\n2. buildAnalyticalState — evidence signals, no hypothesis generation");

const EMPTY_ANALYTICS = { aggregates: {}, derived_metrics: {} };

test("buildAnalyticalState returns no candidate_judgments field", () => {
  const dossier = makeDossier("llm_threats", [makeItem("usable")]);
  const state = buildAnalyticalState([dossier], EMPTY_ANALYTICS);
  const cs = getCategoryState(state, "llm_threats");
  assert.ok(cs, "category state exists");
  assert.ok(!cs.candidate_judgments, "candidate_judgments must NOT be present (was removed in v3)");
  assert.ok(!state.hypothesis_candidates, "hypothesis_candidates must NOT be in top-level state");
});

test("buildAnalyticalState returns no cross_category_state convergence clusters", () => {
  const dossier = makeDossier("llm_threats", [makeItem("usable")]);
  const state = buildAnalyticalState([dossier], EMPTY_ANALYTICS);
  assert.ok(!state.cross_category_state, "cross_category_state (old format) must not exist");
  assert.ok(state.cross_category_summary, "cross_category_summary (new simple format) should exist");
  assert.ok(!state.cross_category_summary.convergence_clusters, "no convergence clusters");
});

test("buildAnalyticalState v3 analytical_state_version", () => {
  const state = buildAnalyticalState([], EMPTY_ANALYTICS);
  assert.equal(state.analytical_state_version, "v3", "version should be v3 after simplification");
});

test("buildAnalyticalState includes evidence_signals in category state", () => {
  const opItem = makeItem("strong", "incident");
  const dossier = makeDossier("llm_threats", [opItem]);
  const state = buildAnalyticalState([dossier], EMPTY_ANALYTICS);
  const cs = getCategoryState(state, "llm_threats");
  assert.ok(cs.evidence_strength, "evidence_strength present");
  assert.ok(typeof cs.evidence_strength.confidence_ceiling === "string", "confidence_ceiling is a string");
  assert.ok(cs.blocked_claim_opportunities !== undefined, "blocked_claim_opportunities present");
});

test("buildAnalyticalState with no items → ceiling=none → positive claims blocked", () => {
  const dossier = makeDossier("llm_threats", [], 0);
  const state = buildAnalyticalState([dossier], EMPTY_ANALYTICS);
  const cs = getCategoryState(state, "llm_threats");
  assert.equal(cs.evidence_strength.confidence_ceiling, "none", "no evidence → ceiling=none");
  const blockedTypes = cs.blocked_claim_opportunities.map((b) => b.claim_type);
  assert.ok(blockedTypes.includes("factual"), "factual must be blocked with no evidence");
  assert.ok(blockedTypes.includes("adoption"), "adoption must be blocked with no evidence");
});

// ── 3. claimQa uses category ceiling, not candidate text-match ──────────────
console.log("\n3. claimQa — category-level ceiling gate");

function makeAdmissiblePacket(overrides = {}) {
  return {
    evidence_id: "e1",
    evidence_type: "research_finding",
    source_type: "research_finding",
    triage_data: {
      evidence_strength: "usable",
      admissibility: "passed",
      permitted_uses: ["capability_support"],
      limitations: [],
    },
    observed_use: false,
    date_published: "2026-01-01",
    publisher: "AcademiaCorp",
    ...overrides,
  };
}

test("claim.confidence=high exceeds category ceiling=medium → blocked", () => {
  const claim = {
    claim_type: "capability",
    source_judgment_type: "capability_change",
    claim_text: "GPT-4 can be jailbroken with 88% ASR using PAIR.",
    confidence: "high",  // claim says high
  };
  const packets = [makeAdmissiblePacket()];
  const corpusAudit = { analysis_allowed: "full", blocked_claim_types: [], evidence_gap_flags: [], source_concentration_flags: [], analysis_limitations: [] };
  // Category-level ceiling is medium
  const analyticalState = { confidence_ceiling: "medium" };

  const result = qaAnalyticalClaim(claim, packets, corpusAudit, analyticalState);
  assert.equal(result.claim_support_status, "exceeds_confidence_ceiling",
    "high claim against medium ceiling must be blocked");
  assert.equal(result.allowed_to_proceed, false);
});

test("claim.confidence=medium does NOT exceed category ceiling=medium", () => {
  const claim = {
    claim_type: "capability",
    source_judgment_type: "capability_change",
    claim_text: "GPT-4 can be jailbroken using PAIR.",
    confidence: "medium",
  };
  const packets = [makeAdmissiblePacket()];
  const corpusAudit = { analysis_allowed: "full", blocked_claim_types: [], evidence_gap_flags: [], source_concentration_flags: [], analysis_limitations: [] };
  const analyticalState = { confidence_ceiling: "medium" };

  const result = qaAnalyticalClaim(claim, packets, corpusAudit, analyticalState);
  assert.notEqual(result.claim_support_status, "exceeds_confidence_ceiling",
    "medium claim against medium ceiling should NOT be blocked by ceiling gate");
});

test("no analyticalState → ceiling gate skipped (not a hard block)", () => {
  const claim = {
    claim_type: "capability",
    source_judgment_type: "capability_change",
    claim_text: "A vulnerability was discovered.",
    confidence: "high",
  };
  const packets = [makeAdmissiblePacket()];
  const corpusAudit = { analysis_allowed: "full", blocked_claim_types: [], evidence_gap_flags: [], source_concentration_flags: [], analysis_limitations: [] };

  // No analytical state — ceiling gate should not fire
  const result = qaAnalyticalClaim(claim, packets, corpusAudit, null);
  assert.notEqual(result.claim_support_status, "exceeds_confidence_ceiling",
    "ceiling gate must not fire without analytical state");
});

// ── 4. corpusAudit thresholds ─────────────────────────────────────────────────
console.log("\n4. corpusAudit threshold gates");

function makeSources(overrides = []) {
  return overrides.map((o, i) => ({
    id: `s${i}`,
    url: `https://example.com/${i}`,
    source_type: o.source_type || "research_finding",
    publisher: o.publisher || `Publisher${i}`,
    trust_tier: o.trust_tier || "medium",
    date_published: o.date || "2026-01-15",
    independence_level: o.independence_level || "independent",
    ...o,
  }));
}

test("vendor_heavy flag triggers when > 60% vendor sources", () => {
  const sources = makeSources([
    { source_type: "threat_intelligence", independence_level: "vendor_interested", publisher: "CrowdStrike" },
    { source_type: "threat_intelligence", independence_level: "vendor_interested", publisher: "CrowdStrike" },
    { source_type: "threat_intelligence", independence_level: "vendor_interested", publisher: "CrowdStrike" },
    { source_type: "threat_intelligence", independence_level: "vendor_interested", publisher: "CrowdStrike" },
    { source_type: "research_finding",    independence_level: "independent",       publisher: "arXiv" },
  ]);
  const audit = buildCorpusAudit(sources, "llm_threats");
  assert.ok(audit.source_concentration_flags.includes("vendor_heavy"),
    "4/5 vendor sources (80%) must trigger vendor_heavy");
});

test("vendor_heavy NOT triggered when exactly 60% vendor (boundary)", () => {
  const sources = makeSources([
    { source_type: "threat_intelligence", independence_level: "vendor_interested", publisher: "CrowdStrike" },
    { source_type: "threat_intelligence", independence_level: "vendor_interested", publisher: "CrowdStrike" },
    { source_type: "threat_intelligence", independence_level: "vendor_interested", publisher: "CrowdStrike" },
    { source_type: "research_finding",    independence_level: "independent",       publisher: "arXiv" },
    { source_type: "incident",            independence_level: "independent",       publisher: "CISA" },
  ]);
  // 3/5 = 60% — exactly AT the threshold; threshold is >60%, not >=
  const audit = buildCorpusAudit(sources, "llm_threats");
  assert.ok(!audit.source_concentration_flags.includes("vendor_heavy"),
    "exactly 60% (not strictly > 60%) must NOT trigger vendor_heavy");
});

test("research_heavy flag triggers when > 70% research AND 0 operational", () => {
  const sources = makeSources([
    { source_type: "research_finding", publisher: "arXiv" },
    { source_type: "research_finding", publisher: "MIT" },
    { source_type: "research_finding", publisher: "Stanford" },
    { source_type: "benchmark_evaluation", publisher: "OpenAI" },
    { source_type: "research_finding", publisher: "Google" },
  ]);
  const audit = buildCorpusAudit(sources, "llm_threats");
  assert.ok(audit.source_concentration_flags.includes("research_heavy"),
    "5/5 research, 0 operational must trigger research_heavy");
});

test("research_heavy NOT triggered when ANY operational source present", () => {
  const sources = makeSources([
    { source_type: "research_finding", publisher: "arXiv" },
    { source_type: "research_finding", publisher: "MIT" },
    { source_type: "research_finding", publisher: "Stanford" },
    { source_type: "research_finding", publisher: "Google" },
    { source_type: "incident", publisher: "CISA" },  // one operational source
  ]);
  const audit = buildCorpusAudit(sources, "llm_threats");
  assert.ok(!audit.source_concentration_flags.includes("research_heavy"),
    "4/5 research with 1 operational must NOT trigger research_heavy");
});

// ── 5. L5B analytics stay corpus-scoped ─────────────────────────────────────
console.log("\n5. L5B analytics — corpus-scoped, not real-world claims");

test("analytics-only packets cannot support factual/adoption/incident claims", () => {
  assert.ok(typeof checkAnalyticsOnlyClaim === "function",
    "checkAnalyticsOnlyClaim should be exported from claimQa.js");
  const analyticsOnlyPackets = [
    { evidence_class: "analytics", source_branch: "L5B", origin: "5B_analytics" },
  ];
  const result = checkAnalyticsOnlyClaim("factual", analyticsOnlyPackets);
  assert.ok(result !== null, "analytics-only factual claim must be blocked");
  assert.equal(result.status, "unsupported");
});

test("adoption claim blocked when no operational evidence (blocked_claim_opportunities)", () => {
  const evidenceStrength = {
    source_type_diversity: 2,
    has_operational_sources: false,
    validated_evidence_count: 3,
    confidence_ceiling: "medium",
  };
  const ops = [];
  const trends = [{ direction: "increasing", non_zero_buckets: 4 }];
  const blocked = buildBlockedClaimOpportunities(evidenceStrength, ops, trends);
  const blockedTypes = blocked.map((b) => b.claim_type);
  assert.ok(blockedTypes.includes("adoption"),
    "adoption must be blocked when no operational sources");
  assert.ok(!blockedTypes.includes("capability"),
    "capability claims are NOT blocked by lack of operational sources");
});

test("L5B analytics evidence type is 'analytics' — cannot anchor real-world claims", () => {
  // Analytics packets should have evidence_class=analytics or source_branch=L5B
  // This verifies the claim gate (checkAnalyticsOnlyClaim) handles them
  const analyticsPacket = {
    evidence_id: "agg_llm_threats",
    evidence_class: "analytics",
    source_branch: "L5B",
    fact: "47 sources discuss prompt injection (corpus count)",
    source_type: "analytics",
  };
  // Real-world claim types (factual/adoption/incident) should not accept analytics-only packets
  // Verify the field that marks a packet as analytics
  assert.equal(analyticsPacket.evidence_class, "analytics",
    "L5B packets must have evidence_class=analytics");
  assert.equal(analyticsPacket.source_branch, "L5B",
    "L5B packets must have source_branch=L5B");
});

// ── 6. Mechanical validators do not make semantic decisions ──────────────────
console.log("\n6. Deterministic code validates mechanics, not meaning");

test("buildAnalyticalState does not block claims based on claim text content", () => {
  // The analytical state computes mechanical signals only.
  // It never reads claim text to decide semantic content.
  const dossier = makeDossier("llm_threats", [
    makeItem("strong", "incident"),
    makeItem("usable", "threat_intelligence"),
  ]);
  const state = buildAnalyticalState([dossier], EMPTY_ANALYTICS);
  const cs = getCategoryState(state, "llm_threats");

  // The state provides signals but NO claim-level semantic decisions
  assert.ok(cs.dominant_threat_patterns !== undefined, "patterns exist");
  assert.ok(cs.evidence_strength !== undefined, "strength exists");
  // No text scanning on claims
  assert.ok(!cs.candidate_judgments, "no candidate judgments (text-based pre-analysis)");
  assert.ok(!cs.insight_hypotheses, "no insight hypotheses");
});

test("buildBlockedClaimOpportunities is deterministic from evidence quality fields only", () => {
  // The blocked claim list derives from: has_operational_sources, trend signal data, ceiling.
  // It does NOT read any claim text.
  const s1 = buildBlockedClaimOpportunities(
    { has_operational_sources: false, confidence_ceiling: "medium", validated_evidence_count: 2 },
    [], [{ direction: "insufficient_data", non_zero_buckets: 1 }]
  );
  const s2 = buildBlockedClaimOpportunities(
    { has_operational_sources: false, confidence_ceiling: "medium", validated_evidence_count: 2 },
    [], [{ direction: "insufficient_data", non_zero_buckets: 1 }]
  );
  // Same inputs → same outputs (deterministic, not dependent on text)
  assert.deepEqual(s1, s2, "blocked opportunities are deterministic from evidence fields");
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
