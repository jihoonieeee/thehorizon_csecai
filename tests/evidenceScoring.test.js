/**
 * Evidence scoring tests — source_type-aware criticality gates.
 * No network, no DB. Run with: node tests/evidenceScoring.test.js
 */

import assert from "node:assert/strict";
import { scoreEvidenceItem } from "../lib/pipeline/rawfact/scoreEvidenceItems.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSource(overrides = {}) {
  return {
    id:           "src_test",
    url:          "https://example.com/article",
    trust_tier:   "high",
    source_type:  "incident",
    date_published: new Date(Date.now() - 7 * 86_400_000).toISOString(), // 7 days ago
    rawfact_taxonomy: { operational_relevance: "high", novelty: "known_tactic" },
    ...overrides,
  };
}

function makeItem(overrides = {}) {
  return {
    evidence_id:       "ev_test_0",
    source_id:         "src_test",
    evidence_type:     "incident_event",
    fact:              "Ransomware group compromised 3 healthcare systems using AI-generated spear-phishing emails.",
    source_quote:      "The group used AI-generated spear-phishing emails to compromise three healthcare systems.",
    quote_verified:    true,
    is_atomic:         true,
    evidence_confidence: "high",
    entities:          ["ransomware group", "healthcare"],
    numbers:           ["3 healthcare systems"],
    evidence_cluster:  null,
    ...overrides,
  };
}

function score(itemOverrides = {}, sourceOverrides = {}, applyDuplicate = false) {
  return scoreEvidenceItem(makeItem(itemOverrides), makeSource(sourceOverrides), applyDuplicate);
}

// ── 1. Incident with confirmed impact → critical ───────────────────────────────
console.log("\nincident sources");

test("confirmed incident with entities and numbers → critical", () => {
  const result = score(
    { evidence_type: "incident_event", entities: ["ransomware group"], numbers: ["3 healthcare systems"] },
    { source_type: "incident", trust_tier: "high", rawfact_taxonomy: { operational_relevance: "very_high", novelty: "known_tactic" } },
  );
  assert.equal(result.score_data.evidence_priority, "critical",
    `Expected critical, got ${result.score_data.evidence_priority}. Explanation: ${result.score_data.scoring_explanation.final_band_reason}`);
  assert.ok(result.score_data.scoring_explanation.criticality_path_passed?.startsWith("incident:"));
});

test("incident with no entities and no numbers → not critical", () => {
  const result = score(
    { evidence_type: "incident_event", entities: [], numbers: [], fact: "A security incident occurred affecting AI systems." },
    { source_type: "incident", trust_tier: "high" },
  );
  assert.notEqual(result.score_data.evidence_priority, "critical");
  assert.equal(result.score_data.scoring_explanation.criticality_path_passed, null);
});

test("incident with threat_actor_activity type and entities → critical allowed", () => {
  const result = score(
    { evidence_type: "threat_actor_activity", entities: ["APT41", "financial sector"], numbers: [] },
    { source_type: "incident", trust_tier: "primary", rawfact_taxonomy: { operational_relevance: "very_high", novelty: "new_tactic" } },
  );
  assert.equal(result.score_data.scoring_explanation.criticality_path_passed, "incident:confirmed_real_world_impact");
});

// ── 2. Research finding — no operational pathway → high, not critical ─────────
console.log("\nresearch_finding sources");

test("research finding with no numbers → cannot be critical (path blocked)", () => {
  const result = score(
    { evidence_type: "research_result", entities: ["GPT-4"], numbers: [],
      fact: "Researchers demonstrated a novel prompt injection attack chain against tool-using LLM agents." },
    { source_type: "research_finding", trust_tier: "high",
      rawfact_taxonomy: { operational_relevance: "medium", novelty: "new_attack_surface" } },
  );
  assert.notEqual(result.score_data.evidence_priority, "critical",
    `Must not be critical when no numbers. Got: ${result.score_data.evidence_priority}`);
  assert.equal(result.score_data.scoring_explanation.criticality_path_passed, null,
    "Criticality path must not pass without numbers");
});

test("research finding with numbers + new_attack_surface + high op_rel → critical allowed", () => {
  const result = score(
    { evidence_type: "research_result", entities: ["Claude", "tool-use"], numbers: ["94% success rate"],
      fact: "94% of Claude tool-use calls were hijacked by prompt injection in the tested configuration." },
    { source_type: "research_finding", trust_tier: "high",
      rawfact_taxonomy: { operational_relevance: "high", novelty: "new_attack_surface" } },
  );
  assert.equal(result.score_data.scoring_explanation.criticality_path_passed, "research:empirical_with_operational_pathway",
    `Expected path to pass. Explanation: ${result.score_data.scoring_explanation.final_band_reason}`);
});

test("research finding that is purely theoretical → low operationalization score", () => {
  const result = score(
    { evidence_type: "research_result", entities: [], numbers: ["42% reduction"],
      fact: "In a lab setting, the theoretical attack reduced model accuracy by 42% in principle, though not yet operationalized." },
    { source_type: "research_finding", trust_tier: "medium",
      rawfact_taxonomy: { operational_relevance: "medium", novelty: "new_tactic" } },
  );
  // Operationalization score should be reduced by the "lab setting / in principle / not yet" phrases
  const dims = result.score_data.score_breakdown;
  assert.ok((dims.operationalization_likelihood ?? 0) < 60,
    `Expected low operationalization likelihood, got ${dims.operationalization_likelihood}`);
});

// ── 3. Exploit disclosure with reproducible method → critical/high ────────────
console.log("\nexploit_disclosure sources");

test("exploit_chain type from high-trust source → critical", () => {
  const result = score(
    { evidence_type: "exploit_chain", entities: ["GPT-4 API"], numbers: [],
      fact: "A working jailbreak using base64-encoded adversarial prompts bypasses GPT-4 safety guardrails with 100% consistency." },
    { source_type: "exploit_disclosure", trust_tier: "high",
      rawfact_taxonomy: { operational_relevance: "very_high", novelty: "new_tactic" } },
  );
  assert.equal(result.score_data.scoring_explanation.criticality_path_passed, "exploit_disclosure:reproducible_method");
});

test("exploit_disclosure with unknown low-trust source → hard gate archive", () => {
  const result = score(
    { evidence_type: "exploit_chain", entities: ["GPT-4"], numbers: [],
      fact: "Researcher shows bypass working on major LLM API." },
    { source_type: "unknown", trust_tier: "low" },
  );
  assert.equal(result.score_data.evidence_priority, "archive_only");
  assert.ok(result.score_data.penalty_reasons.includes("unknown_low_trust_source"));
});

// ── 4. Governance signal → high, critical rare ────────────────────────────────
console.log("\ngovernance_signal sources");

test("governance signal is capped at high regardless of score", () => {
  const result = score(
    { evidence_type: "governance_action", entities: ["NIST", "AI RMF"], numbers: [],
      fact: "NIST AI RMF mandates adversarial ML testing for federal AI systems starting Q1 2026." },
    { source_type: "governance_signal", trust_tier: "primary",
      rawfact_taxonomy: { operational_relevance: "high", novelty: "known_tactic_new_scale" } },
  );
  assert.notEqual(result.score_data.evidence_priority, "critical",
    "Governance signal should never reach critical through scoring alone");
  assert.equal(result.score_data.scoring_explanation.criticality_path_passed, null);
  assert.ok(
    ["high", "medium", "low", "archive_only"].includes(result.score_data.evidence_priority)
  );
});

// ── 5. Benchmark with strong numeric result → high; critical for anchor ────────
console.log("\nbenchmark_evaluation sources");

test("benchmark with numeric result → critical via path", () => {
  const result = score(
    { evidence_type: "benchmark_result", entities: ["GPT-4o", "HarmBench"], numbers: ["88% attack success rate"],
      fact: "GPT-4o scored 88% attack success rate on HarmBench jailbreak benchmark, up from 62% in 2024." },
    { source_type: "benchmark_evaluation", trust_tier: "high",
      rawfact_taxonomy: { operational_relevance: "high", novelty: "known_tactic_new_scale" } },
  );
  assert.equal(result.score_data.scoring_explanation.criticality_path_passed, "benchmark:headline_quantitative_anchor");
});

test("benchmark without numbers → cannot be critical", () => {
  const result = score(
    { evidence_type: "benchmark_result", entities: ["GPT-4"], numbers: [],
      fact: "The benchmark shows GPT-4 is vulnerable to adversarial examples in multiple domains." },
    { source_type: "benchmark_evaluation", trust_tier: "high",
      rawfact_taxonomy: { operational_relevance: "high", novelty: "known_tactic" } },
  );
  assert.notEqual(result.score_data.evidence_priority, "critical");
  assert.equal(result.score_data.scoring_explanation.criticality_path_passed, null);
});

// ── 6. Duplicated evidence → score downgraded ────────────────────────────────
console.log("\nduplicate penalty");

test("non-representative cluster member score is reduced by 10", () => {
  const itemWithCluster = {
    evidence_cluster: { is_multi_source: true, is_representative: false, cluster_size: 3, cluster_id: "cl_1" },
  };
  const noCluster = {
    evidence_cluster: { is_multi_source: true, is_representative: true, cluster_size: 3, cluster_id: "cl_1" },
  };

  const representative    = score(noCluster, {}, true);
  const nonRepresentative = score(itemWithCluster, {}, true);

  assert.ok(
    representative.score_data.evidence_score > nonRepresentative.score_data.evidence_score,
    `Representative (${representative.score_data.evidence_score}) should score higher than non-representative (${nonRepresentative.score_data.evidence_score})`
  );
  assert.ok(nonRepresentative.score_data.penalty_reasons.includes("duplicate(-10)"));
});

test("duplicate penalty not applied in first pass", () => {
  const nonRep = score(
    { evidence_cluster: { is_multi_source: true, is_representative: false, cluster_size: 3 } },
    {}, false, // applyDuplicatePenalty = false
  );
  assert.ok(!nonRep.score_data.penalty_reasons.includes("duplicate(-10)"),
    "Duplicate penalty should not appear in first pass");
});

// ── 7. Unverified quote → hard gate → archive_only ───────────────────────────
console.log("\nunverified quote gate");

test("quote_verified=false with checkable source → archive_only via hard gate", () => {
  const result = score({
    quote_verified: false,
    quote_match:    "no_overlap",
    fact:           "GPT-4 was exploited in a real-world attack on a financial institution's AI chatbot.",
  });
  assert.equal(result.score_data.evidence_priority, "archive_only");
  assert.ok(result.score_data.penalty_reasons.includes("unverified_quote"));
});

test("quote_verified=false with no_source match → not archived for unverified_quote", () => {
  const result = score({
    quote_verified: false,
    quote_match:    "no_source",
    fact:           "AI-enabled phishing kits were sold on underground markets for as low as 40 USD.",
    entities:       ["underground market"],
    numbers:        ["40 USD"],
  });
  assert.notEqual(result.score_data.evidence_priority, "archive_only",
    "no_source match should not trigger the unverified_quote hard gate");
  assert.ok(!result.score_data.penalty_reasons.includes("unverified_quote"));
});

test("quote_verified=null/undefined → not penalised", () => {
  const result = score({ quote_verified: undefined, quote_match: undefined });
  assert.ok(result.score_data.evidence_priority !== "archive_only" ||
            !result.score_data.penalty_reasons.includes("unverified_quote"));
});

// ── 8. Unknown low-trust source → archive_only ───────────────────────────────
console.log("\nunknown low-trust sources");

test("unknown source_type + low trust_tier → hard gate archive", () => {
  const result = score({}, { source_type: "unknown", trust_tier: "low" });
  assert.equal(result.score_data.evidence_priority, "archive_only");
  assert.ok(result.score_data.penalty_reasons.includes("unknown_low_trust_source"));
});

test("unknown source_type + medium trust → not archived by unknown_low_trust gate", () => {
  const result = score(
    { evidence_type: "incident_event", entities: ["bank"], numbers: ["50M affected"],
      fact: "A major bank reported AI-enabled fraud affecting 50 million accounts." },
    { source_type: "unknown", trust_tier: "medium",
      rawfact_taxonomy: { operational_relevance: "high", novelty: "known_tactic" } },
  );
  assert.ok(!result.score_data.penalty_reasons.includes("unknown_low_trust_source"));
});

test("unknown source_type is capped at medium", () => {
  const result = score(
    { evidence_type: "incident_event", entities: ["bank"], numbers: ["50M affected"],
      fact: "A major bank reported AI-enabled fraud affecting 50 million accounts." },
    { source_type: "unknown", trust_tier: "primary",
      rawfact_taxonomy: { operational_relevance: "very_high", novelty: "new_attack_surface" } },
  );
  assert.ok(["medium", "low", "archive_only"].includes(result.score_data.evidence_priority),
    `Unknown source_type should be capped at medium, got ${result.score_data.evidence_priority}`);
});

// ── 9. Evidence role classification ──────────────────────────────────────────
console.log("\nevidence role classification");

test("incident_event type → real_world_incident role", () => {
  const result = score({ evidence_type: "incident_event" });
  assert.equal(result.evidence_role, "real_world_incident");
});

test("benchmark_result type → quantitative_anchor role", () => {
  const result = score({ evidence_type: "benchmark_result" }, { source_type: "benchmark_evaluation", trust_tier: "high" });
  assert.equal(result.evidence_role, "quantitative_anchor");
});

test("exploit_chain type → exploitability_signal role", () => {
  const result = score({ evidence_type: "exploit_chain" }, { source_type: "exploit_disclosure" });
  assert.equal(result.evidence_role, "exploitability_signal");
});

// ── 10. Scoring explanation always present ────────────────────────────────────
console.log("\nscoring explanation fields");

test("every scored item has a scoring_explanation object", () => {
  const result = score();
  assert.ok(result.score_data.scoring_explanation, "scoring_explanation should be present");
  const exp = result.score_data.scoring_explanation;
  assert.ok(typeof exp.source_type === "string", "source_type field present");
  assert.ok(typeof exp.evidence_role === "string", "evidence_role field present");
  assert.ok(Array.isArray(exp.key_positive_signals), "key_positive_signals array present");
  assert.ok(Array.isArray(exp.downgrade_reasons), "downgrade_reasons array present");
  assert.ok(typeof exp.final_band_reason === "string", "final_band_reason field present");
});

test("hard gate failure also produces scoring_explanation", () => {
  const result = score({ fact: "" }); // too short — triggers fact_too_short gate
  const exp = result.score_data.scoring_explanation;
  assert.ok(exp, "scoring_explanation present even after hard gate failure");
  assert.ok(exp.final_band_reason.includes("Failed hard gate"), `Got: ${exp.final_band_reason}`);
});

// ── 11. Speculative language gate ─────────────────────────────────────────────
console.log("\nspeculative language gate");

test("speculative modal in fact → archive via hard gate", () => {
  const result = score({
    fact: "AI could be used to generate convincing deepfakes targeting corporate executives.",
    entities: ["executives"], numbers: [],
  });
  assert.equal(result.score_data.evidence_priority, "archive_only");
  assert.ok(result.score_data.penalty_reasons.includes("speculative_language"));
});

test("fact with non-speculative 'could' in entity name → not archived for speculation", () => {
  // "could" as part of a name, not a modal
  const result = score({
    fact: "The McCloud Institute published research on AI-enabled phishing success rates reaching 73%.",
    entities: ["McCloud Institute"], numbers: ["73%"],
  });
  // "McCloud" contains "could" but is not a modal — should not trigger speculative gate
  assert.ok(result.score_data.evidence_priority !== "archive_only" ||
            !result.score_data.penalty_reasons.includes("speculative_language"),
    `Regex should not match 'could' in a proper noun`);
});

// ── 12. Source type max band enforcement ──────────────────────────────────────
console.log("\nsource type max band caps");

test("defensive_capability is capped at high", () => {
  const result = score(
    { evidence_type: "defensive_control", entities: ["CISA", "EDR"], numbers: ["99% detection"],
      fact: "CISA's new AI-aware EDR signatures achieved 99% detection of AI-generated malware samples in testing." },
    { source_type: "defensive_capability", trust_tier: "primary",
      rawfact_taxonomy: { operational_relevance: "very_high", novelty: "new_tactic" } },
  );
  assert.notEqual(result.score_data.evidence_priority, "critical",
    "Defensive capability cannot reach critical through scoring alone");
});

test("threat_intelligence from primary source → critical allowed", () => {
  const result = score(
    { evidence_type: "threat_actor_activity", entities: ["Lazarus Group", "AI phishing tool"], numbers: [],
      fact: "Lazarus Group deployed an AI phishing tool targeting South Korean defence contractors in Q2 2025." },
    { source_type: "threat_intelligence", trust_tier: "primary",
      rawfact_taxonomy: { operational_relevance: "very_high", novelty: "new_tactic" } },
  );
  assert.equal(result.score_data.scoring_explanation.criticality_path_passed, "threat_intel:observed_adversary_behaviour");
});

// ── 13. Non-atomic claim gate ─────────────────────────────────────────────────
console.log("\nnon-atomic claim gate");

test("is_atomic=false → hard gate archives item", () => {
  const result = score({ is_atomic: false });
  assert.equal(result.score_data.evidence_priority, "archive_only");
  assert.ok(result.score_data.penalty_reasons.includes("non_atomic_claim"));
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
