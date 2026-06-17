/**
 * L6.2 Claim Support Gate tests
 *
 * Covers: buildCorpusAudit (blocked_claim_types), qaAnalyticalClaim,
 * qaAllClaims — new status values, ceiling enforcement, secondary attributes.
 *
 * Run with: node tests/analysis/l6-claim-gate.test.js
 */

import assert from "node:assert/strict";
import { buildCorpusAudit } from "../../lib/pipeline/analysis/corpusAudit.js";
import {
  qaAnalyticalClaim,
  qaAllClaims,
  normalizeClaimType,
  detectSecondaryAttributes,
} from "../../lib/pipeline/analysis/claimQa.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  ✗ ${name}\n    ${err.message}\n`);
    failed++;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeSource(overrides = {}) {
  return {
    id: "src_test",
    url: "https://example.com/article",
    trust_tier: "high",
    source_type: "research_finding",
    publisher: "Test University",
    date_published: new Date(Date.now() - 14 * 86_400_000).toISOString(),
    origin_role: "primary_origin",
    independence_level: "independent",
    ...overrides,
  };
}

function makeVendorSource(overrides = {}) {
  return makeSource({
    source_type: "threat_intelligence",
    publisher: "CrowdStrike",
    trust_tier: "medium",
    independence_level: "vendor_interested",
    ...overrides,
  });
}

function makeResearchSource(overrides = {}) {
  return makeSource({
    source_type: "research_finding",
    publisher: "arXiv",
    trust_tier: "high",
    independence_level: "independent",
    ...overrides,
  });
}

function makeOperationalSource(overrides = {}) {
  return makeSource({
    source_type: "incident",
    publisher: "CISA",
    trust_tier: "primary",
    independence_level: "independent",
    ...overrides,
  });
}

function makeEvidencePacket(overrides = {}) {
  return {
    evidence_id: "ev_test_001",
    source_id: "src_test",
    evidence_type: "research_result",
    source_type: "research_finding",
    fact: "A PoC attack was demonstrated in a lab environment against GPT-4.",
    source_quote: "The attack was demonstrated in a controlled lab setting.",
    triage_data: {
      evidence_strength: "usable",
      admissibility: "passed",
      permitted_uses: ["capability_support", "outlook_input"],
      limitations: ["lab_only"],
      observed_use: false,
      independence_level: "independent",
    },
    date_published: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    publisher: "arXiv",
    ...overrides,
  };
}

function makeOperationalPacket(overrides = {}) {
  return {
    evidence_id: "ev_op_001",
    source_id: "src_op",
    evidence_type: "incident_event",
    source_type: "incident",
    fact: "Attackers used AI-generated phishing to breach a financial institution.",
    source_quote: "AI-generated spear-phishing emails were used to compromise the target.",
    triage_data: {
      evidence_strength: "strong",
      admissibility: "passed",
      permitted_uses: ["fact_support", "adoption_support", "trend_input"],
      limitations: [],
      observed_use: true,
      independence_level: "independent",
    },
    date_published: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    publisher: "CISA",
    ...overrides,
  };
}

function makeClaim(overrides = {}) {
  return {
    claim_id: "claim_test_001",
    claim_type: "category_insight",
    claim_text: "Prompt injection attacks have increased in research literature.",
    confidence: "medium",
    ...overrides,
  };
}

// ── Test 1: Vendor-heavy corpus ────────────────────────────────────────────────

process.stdout.write("\n=== 1. Vendor-heavy corpus ===\n");

test("vendor-heavy: blocked_claim_types includes market_wide and ecosystem_wide", () => {
  const vendorSources = Array.from({ length: 5 }, (_, i) => makeVendorSource({ id: `src_v${i}` }));
  const audit = buildCorpusAudit(vendorSources, "llm_threats");
  assert.ok(audit.source_concentration_flags.includes("vendor_heavy"), "should flag vendor_heavy");
  assert.ok(audit.blocked_claim_types.includes("market_wide"), "should block market_wide");
  assert.ok(audit.blocked_claim_types.includes("ecosystem_wide"), "should block ecosystem_wide");
  // strategic_assessment itself should NOT be in blocked list (only market_wide/ecosystem_wide)
  assert.ok(!audit.blocked_claim_types.includes("strategic_assessment"),
    "strategic_assessment should NOT be globally blocked by vendor_heavy alone");
});

test("vendor-heavy: adoption claim not automatically blocked (no research_heavy)", () => {
  const vendorSources = Array.from({ length: 5 }, (_, i) => makeVendorSource({ id: `src_v${i}` }));
  const audit = buildCorpusAudit(vendorSources, "llm_threats");
  // adoption is not blocked by vendor_heavy alone (no research_heavy, no op_sparse in this case)
  // vendor sources ARE operational-type (threat_intelligence)
  assert.ok(!audit.blocked_claim_types.includes("adoption"),
    "adoption should not be blocked by vendor_heavy alone (vendor TI sources are operational)");
});

test("vendor-heavy: market_wide claim is blocked_by_corpus_audit", () => {
  const vendorSources = Array.from({ length: 5 }, (_, i) => makeVendorSource({ id: `src_v${i}` }));
  const audit = buildCorpusAudit(vendorSources, "llm_threats");
  const claim = makeClaim({
    claim_type: "strategic_assessment",
    claim_text: "This attack technique is widespread across the industry and market.",
    confidence: "high",
  });
  const packets = [makeEvidencePacket()];
  const result = qaAnalyticalClaim(claim, packets, audit);
  // market_wide secondary attribute + vendor_heavy → blocked
  assert.equal(result.claim_support_status, "blocked_by_corpus_audit",
    "market_wide claim in vendor-heavy corpus should be blocked_by_corpus_audit");
  assert.equal(result.allowed_to_proceed, false);
});

// ── Test 2: Research-heavy corpus ─────────────────────────────────────────────

process.stdout.write("\n=== 2. Research-heavy corpus ===\n");

test("research-heavy: blocked_claim_types includes adoption and real_world_factual", () => {
  const researchSources = Array.from({ length: 4 }, (_, i) =>
    makeResearchSource({ id: `src_r${i}` })
  );
  const audit = buildCorpusAudit(researchSources, "traditional_ai_threats");
  assert.ok(audit.source_concentration_flags.includes("research_heavy"), "should flag research_heavy");
  assert.ok(audit.blocked_claim_types.includes("adoption"), "should block adoption");
  assert.ok(audit.blocked_claim_types.includes("real_world_factual"), "should block real_world_factual");
});

test("research-heavy: adoption claim is unsupported (no observed_use)", () => {
  const researchSources = Array.from({ length: 4 }, (_, i) =>
    makeResearchSource({ id: `src_r${i}` })
  );
  const audit = buildCorpusAudit(researchSources, "traditional_ai_threats");
  const claim = makeClaim({
    claim_type: "category_insight",
    claim_text: "Attackers have adopted and deployed this technique in real-world attacks.",
    confidence: "medium",
  });
  const packets = [makeEvidencePacket()]; // lab_only, no observed_use
  const result = qaAnalyticalClaim(claim, packets, audit);
  assert.equal(result.allowed_to_proceed, false,
    "adoption claim in research-heavy corpus with no observed_use should be blocked");
});

test("research-heavy: capability claim is supported with lab_only caveat", () => {
  const researchSources = Array.from({ length: 4 }, (_, i) =>
    makeResearchSource({ id: `src_r${i}` })
  );
  const audit = buildCorpusAudit(researchSources, "traditional_ai_threats");
  const claim = makeClaim({
    claim_type: "category_insight",
    claim_text: "Research demonstrates the capability to extract model weights via timing side-channels.",
    confidence: "medium",
  });
  const packets = [makeEvidencePacket()];
  const result = qaAnalyticalClaim(claim, packets, audit);
  // Capability claims are allowed even in research-heavy corpus
  assert.ok(["supported", "partially_supported"].includes(result.claim_support_status),
    `capability claim should be supported or partially_supported, got: ${result.claim_support_status}`);
  assert.equal(result.allowed_to_proceed, true,
    "capability claim should be allowed in research-heavy corpus");
});

// ── Test 3: Sparse operational evidence ───────────────────────────────────────

process.stdout.write("\n=== 3. Sparse operational evidence ===\n");

test("operational_evidence_sparse: no incident/TI sources → adoption claim unsupported", () => {
  const sources = [
    makeResearchSource({ id: "src_r1" }),
    makeSource({ id: "src_r2", source_type: "benchmark_evaluation" }),
  ];
  const audit = buildCorpusAudit(sources, "agentic_ai_threats");
  assert.ok(audit.evidence_gap_flags.includes("operational_evidence_sparse"),
    "should flag operational_evidence_sparse");
  const claim = makeClaim({
    claim_type: "category_insight",
    claim_text: "Threat actors have adopted agentic AI tools in observed campaigns.",
    confidence: "medium",
  });
  const packets = [makeEvidencePacket({ source_type: "research_finding" })];
  const result = qaAnalyticalClaim(claim, packets, audit);
  assert.equal(result.allowed_to_proceed, false,
    "adoption claim with operational_evidence_sparse should be blocked");
});

// ── Test 4: trend_over_time eligibility ───────────────────────────────────────

process.stdout.write("\n=== 4. trend_over_time eligibility ===\n");

// Helper to make packets with distinct dates and publishers
function makePacketsForTrend(count, publishers, dateOffsets) {
  return Array.from({ length: count }, (_, i) => ({
    evidence_id: `ev_trend_${i}`,
    source_type: "incident",
    evidence_type: "incident_event",
    fact: `Observed attack ${i}`,
    source_quote: `Attack ${i} observed.`,
    publisher: publishers[i % publishers.length],
    primary_origin_url: `https://${publishers[i % publishers.length].toLowerCase().replace(/ /g,"-")}.com/report${i}`,
    triage_data: {
      evidence_strength: "usable",
      admissibility: "passed",
      permitted_uses: ["trend_input", "fact_support"],
      limitations: [],
      observed_use: true,
    },
    date_published: new Date(Date.now() - (dateOffsets[i] || (i * 35)) * 86_400_000).toISOString(),
  }));
}

// Build a permissive audit corpus (multiple operational sources, diverse time windows)
function makePermissiveAuditSources(category = "llm_threats") {
  // 4 operational sources across 3+ months to avoid all flags
  const dates = [10, 45, 80, 110].map(
    (d) => new Date(Date.now() - d * 86_400_000).toISOString()
  );
  return [
    makeOperationalSource({ id: "src_pa1", publisher: "CISA", date_published: dates[0] }),
    makeOperationalSource({ id: "src_pa2", publisher: "Mandiant", date_published: dates[1] }),
    makeOperationalSource({ id: "src_pa3", publisher: "CISA", date_published: dates[2] }),
    makeResearchSource({ id: "src_pa4", publisher: "arXiv", date_published: dates[3] }),
  ];
}

test("trend_over_time: 3 items, 2 publishers, 2 time windows → supported", () => {
  const packets = makePacketsForTrend(3, ["CISA", "Mandiant"], [10, 45, 80]);
  // Use a corpus with operational sources so trend_over_time is not blocked
  const audit = buildCorpusAudit(makePermissiveAuditSources(), "llm_threats");
  assert.ok(!audit.blocked_claim_types.includes("trend_over_time"),
    "permissive audit should not block trend_over_time");
  const claim = makeClaim({
    claim_type: "trend_claim",
    claim_text: "Prompt injection attack volume has grown over the past three months.",
    confidence: "medium",
  });
  const result = qaAnalyticalClaim(claim, packets, audit);
  assert.equal(result.claim_support_status, "supported",
    `trend with 3 items / 2 publishers / 2 windows should be supported, got: ${result.claim_support_status}`);
  assert.equal(result.allowed_to_proceed, true);
});

test("trend_over_time: 2 items, 1 publisher → overgeneralized", () => {
  const packets = makePacketsForTrend(2, ["CISA"], [10, 40]);
  const audit = buildCorpusAudit(makePermissiveAuditSources(), "llm_threats");
  const claim = makeClaim({
    claim_type: "trend_claim",
    claim_text: "Prompt injection attacks show a rising trend over time.",
    confidence: "medium",
  });
  const result = qaAnalyticalClaim(claim, packets, audit);
  assert.equal(result.claim_support_status, "overgeneralized",
    `trend with only 2 items should be overgeneralized, got: ${result.claim_support_status}`);
  assert.equal(result.allowed_to_proceed, false);
});

// ── Test 5: emerging_signal ───────────────────────────────────────────────────

process.stdout.write("\n=== 5. emerging_signal ===\n");

test("emerging_signal: 1 recent item (within 90 days) → supported with caveat", () => {
  const recentPacket = makeEvidencePacket({
    date_published: new Date(Date.now() - 15 * 86_400_000).toISOString(),
  });
  // emerging_signal is allowed even in thin corpora (corpus_insufficient permits it)
  // Use empty audit to verify this path
  const audit = buildCorpusAudit([], "agentic_ai_threats");
  const claim = makeClaim({
    claim_type: "emerging_signal",
    claim_text: "A new MCP tool poisoning technique has emerged as an early signal.",
    confidence: "low",
  });
  const result = qaAnalyticalClaim(claim, [recentPacket], audit);
  // emerging_signal is allowed in insufficient corpus → partially_supported
  assert.ok(["supported", "partially_supported"].includes(result.claim_support_status),
    `emerging_signal with recent evidence should be supported or partially_supported, got: ${result.claim_support_status}`);
  assert.equal(result.allowed_to_proceed, true,
    "emerging_signal with recent evidence should be allowed to proceed");
});

test("emerging_signal: recent evidence with permissive audit → supported", () => {
  const recentPacket = makeEvidencePacket({
    date_published: new Date(Date.now() - 15 * 86_400_000).toISOString(),
  });
  const audit = buildCorpusAudit(makePermissiveAuditSources(), "agentic_ai_threats");
  const claim = makeClaim({
    claim_type: "emerging_signal",
    claim_text: "A new MCP tool poisoning technique has emerged as an early signal.",
    confidence: "low",
  });
  const result = qaAnalyticalClaim(claim, [recentPacket], audit);
  assert.equal(result.claim_support_status, "supported",
    `emerging_signal with recent evidence and permissive audit should be supported, got: ${result.claim_support_status}`);
  assert.equal(result.allowed_to_proceed, true);
  // Should note it's not a confirmed trend
  assert.ok(result.qa_notes.includes("not a confirmed trend"),
    "emerging_signal qa_notes should note it is not a confirmed trend");
});

test("emerging_signal: only stale evidence (>90 days) → unsupported", () => {
  const stalePacket = makeEvidencePacket({
    date_published: new Date(Date.now() - 120 * 86_400_000).toISOString(),
  });
  const audit = buildCorpusAudit(makePermissiveAuditSources(), "agentic_ai_threats");
  const claim = makeClaim({
    claim_type: "emerging_signal",
    claim_text: "An early signal of new tool-use attacks has been detected.",
    confidence: "low",
  });
  const result = qaAnalyticalClaim(claim, [stalePacket], audit);
  assert.equal(result.claim_support_status, "unsupported",
    `emerging_signal with only stale evidence should be unsupported, got: ${result.claim_support_status}`);
  assert.equal(result.allowed_to_proceed, false);
});

// ── Test 6: exceeds_confidence_ceiling ────────────────────────────────────────

process.stdout.write("\n=== 6. exceeds_confidence_ceiling ===\n");

test("exceeds_confidence_ceiling: claim.confidence=high, ceiling=low → blocked", () => {
  const audit = buildCorpusAudit([], "llm_threats");
  const claim = makeClaim({
    claim_type: "category_insight",
    claim_text: "Jailbreaking is now a mainstream concern.",
    confidence: "high",
  });
  const packets = [makeEvidencePacket()];
  // Provide an analyticalState with a candidate whose ceiling is "low"
  // analyticalState.confidence_ceiling is the category-level ceiling (v3 schema)
  const analyticalState = { confidence_ceiling: "low" };
  const result = qaAnalyticalClaim(claim, packets, audit, analyticalState);
  assert.equal(result.claim_support_status, "exceeds_confidence_ceiling",
    `high confidence against low ceiling should give exceeds_confidence_ceiling, got: ${result.claim_support_status}`);
  assert.equal(result.allowed_to_proceed, false);
});

test("exceeds_confidence_ceiling: claim.confidence=medium, ceiling=medium → allowed", () => {
  const audit = buildCorpusAudit([], "llm_threats");
  const claim = makeClaim({
    claim_type: "category_insight",
    claim_text: "Jailbreaking is now a mainstream concern.",
    confidence: "medium",
  });
  const packets = [makeEvidencePacket()];
  const analyticalState = {
    candidate_judgments: [{
      judgment_type: "insight",
      candidate_claim: "Jailbreaking is now a mainstream concern.",
      confidence_ceiling: "medium",
    }],
  };
  const result = qaAnalyticalClaim(claim, packets, audit, analyticalState);
  // medium == medium ceiling → should not be blocked by ceiling
  assert.notEqual(result.claim_support_status, "exceeds_confidence_ceiling",
    "claim with confidence matching ceiling should not be blocked by ceiling gate");
});

// ── Test 7: qaAllClaims — blocked claims in blocked array, not passing ────────

process.stdout.write("\n=== 7. qaAllClaims blocked claim routing ===\n");

test("qaAllClaims: blocked claims go to blocked[], not passing[]", () => {
  const sources = Array.from({ length: 4 }, (_, i) => makeResearchSource({ id: `src_r${i}` }));
  const audit = buildCorpusAudit(sources, "traditional_ai_threats");

  const claims = [
    // Should be blocked (adoption with no observed_use in research-heavy corpus)
    makeClaim({
      claim_id: "claim_blocked_1",
      claim_type: "category_insight",
      claim_text: "Attackers are now actively deploying model extraction in the wild.",
      confidence: "medium",
    }),
    // Should pass (capability from research)
    makeClaim({
      claim_id: "claim_pass_1",
      claim_type: "category_insight",
      claim_text: "Research demonstrates new capability for model inversion attacks.",
      confidence: "low",
    }),
  ];

  const packets = [makeEvidencePacket()];
  const { passing, blocked } = qaAllClaims(claims, packets, audit);

  // The adoption (in-the-wild) claim should be blocked
  const blockedIds = blocked.map((c) => c.claim_id);
  const passingIds = passing.map((c) => c.claim_id);

  assert.ok(blockedIds.includes("claim_blocked_1"),
    "adoption/in-the-wild claim should be in blocked[], not passing[]");
  assert.ok(!passingIds.includes("claim_blocked_1"),
    "blocked claim should not appear in passing[]");
});

test("qaAllClaims: capability claims pass even in research-heavy corpus", () => {
  const sources = Array.from({ length: 4 }, (_, i) => makeResearchSource({ id: `src_r${i}` }));
  const audit = buildCorpusAudit(sources, "traditional_ai_threats");
  const claims = [
    makeClaim({
      claim_id: "claim_cap_1",
      claim_type: "category_insight",
      claim_text: "Research papers demonstrate new adversarial attack capabilities on LLMs.",
      confidence: "medium",
    }),
  ];
  const packets = [makeEvidencePacket()];
  const { passing, blocked } = qaAllClaims(claims, packets, audit);
  const passingIds = passing.map((c) => c.claim_id);
  assert.ok(passingIds.includes("claim_cap_1"),
    "capability claim should pass in research-heavy corpus");
});

// ── Test 8: secondary attribute detection ─────────────────────────────────────

process.stdout.write("\n=== 8. Secondary attribute detection ===\n");

test("detectSecondaryAttributes: real_world_use detected", () => {
  const attrs = detectSecondaryAttributes("Attackers deployed this in the wild against production systems.", []);
  assert.ok(attrs.has("real_world_use"), "should detect real_world_use");
});

test("detectSecondaryAttributes: lab_only detected", () => {
  const attrs = detectSecondaryAttributes("This PoC was demonstrated in a research lab environment.", []);
  assert.ok(attrs.has("lab_only"), "should detect lab_only");
});

test("detectSecondaryAttributes: market_wide detected", () => {
  const attrs = detectSecondaryAttributes("This vulnerability is now widespread across the industry.", []);
  assert.ok(attrs.has("market_wide"), "should detect market_wide");
});

test("detectSecondaryAttributes: forward_looking detected", () => {
  const attrs = detectSecondaryAttributes("This technique could be used in future campaigns.", []);
  assert.ok(attrs.has("forward_looking"), "should detect forward_looking");
});

// ── Test 9: normalizeClaimType mapping ────────────────────────────────────────

process.stdout.write("\n=== 9. normalizeClaimType ===\n");

test("normalizeClaimType: trend_claim → trend_over_time", () => {
  assert.equal(normalizeClaimType({ claim_type: "trend_claim", claim_text: "a trend" }), "trend_over_time");
});

test("normalizeClaimType: trend → trend_over_time", () => {
  assert.equal(normalizeClaimType({ claim_type: "trend", claim_text: "a trend" }), "trend_over_time");
});

test("normalizeClaimType: emerging_signal preserved", () => {
  assert.equal(normalizeClaimType({ claim_type: "emerging_signal" }), "emerging_signal");
});

test("normalizeClaimType: category_insight with trend language → trend_over_time", () => {
  assert.equal(normalizeClaimType({
    claim_type: "category_insight",
    claim_text: "Attacks are increasingly growing month over month.",
  }), "trend_over_time");
});

test("normalizeClaimType: category_insight with adoption language → adoption", () => {
  assert.equal(normalizeClaimType({
    claim_type: "category_insight",
    claim_text: "Attackers have adopted this technique in the wild.",
  }), "adoption");
});

// ── Test 10: corpus_audit.blocked_claim_types with operational sparse ─────────

process.stdout.write("\n=== 10. blocked_claim_types via operational_evidence_sparse ===\n");

test("operational_evidence_sparse: adoption in blocked_claim_types", () => {
  const sources = [
    makeResearchSource({ id: "src_r1" }),
    makeResearchSource({ id: "src_r2", publisher: "MIT" }),
  ];
  const audit = buildCorpusAudit(sources, "ai_enabled_threats");
  assert.ok(audit.evidence_gap_flags.includes("operational_evidence_sparse"),
    "should flag operational_evidence_sparse");
  assert.ok(audit.blocked_claim_types.includes("adoption"),
    "adoption should be in blocked_claim_types");
  assert.ok(audit.blocked_claim_types.includes("real_world_factual"),
    "real_world_factual should be in blocked_claim_types");
});

// ── Test 11: category_undercovered with strong primary source exception ────────

process.stdout.write("\n=== 11. category_undercovered primary source exception ===\n");

test("category_undercovered: <3 sources with no primary → in evidence_gap_flags", () => {
  const sources = [
    makeSource({ id: "src_m1", publisher: "TechBlog", trust_tier: "medium", source_type: "incident" }),
    makeSource({ id: "src_m2", publisher: "Unknown", trust_tier: "low", source_type: "research_finding" }),
  ];
  const audit = buildCorpusAudit(sources, "llm_threats");
  assert.ok(audit.evidence_gap_flags.includes("category_undercovered"),
    "should flag category_undercovered when < 3 sources with no primary");
});

test("category_undercovered: 2 sources but 1 is primary_authority → NOT undercovered", () => {
  const sources = [
    makeSource({
      id: "src_p1", publisher: "CISA", trust_tier: "primary",
      source_type: "advisory",
    }),
    makeResearchSource({ id: "src_r1" }),
  ];
  const audit = buildCorpusAudit(sources, "llm_threats");
  assert.ok(!audit.evidence_gap_flags.includes("category_undercovered"),
    "should NOT flag category_undercovered when primary authority source exists");
});

// ── Results ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${"─".repeat(60)}\n`);
process.stdout.write(`Tests: ${passed + failed} total | ${passed} passed | ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
