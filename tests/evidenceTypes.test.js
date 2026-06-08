/**
 * Evidence type system tests — validates the 14-type cleaned model.
 *
 * Tests:
 *   - Removed types (timeline_event, statistic, strategic_signal, etc.) are rejected by QA
 *   - capability_delta requires explicit before/after comparison
 *   - exploit_chain requires ordered steps
 *   - benchmark_result requires a measurable number or metric
 *   - adversary_adoption requires an actor or observed-use signal
 *   - evidence_class and abstraction_level are assigned correctly
 *   - metric field is normalized from raw LLM output
 *   - type_justification is preserved through normalization
 *
 * Run with: node tests/evidenceTypes.test.js
 */

import assert from "node:assert/strict";
import {
  ALL_EVIDENCE_TYPES,
  EVIDENCE_TYPE_TO_CLASS,
  EVIDENCE_TYPE_TO_ABSTRACTION,
  EXTRACTION_PROFILES,
  getExtractionProfile,
  UNIVERSAL_EXTRACTION_RULES,
} from "../lib/pipeline/rawfact/evidenceExtractionProfiles.js";
import { normalizeSourceEvidenceItems } from "../lib/pipeline/rawfact/normalizeEvidenceItems.js";
import { qaEvidenceItems } from "../lib/pipeline/rawfact/qaEvidenceItems.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSource(overrides = {}) {
  return {
    id: "src_test",
    url: "https://example.com",
    source_type: "incident",
    trust_tier: "high",
    clean_text: "A ransomware group used AI-generated phishing emails to compromise healthcare systems. They previously relied on manual crafting. This is now automated at scale. The attack infected 3,000 endpoints.",
    evidence_eligibility: { evidence_use: "primary_evidence" },
    extraction_profile: getExtractionProfile("incident"),
    ...overrides,
  };
}

function makeRawItem(overrides = {}) {
  return {
    evidence_type:      "incident_event",
    fact:               "A ransomware group used AI-generated phishing emails to compromise healthcare systems.",
    display_label:      "AI phishing incident",
    source_quote:       "A ransomware group used AI-generated phishing emails to compromise healthcare systems.",
    type_justification: "This describes a confirmed real-world attack against healthcare systems.",
    entities:           ["ransomware group", "healthcare"],
    evidence_confidence:"high",
    best_used_for:      ["case_study"],
    event_date:         null,
    date_range:         null,
    metric:             null,
    ...overrides,
  };
}

function normalizeOne(rawItem, sourceOverrides = {}) {
  const source = makeSource({ evidence_items_raw: [rawItem], ...sourceOverrides });
  return normalizeSourceEvidenceItems(source).evidence_items;
}

function qaOne(item, sourceOverrides = {}) {
  const source = makeSource({
    evidence_items: [item],
    ...sourceOverrides,
  });
  const { sources } = qaEvidenceItems([source], []);
  return sources[0].evidence_items;
}

// ── Evidence type vocabulary ──────────────────────────────────────────────────
console.log("\nevidence type vocabulary");

test("ALL_EVIDENCE_TYPES has exactly 14 types", () => {
  assert.equal(ALL_EVIDENCE_TYPES.length, 14, `got ${ALL_EVIDENCE_TYPES.length}: ${ALL_EVIDENCE_TYPES.join(", ")}`);
});

test("removed types are absent: timeline_event, statistic, strategic_signal, ecosystem_shift, trust_boundary_shift", () => {
  const removed = ["timeline_event", "statistic", "strategic_signal", "ecosystem_shift", "trust_boundary_shift"];
  for (const t of removed) {
    assert.ok(!ALL_EVIDENCE_TYPES.includes(t), `${t} should not be in ALL_EVIDENCE_TYPES`);
  }
});

test("every type has an evidence_class", () => {
  for (const t of ALL_EVIDENCE_TYPES) {
    assert.ok(EVIDENCE_TYPE_TO_CLASS[t], `missing evidence_class for ${t}`);
  }
});

test("every type has an abstraction_level", () => {
  for (const t of ALL_EVIDENCE_TYPES) {
    assert.ok(EVIDENCE_TYPE_TO_ABSTRACTION[t], `missing abstraction_level for ${t}`);
  }
});

test("incident_event is observational/raw_fact", () => {
  assert.equal(EVIDENCE_TYPE_TO_CLASS["incident_event"], "observational");
  assert.equal(EVIDENCE_TYPE_TO_ABSTRACTION["incident_event"], "raw_fact");
});

test("capability_delta is technical/derived_observation", () => {
  assert.equal(EVIDENCE_TYPE_TO_CLASS["capability_delta"], "technical");
  assert.equal(EVIDENCE_TYPE_TO_ABSTRACTION["capability_delta"], "derived_observation");
});

// ── Normalization ─────────────────────────────────────────────────────────────
console.log("\nnormalization");

test("valid item is normalized with evidence_class and abstraction_level", () => {
  const items = normalizeOne(makeRawItem());
  assert.equal(items.length, 1);
  assert.equal(items[0].evidence_class, "observational");
  assert.equal(items[0].abstraction_level, "raw_fact");
});

test("type_justification is preserved through normalization", () => {
  const items = normalizeOne(makeRawItem({ type_justification: "It describes a real attack." }));
  assert.equal(items[0].type_justification, "It describes a real attack.");
});

test("metric is normalized from raw LLM output", () => {
  const items = normalizeOne(makeRawItem({
    evidence_type: "benchmark_result",
    fact: "The attack succeeded in 87% of trials against GPT-4.",
    source_quote: "The attack succeeded in 87% of trials against GPT-4.",
    metric: { name: "attack_success_rate", value: "87", unit: "%", context: "against GPT-4" },
  }), { source_type: "benchmark_evaluation", extraction_profile: getExtractionProfile("benchmark_evaluation") });
  assert.equal(items.length, 1);
  assert.ok(items[0].metric, "metric should be present");
  assert.equal(items[0].metric.name, "attack_success_rate");
  assert.equal(items[0].metric.unit, "%");
});

test("metric null when not provided", () => {
  const items = normalizeOne(makeRawItem());
  assert.equal(items[0].metric, null);
});

test("event_date is normalized from event_date field", () => {
  const items = normalizeOne(makeRawItem({ event_date: "2026-05-15" }));
  assert.equal(items[0].event_date, "2026-05-15");
});

test("event_date falls back to legacy date field", () => {
  const items = normalizeOne(makeRawItem({ date: "2026-03-01", event_date: undefined }));
  assert.equal(items[0].event_date, "2026-03-01");
});

test("timeline and stat_callout are removed from best_used_for", () => {
  const items = normalizeOne(makeRawItem({ best_used_for: ["case_study", "timeline", "stat_callout"] }));
  assert.ok(!items[0].best_used_for.includes("timeline"), "timeline should be stripped");
  assert.ok(!items[0].best_used_for.includes("stat_callout"), "stat_callout should be stripped");
  assert.ok(items[0].best_used_for.includes("case_study"), "case_study should remain");
});

test("unknown evidence_type is rejected by normalizer", () => {
  const items = normalizeOne(makeRawItem({ evidence_type: "timeline_event" }));
  assert.equal(items.length, 0, "timeline_event should be rejected");
});

test("statistic evidence_type is rejected by normalizer", () => {
  const items = normalizeOne(makeRawItem({ evidence_type: "statistic" }));
  assert.equal(items.length, 0);
});

test("strategic_signal evidence_type is rejected by normalizer", () => {
  const items = normalizeOne(makeRawItem({ evidence_type: "strategic_signal" }));
  assert.equal(items.length, 0);
});

// ── QA rules ─────────────────────────────────────────────────────────────────
console.log("\nQA rules");

function makeTriagedItem(overrides = {}) {
  return {
    evidence_id: "ev_test_1",
    source_id: "src_test",
    evidence_type: "incident_event",
    fact: "A ransomware group used AI-generated phishing emails to compromise healthcare systems.",
    source_quote: "A ransomware group used AI-generated phishing emails to compromise healthcare systems.",
    type_justification: "Confirmed attack against healthcare.",
    is_atomic: true,
    quote_verified: true,
    quote_match: "exact",
    entities: ["ransomware group"],
    numbers: [],
    metric: null,
    evidence_confidence: "high",
    best_used_for: ["case_study"],
    event_date: null,
    triage_data: { evidence_strength: "usable", admissibility: "passed", permitted_uses: ["case_study", "fact_support"], limitations: [] },
    ...overrides,
  };
}

test("strategic_signal in QA → removed", () => {
  const items = qaOne({ ...makeTriagedItem(), evidence_type: "strategic_signal" });
  assert.equal(items.length, 0);
});

test("ecosystem_shift in QA → removed", () => {
  const items = qaOne({ ...makeTriagedItem(), evidence_type: "ecosystem_shift" });
  assert.equal(items.length, 0);
});

test("timeline_event in QA → removed", () => {
  const items = qaOne({ ...makeTriagedItem(), evidence_type: "timeline_event" });
  assert.equal(items.length, 0);
});

test("capability_delta without comparison language → downgraded", () => {
  const item = makeTriagedItem({
    evidence_type: "capability_delta",
    fact: "Researchers demonstrated LLM-assisted phishing email generation at scale.",
    source_quote: "Researchers demonstrated LLM-assisted phishing email generation at scale.",
    triage_data: { evidence_strength: "strong", admissibility: "passed", permitted_uses: ["fact_support"], limitations: [] },
  });
  const items = qaOne(item, { source_type: "research_finding", extraction_profile: getExtractionProfile("research_finding") });
  // Should be downgraded, not removed
  assert.ok(items.length > 0, "item should survive (downgraded, not removed)");
  assert.ok(items[0].qa_issues?.includes("capability_delta_missing_comparison"), "should have comparison issue");
  assert.ok(items[0].triage_data.evidence_strength !== "strong", "should be downgraded from strong");
});

test("capability_delta with explicit comparison → passes QA", () => {
  const item = makeTriagedItem({
    evidence_type: "capability_delta",
    fact: "GPT-4 can now bypass guardrails that GPT-3.5 could not, enabling previously blocked content generation.",
    source_quote: "GPT-4 can now bypass guardrails that GPT-3.5 could not",
    entities: ["GPT-4", "GPT-3.5"],
    triage_data: { evidence_strength: "usable", admissibility: "passed", permitted_uses: ["fact_support"], limitations: [] },
  });
  const items = qaOne(item, { source_type: "research_finding", extraction_profile: getExtractionProfile("research_finding") });
  assert.equal(items.length, 1);
  assert.ok(!items[0].qa_issues?.includes("capability_delta_missing_comparison"));
});

test("exploit_chain without ordered steps → downgraded", () => {
  const item = makeTriagedItem({
    evidence_type: "exploit_chain",
    fact: "Attackers exploited a prompt injection vulnerability in the LLM-based assistant.",
    source_quote: "Attackers exploited a prompt injection vulnerability in the LLM-based assistant.",
    triage_data: { evidence_strength: "usable", admissibility: "passed", permitted_uses: ["case_study"], limitations: [] },
  });
  const items = qaOne(item, { source_type: "exploit_disclosure", extraction_profile: getExtractionProfile("exploit_disclosure") });
  assert.ok(items.length > 0);
  assert.ok(items[0].qa_issues?.includes("exploit_chain_no_ordered_steps"));
});

test("exploit_chain with ordered steps → passes QA", () => {
  const item = makeTriagedItem({
    evidence_type: "exploit_chain",
    fact: "Step 1: inject malicious instructions into retrieved docs; then the agent executes arbitrary commands.",
    source_quote: "Step 1: inject malicious instructions into retrieved docs; then the agent executes arbitrary commands.",
    triage_data: { evidence_strength: "usable", admissibility: "passed", permitted_uses: ["case_study"], limitations: [] },
  });
  const items = qaOne(item, { source_type: "exploit_disclosure", extraction_profile: getExtractionProfile("exploit_disclosure") });
  assert.equal(items.length, 1);
  assert.ok(!items[0].qa_issues?.includes("exploit_chain_no_ordered_steps"));
});

test("benchmark_result without number → downgraded", () => {
  const item = makeTriagedItem({
    evidence_type: "benchmark_result",
    fact: "The attack performed well against most models in the evaluation.",
    source_quote: "The attack performed well against most models in the evaluation.",
    numbers: [],
    metric: null,
    triage_data: { evidence_strength: "usable", admissibility: "passed", permitted_uses: ["trend_support"], limitations: [] },
  });
  const items = qaOne(item, { source_type: "benchmark_evaluation", extraction_profile: getExtractionProfile("benchmark_evaluation") });
  assert.ok(items.length > 0);
  assert.ok(items[0].qa_issues?.includes("benchmark_result_has_no_metric"));
});

test("adversary_adoption without actor or observed language → downgraded", () => {
  const item = makeTriagedItem({
    evidence_type: "adversary_adoption",
    fact: "AI-generated phishing campaigns could become widespread in 2026.",
    source_quote: "AI-generated phishing campaigns could become widespread in 2026.",
    entities: [],
    triage_data: { evidence_strength: "usable", admissibility: "passed", permitted_uses: ["trend_support"], limitations: [] },
  });
  const items = qaOne(item, { source_type: "threat_intelligence", extraction_profile: getExtractionProfile("threat_intelligence") });
  assert.ok(items.length > 0);
  assert.ok(items[0].qa_issues?.includes("adversary_adoption_no_actor_or_evidence"));
});

test("adversary_adoption with named actor → passes QA", () => {
  const item = makeTriagedItem({
    evidence_type: "adversary_adoption",
    fact: "APT29 was observed using LLM-generated spear-phishing emails in a 2026 campaign.",
    source_quote: "APT29 was observed using LLM-generated spear-phishing emails in a 2026 campaign.",
    entities: ["APT29"],
    triage_data: { evidence_strength: "usable", admissibility: "passed", permitted_uses: ["fact_support"], limitations: [] },
  });
  const items = qaOne(item, { source_type: "threat_intelligence", extraction_profile: getExtractionProfile("threat_intelligence") });
  assert.equal(items.length, 1);
  assert.ok(!items[0].qa_issues?.includes("adversary_adoption_no_actor_or_evidence"));
});

// ── Extraction profiles ───────────────────────────────────────────────────────
console.log("\nextraction profiles");

test("attack_surface_signal profile does not include ecosystem_shift or strategic_signal", () => {
  const profile = getExtractionProfile("attack_surface_signal");
  assert.ok(!profile.allowed_evidence_types.includes("ecosystem_shift"));
  assert.ok(!profile.allowed_evidence_types.includes("strategic_signal"));
  assert.ok(!profile.allowed_evidence_types.includes("trust_boundary_shift"));
});

test("every profile's allowed_evidence_types are all in ALL_EVIDENCE_TYPES", () => {
  const all = new Set(ALL_EVIDENCE_TYPES);
  for (const [sourceType, profile] of Object.entries(EXTRACTION_PROFILES)) {
    for (const t of profile.allowed_evidence_types) {
      assert.ok(all.has(t), `${sourceType} profile allows ${t} which is not in ALL_EVIDENCE_TYPES`);
    }
  }
});

test("universal extraction rules mention key type-specific restrictions", () => {
  assert.ok(/capability_delta/i.test(UNIVERSAL_EXTRACTION_RULES), "should mention capability_delta rule");
  assert.ok(/exploit_chain/i.test(UNIVERSAL_EXTRACTION_RULES), "should mention exploit_chain rule");
  assert.ok(/adversary_adoption/i.test(UNIVERSAL_EXTRACTION_RULES), "should mention adversary_adoption rule");
  assert.ok(/synthesis/i.test(UNIVERSAL_EXTRACTION_RULES), "should reference synthesis-layer prohibition");
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nEvidence types: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
