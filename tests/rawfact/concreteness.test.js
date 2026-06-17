/**
 * Concreteness anchor tests — Phase 1 & 5 of the evidence-quality fixes.
 *
 * Tests:
 *   1-5:  computeConcretenessAnchors (normalizeEvidenceItems.js)
 *   6-7:  strength capping via evidenceTriage.js (hype_flag + concreteness_level)
 *   8-10: claim QA concreteness floor (claimQa.js)
 *   11-12: hype detection in claim text (claimQa.js)
 *
 * Run with: node tests/rawfact/concreteness.test.js
 */

import assert from "node:assert/strict";
import { computeConcretenessAnchors } from "../../lib/pipeline/rawfact/normalizeEvidenceItems.js";
import { triageEvidenceItem } from "../../lib/pipeline/evidenceTriage/evidenceTriage.js";
import { qaAnalyticalClaim } from "../../lib/pipeline/analysis/claimQa.js";

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
    source_type: "research_finding",
    trust_tier: "high",
    ...overrides,
  };
}

function makeItem(overrides = {}) {
  return {
    evidence_id: "ev_test_1",
    evidence_type: "research_result",
    fact: "Some fact about AI security.",
    source_quote: "Some quote about AI security.",
    entities: [],
    numbers: [],
    is_atomic: true,
    quote_verified: true,
    concreteness_level: "moderate",
    hype_flag: false,
    ...overrides,
  };
}

function makePacket(overrides = {}) {
  return {
    evidence_id: "ev_p_1",
    evidence_type: "research_result",
    source_type: "research_finding",
    triage_data: {
      evidence_strength: "usable",
      admissibility: "passed",
      permitted_uses: ["fact_support", "context_only"],
      limitations: [],
    },
    concreteness_level: "moderate",
    ...overrides,
  };
}

function makeCorpusAudit(overrides = {}) {
  return {
    analysis_allowed: "full",
    source_concentration_flags: [],
    evidence_gap_flags: [],
    analysis_limitations: [],
    blocked_claim_types: [],
    ...overrides,
  };
}

// ── Section 1: computeConcretenessAnchors ─────────────────────────────────────

process.stdout.write("\n=== 1. computeConcretenessAnchors: CVE reference ===\n");

test("CVE ID → anchors includes cve_reference", () => {
  const { anchors, concreteness_level } = computeConcretenessAnchors(
    "CVE-2024-12345 affects GPT-4 inference endpoints",
    "vulnerability identified as CVE-2024-12345",
    [], []
  );
  assert.ok(anchors.includes("cve_reference"), `expected cve_reference in anchors: ${JSON.stringify(anchors)}`);
  assert.ok(["moderate", "high"].includes(concreteness_level), `expected moderate or high, got ${concreteness_level}`);
});

process.stdout.write("\n=== 2. computeConcretenessAnchors: named model + metric ===\n");

test("GPT-4 + 88% → named_ai_model + measured_metric, level=high", () => {
  const { anchors, concreteness_level } = computeConcretenessAnchors(
    "GPT-4 was jailbroken with 88% success rate using PAIR methodology",
    "we achieved 88% attack success rate on GPT-4",
    [], []
  );
  assert.ok(anchors.includes("named_ai_model"), `expected named_ai_model in anchors: ${JSON.stringify(anchors)}`);
  assert.ok(anchors.includes("measured_metric") || anchors.includes("attack_success_rate"),
    `expected measured_metric or attack_success_rate in anchors: ${JSON.stringify(anchors)}`);
  assert.equal(concreteness_level, "high", `expected high, got ${concreteness_level} (anchors=${JSON.stringify(anchors)})`);
});

process.stdout.write("\n=== 3. computeConcretenessAnchors: pure hype text ===\n");

test("'unprecedented AI attacks are exploding' → anchors=[], level=low, hype_flag=true", () => {
  const { anchors, concreteness_level, hype_flag } = computeConcretenessAnchors(
    "AI-powered attacks are at an unprecedented scale, posing critical risks to enterprises",
    "unprecedented surge in AI threats is alarming",
    [], []
  );
  assert.equal(anchors.length, 0, `expected empty anchors, got: ${JSON.stringify(anchors)}`);
  assert.equal(concreteness_level, "low", `expected low, got ${concreteness_level}`);
  assert.equal(hype_flag, true, `expected hype_flag=true`);
});

process.stdout.write("\n=== 4. computeConcretenessAnchors: CISA advisory ===\n");

test("CISA advisory text → anchors includes named_authority", () => {
  const { anchors, concreteness_level } = computeConcretenessAnchors(
    "CISA issued an advisory warning about LLM prompt injection attacks",
    "CISA Advisory AA24-131A warns of LLM exploitation",
    [], []
  );
  assert.ok(anchors.includes("named_authority"), `expected named_authority in anchors: ${JSON.stringify(anchors)}`);
  assert.ok(["moderate", "high"].includes(concreteness_level), `expected moderate or high, got ${concreteness_level}`);
});

process.stdout.write("\n=== 5. computeConcretenessAnchors: attack success rate ===\n");

test("attack success rate text → anchors includes attack_success_rate", () => {
  const { anchors } = computeConcretenessAnchors(
    "The attack success rate was 92% against the tested models",
    "92% ASR achieved against all baseline models",
    [], []
  );
  assert.ok(
    anchors.includes("attack_success_rate") || anchors.includes("measured_metric"),
    `expected attack_success_rate or measured_metric in anchors: ${JSON.stringify(anchors)}`
  );
});

// ── Section 2: Strength capping via triage ────────────────────────────────────

process.stdout.write("\n=== 6. Hype gate: hype_flag=true + concreteness_level=low + concrete_claim=false → context_only ===\n");

// applyHypeCap was removed 2026-06-17 (fake precision — penalized items with named CVEs
// by hype-count regex). The remaining hype gate in checkAdmissibility fires only when
// ALL three conditions hold: hype_flag=true, concreteness_level=low, AND the LLM says
// concrete_claim=false. When LLM says concrete_claim=true, the LLM judgment is trusted.
test("hype_flag=true + concreteness_level=low + LLM concrete_claim=false → admissibility=context_only", () => {
  const source = makeSource({ source_type: "threat_intelligence", trust_tier: "high" });
  const item = makeItem({
    source_quote: "AI threats are exploding at unprecedented scale",
    fact: "AI threats are at an unprecedented scale posing critical risks",
    entities: ["Acme Corp"],
    numbers: [],
    concreteness_level: "low",
    hype_flag: true,
    is_atomic: true,
    quote_verified: true,
  });
  const llm = {
    direct_demonstration: true,
    concrete_claim: false,  // LLM agrees: not a concrete claim
    source_type_fit: true,
    observed_use: false,
    limitations: [],
  };
  const triage = triageEvidenceItem(item, source, llm);
  // When LLM says concrete_claim=false AND hype_flag+low_concreteness, admissibility=context_only
  // → strength is "context", not "strong" or "usable"
  assert.notEqual(triage.evidence_strength, "strong",
    `expected non-strong strength, got ${triage.evidence_strength}`);
  assert.ok(["context", "usable"].includes(triage.evidence_strength),
    `expected context or usable, got ${triage.evidence_strength}`);
});

process.stdout.write("\n=== 7. High concreteness → allowed to be 'strong' ===\n");

test("concreteness_level=high + all strong conditions → allowed to be 'strong'", () => {
  const source = makeSource({ source_type: "vulnerability", trust_tier: "primary" });
  const item = makeItem({
    source_quote: "CVE-2024-99999 was exploited with 88% success rate by APT29 against GPT-4",
    fact: "CVE-2024-99999 exploited by APT29 against GPT-4 with 88% success rate",
    entities: ["APT29", "GPT-4"],
    numbers: ["88%"],
    concreteness_level: "high",
    hype_flag: false,
    is_atomic: true,
    quote_verified: true,
  });
  const llm = {
    direct_demonstration: true,
    concrete_claim: true,
    source_type_fit: true,
    observed_use: true,
    limitations: [],
  };
  const triage = triageEvidenceItem(item, source, llm);
  assert.equal(triage.evidence_strength, "strong",
    `expected strong, got ${triage.evidence_strength}. limitations: ${JSON.stringify(triage.limitations)}`);
  assert.ok(!triage.limitations.includes("hype_flag_caps_strength"),
    `unexpected hype_flag_caps_strength in limitations`);
});

// ── Section 3: Claim QA concreteness floor ────────────────────────────────────

process.stdout.write("\n=== 8. Claim QA: critical claim + all low-concreteness evidence → blocked ===\n");

test("critical claim + all evidence has concreteness_level=low → blocked", () => {
  const claim = {
    claim_type: "category_insight",
    claim_text: "AI threats are exploding and pose unprecedented risks to all organizations",
    claim_priority: "critical",
    confidence: "high",
  };
  const packets = [
    makePacket({ concreteness_level: "low" }),
    makePacket({ concreteness_level: "low", evidence_id: "ev_p_2" }),
  ];
  const audit = makeCorpusAudit();
  const result = qaAnalyticalClaim(claim, packets, audit);
  assert.equal(result.allowed_to_proceed, false,
    `expected blocked, got allowed_to_proceed=${result.allowed_to_proceed}`);
  assert.ok(
    result.blocking_reasons.some((r) => r.includes("claim_priority_exceeds_evidence_concreteness")),
    `expected claim_priority_exceeds_evidence_concreteness in blocking_reasons: ${JSON.stringify(result.blocking_reasons)}`
  );
});

process.stdout.write("\n=== 9. Claim QA: high priority + one moderate-concreteness evidence → allowed ===\n");

test("high priority claim + one moderate-concreteness evidence → allowed", () => {
  const claim = {
    claim_type: "category_insight",
    claim_text: "Prompt injection attacks on GPT-4 are increasingly documented in research",
    claim_priority: "high",
    confidence: "medium",
  };
  const packets = [
    makePacket({ concreteness_level: "low" }),
    makePacket({ concreteness_level: "moderate", evidence_id: "ev_p_2" }),
  ];
  const audit = makeCorpusAudit();
  const result = qaAnalyticalClaim(claim, packets, audit);
  assert.ok(
    !result.blocking_reasons.some((r) => r.includes("claim_priority_exceeds_evidence_concreteness")),
    `unexpected concreteness block: ${JSON.stringify(result.blocking_reasons)}`
  );
});

process.stdout.write("\n=== 10. Claim QA: medium priority + all low-concreteness evidence → allowed ===\n");

test("medium priority claim + all evidence has concreteness_level=low → allowed (medium is OK)", () => {
  const claim = {
    claim_type: "category_insight",
    claim_text: "AI threats continue to evolve in various categories",
    claim_priority: "medium",
    confidence: "low",
  };
  const packets = [
    makePacket({ concreteness_level: "low" }),
  ];
  const audit = makeCorpusAudit();
  const result = qaAnalyticalClaim(claim, packets, audit);
  assert.ok(
    !result.blocking_reasons.some((r) => r.includes("claim_priority_exceeds_evidence_concreteness")),
    `unexpected concreteness block on medium-priority claim: ${JSON.stringify(result.blocking_reasons)}`
  );
});

// ── Section 4: Hype detection in claim text ───────────────────────────────────

process.stdout.write("\n=== 11. Hype detection: claim text with 'unprecedented surge' → warning ===\n");

test("all-hype-flagged low-concreteness evidence → hype_language_warning", () => {
  // hype_language_warning triggers when ALL packets are hype_flag=true with low concreteness
  // (evidence-driven check, not claim-text regex — text-based hype check was removed).
  const claim = {
    claim_type: "category_insight",
    claim_text: "There is an unprecedented surge in AI-powered attacks threatening organizations",
    claim_priority: "medium",
    confidence: "medium",
  };
  const packets = [makePacket({ concreteness_level: "low", hype_flag: true })];
  const audit = makeCorpusAudit();
  const result = qaAnalyticalClaim(claim, packets, audit);
  assert.ok(
    result.hype_language_warning,
    `expected hype_language_warning to be set, got: ${JSON.stringify(result.hype_language_warning)}`
  );
  assert.equal(
    result.hype_language_warning.warning,
    "claim_backed_only_by_hype_flagged_low_concreteness_evidence",
    `expected warning key 'claim_backed_only_by_hype_flagged_low_concreteness_evidence'`
  );
});

process.stdout.write("\n=== 12. Hype detection: claim text with '88% ASR on GPT-4' → no warning ===\n");

test("claim text with '88% ASR on GPT-4' → no hype_language_warning", () => {
  const claim = {
    claim_type: "category_insight",
    claim_text: "Research achieved 88% ASR on GPT-4 using PAIR methodology",
    claim_priority: "medium",
    confidence: "medium",
  };
  const packets = [makePacket({ concreteness_level: "high" })];
  const audit = makeCorpusAudit();
  const result = qaAnalyticalClaim(claim, packets, audit);
  assert.ok(
    !result.hype_language_warning,
    `unexpected hype_language_warning: ${JSON.stringify(result.hype_language_warning)}`
  );
});

// ── Final summary ──────────────────────────────────────────────────────────────

process.stdout.write(`\n${"─".repeat(60)}\n`);
process.stdout.write(`Tests: ${passed + failed} total | ${passed} passed | ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
