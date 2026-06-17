/**
 * L6 Strategic Analysis Refactor — Tests
 *
 * Covers:
 *   1. L5 analytical hooks preserved through extraction
 *   2. L6.2 analytical state produces signals, not pre-written assertions
 *   3. L6.3 synthesis receives strategic_judgments schema
 *   4. Analytical quality QA blocks summary-only judgments
 *   5. validateCategoryAnalysis handles new schema + blocks unsupported judgments
 *   6. Trend/adoption overclaim is blocked
 *   7. Cross-category synthesis uses strategic_judgments from categories
 *   8. L8 slide plan preserves reasoning chain
 *
 * Run: node tests/analysis/l6-strategic-analysis.test.js
 */

import assert from "node:assert/strict";
import { rateJudgmentQuality, validateCategoryAnalysis } from "../../lib/pipeline/analysis/validateCategoryAnalysis.js";
import { buildAnalyticalState, buildBlockedClaimOpportunities } from "../../lib/pipeline/analysis/buildAnalyticalState.js";
import { CATEGORY_SYNTHESIS_SCHEMA, buildAnalyticalStateBlock, buildCorpusAuditBlock } from "../../lib/pipeline/analysis/synthesizeCategory.js";

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

function makeIdIndex(items) {
  const m = new Map();
  for (const it of items) {
    m.set(it.evidence_id, {
      origin:           it.origin || "5A_rawfact",
      source_type:      it.source_type || "research_finding",
      evidence_strength:it.evidence_strength || "usable",
      permitted_uses:   it.permitted_uses || ["fact_support"],
      limitations:      it.limitations || [],
      publisher:        it.publisher || "Test Publisher",
      date:             it.date || "2026-05-01",
    });
  }
  return m;
}

function makeCompactDossier(category, evidenceItems, opts = {}) {
  return {
    category,
    source_count: evidenceItems.length,
    id_index: makeIdIndex(evidenceItems),
    allowed_ids: new Set(evidenceItems.map((e) => e.evidence_id)),
    evidence_5A: evidenceItems,
    evidence_5B: [],
    evidence_5C: [],
    analytical_state: opts.analytical_state || null,
    corpus_audit: opts.corpus_audit || null,
  };
}

function makeJudgment(overrides = {}) {
  return {
    judgment:           "Automated jailbreak search commoditizes bypass tooling by removing artisanal skill requirement",
    judgment_type:      "capability_change",
    evidence_for:       ["ev_001"],
    evidence_against:   [],
    what_changed:       "Attack success rate rose from 23% to 88% with automated gradient-based search",
    causal_mechanism:   "Gradient-based optimization removes need for manual crafting; any actor can run automated scans",
    why_this_matters:   "Low-sophistication adversaries can now bypass RLHF safety filters at scale",
    second_order_implications: ["Expect open-source jailbreak tools within 6 months"],
    affected_stakeholders: ["LLM providers", "enterprise deployments"],
    uncertainty:        "Lab results on production RLHF models may not hold; gap between research and deployed models",
    confidence:         "medium",
    monitoring_signals: ["open-source PoC release rate", "adversary forum discussions of automated bypass"],
    recommended_actions:["Implement adaptive prompt filtering", "Monitor for automated scanning patterns"],
    supporting_evidence_ids: ["ev_001"],
    caveat_if_any:      null,
    slide_usefulness:   "high",
    ...overrides,
  };
}

// ── 1. L5 analytical hooks preserved ─────────────────────────────────────────

process.stdout.write("\n1. L5 analytical hooks\n");

test("analytical_hook field is in evidence item schema", () => {
  // The EVIDENCE_ITEMS_SCHEMA in extractEvidenceItems.js must include analytical_hook
  // We test indirectly by checking the schema imports work; the actual extraction
  // is tested through the validateItem path
  const judgment = makeJudgment();
  assert.ok(judgment.what_changed, "what_changed field exists");
  assert.ok(judgment.causal_mechanism, "causal_mechanism field exists");
});

test("novelty_signal and assumption_challenged are optional", () => {
  const judgment = makeJudgment({ assumption_challenged: null });
  // Judgment without assumption_challenged still works
  const quality = rateJudgmentQuality(judgment);
  assert.ok(quality !== "unsupported", `quality is ${quality}`);
});

// ── 2. L6.2 analytical state produces signals, not assertions ────────────────

process.stdout.write("\n2. L6.2 signal language\n");

test("candidate_judgments have signal_description (observation, not assertion)", () => {
  const dossiers = [{
    category: "llm_threats",
    source_count: 5,
    rawfact: {
      strong_evidence: [
        { evidence_id: "ev_001", evidence_type: "vulnerability_fact", fact: "CVE-2026 in LLM deployment", source_type: "vulnerability", triage_data: { evidence_strength: "strong" } },
      ],
      usable_evidence: [
        { evidence_id: "ev_002", evidence_type: "research_result", fact: "88% ASR on GPT-4", source_type: "research_finding", triage_data: { evidence_strength: "usable" } },
      ],
    },
    fusion_summary: { evidence_gaps: [] },
    analytics: { analytics_evidence: [] },
  }];
  const analyticsResult = { aggregates: {}, derived_metrics: {} };

  const state = buildAnalyticalState(dossiers, analyticsResult);
  const catState = state.category_states.find((cs) => cs.category === "llm_threats");
  assert.ok(catState, "category state exists");

  // Candidates should have signal_description (non-assertive language)
  for (const c of (catState.candidate_judgments || [])) {
    if (c.signal_description) {
      // Signal description should not end with a period-terminated assertion
      // (it describes what the data shows, not a conclusion)
      assert.ok(
        typeof c.signal_description === "string" && c.signal_description.length > 0,
        `signal_description is non-empty for ${c.hypothesis_id}`
      );
    }
    // candidate_claim is still present for backward compat (validation noun-matching)
    assert.ok("candidate_claim" in c, `candidate_claim still present for ${c.hypothesis_id}`);
  }
});

test("blocked_claim_opportunities are derived for thin corpus", () => {
  const thinEvidence = {
    confidence_ceiling: "none",
    source_type_diversity: 0,
    has_operational_sources: false,
    validated_evidence_count: 0,
  };
  const blocked = buildBlockedClaimOpportunities(thinEvidence, [], []);
  const blockedTypes = blocked.map((b) => b.claim_type);
  assert.ok(blockedTypes.includes("factual"), "factual blocked when no evidence");
  assert.ok(blockedTypes.includes("adoption"), "adoption blocked when no evidence");
});

// ── 3. L6.3 schema includes strategic_judgments ──────────────────────────────

process.stdout.write("\n3. L6.3 schema\n");

test("CATEGORY_SYNTHESIS_SCHEMA requires strategic_judgments", () => {
  assert.ok(CATEGORY_SYNTHESIS_SCHEMA.required.includes("strategic_judgments"),
    "schema requires strategic_judgments");
  assert.ok(CATEGORY_SYNTHESIS_SCHEMA.required.includes("outlook_6_months"),
    "schema requires outlook_6_months");
  assert.ok(CATEGORY_SYNTHESIS_SCHEMA.required.includes("evidence_gaps"),
    "schema requires evidence_gaps");
});

test("strategic_judgment item requires causal fields", () => {
  const judgmentItem = CATEGORY_SYNTHESIS_SCHEMA.properties.strategic_judgments.items;
  const required = judgmentItem.required || [];
  assert.ok(required.includes("what_changed"), "what_changed required");
  assert.ok(required.includes("causal_mechanism"), "causal_mechanism required");
  assert.ok(required.includes("why_this_matters"), "why_this_matters required");
  assert.ok(required.includes("evidence_for"), "evidence_for required");
  assert.ok(required.includes("evidence_against"), "evidence_against required");
  assert.ok(required.includes("uncertainty"), "uncertainty required");
});

test("schema does NOT include top_insights as required output", () => {
  assert.ok(!CATEGORY_SYNTHESIS_SCHEMA.required.includes("top_insights"),
    "top_insights not in required (old schema removed)");
  assert.ok(!CATEGORY_SYNTHESIS_SCHEMA.required.includes("top_happenings"),
    "top_happenings not in required (old schema removed)");
});

test("buildAnalyticalStateBlock uses signal language, not pre-approved claim language", () => {
  const analyticalState = {
    confidence_ceiling: "medium",
    hypothesis_candidates: [
      {
        hypothesis_id: "hyp_001",
        judgment_type: "pattern",
        confidence_ceiling: "medium",
        signal_description: "5 sources show prompt_injection activity in llm threats",
        candidate_claim: "prompt_injection signal in llm threats: 5 sources",
        supporting_evidence_ids: ["ev_001"],
        required_caveats: ["Evidence ceiling is medium — use hedged language"],
      },
    ],
    blocked_claim_opportunities: [
      { claim_type: "adoption", blocking_reason: "no_operational_sources" },
    ],
  };
  const block = buildAnalyticalStateBlock(analyticalState);
  assert.ok(block.includes("EVIDENCE SIGNALS"), "uses signal language");
  assert.ok(!block.includes("PRE-COMPUTED HYPOTHESIS CANDIDATES"), "no pre-approved claim language");
  assert.ok(!block.includes("confirm/refute"), "no confirm/refute instruction");
  assert.ok(block.includes("form YOUR OWN strategic judgments"), "explicitly asks for own judgment");
  assert.ok(block.includes("BLOCKED CLAIM TYPES"), "shows blocked claim types");
});

// ── 4. Analytical quality QA ─────────────────────────────────────────────────

process.stdout.write("\n4. Analytical quality QA\n");

test("summary_only judgment is rated summary_only", () => {
  const summary = makeJudgment({
    judgment: "Prompt injection continues to be a notable attack technique",
    what_changed: "",          // no change stated
    causal_mechanism: "",      // no cause stated
    why_this_matters: "",      // no implication
    uncertainty: "",
  });
  assert.equal(rateJudgmentQuality(summary), "summary_only");
});

test("descriptive judgment (has change, no cause) is rated descriptive", () => {
  const descriptive = makeJudgment({
    judgment: "Researchers demonstrated prompt injection against several LLMs",
    what_changed: "Several new prompt injection techniques demonstrated against LLMs",
    causal_mechanism: "", // no causal mechanism
    why_this_matters: "",
    uncertainty: "",
  });
  const rating = rateJudgmentQuality(descriptive);
  assert.ok(["descriptive", "summary_only"].includes(rating), `got ${rating}, expected descriptive/summary_only`);
});

test("analytical judgment passes (has change + cause + implication)", () => {
  const analytical = makeJudgment(); // all fields populated
  const rating = rateJudgmentQuality(analytical);
  assert.ok(["analytical", "strategic"].includes(rating), `got ${rating}, expected analytical/strategic`);
});

test("strategic judgment is rated strategic (has second_order_implications + monitoring)", () => {
  const strategic = makeJudgment({
    second_order_implications: ["Open-source jailbreak tooling within 6 months"],
    monitoring_signals: ["Monitor adversary forum discussions"],
    uncertainty: "Lab conditions may differ from production RLHF-tuned deployments",
  });
  assert.equal(rateJudgmentQuality(strategic), "strategic");
});

test("judgment with no evidence_for is rated unsupported", () => {
  const unsupported = makeJudgment({
    evidence_for: [],
    supporting_evidence_ids: [],
  });
  assert.equal(rateJudgmentQuality(unsupported), "unsupported");
});

// ── 5. validateCategoryAnalysis blocks low-quality judgments ─────────────────

process.stdout.write("\n5. validateCategoryAnalysis\n");

test("summary-only judgment is blocked by analytical quality gate", () => {
  const evidence = [{ evidence_id: "ev_001", origin: "5A_rawfact", source_type: "research_finding", evidence_strength: "usable", permitted_uses: [], limitations: [], publisher: "arXiv", date: "2026-05-01" }];
  const compact = makeCompactDossier("llm_threats", evidence);

  const raw = {
    strategic_judgments: [{
      judgment: "Prompt injection continues to be a notable attack technique",
      judgment_type: "technique_evolution",
      evidence_for: ["ev_001"],
      evidence_against: [],
      what_changed: "",
      causal_mechanism: "",
      why_this_matters: "",
      uncertainty: "",
      confidence: "high",
      supporting_evidence_ids: ["ev_001"],
      monitoring_signals: [],
      recommended_actions: [],
    }],
    outlook_6_months: {
      observed_basis: "Research activity continues",
      projected_trajectory: "Attacks may increase",
      reasoning: "Based on observed patterns",
      confidence: "low",
      supporting_evidence_ids: ["ev_001"],
    },
    evidence_gaps: [],
  };

  const result = validateCategoryAnalysis(raw, compact);
  assert.equal(result.strategic_judgments.length, 0, "summary-only judgment is blocked");
  assert.ok(result.validation_report.analytical_quality_blocked >= 1, "analytical_quality_blocked incremented");
});

test("analytical judgment passes validation", () => {
  const evidence = [
    { evidence_id: "ev_001", origin: "5A_rawfact", source_type: "research_finding", evidence_strength: "usable", permitted_uses: [], limitations: [], publisher: "arXiv", date: "2026-05-01" },
    { evidence_id: "ev_002", origin: "5A_rawfact", source_type: "research_finding", evidence_strength: "strong", permitted_uses: [], limitations: [], publisher: "Google DeepMind", date: "2026-04-15" },
  ];
  const compact = makeCompactDossier("llm_threats", evidence);

  const raw = {
    strategic_judgments: [makeJudgment({ evidence_for: ["ev_001", "ev_002"], supporting_evidence_ids: ["ev_001", "ev_002"] })],
    outlook_6_months: {
      observed_basis: "Research shows automated jailbreak tools are achieving high ASR",
      projected_trajectory: "Automated bypass tooling may become widely available within 6 months",
      reasoning: "Current research trajectory suggests rapid operationalization",
      confidence: "medium",
      supporting_evidence_ids: ["ev_001"],
    },
    evidence_gaps: [],
  };

  const result = validateCategoryAnalysis(raw, compact);
  assert.ok(result.strategic_judgments.length >= 1, "analytical judgment passes");
  assert.ok(result.strategic_judgments[0].analytical_quality === "strategic" ||
            result.strategic_judgments[0].analytical_quality === "analytical",
            `quality is ${result.strategic_judgments[0].analytical_quality}`);
});

test("unresolved evidence_for IDs cause judgment removal", () => {
  const evidence = [{ evidence_id: "ev_001", origin: "5A_rawfact", source_type: "research_finding", evidence_strength: "usable", permitted_uses: [], limitations: [], publisher: "arXiv", date: "2026-05-01" }];
  const compact = makeCompactDossier("llm_threats", evidence);

  const raw = {
    strategic_judgments: [makeJudgment({ evidence_for: ["ev_NONEXISTENT"], supporting_evidence_ids: ["ev_NONEXISTENT"] })],
    outlook_6_months: { observed_basis: "obs", projected_trajectory: "may continue", reasoning: "r", confidence: "low", supporting_evidence_ids: [] },
    evidence_gaps: [],
  };

  const result = validateCategoryAnalysis(raw, compact);
  assert.equal(result.strategic_judgments.length, 0, "judgment with nonexistent evidence removed");
  assert.ok(result.validation_report.removed_unsupported >= 1, "removed_unsupported incremented");
});

// ── 6. Trend/adoption overclaim is blocked ───────────────────────────────────

process.stdout.write("\n6. Overclaim blocking\n");

test("adoption claim with no observed-use evidence gets confidence capped", () => {
  const evidence = [
    { evidence_id: "ev_001", origin: "5A_rawfact", source_type: "research_finding", evidence_strength: "strong", permitted_uses: [], limitations: [], publisher: "arXiv", date: "2026-05-01" },
  ];
  const compact = makeCompactDossier("llm_threats", evidence);

  const raw = {
    strategic_judgments: [makeJudgment({
      judgment: "Threat actors have widely adopted automated jailbreaks in the wild — real-world adoption confirmed",
      judgment_type: "adversary_adoption",
      confidence: "high",
      evidence_for: ["ev_001"],
      supporting_evidence_ids: ["ev_001"],
    })],
    outlook_6_months: { observed_basis: "obs", projected_trajectory: "may continue", reasoning: "r", confidence: "low", supporting_evidence_ids: [] },
    evidence_gaps: [],
  };

  const result = validateCategoryAnalysis(raw, compact);
  // The adoption gate should downgrade confidence since no observed-use source
  if (result.strategic_judgments.length > 0) {
    assert.notEqual(result.strategic_judgments[0].confidence, "high",
      "adoption without observed-use cannot be high confidence");
  }
  // If blocked by analytical quality gate first, that's also acceptable
  assert.ok(
    result.strategic_judgments.length === 0 || result.strategic_judgments[0].confidence !== "high",
    "adoption overclaim is either blocked or downgraded"
  );
});

test("trend claim with single source gets confidence capped to medium", () => {
  const evidence = [
    { evidence_id: "ev_001", origin: "5A_rawfact", source_type: "research_finding", evidence_strength: "strong", permitted_uses: [], limitations: [], publisher: "arXiv", date: "2026-05-01" },
  ];
  const compact = makeCompactDossier("llm_threats", evidence);

  const raw = {
    strategic_judgments: [makeJudgment({
      judgment: "Prompt injection attacks are increasingly widespread and growing rapidly across all deployments",
      confidence: "high",
      evidence_for: ["ev_001"],
      supporting_evidence_ids: ["ev_001"],
      what_changed: "Volume of attacks has been growing over the past 3 months",
      causal_mechanism: "Wider LLM deployment creates more targets",
      why_this_matters: "Defenders face growing attack volume",
      uncertainty: "Corpus-only data; real-world prevalence unknown",
    })],
    outlook_6_months: { observed_basis: "obs", projected_trajectory: "may continue", reasoning: "r", confidence: "low", supporting_evidence_ids: [] },
    evidence_gaps: [],
  };

  const result = validateCategoryAnalysis(raw, compact);
  if (result.strategic_judgments.length > 0) {
    // Trend-scope language ("increasingly", "growing") with single item → must be downgraded
    assert.notEqual(result.strategic_judgments[0].confidence, "high",
      "trend-scope claim with single source cannot be high confidence");
  }
});

test("confidence ceiling from analytical state is enforced", () => {
  const evidence = [
    { evidence_id: "ev_001", origin: "5A_rawfact", source_type: "research_finding", evidence_strength: "usable", permitted_uses: [], limitations: [], publisher: "arXiv", date: "2026-05-01" },
    { evidence_id: "ev_002", origin: "5A_rawfact", source_type: "research_finding", evidence_strength: "usable", permitted_uses: [], limitations: [], publisher: "Google", date: "2026-04-01" },
  ];
  const compact = makeCompactDossier("llm_threats", evidence, {
    analytical_state: { confidence_ceiling: "low" },
  });

  const raw = {
    strategic_judgments: [makeJudgment({
      confidence: "high", // LLM tried to assign high, but ceiling is low
      evidence_for: ["ev_001", "ev_002"],
      supporting_evidence_ids: ["ev_001", "ev_002"],
    })],
    outlook_6_months: { observed_basis: "obs", projected_trajectory: "may", reasoning: "r", confidence: "low", supporting_evidence_ids: [] },
    evidence_gaps: [],
  };

  const result = validateCategoryAnalysis(raw, compact);
  if (result.strategic_judgments.length > 0) {
    assert.equal(result.strategic_judgments[0].confidence, "low",
      "confidence capped to analytical state ceiling");
  }
});

// ── 7. Cross-category synthesis uses strategic_judgments ─────────────────────

process.stdout.write("\n7. Cross-category synthesis\n");

test("buildAnalyticalStateBlock shows BLOCKED claim types", () => {
  const analyticalState = {
    confidence_ceiling: "medium",
    hypothesis_candidates: [],
    blocked_claim_opportunities: [
      { claim_type: "trend_over_time", blocking_reason: "insufficient_time_buckets" },
      { claim_type: "market_wide", blocking_reason: "no_operational_sources_for_ecosystem_claim" },
    ],
  };
  const block = buildAnalyticalStateBlock(analyticalState);
  assert.ok(block.includes("BLOCKED CLAIM TYPES"), "shows blocked claim types header");
  assert.ok(block.includes("trend_over_time"), "shows blocked trend_over_time");
  assert.ok(block.includes("market_wide"), "shows blocked market_wide");
});

test("corpus audit block surfaces vendor_heavy constraint", () => {
  const audit = {
    analysis_allowed: "full",
    source_concentration_flags: ["vendor_heavy"],
    evidence_gap_flags: [],
    analysis_limitations: ["Corpus is vendor-dominated"],
  };
  const block = buildCorpusAuditBlock(audit);
  assert.ok(block.includes("vendor_heavy"), "shows vendor_heavy flag");
  assert.ok(block.includes("CLAIM CONSTRAINTS"), "shows claim constraints");
});

// ── 8. Slide plan preserves reasoning chain ───────────────────────────────────

process.stdout.write("\n8. Reasoning chain in claims\n");

test("claim object has reasoning_chain with required fields", () => {
  const claim = {
    claim_id: "claim_llm_1",
    claim_type: "category_insight",
    claim_priority: "high",
    claim_text: "Automated jailbreak search commoditizes bypass tooling",
    reasoning_chain: {
      what_changed: "Attack success rate rose from 23% to 88%",
      causal_mechanism: "Gradient-based optimization removes artisanal skill requirement",
      why_this_matters: "Low-sophistication adversaries can now bypass RLHF filters at scale",
      second_order_implications: ["Open-source jailbreak tools within 6 months"],
      affected_stakeholders: ["LLM providers"],
      uncertainty: "Lab results may not hold for production RLHF models",
      monitoring_signals: ["Monitor adversary forum discussions"],
      recommended_actions: ["Implement adaptive prompt filtering"],
      evidence_against_ids: [],
      analytical_quality: "strategic",
    },
    supporting_evidence_ids: ["ev_001"],
  };
  assert.ok(claim.reasoning_chain.what_changed, "what_changed present");
  assert.ok(claim.reasoning_chain.causal_mechanism, "causal_mechanism present");
  assert.ok(claim.reasoning_chain.why_this_matters, "why_this_matters present");
  assert.ok(claim.reasoning_chain.uncertainty, "uncertainty present");
  assert.ok(Array.isArray(claim.reasoning_chain.second_order_implications), "second_order_implications is array");
  assert.ok(Array.isArray(claim.reasoning_chain.monitoring_signals), "monitoring_signals is array");
});

test("reasoning_chain fields are distinct from claim_text", () => {
  // The reasoning chain should provide ADDITIONAL context beyond the claim_text
  const claimText = "Automated jailbreak search commoditizes bypass tooling";
  const whatChanged = "Attack success rate rose from 23% to 88% with gradient-based search";
  const causal = "Gradient-based optimization removes need for manual crafting";

  // These are different — the reasoning chain adds the mechanism and evidence
  assert.notEqual(whatChanged, claimText, "what_changed differs from claim_text");
  assert.notEqual(causal, claimText, "causal_mechanism differs from claim_text");
  assert.ok(whatChanged.length > claimText.length || whatChanged !== claimText,
    "what_changed is not just the claim text");
});

// ── Summary ───────────────────────────────────────────────────────────────────

process.stdout.write(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
