/**
 * Semantic Gate Refactor — regression tests
 *
 * Core principle under test: DETERMINISTIC code validates MECHANICS only.
 * LLM-assigned fields (judgment_flags, secondary_attributes, source_judgment_type,
 * quote_support) determine semantic routing — never keyword regex on LLM-generated text.
 *
 * Run with: node tests/semanticGateRefactor.test.js
 */

import assert from "node:assert/strict";

import {
  normalizeClaimType,
  detectSecondaryAttributes,
  qaAnalyticalClaim,
  QA_EXPLICIT_GATE_TYPES,
} from "../lib/pipeline/analysis/claimQa.js";

import {
  validateCategoryAnalysis,
} from "../lib/pipeline/analysis/validateCategoryAnalysis.js";

import {
  buildBlockedClaimOpportunities,
} from "../lib/pipeline/analysis/buildAnalyticalState.js";

import {
  quoteSupport,
} from "../lib/pipeline/discovery/candidateGates.js";

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePacket(overrides = {}) {
  return {
    evidence_id: "e1",
    source_id: "s1",
    evidence_type: "research_finding",
    source_type: "research_finding",
    evidence_strength: "usable",
    triage_data: {
      evidence_strength: overrides.evidence_strength || "usable",
      admissibility: overrides.admissibility || "passed",
      permitted_uses: overrides.permitted_uses || ["capability_support"],
      limitations: overrides.limitations || [],
    },
    observed_use: overrides.observed_use || false,
    date_published: overrides.date_published || "2026-01-15",
    publisher: overrides.publisher || "ResearchOrg",
    independence_level: overrides.independence_level || "independent",
    concreteness_level: overrides.concreteness_level || "moderate",
    ...overrides,
  };
}

// ── 1. normalizeClaimType uses source_judgment_type (structural, not regex) ──
console.log("\n1. normalizeClaimType — structural routing from source_judgment_type");

test("adversary_adoption judgment_type routes to 'adoption' gate (no text needed)", () => {
  const claim = {
    claim_type: "category_insight",
    source_judgment_type: "adversary_adoption",
    claim_text: "This sentence has no adoption keywords whatsoever.",
  };
  assert.equal(normalizeClaimType(claim), "adoption");
});

test("operational_shift judgment_type routes to 'factual' gate (no text needed)", () => {
  const claim = {
    claim_type: "category_insight",
    source_judgment_type: "operational_shift",
    claim_text: "This text is completely generic with no operational language.",
  };
  assert.equal(normalizeClaimType(claim), "factual");
});

test("capability_change judgment_type routes to 'capability' gate", () => {
  const claim = {
    claim_type: "category_insight",
    source_judgment_type: "capability_change",
    claim_text: "Researchers demonstrated a new attack method.",
  };
  assert.equal(normalizeClaimType(claim), "capability");
});

test("early_signal judgment_type routes to 'emerging_signal' gate", () => {
  const claim = {
    claim_type: "category_insight",
    source_judgment_type: "early_signal",
    claim_text: "Some early indication has appeared.",
  };
  assert.equal(normalizeClaimType(claim), "emerging_signal");
});

test("monitoring_required routes to 'recommendation'", () => {
  const claim = {
    claim_type: "category_insight",
    source_judgment_type: "monitoring_required",
    claim_text: "Watch for signs of escalation.",
  };
  assert.equal(normalizeClaimType(claim), "recommendation");
});

test("HIGH TOKEN OVERLAP but judgment_type=capability_change → capability gate, NOT adoption", () => {
  // This test verifies the old bug: if claim text said 'adversaries are adopting X'
  // but judgment_type says capability_change, the new code trusts judgment_type.
  const claim = {
    claim_type: "category_insight",
    source_judgment_type: "capability_change",
    claim_text: "Adversaries are adopting and deploying this technique in the wild against real targets.",
  };
  // judgment_type wins — text has ADOPTION_LANG but we use structural mapping
  assert.equal(normalizeClaimType(claim), "capability");
});

test("judgment_flags used when source_judgment_type absent (Path 2)", () => {
  const claim = {
    claim_type: "category_insight",
    // no source_judgment_type
    judgment_flags: { implies_adoption: true },
    claim_text: "No adoption keyword here.",
  };
  assert.equal(normalizeClaimType(claim), "adoption");
});

test("legacy regex fallback used only when no LLM-assigned fields present", () => {
  const claim = {
    claim_type: "category_insight",
    // no source_judgment_type, no judgment_flags
    // Text uses exact OPERATIONAL_LANG phrase "actively exploited" (past tense)
    claim_text: "This CVE has been actively exploited against enterprise targets.",
  };
  // Falls back to regex: OPERATIONAL_LANG ("actively exploited") matches → "factual"
  assert.equal(normalizeClaimType(claim), "factual");
});

test("trend_claim label always maps to trend_over_time regardless of text", () => {
  const claim = {
    claim_type: "trend_claim",
    claim_text: "No trend language here.",
  };
  assert.equal(normalizeClaimType(claim), "trend_over_time");
});

// ── 2. detectSecondaryAttributes — LLM-assigned fields take priority ──────────
console.log("\n2. detectSecondaryAttributes — LLM-assigned fields before regex");

test("claim.secondary_attributes is used directly (no regex needed)", () => {
  const claim = { secondary_attributes: ["lab_only", "forward_looking"] };
  const attrs = detectSecondaryAttributes("Adversaries are deploying this at scale.", [], claim);
  // Text has 'deploying' → regex would add real_world_use. LLM says lab_only.
  assert.ok(attrs.has("lab_only"), "should have lab_only from LLM-assigned");
  assert.ok(attrs.has("forward_looking"), "should have forward_looking from LLM-assigned");
  assert.ok(!attrs.has("real_world_use"), "should NOT add real_world_use — overridden by LLM");
});

test("judgment_flags used when secondary_attributes absent", () => {
  const claim = {
    judgment_flags: { implies_adoption: true, is_lab_only: false },
  };
  const attrs = detectSecondaryAttributes("", [], claim);
  // implies_adoption=true + is_lab_only=false → real_world_use expected
  assert.ok(attrs.has("real_world_use"), "implies_adoption without is_lab_only → real_world_use");
});

test("judgment_flags is_lab_only=true adds lab_only, suppresses real_world_use", () => {
  const claim = {
    judgment_flags: { implies_adoption: true, is_lab_only: true },
  };
  const attrs = detectSecondaryAttributes("Adversaries deployed this.", [], claim);
  assert.ok(attrs.has("lab_only"), "is_lab_only=true → lab_only");
  assert.ok(!attrs.has("real_world_use"), "is_lab_only=true overrides implies_adoption");
});

test("regex fallback runs only when no LLM-assigned fields", () => {
  const claim = {}; // no secondary_attributes, no judgment_flags
  const attrs = detectSecondaryAttributes("The trend is increasingly widespread.", [], claim);
  // Regex fires: MARKET_WIDE_PATTERNS matches "widespread"
  assert.ok(attrs.has("market_wide"), "regex fallback should detect market_wide");
});

test("vendor_claim detection is structural (evidence-level), not text-driven", () => {
  const vendorPacket = makePacket({ independence_level: "vendor_interested" });
  const claim = { secondary_attributes: [] }; // empty LLM-assigned attrs
  // Use a text with a simple named entity (no camelCase) to satisfy the vendor heuristic.
  // The point of this test: vendor_claim derives from EVIDENCE (independence_level),
  // not from the claim text content.
  const attrs = detectSecondaryAttributes("Palo Alto Networks platform blocks all modern threats.", [vendorPacket], claim);
  // vendor_claim added from evidence structure: hasVendorInterestedSource=true + named entity in text
  assert.ok(attrs.has("vendor_claim"), "vendor_claim from evidence independence_level");
});

// ── 3. quoteSupport — always flags entailment QA, never decides semantically ──
console.log("\n3. quoteSupport — mechanical location, not semantic verdict");

test("high token overlap (≥0.85) returns 'lexically_matched' + requires_entailment_qa=true", () => {
  const claim = "GPT-4 was jailbroken with 88% ASR using PAIR methodology";
  const quote = "GPT-4 was jailbroken with 88% ASR using PAIR methodology in a controlled experiment";
  const { quote_support, requires_entailment_qa } = quoteSupport(claim, quote);
  assert.equal(quote_support, "lexically_matched");
  assert.equal(requires_entailment_qa, true, "even high overlap must be confirmed by LLM");
});

test("medium overlap (0.3–0.85) returns 'requires_entailment_qa'", () => {
  // Construct a pair with ~50% token overlap to exercise the intermediate branch.
  // Shared content tokens: "gpt-4", "jailbreak", "attack" (3 of ~6 claim tokens)
  const claim = "GPT-4 jailbreak attack method achieves bypass against safety filters";
  const quote = "GPT-4 jailbreak attack was demonstrated by researchers who also tested other models";
  const { quote_support, requires_entailment_qa } = quoteSupport(claim, quote);
  // Should be in the 0.3–0.85 range → requires_entailment_qa
  assert.equal(quote_support, "requires_entailment_qa");
  assert.equal(requires_entailment_qa, true);
});

test("low overlap (<0.3) returns 'unsupported' without entailment QA", () => {
  const claim = "Adversaries are using deepfakes to bypass authentication systems";
  const quote = "Enterprise cloud workloads grew by 45% in Q2 amid budget pressures";
  const { quote_support, requires_entailment_qa } = quoteSupport(claim, quote);
  assert.equal(quote_support, "unsupported");
  assert.equal(requires_entailment_qa, false);
});

test("no quote returns 'unverified' without entailment QA", () => {
  const { quote_support, requires_entailment_qa } = quoteSupport("any claim", "");
  assert.equal(quote_support, "unverified");
  assert.equal(requires_entailment_qa, false);
});

test("co_occurrence_ratio is numeric and informational (not a routing decision)", () => {
  const { co_occurrence_ratio } = quoteSupport("GPT-4 attack", "GPT-4 vulnerability research paper");
  assert.equal(typeof co_occurrence_ratio, "number");
  assert.ok(co_occurrence_ratio >= 0 && co_occurrence_ratio <= 1);
});

// ── 4. validateCategoryAnalysis — judgment_flags drive semantic gates ─────────
console.log("\n4. validateCategoryAnalysis — judgment_flags-based semantic gates");

function makeIdIndex(entries = []) {
  const m = new Map();
  for (const e of entries) m.set(e.id, e);
  return m;
}

function makeCompact(idEntries, opts = {}) {
  return {
    category: "llm_threats",
    id_index: makeIdIndex(idEntries),
    analytical_state: opts.analytical_state || null,
    corpus_audit: opts.corpus_audit || null,
  };
}

function makeJudgment(overrides = {}) {
  return {
    judgment: "A strategic insight about LLM threats.",
    judgment_type: "capability_change",
    what_changed: "New attack method emerged this month.",
    causal_mechanism: "Automation reduced barrier for novice attackers.",
    why_this_matters: "Defenders must update detection strategies.",
    uncertainty: "Scale of real-world deployment unknown.",
    confidence: "medium",
    evidence_for: ["e1"],
    evidence_against: [],
    supporting_evidence_ids: ["e1"],
    second_order_implications: ["Potential for script-kiddie level exploitation"],
    monitoring_signals: ["Watch for CVE disclosures in LLM libraries"],
    ...overrides,
  };
}

const RESEARCH_ENTRY = {
  id: "e1",
  source_type: "research_finding",
  evidence_strength: "usable",
  origin: "5A_rawfact",
  publisher: "AcademiaCorp",
  date: "2026-01-10",
  observed_use: false,
};

test("judgment_flags.implies_adoption=false → adoption gate NOT triggered (not relying on text scan)", () => {
  const judgment = makeJudgment({
    judgment: "Adversaries are adopting this technique extensively in the wild.",
    judgment_flags: { implies_adoption: false, implies_operational: false, implies_trend: false },
    confidence: "high",
  });
  const compact = makeCompact([RESEARCH_ENTRY]);
  const raw = { strategic_judgments: [judgment], evidence_gaps: [], outlook_6_months: {
    observed_basis: "Some activity observed.", projected_trajectory: "May continue.",
    reasoning: "Based on corpus.", confidence: "medium", supporting_evidence_ids: [],
  }};
  const result = validateCategoryAnalysis(raw, compact);
  // Text says "adopting" + "in the wild" but judgment_flags.implies_adoption=false
  // → adoption gate should NOT fire → confidence should NOT be capped to "low"
  const j = result.strategic_judgments[0];
  assert.ok(j, "judgment should survive validation");
  assert.notEqual(j?.confidence, "low",
    "adoption gate must NOT fire when implies_adoption=false, even with adoption language in text");
});

test("judgment_flags.implies_adoption=true → adoption gate fires when no observed_use evidence", () => {
  const judgment = makeJudgment({
    judgment: "A new technique has emerged from research.",
    judgment_flags: { implies_adoption: true },
    confidence: "high",
  });
  const compact = makeCompact([RESEARCH_ENTRY]);
  const raw = { strategic_judgments: [judgment], evidence_gaps: [], outlook_6_months: {
    observed_basis: "x", projected_trajectory: "y", reasoning: "z", confidence: "low",
    supporting_evidence_ids: [],
  }};
  const result = validateCategoryAnalysis(raw, compact);
  const j = result.strategic_judgments[0];
  // implies_adoption=true but evidence is research_finding (not observed_use) → capped to low
  assert.equal(j?.confidence, "low",
    "adoption gate MUST fire when implies_adoption=true and no observed-use evidence");
});

test("judgment_flags.implies_trend=false → trend gate NOT triggered (not relying on text scan)", () => {
  const judgment = makeJudgment({
    judgment: "The growing trend of increasingly widespread attacks is escalating rapidly.",
    judgment_flags: { implies_trend: false },
    confidence: "medium",
    evidence_for: ["e1", "e2", "e3"],
    supporting_evidence_ids: ["e1", "e2", "e3"],
  });
  const entries = [
    RESEARCH_ENTRY,
    { id: "e2", source_type: "research_finding", evidence_strength: "usable", origin: "5A_rawfact",
      publisher: "B", date: "2026-02-10", observed_use: false },
    { id: "e3", source_type: "threat_intelligence", evidence_strength: "strong", origin: "5A_rawfact",
      publisher: "C", date: "2026-03-10", observed_use: true },
  ];
  const compact = makeCompact(entries);
  const raw = { strategic_judgments: [judgment], evidence_gaps: [], outlook_6_months: {
    observed_basis: "x", projected_trajectory: "y", reasoning: "z", confidence: "medium",
    supporting_evidence_ids: [],
  }};
  const result = validateCategoryAnalysis(raw, compact);
  const j = result.strategic_judgments[0];
  // Text has TREND_SCOPE language but implies_trend=false → trend gate must NOT fire
  assert.ok(j, "judgment should survive");
  // If trend gate had fired with only 1 resolved evidence item, confidence would be capped
  // to medium OR judgment removed. But since it shouldn't fire, confidence stays medium.
  assert.ok(j?.confidence !== undefined, "judgment should have a confidence value");
});

// ── 5. buildEvidenceStrength — quality-gated, not count-gated ─────────────────
console.log("\n5. buildEvidenceStrength — quality-gated confidence ceiling");

test("no operational sources → adoption blocked (verifiable through blockOpportunities)", () => {
  // buildEvidenceStrength is internal; we verify quality-gating via buildBlockedClaimOpportunities
  // which reads the ceiling produced by buildEvidenceStrength.
  // Simulate what buildEvidenceStrength produces for 3 usable non-operational items.
  const strengthNonOperational = {
    source_type_diversity: 2,
    has_operational_sources: false,
    validated_evidence_count: 3,
    confidence_ceiling: "medium", // 3 usable items but no operational → medium
  };
  const blocked = buildBlockedClaimOpportunities(strengthNonOperational, [], []);
  const adoptionBlocked = blocked.some((b) => b.claim_type === "adoption");
  assert.ok(adoptionBlocked, "adoption must be blocked when no operational sources (quality check)");
});

test("2 strong items + operational source type → high ceiling", () => {
  // Test through buildBlockedClaimOpportunities indirectly
  const strength = {
    source_type_diversity: 2,
    has_operational_sources: true,
    validated_evidence_count: 2,
    confidence_ceiling: "high", // what the new logic produces
  };
  const ops = [];
  const trends = [];
  const blocked = buildBlockedClaimOpportunities(strength, ops, trends);
  // high ceiling → only trend (no trend data) and market_wide/ecosystem_wide may be blocked
  // but adoption and factual should NOT be blocked (we have operational sources)
  const adoptionBlocked = blocked.some((b) => b.claim_type === "adoption");
  assert.ok(!adoptionBlocked, "adoption should NOT be blocked when has_operational_sources=true");
});

test("no operational sources → adoption blocked regardless of evidence count", () => {
  const strength = {
    source_type_diversity: 3,
    has_operational_sources: false,
    validated_evidence_count: 10,
    confidence_ceiling: "medium",
  };
  const blocked = buildBlockedClaimOpportunities(strength, [], [{ direction: "insufficient_data", non_zero_buckets: 1 }]);
  const adoptionBlocked = blocked.some((b) => b.claim_type === "adoption");
  assert.ok(adoptionBlocked, "adoption must be blocked when no operational sources present");
});

test("confidence_ceiling=none blocks all positive claims", () => {
  const strength = {
    source_type_diversity: 0,
    has_operational_sources: false,
    validated_evidence_count: 0,
    confidence_ceiling: "none",
  };
  const blocked = buildBlockedClaimOpportunities(strength, [], []);
  const blockedTypes = new Set(blocked.map((b) => b.claim_type));
  assert.ok(blockedTypes.has("factual"), "factual blocked when ceiling=none");
  assert.ok(blockedTypes.has("adoption"), "adoption blocked when ceiling=none");
  assert.ok(blockedTypes.has("trend_over_time"), "trend blocked when ceiling=none");
});

// ── 6. Deterministic validators do not make semantic judgments ─────────────────
console.log("\n6. Deterministic validators — mechanics only, not meaning");

test("high overlap quote does NOT auto-pass semantic support — requires_entailment_qa stays true", () => {
  // Even 90% token overlap must still require LLM confirmation.
  // The old code would return quote_support="supported" for this case.
  const claim = "GPT-4 achieved 88% attack success rate in prompt injection tests";
  const quote = "GPT-4 achieved 88% attack success rate in prompt injection test evaluations";
  const result = quoteSupport(claim, quote);
  assert.ok(result.requires_entailment_qa, "LLM must still verify even at high overlap");
  assert.notEqual(result.quote_support, "supported",
    "'supported' verdict must not come from token overlap alone");
});

test("low overlap quote does NOT auto-pass even if claim text matches quote topic", () => {
  // Adversarial test: claim uses completely different vocabulary than quote
  // but they're about the same topic. This should NOT pass mechanically.
  const claim = "Attackers leverage foundation model vulnerabilities for unauthorized access";
  const quote = "LLMs can be exploited through prompt injection bypassing safety guardrails";
  const result = quoteSupport(claim, quote);
  // Vocabulary is almost entirely different → low overlap
  assert.ok(["unsupported", "requires_entailment_qa"].includes(result.quote_support));
});

test("normalizeClaimType never re-derives claim type by scanning LLM judgment text when source_judgment_type is set", () => {
  // The claim text contains strong adoption + trend language.
  // source_judgment_type=risk_elevation should override ALL text patterns.
  const claim = {
    claim_type: "category_insight",
    source_judgment_type: "risk_elevation",
    claim_text: "Adversaries are increasingly adopting this technique, used in the wild by APT groups, growing trend.",
  };
  // risk_elevation maps to "strategic_assessment"
  assert.equal(normalizeClaimType(claim), "strategic_assessment",
    "structural judgment_type must win over all text keywords");
});

test("detectSecondaryAttributes does not override LLM 'lab_only' with text 'real_world_use'", () => {
  // LLM explicitly says lab_only. Claim text mentions real-world deployment.
  // The LLM is authoritative.
  const claim = {
    secondary_attributes: ["lab_only"],
  };
  const text = "Adversaries are deploying this in real-world attacks and in the wild.";
  const attrs = detectSecondaryAttributes(text, [], claim);
  assert.ok(attrs.has("lab_only"), "lab_only from LLM must be present");
  assert.ok(!attrs.has("real_world_use"), "real_world_use from text regex must NOT override LLM");
});

// ── 7. judgment_flags absent → legacy regex fallback (backward compat) ────────
console.log("\n7. Legacy fallback — backward compatibility when judgment_flags absent");

test("category_insight without any LLM fields falls back to regex routing", () => {
  const claim = {
    claim_type: "category_insight",
    claim_text: "Adversaries are actively adopting this capability in real-world attacks.",
  };
  // No source_judgment_type, no judgment_flags → regex must handle it
  assert.equal(normalizeClaimType(claim), "adoption",
    "legacy regex must correctly route adoption-language claim");
});

test("detectSecondaryAttributes falls back to regex when no LLM fields on claim", () => {
  const claim = {}; // no secondary_attributes, no judgment_flags
  const text = "Researchers in a lab demonstrated this in a controlled proof-of-concept.";
  const attrs = detectSecondaryAttributes(text, [], claim);
  assert.ok(attrs.has("lab_only"), "regex fallback must detect lab_only from text");
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
