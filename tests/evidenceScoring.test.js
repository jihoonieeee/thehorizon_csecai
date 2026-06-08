/**
 * Evidence Triage tests — categorical model (replaces 0-100 numeric scoring).
 *
 * Tests the triage chain: admissibility gates → evidence_strength → permitted_uses → limitations.
 * Claim priority (critical/high/medium/rejected) is tested separately in the claim layer.
 *
 * Run with: node tests/evidenceScoring.test.js
 */

import assert from "node:assert/strict";
import { scoreEvidenceItem } from "../lib/pipeline/rawfact/scoreEvidenceItems.js";
import { triageEvidenceItem, checkAdmissibility } from "../lib/pipeline/evidenceTriage/evidenceTriage.js";
import { assignClaimPriority, checkTrendRecurrence, deriveClaimSupportFlags } from "../lib/pipeline/evidenceTriage/claimLayer.js";
import { isInherentlyObserved } from "../lib/config/sourceTypeClaimPermissions.js";

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
    date_published: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    rawfact_taxonomy: { operational_relevance: "high", novelty: "known_tactic" },
    ...overrides,
  };
}

function makeItem(overrides = {}) {
  return {
    evidence_id:        "ev_test_0",
    source_id:          "src_test",
    evidence_type:      "incident_event",
    fact:               "Ransomware group compromised 3 healthcare systems using AI-generated spear-phishing emails.",
    source_quote:       "The group used AI-generated spear-phishing emails to compromise three healthcare systems.",
    quote_verified:     true,
    is_atomic:          true,
    evidence_confidence:"high",
    entities:           ["ransomware group", "healthcare"],
    numbers:            ["3 healthcare systems"],
    evidence_cluster:   null,
    ...overrides,
  };
}

function triage(itemOverrides = {}, sourceOverrides = {}) {
  return triageEvidenceItem(makeItem(itemOverrides), makeSource(sourceOverrides), {});
}

function score(itemOverrides = {}, sourceOverrides = {}, applyDuplicate = false) {
  return scoreEvidenceItem(makeItem(itemOverrides), makeSource(sourceOverrides), applyDuplicate);
}

// ── Part 1: Admissibility gates ───────────────────────────────────────────────
console.log("\nAdmissibility gates");

test("traceable source + verified quote + specific fact → admissibility passed", () => {
  const result = triage();
  assert.equal(result.admissibility, "passed", `Expected passed, got ${result.admissibility}`);
});

test("no source URL → admissibility failed", () => {
  const result = triageEvidenceItem(makeItem(), { ...makeSource(), url: null, id: null }, {});
  assert.equal(result.admissibility, "failed");
});

test("short generic fact → admissibility failed (generic_or_too_short)", () => {
  const result = triage({ fact: "AI can be used." });
  assert.equal(result.admissibility, "failed");
});

test("marketing language in fact → admissibility failed", () => {
  const result = triage({ fact: "This industry-leading AI solution is best-in-class for enterprise security teams." });
  assert.equal(result.admissibility, "failed");
});

test("speculative language without demonstration → admissibility failed", () => {
  const result = triage({
    fact: "AI could be used to generate convincing deepfakes targeting corporate executives.",
    entities: [], numbers: [],
  });
  assert.equal(result.admissibility, "failed");
});

test("non-atomic item → admissibility failed", () => {
  const result = triage({ is_atomic: false });
  assert.equal(result.admissibility, "failed");
});

test("LLM source_type_fit=false → admissibility failed (source_type_mismatch)", () => {
  const result = triageEvidenceItem(makeItem(), makeSource(), { source_type_fit: false });
  assert.equal(result.admissibility, "failed");
});

// ── Part 2: Evidence strength ─────────────────────────────────────────────────
console.log("\nEvidence strength");

test("concrete incident with entities + verified quote → strong", () => {
  const result = triage(
    { evidence_type: "incident_event", entities: ["ransomware group"], numbers: ["3 systems"] },
    { source_type: "incident", trust_tier: "high" },
  );
  assert.equal(result.evidence_strength, "strong",
    `Expected strong, got ${result.evidence_strength}. Reason: ${result.reasoning}`);
});

test("item passing admissibility but without direct_demonstration → usable (not strong)", () => {
  const result = triageEvidenceItem(
    makeItem({ evidence_type: "timeline_event", entities: [], numbers: [] }),
    makeSource({ source_type: "incident" }),
    { direct_demonstration: false, concrete_claim: false },
  );
  assert.ok(["usable", "context"].includes(result.evidence_strength),
    `Expected usable/context (no direct demo), got ${result.evidence_strength}`);
});

test("failed admissibility → archive strength", () => {
  const result = triage({ fact: "Short." });
  assert.equal(result.evidence_strength, "archive");
});

test("unknown source_type with context_only permissions → context strength", () => {
  const result = triage(
    { evidence_type: "incident_event", entities: ["bank"], numbers: ["50M"] },
    { source_type: "unknown", trust_tier: "primary" },
  );
  assert.ok(["context", "archive"].includes(result.evidence_strength),
    `unknown source_type should be context or archive, got ${result.evidence_strength}`);
});

test("governance_signal source → context or usable (cannot prove operational activity)", () => {
  const result = triage(
    { evidence_type: "governance_action", entities: ["NIST"], numbers: [],
      fact: "NIST AI RMF mandates adversarial ML testing for federal AI systems starting Q1 2026." },
    { source_type: "governance_signal", trust_tier: "primary" },
  );
  // governance_signal can_support: context_only, recommendation_input, outlook_input
  assert.ok(["context", "usable"].includes(result.evidence_strength),
    `governance_signal should not be strong for operational claims, got ${result.evidence_strength}`);
});

// ── Part 3: Permitted uses ────────────────────────────────────────────────────
console.log("\nPermitted uses");

test("failed admissibility → permitted_uses = [not_used]", () => {
  const result = triage({ fact: "." });
  assert.deepEqual(result.permitted_uses, ["not_used"]);
});

test("incident source → includes fact_support and case_study", () => {
  const result = triage(
    { evidence_type: "incident_event", entities: ["actor"], numbers: [] },
    { source_type: "incident", trust_tier: "high" },
  );
  assert.ok(result.permitted_uses.includes("fact_support"),
    `incident should permit fact_support. Got: ${result.permitted_uses}`);
  assert.ok(result.permitted_uses.includes("case_study"),
    `incident should permit case_study. Got: ${result.permitted_uses}`);
});

test("inherently-observed source (incident) grants adoption_support on the rawfact path", () => {
  // B1 fix: the rawfact triage path passes no LLM judgements ({}). Incidents,
  // threat-intel, and adversary-adoption signals are observed real-world activity
  // by definition, so adoption_support is grantable without an explicit observed_use flag.
  const result = triageEvidenceItem(
    makeItem({ evidence_type: "incident_event", entities: ["actor"] }),
    makeSource({ source_type: "incident" }),
    {},  // no LLM judgements — production rawfact path
  );
  assert.ok(result.permitted_uses.includes("adoption_support"),
    `incident is inherently observed → adoption_support should be granted. Got: ${result.permitted_uses}`);
  assert.equal(result.observed_use, true,
    "incident should be marked observed_use=true");
});

test("threat_intelligence grants adoption_support without explicit flag", () => {
  const result = triageEvidenceItem(
    makeItem({ evidence_type: "threat_actor_activity", entities: ["APT99"] }),
    makeSource({ source_type: "threat_intelligence" }),
    {},
  );
  assert.ok(result.permitted_uses.includes("adoption_support"),
    `threat_intelligence is inherently observed → adoption_support should be granted. Got: ${result.permitted_uses}`);
});

test("governance_signal → only context_only, recommendation_input, outlook_input", () => {
  const result = triage(
    { fact: "NIST AI RMF mandates adversarial ML testing for federal AI systems starting Q1 2026.",
      entities: ["NIST"], numbers: [] },
    { source_type: "governance_signal", trust_tier: "primary" },
  );
  const operational = result.permitted_uses.filter(
    (u) => ["fact_support", "case_study", "capability_support", "adoption_support", "trend_input"].includes(u)
  );
  assert.equal(operational.length, 0,
    `governance_signal must not have operational uses. Got: ${result.permitted_uses}`);
});

test("research_finding without observed_use → no adoption_support", () => {
  const result = triage(
    { evidence_type: "research_result",
      fact: "Researchers demonstrated a novel prompt injection attack against tool-using LLM agents.",
      entities: ["GPT-4"], numbers: ["94%"] },
    { source_type: "research_finding", trust_tier: "high" },
  );
  assert.ok(!result.permitted_uses.includes("adoption_support"),
    `research_finding cannot prove adversary adoption. Got: ${result.permitted_uses}`);
});

// ── Part 4: Limitations ───────────────────────────────────────────────────────
console.log("\nLimitations");

test("single non-clustered item → single_source limitation", () => {
  const result = triage({ evidence_cluster: null });
  assert.ok(result.limitations.includes("single_source"),
    `Expected single_source, got: ${result.limitations}`);
});

test("non-representative cluster member → duplicate_reporting limitation", () => {
  const result = triage({
    evidence_cluster: { is_multi_source: true, is_representative: false, cluster_size: 3 },
  });
  assert.ok(result.limitations.includes("duplicate_reporting"),
    `Non-representative items should have duplicate_reporting. Got: ${result.limitations}`);
});

test("benchmark_evaluation without numbers → missing_quantitative_detail", () => {
  const result = triage(
    { evidence_type: "benchmark_result", numbers: [], entities: ["GPT-4"],
      fact: "The benchmark shows GPT-4 is vulnerable to adversarial examples in multiple domains." },
    { source_type: "benchmark_evaluation", trust_tier: "high" },
  );
  assert.ok(result.limitations.includes("missing_quantitative_detail"),
    `benchmark without numbers should flag missing_quantitative_detail. Got: ${result.limitations}`);
});

// ── Part 5: evidence_strength is the ONLY importance output ───────────────────
// No score_data, no evidence_priority (critical/high), no 0-100 score on evidence.
console.log("\nEvidence importance: evidence_strength only (no score/priority mirror)");

test("strong evidence → triage_data.evidence_strength = 'strong'", () => {
  const result = score(
    { evidence_type: "incident_event", entities: ["actor"], numbers: ["3 systems"] },
    { source_type: "incident", trust_tier: "high" },
  );
  assert.equal(result.triage_data.evidence_strength, "strong",
    `strong-eligible item should be 'strong'. Got: ${result.triage_data.evidence_strength}`);
});

test("archive evidence → triage_data.evidence_strength = 'archive'", () => {
  const result = score({ fact: "." });
  assert.equal(result.triage_data.evidence_strength, "archive");
});

test("triaged items expose triage_data only — NO score_data / evidence_priority mirror", () => {
  const result = score();
  assert.ok(result.triage_data, "triage_data should be present");
  assert.ok(typeof result.triage_data.evidence_strength === "string", "evidence_strength present");
  assert.ok(Array.isArray(result.triage_data.permitted_uses), "permitted_uses array present");
  assert.ok(Array.isArray(result.triage_data.limitations), "limitations array present");
  // The confusing claim-priority mirror must be GONE from evidence items.
  assert.equal(result.score_data, undefined, "score_data must not exist on evidence items");
  assert.equal(result.evidence_priority, undefined, "evidence items must not carry evidence_priority");
});

test("unknown low-trust source → context strength (restricted to context_only permitted use)", () => {
  const result = score({}, { source_type: "unknown", trust_tier: "low" });
  // unknown source_type permits only context_only → strength = context (not archive).
  // Archive requires failing admissibility gates (no URL, no quote, generic fact, etc.).
  // A concrete item from an unknown source is contextually usable but proves nothing beyond that.
  assert.ok(["context", "archive"].includes(result.triage_data.evidence_strength),
    `unknown+low trust should be context or archive. Got: ${result.triage_data.evidence_strength}`);
  assert.ok(!result.triage_data.permitted_uses.includes("fact_support"),
    "unknown source must not permit fact_support");
  assert.ok(!result.triage_data.permitted_uses.includes("case_study"),
    "unknown source must not permit case_study");
});

// ── Part 6: Duplicate penalty ─────────────────────────────────────────────────
console.log("\nDuplicate penalty (triage-level)");

test("non-representative cluster member is downgraded one strength level", () => {
  const rep = score(
    { evidence_cluster: { is_multi_source: true, is_representative: true, cluster_size: 3 } },
    {}, true,
  );
  const nonRep = score(
    { evidence_cluster: { is_multi_source: true, is_representative: false, cluster_size: 3 } },
    {}, true,
  );
  const STRENGTH_ORDER = { strong: 0, usable: 1, context: 2, archive: 3 };
  assert.ok(
    (STRENGTH_ORDER[rep.triage_data.evidence_strength] ?? 4) <=
    (STRENGTH_ORDER[nonRep.triage_data.evidence_strength] ?? 4),
    `Representative (${rep.triage_data.evidence_strength}) should be >= non-rep (${nonRep.triage_data.evidence_strength})`,
  );
});

test("duplicate penalty not applied in first pass", () => {
  const item = { evidence_cluster: { is_multi_source: true, is_representative: false, cluster_size: 3 } };
  const firstPass  = score(item, {}, false);
  const secondPass = score(item, {}, true);
  const ORDER = { strong: 0, usable: 1, context: 2, archive: 3 };
  // First pass must not be downgraded relative to the penalized second pass.
  assert.ok(
    (ORDER[firstPass.triage_data.evidence_strength] ?? 4) <=
    (ORDER[secondPass.triage_data.evidence_strength] ?? 4),
    `first pass (${firstPass.triage_data.evidence_strength}) must be >= strength of penalized pass (${secondPass.triage_data.evidence_strength})`,
  );
});

test("duplicate downgrade never drops below 'usable' (keeps corroboration metadata)", () => {
  const nonRep = score(
    { evidence_type: "incident_event", entities: ["actor"], numbers: ["3 systems"],
      evidence_cluster: { is_multi_source: true, is_representative: false, cluster_size: 3 } },
    { source_type: "incident", trust_tier: "high" }, true,
  );
  assert.ok(["strong", "usable"].includes(nonRep.triage_data.evidence_strength),
    `a strong duplicate should downgrade to usable, not below. Got: ${nonRep.triage_data.evidence_strength}`);
  assert.ok(nonRep.triage_data.limitations.includes("duplicate_reporting"),
    "duplicate carries duplicate_reporting limitation for corroboration counting");
});

// ── Part 7: Deterministic claim priority (claimLayer.assignClaimPriority) ─────
console.log("\nDeterministic claim priority gates");

function makeClaim(overrides = {}) {
  return {
    claim_id:                   "cl_test",
    claim_text:                 "Prompt injection attacks against LLM agents have increased significantly.",
    claim_type:                 "category_insight",
    analytical_change:          "capability_increased",
    change_driver:              "operationalized",
    signal_temporality:         "emerging",
    supporting_viewpoint_ids:   ["vp_1"],
    supporting_observation_ids: ["obs_1"],
    supporting_evidence_ids:    ["ev_1"],
    evidence_sufficiency:       "sufficient",
    broad_relevance:            true,
    broad_relevance_basis:      ["reusable_attacker_capability"],
    multi_scope_impact:         true,
    multi_scope_basis:          ["actors", "systems"],
    strong_viewpoint_support:   true,
    strong_evidence_support:    true,
    blocking_limitations:       false,
    slide_driving_power:        true,
    caveat_if_any:              null,
    reasoning:                  "Strong evidence from multiple sources.",
    ...overrides,
  };
}

test("all critical gates pass → critical priority", () => {
  const priority = assignClaimPriority(makeClaim());
  assert.equal(priority, "critical",
    `All gates pass → critical. Got: ${priority}`);
});

test("broad_relevance=false → not critical (missing gate)", () => {
  const priority = assignClaimPriority(makeClaim({ broad_relevance: false, broad_relevance_basis: [] }));
  assert.notEqual(priority, "critical");
});

test("multi_scope_impact=false → not critical", () => {
  const priority = assignClaimPriority(makeClaim({ multi_scope_impact: false, multi_scope_basis: [] }));
  assert.notEqual(priority, "critical");
});

test("slide_driving_power=false → not critical", () => {
  const priority = assignClaimPriority(makeClaim({ slide_driving_power: false }));
  assert.notEqual(priority, "critical");
});

test("sufficient + non-trivial change + driver + no blocking lim → at least high", () => {
  const priority = assignClaimPriority(makeClaim({
    broad_relevance: false, multi_scope_impact: false, slide_driving_power: false,
  }));
  assert.ok(["high", "critical"].includes(priority),
    `Should be at least high when sufficient + change + driver. Got: ${priority}`);
});

test("insufficient evidence → rejected", () => {
  const priority = assignClaimPriority(makeClaim({ evidence_sufficiency: "insufficient" }));
  assert.equal(priority, "rejected");
});

test("trend_claim with partial evidence → rejected", () => {
  const priority = assignClaimPriority(makeClaim({
    claim_type: "trend_claim",
    evidence_sufficiency: "partial",
  }));
  assert.equal(priority, "rejected",
    "trend_claim with partial evidence must be rejected");
});

test("no_clear_change analytical_change → not critical", () => {
  const priority = assignClaimPriority(makeClaim({
    analytical_change: "no_clear_change",
    change_driver: "not_applicable",
  }));
  assert.notEqual(priority, "critical");
});

test("governance escalation without analytical change → rejected or medium", () => {
  const priority = assignClaimPriority(makeClaim({
    claim_type: "executive_judgment",
    analytical_change: "no_clear_change",
    change_driver: "not_applicable",
    evidence_sufficiency: "partial",
  }));
  assert.ok(["rejected", "medium"].includes(priority),
    `governance without change should be rejected or medium. Got: ${priority}`);
});

test("valid recommendation claim → medium or higher", () => {
  const priority = assignClaimPriority(makeClaim({
    claim_type: "recommendation",
    broad_relevance: false,
    multi_scope_impact: false,
    slide_driving_power: false,
  }));
  assert.ok(["high", "medium"].includes(priority),
    `recommendation with sufficient evidence → at least medium. Got: ${priority}`);
});

// ── Part 8: inherently-observed source types (B1) ─────────────────────────────
console.log("\nInherently-observed source types");

test("incident / threat_intelligence / adversary_adoption_signal are inherently observed", () => {
  assert.equal(isInherentlyObserved("incident"), true);
  assert.equal(isInherentlyObserved("threat_intelligence"), true);
  assert.equal(isInherentlyObserved("adversary_adoption_signal"), true);
});

test("research / governance / benchmark are NOT inherently observed", () => {
  assert.equal(isInherentlyObserved("research_finding"), false);
  assert.equal(isInherentlyObserved("governance_signal"), false);
  assert.equal(isInherentlyObserved("benchmark_evaluation"), false);
  assert.equal(isInherentlyObserved("unknown"), false);
});

// ── Part 9: deterministic claim support flags (M2) ────────────────────────────
console.log("\nDeterministic claim support flags");

test("strong_evidence_support derived from triage strength", () => {
  const claim = { supporting_evidence_ids: ["ev1", "ev2"], supporting_viewpoint_ids: ["vp1"], analytical_change: "capability_increased" };
  const triageById = { ev1: { evidence_strength: "usable" }, ev2: { evidence_strength: "strong" } };
  const vpStrengthById = { vp1: "moderate" };
  const flags = deriveClaimSupportFlags(claim, vpStrengthById, triageById);
  assert.equal(flags.strong_evidence_support, true, "ev2 is strong → strong_evidence_support");
  assert.equal(flags.strong_viewpoint_support, false, "vp1 is moderate → not strong viewpoint");
  assert.equal(flags.slide_driving_power, true, "strong evidence + critical analytical_change → slide_driving_power");
});

test("no strong evidence → strong_evidence_support false, slide_driving_power false", () => {
  const claim = { supporting_evidence_ids: ["ev1"], supporting_viewpoint_ids: ["vp1"], analytical_change: "capability_increased" };
  const flags = deriveClaimSupportFlags(claim, { vp1: "strong" }, { ev1: { evidence_strength: "usable" } });
  assert.equal(flags.strong_evidence_support, false);
  assert.equal(flags.strong_viewpoint_support, true);
  assert.equal(flags.slide_driving_power, false, "no strong evidence → cannot drive a slide");
});

test("slide_driving_power false when analytical_change is no_clear_change", () => {
  const claim = { supporting_evidence_ids: ["ev1"], supporting_viewpoint_ids: [], analytical_change: "no_clear_change" };
  const flags = deriveClaimSupportFlags(claim, {}, { ev1: { evidence_strength: "strong" } });
  assert.equal(flags.slide_driving_power, false, "no_clear_change is never slide-driving");
});

// ── Part 10: trend recurrence enforcement (M1) ────────────────────────────────
console.log("\nTrend recurrence enforcement");

const trendTriage = (ids, opts = {}) =>
  Object.fromEntries(ids.map((id) => [id, { evidence_id: id, evidence_strength: "usable", limitations: opts.dup?.includes(id) ? ["duplicate_reporting"] : [] }]));
const trendItems = (specs) => Object.fromEntries(specs.map((s) => [s.id, { evidence_id: s.id, publisher: s.pub, date_published: s.date }]));

test("trend passes with 3 items, 2 publishers, 2 months", () => {
  const ids = ["e1", "e2", "e3"];
  const ok = checkTrendRecurrence(
    { claim_type: "trend_claim", supporting_evidence_ids: ids },
    trendItems([{ id: "e1", pub: "A", date: "2026-01-10" }, { id: "e2", pub: "B", date: "2026-02-10" }, { id: "e3", pub: "A", date: "2026-02-20" }]),
    trendTriage(ids),
  );
  assert.equal(ok, true);
});

test("trend fails with <3 non-duplicate items", () => {
  const ids = ["e1", "e2", "e3"];
  const ok = checkTrendRecurrence(
    { claim_type: "trend_claim", supporting_evidence_ids: ids },
    trendItems([{ id: "e1", pub: "A", date: "2026-01-10" }, { id: "e2", pub: "B", date: "2026-02-10" }, { id: "e3", pub: "A", date: "2026-02-20" }]),
    trendTriage(ids, { dup: ["e3"] }),   // e3 is a duplicate → only 2 usable
  );
  assert.equal(ok, false);
});

test("trend fails with only one publisher", () => {
  const ids = ["e1", "e2", "e3"];
  const ok = checkTrendRecurrence(
    { claim_type: "trend_claim", supporting_evidence_ids: ids },
    trendItems([{ id: "e1", pub: "A", date: "2026-01-10" }, { id: "e2", pub: "A", date: "2026-02-10" }, { id: "e3", pub: "A", date: "2026-03-10" }]),
    trendTriage(ids),
  );
  assert.equal(ok, false);
});

test("trend fails with same-month burst (3 items, 2 publishers, 1 window)", () => {
  const ids = ["e1", "e2", "e3"];
  const ok = checkTrendRecurrence(
    { claim_type: "trend_claim", supporting_evidence_ids: ids },
    trendItems([{ id: "e1", pub: "A", date: "2026-01-10" }, { id: "e2", pub: "B", date: "2026-01-12" }, { id: "e3", pub: "C", date: "2026-01-15" }]),
    trendTriage(ids),
  );
  assert.equal(ok, false, "same-month burst is not a trend");
});

test("trend window check skipped when items are undated", () => {
  const ids = ["e1", "e2", "e3"];
  const ok = checkTrendRecurrence(
    { claim_type: "trend_claim", supporting_evidence_ids: ids },
    trendItems([{ id: "e1", pub: "A" }, { id: "e2", pub: "B" }, { id: "e3", pub: "C" }]),
    trendTriage(ids),
  );
  assert.equal(ok, true, "undated items: items+publishers gates pass, window gate not enforced");
});

// ── Part 11: end-to-end integration (real functions, production order) ────────
console.log("\nIntegration — triage → flags → priority");

test("adoption claim from threat-intel is reachable end-to-end (B1)", () => {
  // 1. Real triage of a threat-intel item with NO LLM judgements (rawfact path)
  const tri = triageEvidenceItem(
    makeItem({ evidence_id: "ev_ti", evidence_type: "threat_actor_activity", entities: ["APT99"] }),
    makeSource({ source_type: "threat_intelligence" }),
    {},
  );
  assert.ok(tri.permitted_uses.includes("adoption_support"),
    `precondition: triage should grant adoption_support. Got: ${tri.permitted_uses}`);

  // 2. Build an adoption claim citing it, derive flags deterministically, assign priority
  const claim = makeClaim({
    claim_id: "cl_adopt", analytical_change: "adoption_moved_forward",
    change_driver: "operationalized", supporting_evidence_ids: ["ev_ti"],
  });
  const flags = deriveClaimSupportFlags(claim, { vp_1: "strong" }, { ev_ti: tri });
  const priority = assignClaimPriority({ ...claim, ...flags }, [tri]);

  // Before B1 this was ALWAYS "rejected" (adoption_support never granted).
  assert.notEqual(priority, "rejected",
    `adoption claim backed by observed threat-intel must not be rejected. Got: ${priority}`);
});

test("same-window trend burst is rejected end-to-end (M1)", () => {
  const ids = ["t1", "t2", "t3"];
  const triageById = Object.fromEntries(ids.map((id) => [id, { evidence_id: id, evidence_strength: "strong", limitations: [], permitted_uses: ["trend_input"] }]));
  const itemsById  = Object.fromEntries(ids.map((id, i) => [id, { evidence_id: id, publisher: ["A","B","C"][i], date_published: "2026-01-1" + i }]));

  const claim = makeClaim({ claim_id: "cl_trend", claim_type: "trend_claim", supporting_evidence_ids: ids });
  // Replicate generateClaims' deterministic step: trend recurrence → sufficiency
  let evidence_sufficiency = claim.evidence_sufficiency;
  if (!checkTrendRecurrence(claim, itemsById, triageById)) evidence_sufficiency = "insufficient";
  const priority = assignClaimPriority({ ...claim, evidence_sufficiency }, Object.values(triageById));

  assert.equal(priority, "rejected", `same-month trend burst must be rejected. Got: ${priority}`);
});

// ── Results ────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
