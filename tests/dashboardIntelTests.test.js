/**
 * Dashboard Intelligence QA — tests
 *
 * Verifies:
 *   1. Quality tier classification (summary_only blocked, analytical passes)
 *   2. Consumption approval statuses
 *   3. Dashboard intel object construction
 *   4. Dashboard QA gate checks
 *   5. Cross-category QA requirements
 *   6. Chatbot cannot use blocked claims
 *
 * Run with: node tests/dashboardIntelTests.test.js
 */

import assert from "node:assert/strict";

import {
  rateJudgmentQuality,
  classifyJudgmentTier,
  MINIMUM_QUALITY_FOR_MAIN_OUTPUT,
} from "../lib/pipeline/analysis/analyticalQualityQa.js";

import {
  buildIntelObject,
  buildDashboardIntelPackage,
} from "../lib/pipeline/analysis/buildDashboardIntelPackage.js";

import {
  qaDashboardIntelObject,
  qaAllDashboardIntelObjects,
} from "../lib/pipeline/analysis/dashboardIntelQa.js";

import {
  composeIntelAnswer,
} from "../lib/agent/responseComposer.js";

import {
  findDashboardIntel,
  intelToEvidencePoints,
} from "../lib/agent/claimChainLookup.js";

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeJudgment(overrides = {}) {
  return {
    judgment_id:    "j001",
    judgment:       "Prompt injection tooling is now automated, reducing barrier for attackers.",
    judgment_type:  "capability_change",
    what_changed:   "Gradient search replaces artisanal attack crafting.",
    causal_mechanism: "JailbreakOPT automates PAIR with no human loop required.",
    why_this_matters: "Low-skill adversaries can now generate bypass prompts at scale.",
    uncertainty:    "Only demonstrated in lab; operational adoption unconfirmed.",
    confidence:     "medium",
    evidence_for:   ["e1", "e2"],
    evidence_against: [],
    supporting_evidence_ids: ["e1", "e2"],
    second_order_implications: ["Wider exploit tool distribution expected."],
    monitoring_signals: ["Track PoC tool releases on GitHub"],
    recommended_actions: ["Implement input length heuristics"],
    affected_stakeholders: ["LLM API operators"],
    caveat_if_any:  null,
    slide_usefulness: "high",
    short_takeaway: "Automated jailbreak tools lower bar for low-skill adversaries",
    dashboard_relevance_hint: "capability_update",
    judgment_flags: { is_lab_only: true },
    secondary_attributes: ["lab_only"],
    ...overrides,
  };
}

const MOCK_EVIDENCE_REGISTRY = new Map([
  ["e1", { evidence_id: "e1", fact: "88% ASR on GPT-4 using PAIR.", source_type: "research_finding", publisher: "arXiv", url: "https://arxiv.org/abs/2023.01", trust_tier: "high" }],
  ["e2", { evidence_id: "e2", fact: "JailbreakOPT runs in under 60s per target.", source_type: "benchmark_evaluation", publisher: "MIT", url: "https://mit.edu/paper", trust_tier: "high" }],
]);

// ── 1. Quality tier classification ────────────────────────────────────────────
console.log("\n1. Quality tier classification");

test("analytical judgment with change+cause+implication → 'analytical'", () => {
  // Strip second_order and monitoring to get exactly 'analytical' not 'strategic'
  const j = makeJudgment({ second_order_implications: [], monitoring_signals: [], uncertainty: "" });
  assert.equal(rateJudgmentQuality(j), "analytical");
});

test("judgment with second_order AND uncertainty → 'strategic'", () => {
  const j = makeJudgment({
    second_order_implications: ["Tool distribution expected"],
    monitoring_signals: ["Watch GitHub releases"],
  });
  assert.equal(rateJudgmentQuality(j), "strategic");
});

test("judgment without causal_mechanism → 'descriptive'", () => {
  const j = makeJudgment({ causal_mechanism: "", what_changed: "Something happened." });
  assert.equal(rateJudgmentQuality(j), "descriptive");
});

test("judgment without change and cause → 'summary_only'", () => {
  const j = makeJudgment({ what_changed: "", causal_mechanism: "" });
  assert.equal(rateJudgmentQuality(j), "summary_only");
});

test("judgment with no cited evidence → 'unsupported'", () => {
  const j = makeJudgment({ evidence_for: [], supporting_evidence_ids: [] });
  assert.equal(rateJudgmentQuality(j), "unsupported");
});

test("MINIMUM_QUALITY_FOR_MAIN_OUTPUT is 'analytical'", () => {
  assert.equal(MINIMUM_QUALITY_FOR_MAIN_OUTPUT, "analytical");
});

// ── 2. Consumption approval statuses ──────────────────────────────────────────
console.log("\n2. Consumption approval statuses");

test("analytical judgment → approved for dashboard, slides, report, chatbot", () => {
  const j     = makeJudgment({
    short_takeaway: "A meaningful 10-word short takeaway for analysts here",
    second_order_implications: [], monitoring_signals: [], uncertainty: "",
  });
  const tiers = classifyJudgmentTier(j);
  assert.equal(tiers.quality_tier, "analytical");
  assert.ok(tiers.approved_for_dashboard, "should be approved for dashboard");
  assert.ok(tiers.approved_for_slides,    "should be approved for slides");
  assert.ok(tiers.approved_for_report,    "should be approved for report");
  assert.ok(tiers.approved_for_chatbot,   "should be approved for chatbot");
  assert.ok(!tiers.approved_for_appendix, "analytical should NOT be appendix-only");
  assert.ok(!tiers.blocked,               "should not be blocked");
});

test("summary_only judgment → blocked from dashboard, slides, report", () => {
  const j     = makeJudgment({ what_changed: "", causal_mechanism: "" });
  const tiers = classifyJudgmentTier(j);
  assert.equal(tiers.quality_tier, "summary_only");
  assert.ok(!tiers.approved_for_dashboard, "summary_only must not reach dashboard");
  assert.ok(!tiers.approved_for_slides,    "summary_only must not reach slides");
  assert.ok(!tiers.approved_for_chatbot,   "summary_only must not reach chatbot");
  assert.ok(tiers.blocked,                 "summary_only must be blocked");
});

test("unsupported judgment → blocked everywhere", () => {
  const j     = makeJudgment({ evidence_for: [], supporting_evidence_ids: [] });
  const tiers = classifyJudgmentTier(j);
  assert.ok(!tiers.approved_for_dashboard);
  assert.ok(!tiers.approved_for_chatbot);
  assert.ok(tiers.blocked);
});

test("descriptive judgment → appendix only, not main panels", () => {
  const j     = makeJudgment({ causal_mechanism: "" });
  const tiers = classifyJudgmentTier(j);
  assert.equal(tiers.quality_tier, "descriptive");
  assert.ok(!tiers.approved_for_dashboard, "descriptive must not be on main dashboard");
  assert.ok(tiers.approved_for_appendix,  "descriptive is allowed in appendix");
});

test("adoption claim without caveat → dashboard rejected", () => {
  const j = makeJudgment({
    judgment_flags: { implies_adoption: true },
    caveat_if_any: null,
  });
  const tiers = classifyJudgmentTier(j);
  assert.ok(!tiers.approved_for_dashboard, "adoption without caveat must not reach dashboard");
  assert.ok(tiers.dashboard_rejection_reason, "should have rejection reason");
  assert.ok(/caveat/.test(tiers.dashboard_rejection_reason), "reason should mention caveat");
});

test("confidence exceeds ceiling → blocked", () => {
  const j     = makeJudgment({ confidence: "high" });
  const tiers = classifyJudgmentTier(j, { ceiling: "low" });
  assert.ok(!tiers.approved_for_slides, "high confidence should be blocked when ceiling=low");
  assert.ok(tiers.quality_reasons.some((r) => /ceiling/.test(r)));
});

// ── 3. Dashboard intel object construction ────────────────────────────────────
console.log("\n3. buildIntelObject");

test("builds intel object with required fields", () => {
  const j   = makeJudgment({ approved_for_dashboard: true, approved_for_chatbot: true, approved_for_slides: true, approved_for_report: true, analytical_quality: "analytical" });
  const obj = buildIntelObject(j, "llm_threats", MOCK_EVIDENCE_REGISTRY, new Map());
  assert.ok(obj.intel_id,              "should have intel_id");
  assert.ok(obj.judgment,              "should have judgment");
  assert.ok(obj.short_takeaway,        "should have short_takeaway");
  assert.ok(obj.why_it_matters,        "should have why_it_matters");
  assert.ok(Array.isArray(obj.evidence_for), "should have evidence_for array");
  assert.ok(obj.evidence_for.length > 0, "evidence should be resolved");
  assert.ok(Array.isArray(obj.caveats), "caveats should be array");
  assert.ok(obj.trend_status,          "should have trend_status");
  assert.ok(obj.visual_suggestion,     "should have visual_suggestion");
  assert.ok(obj.visual_suggestion.visual_type, "visual suggestion should have type");
  assert.ok(obj.visual_suggestion.supporting_evidence_ids?.length >= 0, "visual should include evidence IDs");
});

test("resolved evidence includes URL and publisher", () => {
  const j   = makeJudgment({ approved_for_dashboard: true, analytical_quality: "analytical" });
  const obj = buildIntelObject(j, "llm_threats", MOCK_EVIDENCE_REGISTRY, new Map());
  const ev  = obj.evidence_for[0];
  assert.ok(ev.publisher, "publisher present");
  assert.ok(ev.url,       "URL present");
  assert.ok(ev.fact,      "fact present");
});

test("trend_status=emerging_signal for lab-only single source", () => {
  const j   = makeJudgment({ judgment_flags: { is_lab_only: true }, approved_for_dashboard: true, analytical_quality: "analytical" });
  const obj = buildIntelObject(j, "llm_threats", MOCK_EVIDENCE_REGISTRY, new Map());
  assert.ok(["emerging_signal", "isolated_case"].includes(obj.trend_status),
    `expected emerging_signal or isolated_case, got ${obj.trend_status}`);
});

test("visual_suggestion includes fallback_if_data_missing", () => {
  const j   = makeJudgment({ approved_for_dashboard: true, analytical_quality: "analytical" });
  const obj = buildIntelObject(j, "llm_threats", MOCK_EVIDENCE_REGISTRY, new Map());
  assert.ok(obj.visual_suggestion.fallback_if_data_missing, "should have fallback");
});

// ── 4. Dashboard QA gate ──────────────────────────────────────────────────────
console.log("\n4. dashboardIntelQa");

test("QA passes when evidence IDs resolve and quality is analytical", () => {
  const intelObj = buildIntelObject(
    makeJudgment({ approved_for_dashboard: true, analytical_quality: "analytical" }),
    "llm_threats", MOCK_EVIDENCE_REGISTRY, new Map()
  );
  const result = qaDashboardIntelObject(intelObj, MOCK_EVIDENCE_REGISTRY, null);
  assert.ok(result.qa_pass, `QA should pass, issues: ${result.qa_issues.join(", ")}`);
});

test("QA fails when all evidence IDs unresolved", () => {
  const badObj = {
    intel_id: "test1",
    judgment: "Some claim",
    analytical_quality: "analytical",
    supporting_evidence_ids: ["missing_e1", "missing_e2"],
    evidence_for: [],
    judgment_flags: {},
    caveats: [],
    confidence: "low",
    short_takeaway: "A clear actionable takeaway here",
    approved_for_dashboard: true,
    approved_for_appendix: false,
  };
  const result = qaDashboardIntelObject(badObj, MOCK_EVIDENCE_REGISTRY, null);
  assert.ok(!result.qa_pass, "QA should fail when evidence IDs unresolved");
  assert.ok(!result.final_approved_for_dashboard);
});

test("QA fails for analytics-only real-world claim", () => {
  const intelObj = {
    intel_id: "test2",
    judgment: "Adversaries have adopted X.",
    analytical_quality: "analytical",
    supporting_evidence_ids: ["e1"],
    evidence_for: [{ evidence_id: "e1", source_type: "analytics", evidence_class: "analytics" }],
    judgment_flags: { implies_adoption: true },
    caveats: ["Needs corroboration"],
    confidence: "medium",
    short_takeaway: "A clear actionable takeaway for this",
    approved_for_dashboard: true,
    approved_for_appendix: true,
  };
  const result = qaDashboardIntelObject(intelObj, MOCK_EVIDENCE_REGISTRY, null);
  assert.ok(
    result.qa_issues.some((i) => i.includes("analytics_only")),
    "Should flag analytics-only real-world claim"
  );
});

test("QA warns when no source URL available", () => {
  const intelObj = {
    intel_id: "test3",
    judgment: "A finding.",
    analytical_quality: "analytical",
    supporting_evidence_ids: ["e1"],
    evidence_for: [{ evidence_id: "e1", source_type: "research_finding" }],
    source_links: [],  // No URLs
    judgment_flags: {},
    caveats: [],
    confidence: "medium",
    short_takeaway: "A ten word clear actionable takeaway for user",
    approved_for_dashboard: true,
    approved_for_appendix: true,
  };
  const result = qaDashboardIntelObject(intelObj, MOCK_EVIDENCE_REGISTRY, null);
  assert.ok(result.qa_issues.some((i) => i.includes("source_url")), "Should warn about missing URL");
});

// ── 5. Cross-category QA ──────────────────────────────────────────────────────
console.log("\n5. Cross-category intel requirements");

test("cross-category pattern with < 2 evidence IDs is excluded", () => {
  const result = buildDashboardIntelPackage({
    categoryAnalyses: [],
    crossCategorySynthesis: {
      patterns: [
        { insight: "weak pattern", confidence: "medium", supporting_evidence_ids: ["e1"], categories: ["llm_threats"] },
      ],
    },
    evidenceRegistry: MOCK_EVIDENCE_REGISTRY,
    sourceRegistry: new Map(),
  });
  assert.equal(result.cross_category_intel.length, 0, "pattern with only 1 evidence ID should be excluded");
});

test("cross-category pattern with ≥ 2 evidence IDs is included", () => {
  const result = buildDashboardIntelPackage({
    categoryAnalyses: [],
    crossCategorySynthesis: {
      patterns: [
        { insight: "strong cross-category pattern", confidence: "medium", supporting_evidence_ids: ["e1", "e2"], categories: ["llm_threats", "agentic_ai_threats"] },
      ],
    },
    evidenceRegistry: MOCK_EVIDENCE_REGISTRY,
    sourceRegistry: new Map(),
  });
  assert.equal(result.cross_category_intel.length, 1, "pattern with 2 evidence IDs should be included");
  assert.deepEqual(result.cross_category_intel[0].affected_categories, ["llm_threats", "agentic_ai_threats"]);
});

test("low-confidence cross-category pattern is appendix only", () => {
  const result = buildDashboardIntelPackage({
    categoryAnalyses: [],
    crossCategorySynthesis: {
      patterns: [
        { insight: "low confidence pattern", confidence: "low", supporting_evidence_ids: ["e1", "e2"], categories: ["llm_threats"] },
      ],
    },
    evidenceRegistry: MOCK_EVIDENCE_REGISTRY,
    sourceRegistry: new Map(),
  });
  const obj = result.cross_category_intel[0];
  assert.ok(!obj.approved_for_dashboard, "low confidence cross-category must not be on main panels");
  assert.ok(obj.dashboard_rejection_reason?.includes("low confidence"), "should have rejection reason");
});

// ── 6. Chatbot / dashboard consumption ────────────────────────────────────────
console.log("\n6. Chatbot consumption rules");

test("composeIntelAnswer works for approved chatbot intel", () => {
  const j   = makeJudgment({
    approved_for_chatbot: true,
    approved_for_dashboard: true,
    analytical_quality: "analytical",
    short_takeaway: "Automated jailbreak tools lower bar for low-skill attackers",
  });
  const obj = buildIntelObject(j, "llm_threats", MOCK_EVIDENCE_REGISTRY, new Map());
  const ans = composeIntelAnswer({ ...obj, approved_for_chatbot: true }, []);
  assert.ok(ans, "should produce an answer");
  assert.ok(ans.answer, "answer text present");
  assert.equal(ans.source_type, "dashboard_intel");
  assert.ok(ans.evidence_points?.length > 0, "should have evidence points");
});

test("composeIntelAnswer returns null for non-approved chatbot intel", () => {
  const j   = makeJudgment({ what_changed: "", causal_mechanism: "" }); // summary_only
  const obj = buildIntelObject(j, "llm_threats", MOCK_EVIDENCE_REGISTRY, new Map());
  // Ensure approved_for_chatbot=false
  const ans = composeIntelAnswer({ ...obj, approved_for_chatbot: false }, []);
  assert.equal(ans, null, "must not compose answer for non-chatbot-approved intel");
});

test("findDashboardIntel uses approved objects when available", () => {
  const mockSynth = {
    analysis_package: {
      dashboard_intel: {
        approved_for_main_panels: [
          {
            intel_id: "intel_test",
            category: "llm_threats",
            judgment: "Test judgment",
            short_takeaway: "A clear short takeaway",
            confidence: "medium",
            analytical_quality: "analytical",
            supporting_evidence_ids: ["e1"],
            approved_for_chatbot: true,
          },
        ],
      },
    },
  };
  const result = findDashboardIntel({ synthesisData: mockSynth });
  assert.equal(result.source, "dashboard_intel");
  assert.ok(result.intel, "should find intel object");
  assert.equal(result.intel.intel_id, "intel_test");
});

test("findDashboardIntel returns null intel when no dashboard_intel in synthesis", () => {
  const result = findDashboardIntel({ synthesisData: {} });
  assert.equal(result.intel, null, "should return null when no dashboard intel");
  assert.equal(result.source, "claim_chain", "should fall back to claim_chain source");
});

test("intelToEvidencePoints extracts facts and URLs", () => {
  const j   = makeJudgment({ approved_for_chatbot: true, analytical_quality: "analytical" });
  const obj = buildIntelObject(j, "llm_threats", MOCK_EVIDENCE_REGISTRY, new Map());
  const pts = intelToEvidencePoints(obj);
  assert.ok(pts.length > 0, "should have evidence points");
  assert.ok(pts[0].fact,      "each point has a fact");
  assert.ok(pts[0].publisher, "each point has a publisher");
});

// ── 7. Dashboard visual suggestions ───────────────────────────────────────────
console.log("\n7. Dashboard visual suggestions");

test("capability_change → attack_chain_diagram suggestion", () => {
  const j   = makeJudgment({ judgment_type: "capability_change", approved_for_dashboard: true, analytical_quality: "analytical" });
  const obj = buildIntelObject(j, "llm_threats", MOCK_EVIDENCE_REGISTRY, new Map());
  assert.equal(obj.visual_suggestion.visual_type, "attack_chain_diagram");
  assert.ok(obj.visual_suggestion.supporting_evidence_ids?.length >= 0);
});

test("adversary_adoption → evidence_matrix suggestion", () => {
  const j   = makeJudgment({ judgment_type: "adversary_adoption", approved_for_dashboard: true, analytical_quality: "analytical" });
  const obj = buildIntelObject(j, "llm_threats", MOCK_EVIDENCE_REGISTRY, new Map());
  assert.equal(obj.visual_suggestion.visual_type, "evidence_matrix");
});

test("monitoring_required → weak_signal_watchlist suggestion", () => {
  const j   = makeJudgment({ judgment_type: "monitoring_required", approved_for_dashboard: true, analytical_quality: "analytical" });
  const obj = buildIntelObject(j, "llm_threats", MOCK_EVIDENCE_REGISTRY, new Map());
  assert.equal(obj.visual_suggestion.visual_type, "weak_signal_watchlist");
});

test("every visual suggestion includes required_data and fallback", () => {
  for (const type of ["adversary_adoption", "operational_shift", "capability_change", "risk_elevation", "ecosystem_change", "monitoring_required"]) {
    const j   = makeJudgment({ judgment_type: type, approved_for_dashboard: true, analytical_quality: "analytical" });
    const obj = buildIntelObject(j, "llm_threats", MOCK_EVIDENCE_REGISTRY, new Map());
    assert.ok(obj.visual_suggestion.required_data?.length >= 1, `${type}: visual must have required_data`);
    assert.ok(obj.visual_suggestion.fallback_if_data_missing, `${type}: visual must have fallback`);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
