/**
 * L5 Evidence Hardening Tests
 *
 * Covers:
 *   1. Vendor hype source cannot create trend/adoption packet
 *   2. Cautious research source can create strong capability packet
 *   3. Unsupported quote demotes evidence
 *   4. Over-interpreted fact is corrected or blocked
 *   5. Medium-trust concrete incident gets deeper extraction
 *   6. Duplicate reporting does not inflate adoption analytics
 *   7. Analytics-only packet cannot support real-world factual claim
 *   8. Analytical hooks are preserved through normalization
 *   9. claim_permissions blocked_claim_types enforced for vendor/prediction
 *   10. AnalyticsEvidencePacket has corpus-scoped claim_permissions
 *   11. quote_entailment and required_caveats are derived
 *   12. Concreteness classifier correctly identifies source types
 *
 * Run: node tests/analysis/l5-evidence-hardening.test.js
 */

import assert from "node:assert/strict";
import { classifyFactSupport } from "../../lib/pipeline/rawfact/evidenceFactQa.js";
import { buildClaimPermissions } from "../../lib/pipeline/rawfact/buildClaimPermissions.js";
import { classifySourceConcreteness } from "../../lib/pipeline/rawfact/evidenceEligibility.js";
import { assessEvidenceEligibility } from "../../lib/pipeline/rawfact/evidenceEligibility.js";
import { makeEvidencePacket, makeAnalyticsEvidencePacket, validatePacket } from "../../lib/schemas/evidencePacketSchema.js";

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

function makeItem(overrides = {}) {
  return {
    evidence_id: "ev_test_001",
    source_id: "src_test",
    evidence_type: "research_result",
    fact: "GPT-4 was jailbroken with 88% ASR using PAIR methodology",
    source_quote: "we achieve an attack success rate of 88% on GPT-4 using PAIR",
    source_type: "research_finding",
    quote_verification: {
      quote_entailment: "supported",
      claim_preservation: "preserved",
    },
    hype_flag: false,
    limitations: [],
    triage_data: {
      evidence_strength: "usable",
      permitted_uses: ["capability_support", "fact_support"],
      observed_use: false,
    },
    ...overrides,
  };
}

function makeVendorItem(overrides = {}) {
  return makeItem({
    source_type: "research_finding",
    fact: "Threat actors are using AI-powered phishing at unprecedented scale",
    source_quote: "AI-enabled phishing campaigns are increasing at unprecedented scale",
    publisher_class: "major_vendor",
    independence_level: "vendor_interested",
    hype_flag: true,
    triage_data: {
      evidence_strength: "context",
      permitted_uses: ["context_only"],
      observed_use: false,
    },
    ...overrides,
  });
}

function makeResearchItem(overrides = {}) {
  return makeItem({
    source_type: "research_finding",
    fact: "Fine-tuning aligned models with 100 adversarial examples can restore unsafe behaviors",
    source_quote: "we demonstrate that fine-tuning with as few as 100 adversarial examples restores harmful behaviors",
    publisher_class: "academic",
    independence_level: "independent",
    hype_flag: false,
    triage_data: {
      evidence_strength: "strong",
      permitted_uses: ["capability_support", "fact_support", "outlook_input"],
      observed_use: false,
    },
    ...overrides,
  });
}

// ── 1. Vendor hype → blocked from adoption/trend ──────────────────────────────

process.stdout.write("\n1. Vendor hype source claim permissions\n");

test("vendor_marketing intent blocks adoption claim type", () => {
  const item = makeVendorItem();
  const factQa = classifyFactSupport(item);
  const perms = buildClaimPermissions(
    item, "research_finding", factQa,
    { intent_class: "vendor_marketing", commercial_interest: "high" }
  );
  assert.ok(perms.blocked_claim_types.includes("adoption"),
    `adoption not blocked: ${perms.blocked_claim_types.join(", ")}`);
  assert.ok(perms.blocked_claim_types.includes("trend_over_time"),
    "trend_over_time not blocked for vendor_marketing");
  assert.ok(perms.blocked_claim_types.includes("market_wide"),
    "market_wide not blocked for vendor_marketing");
});

test("vendor_marketing requires caveat in required_caveats", () => {
  const item = makeVendorItem();
  const factQa = classifyFactSupport(item);
  const perms = buildClaimPermissions(
    item, "research_finding", factQa,
    { intent_class: "vendor_marketing", commercial_interest: "high" }
  );
  assert.ok(perms.required_caveats.some((c) => c.includes("vendor")),
    "no vendor caveat in required_caveats");
});

test("speculative_blog intent blocks factual and adoption", () => {
  const item = makeItem({
    fact: "AI will enable cyberattacks at scale within 12 months",
    source_type: "research_finding",
    triage_data: { evidence_strength: "context", permitted_uses: ["context_only"] },
  });
  const factQa = classifyFactSupport(item);
  const perms = buildClaimPermissions(
    item, "research_finding", factQa,
    { intent_class: "speculative_blog" }
  );
  assert.ok(perms.blocked_claim_types.includes("factual"),
    "factual not blocked for speculative_blog");
  assert.ok(perms.blocked_claim_types.includes("adoption"),
    "adoption not blocked for speculative_blog");
});

// ── 2. Cautious research → strong capability ──────────────────────────────────

process.stdout.write("\n2. Cautious research source\n");

test("research_finding with strong triage permits capability", () => {
  const item = makeResearchItem();
  const factQa = classifyFactSupport(item);
  const perms = buildClaimPermissions(
    item, "research_finding", factQa,
    { intent_class: "primary_research", commercial_interest: "none" }
  );
  assert.ok(perms.permitted_claim_types.includes("capability"),
    `capability not permitted: ${perms.permitted_claim_types.join(", ")}`);
});

test("research_finding requires lab caveat when no observed_use", () => {
  const item = makeResearchItem({ triage_data: { evidence_strength: "strong", permitted_uses: ["capability_support"], observed_use: false } });
  const factQa = classifyFactSupport(item);
  const perms = buildClaimPermissions(item, "research_finding", factQa, null);
  assert.ok(perms.required_caveats.some((c) => c.includes("lab") || c.includes("research")),
    "no lab/research caveat for research_finding without observed_use");
});

test("research_finding does not permit adoption (no observed_use)", () => {
  const item = makeResearchItem();
  const factQa = classifyFactSupport(item);
  const perms = buildClaimPermissions(item, "research_finding", factQa, null);
  assert.ok(!perms.permitted_claim_types.includes("adoption"),
    "research_finding should not permit adoption without observed_use");
  assert.ok(perms.blocked_claim_types.includes("adoption"),
    "adoption should be blocked for research_finding without observed_use");
});

// ── 3. Unsupported quote demotes evidence ─────────────────────────────────────

process.stdout.write("\n3. Unsupported quote handling\n");

test("quote_entailment=none → fact_support blocked", () => {
  const item = makeItem({
    quote_verification: { quote_entailment: "unsupported", claim_preservation: "changed_meaning" },
    source_quote: "completely unrelated text",
    fact: "GPT-4 has a 95% success rate against safety filters",
  });
  const perms = buildClaimPermissions(item, "research_finding", classifyFactSupport(item), null);
  assert.ok(perms.blocked_claim_types.includes("factual"),
    "factual should be blocked when quote_entailment=none");
  assert.ok(perms.blocked_claim_types.includes("case_study"),
    "case_study should be blocked when quote_entailment=none");
});

test("classifyFactSupport returns support_level=unsupported for missing quote", () => {
  const item = makeItem({
    source_quote: "",
    fact: "AI attacks have tripled in the last year",
    quote_verification: { quote_entailment: "unsupported" },
  });
  const qa = classifyFactSupport(item);
  assert.ok(["unsupported", "vendor_claim", "prediction"].includes(qa.support_level),
    `expected unsupported/vendor/prediction, got ${qa.support_level}`);
});

test("quote_entailment field is returned by classifyFactSupport", () => {
  // quote_entailment is derived from triage_judgment.quote_support (LLM field).
  // quote_verification.quote_entailment was a mechanical overlap check (removed).
  // To get "direct" entailment, the LLM must set quote_support="directly_supports".
  const item = makeItem({
    triage_judgment: { quote_support: "directly_supports", support_level: "research_finding" },
  });
  const qa = classifyFactSupport(item);
  assert.ok(qa.quote_entailment, "quote_entailment not returned");
  assert.ok(["direct", "partial", "weak", "none"].includes(qa.quote_entailment),
    `invalid quote_entailment value: ${qa.quote_entailment}`);
  assert.equal(qa.quote_entailment, "direct", "directly_supports should map to direct");
});

// ── 4. Over-interpreted fact is corrected ─────────────────────────────────────

process.stdout.write("\n4. Over-interpretation handling\n");

test("adoption language with research-scope quote is over_interpreted", () => {
  // over_interpreted is derived from triage_judgment.quote_support="overstates_scope"
  // (the LLM detects scope mismatch; deterministic path has no regex for this).
  const item = makeItem({
    fact: "Adversaries are deploying AI-powered attacks in production against enterprises",
    source_quote: "we demonstrate that AI could be used by attackers to improve phishing",
    triage_judgment: { quote_support: "overstates_scope" },
  });
  const qa = classifyFactSupport(item);
  assert.equal(qa.over_interpreted, true, "adoption language + research scope quote should be over_interpreted");
});

test("corrected_fact_text hedges over-interpreted adoption language", () => {
  const item = makeItem({
    fact: "Adversaries are deploying AI-powered attacks in production",
    source_quote: "researchers demonstrate that AI could be used by attackers",
  });
  const qa = classifyFactSupport(item);
  if (qa.over_interpreted) {
    assert.notEqual(qa.corrected_fact_text, item.fact, "corrected text should differ from original");
    // Corrected text should remove definitive adoption language
    assert.ok(
      !qa.corrected_fact_text.includes("are deploying") ||
      qa.corrected_fact_text.includes("may") ||
      qa.corrected_fact_text.includes("research suggests") ||
      qa.corrected_fact_text.includes("could"),
      "corrected text should hedge adoption language"
    );
  }
});

test("required_caveats includes fact-hedging caveat when over_interpreted", () => {
  const item = makeItem({
    fact: "Adversaries are deploying AI phishing tools in production environments",
    source_quote: "researchers demonstrate potential for AI-assisted phishing campaigns",
  });
  const qa = classifyFactSupport(item);
  if (qa.over_interpreted) {
    assert.ok(qa.required_caveats.some((c) => c.includes("hedged") || c.includes("corrected")),
      "no hedging caveat for over_interpreted item");
  }
});

// ── 5. Concreteness classification (debug metadata) ───────────────────────────
// extraction_depth_hint is always "standard" (removed 2026-06-17: was semantic grading).
// concreteness_class is still computed for debug observability but does NOT affect
// evidence_use or extraction depth.

process.stdout.write("\n5. Concreteness classification (debug metadata only)\n");

test("concrete_operational source classified correctly (debug label)", () => {
  const source = {
    source_type: "incident",
    trust_tier: "medium",
    title: "Russian APT29 breached SolarWinds supply chain using CVE-2024-12345",
    full_text: "APT29 threat actors exploited CVE-2024-12345 to compromise SolarWinds Orion, affecting thousands of organizations. The breach was confirmed and attributed to APT29.",
  };
  const result = classifySourceConcreteness(source);
  assert.equal(result.concreteness_class, "concrete_operational",
    `expected concrete_operational, got ${result.concreteness_class}`);
  // extraction_depth_hint removed — no longer set by classifySourceConcreteness
});

test("marketing source classified as vague_commentary (debug label; no longer marketing_or_prediction)", () => {
  // marketing_or_prediction class removed (2026-06-17): semantic grading by regex.
  // Marketing language detection moved to LLM (triage_judgment.support_level).
  const source = {
    source_type: "research_finding",
    trust_tier: "high",
    title: "Announcing Our Revolutionary AI Security Solution",
    full_text: "Our platform provides best-in-class protection against AI threats. Sign up for a free trial today.",
  };
  const result = classifySourceConcreteness(source);
  // Without concrete anchors (CVE, named model, metric), falls to vague_commentary
  assert.equal(result.concreteness_class, "vague_commentary",
    `expected vague_commentary (no concrete anchors), got ${result.concreteness_class}`);
  // extraction_depth_hint no longer returned
  assert.ok(!result.extraction_depth_hint, "extraction_depth_hint must not be set");
});

test("concrete research with metrics classified correctly (debug label)", () => {
  const source = {
    source_type: "research_finding",
    trust_tier: "high",
    title: "Jailbreaking GPT-4 with 88% attack success rate using PAIR methodology",
    full_text: "We propose PAIR methodology and evaluate it against GPT-4. Our experiment achieves 88% ASR across 10 safety categories.",
  };
  const result = classifySourceConcreteness(source);
  assert.equal(result.concreteness_class, "concrete_research",
    `expected concrete_research, got ${result.concreteness_class}`);
});

test("medium-trust concrete incident gets primary_evidence use (structural gate)", () => {
  const source = {
    source_type: "incident",
    trust_tier: "medium",
    layer3_status: "pass",
    relevance_tier: "core",
    main_category: "llm_threats",
    title: "APT29 exploited CVE-2024-12345 in SolarWinds attack",
    full_text: "APT29 breached SolarWinds using CVE-2024-12345. The incident compromised thousands of systems.",
  };
  const result = assessEvidenceEligibility(source);
  // Incident + medium trust → primary_evidence (structural, not semantic)
  assert.equal(result.evidence_eligibility.evidence_use, "primary_evidence",
    `medium-trust incident should be primary_evidence, got ${result.evidence_eligibility.evidence_use}`);
  // concreteness_class is debug metadata; extraction_depth_hint is always "standard"
  assert.equal(result.evidence_eligibility.extraction_depth_hint, "standard",
    `extraction_depth_hint must be standard (semantic depth hints removed)`);
});

test("vague commentary does not elevate evidence_use to primary", () => {
  const source = {
    source_type: "research_finding",
    trust_tier: "high",
    layer3_status: "pass",
    relevance_tier: "core",
    main_category: "llm_threats",
    title: "The Future of AI Security: What to Watch in 2026",
    full_text: "AI threats are evolving rapidly. Organizations must prepare for the next wave of attacks. Security teams should be aware of emerging trends.",
  };
  const result = assessEvidenceEligibility(source);
  // Vague commentary with no concrete anchors should not get extraction_depth_hint=deep
  assert.notEqual(result.evidence_eligibility.extraction_depth_hint, "deep",
    "vague commentary should not get deep extraction");
  assert.ok(
    ["vague_commentary", "marketing_or_prediction"].includes(result.evidence_eligibility.concreteness_class),
    `expected vague/marketing, got ${result.evidence_eligibility.concreteness_class}`
  );
});

// ── 6. Duplicate reporting does not inflate adoption analytics ────────────────

process.stdout.write("\n6. Duplicate reporting deduplication\n");

test("features sharing primary_origin_url are flagged as duplicate_reporting", () => {
  // Simulate what analyticsAggregation does with the flagDuplicateReporting function
  function flagDuplicateReporting(features) {
    const originCounts = {};
    for (const f of features) {
      const key = f.primary_origin_url || null;
      if (key) originCounts[key] = (originCounts[key] || 0) + 1;
    }
    return features.map((f) => ({
      ...f,
      duplicate_reporting: !!(f.primary_origin_url && (originCounts[f.primary_origin_url] || 1) > 1),
      origin_cluster_id: f.primary_origin_url || null,
    }));
  }

  const features = [
    { source_id: "src_001", primary_origin_url: "https://original.com/report-1", adversary_adoption_stage: "emerging_use", source_type: "threat_intelligence", main_category: "llm_threats", attack_vectors: [] },
    { source_id: "src_002", primary_origin_url: "https://original.com/report-1", adversary_adoption_stage: "emerging_use", source_type: "threat_intelligence", main_category: "llm_threats", attack_vectors: [] },
    { source_id: "src_003", primary_origin_url: "https://other.com/report-2", adversary_adoption_stage: "proof_of_concept", source_type: "incident", main_category: "llm_threats", attack_vectors: [] },
  ];

  const deduped = flagDuplicateReporting(features);
  const duplicates = deduped.filter((f) => f.duplicate_reporting);
  assert.equal(duplicates.length, 2, `expected 2 duplicates (both from same origin), got ${duplicates.length}`);
  assert.equal(deduped.filter((f) => !f.duplicate_reporting).length, 1, "only 1 item should be primary");
});

// ── 7. Analytics-only packet cannot support real-world claims ────────────────

process.stdout.write("\n7. Analytics packet claim permissions\n");

test("AnalyticsEvidencePacket has blocked factual, adoption, market_wide", () => {
  const packet = makeAnalyticsEvidencePacket({
    evidence_type: "analytics_trend",
    content: { summary: "12 of 15 sources discuss prompt injection" },
    provenance: {
      computation_method: "count_by_field",
      aggregation_logic: "count sources per category",
      input_evidence_ids: ["ev_001", "ev_002"],
    },
  });
  assert.ok(packet.claim_permissions, "claim_permissions missing from analytics packet");
  const blocked = packet.claim_permissions.blocked_claim_types;
  assert.ok(blocked.includes("factual"), "factual not blocked in analytics packet");
  assert.ok(blocked.includes("adoption"), "adoption not blocked in analytics packet");
  assert.ok(blocked.includes("market_wide"), "market_wide not blocked in analytics packet");
});

test("AnalyticsEvidencePacket permits corpus_scoped_pattern", () => {
  const packet = makeAnalyticsEvidencePacket({
    evidence_type: "analytics_metric",
    content: { summary: "Frequency distribution" },
    provenance: {
      computation_method: "count_by_field",
      aggregation_logic: "count",
      input_evidence_ids: [],
    },
  });
  const permitted = packet.claim_permissions.permitted_claim_types;
  assert.ok(permitted.includes("corpus_scoped_pattern"),
    "corpus_scoped_pattern not in permitted types for analytics packet");
});

test("AnalyticsEvidencePacket has corpus_scoped_only in limitations", () => {
  const packet = makeAnalyticsEvidencePacket({
    evidence_type: "analytics_metric",
    content: { summary: "Attack vector frequency" },
    provenance: {
      computation_method: "count_by_field",
      aggregation_logic: "count",
      input_evidence_ids: [],
    },
  });
  assert.ok(
    packet.claim_relevance.limitations.includes("corpus_scoped_only"),
    "corpus_scoped_only not in analytics packet limitations"
  );
});

// ── 8. Analytical hooks preserved through normalization ───────────────────────

process.stdout.write("\n8. Analytical hooks\n");

test("EvidencePacket schema includes analytical_hooks object", () => {
  const packet = makeEvidencePacket({
    source_id: "src_001",
    evidence_type: "research_finding",
    content: { summary: "Research finding about LLM jailbreaks" },
    provenance: { extraction_layer: "L5A", url: "https://example.com" },
    analytical_hooks: {
      why_this_may_matter: "Changes the threat model for LLM safety",
      what_changed: "Attack success rate rose from 23% to 88%",
      novelty_signal: "First gradient-based automated jailbreak demonstrated",
      assumption_challenged: "Challenges assumption that RLHF provides robust safety",
      implication_candidates: ["RLHF safety may be insufficient for production deployments"],
    },
  });
  assert.ok(packet.analytical_hooks, "analytical_hooks missing from EvidencePacket");
  assert.equal(packet.analytical_hooks.what_changed, "Attack success rate rose from 23% to 88%");
  assert.equal(packet.analytical_hooks.assumption_challenged,
    "Challenges assumption that RLHF provides robust safety");
  assert.ok(Array.isArray(packet.analytical_hooks.implication_candidates), "implication_candidates should be array");
});

test("analytical_hooks defaults are all null/empty", () => {
  const packet = makeEvidencePacket({
    source_id: "src_001",
    evidence_type: "research_finding",
    content: { summary: "test" },
    provenance: { extraction_layer: "L5A" },
  });
  assert.strictEqual(packet.analytical_hooks.why_this_may_matter, null);
  assert.strictEqual(packet.analytical_hooks.what_changed, null);
  assert.deepEqual(packet.analytical_hooks.implication_candidates, []);
  assert.deepEqual(packet.analytical_hooks.uncertainty_notes, []);
});

// ── 9. Claim permissions for incident (operational) sources ──────────────────

process.stdout.write("\n9. Incident source claim permissions\n");

test("incident source permits adoption when LLM-reviewed and triage has adoption_support", () => {
  // LLM must review the item (triage_judgment present) for adoption_support to be load-bearing.
  // Without LLM judgment, classifyFactSupport returns fallback_unreviewed which blocks adoption.
  const item = makeItem({
    source_type: "incident",
    fact: "APT29 used AI-generated spear-phishing in the SolarWinds campaign",
    source_quote: "APT29 operators used AI-generated spear-phishing emails in the campaign",
    triage_data: {
      evidence_strength: "strong",
      permitted_uses: ["fact_support", "case_study", "adoption_support", "trend_input"],
      observed_use: true,
    },
    triage_judgment: {  // LLM review present → support_level is authoritative
      quote_support: "directly_supports",
      support_level: "direct_fact",
      direct_demonstration: true,
      concrete_claim: true,
      observed_use: true,
      limitations: [],
    },
  });
  const factQa = classifyFactSupport(item);
  const perms = buildClaimPermissions(item, "incident", factQa, { intent_class: "incident_report" });
  assert.ok(perms.permitted_claim_types.includes("adoption"),
    `adoption not permitted for LLM-reviewed incident with adoption_support: ${perms.permitted_claim_types.join(", ")}`);
  assert.ok(!perms.blocked_claim_types.includes("adoption"),
    "adoption should not be blocked for LLM-reviewed incident");
});

// ── 10. Visual classification ─────────────────────────────────────────────────

process.stdout.write("\n10. Visual ref classification\n");

import { makeVisualRef } from "../../lib/schemas/evidencePacketSchema.js";

test("makeVisualRef includes visual_type, visual_usefulness, visual_role", () => {
  const visual = makeVisualRef({
    visual_type: "chart",
    visual_usefulness: "high",
    visual_role: "data_bearing",
    data_backing_ids: ["ev_001", "ev_002"],
    source_evidence_id: "ev_001",
    caption_or_context: "Attack success rates by model family",
    provenance_url: "https://arxiv.org/fig1",
  });
  assert.equal(visual.visual_type, "chart");
  assert.equal(visual.visual_usefulness, "high");
  assert.equal(visual.visual_role, "data_bearing");
  assert.deepEqual(visual.data_backing_ids, ["ev_001", "ev_002"]);
});

test("decorative visual has decorative role and low usefulness", () => {
  const decorative = makeVisualRef({
    visual_type: "decorative",
    visual_usefulness: "decorative",
    visual_role: "decorative",
    source_evidence_id: "ev_001",
    caption_or_context: "Stock photo of cybersecurity",
  });
  assert.equal(decorative.visual_usefulness, "decorative");
  assert.equal(decorative.visual_role, "decorative");
});

// ── Summary ───────────────────────────────────────────────────────────────────

process.stdout.write(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
