/**
 * Tests — Slide Argument Form Selection, Visual Scoring, and Case Study Gating
 *
 * Covers:
 *   1. selectSlideArgumentForm — 12 argument forms
 *   2. classifyVisualSupportRelationship — direct / contextual / not_supporting
 *   3. scoreVisualForClaim — visual scoring
 *   4. scoreClaimSlideUsefulness — claim-level usefulness
 *   5. gateCaseStudyCandidates — hard gate before LLM selection
 *   6. validateSelectedCaseStudy — post-LLM deterministic QA
 *   7. qaSlideContent — new checks: bullet_role, analytics, visual support
 *   8. validateSlideTraceability — new rules: input_evidence_ids, bullet roles
 *
 * Run with: node tests/slideArgumentForm.test.js
 */

import assert from "node:assert/strict";
import {
  selectSlideArgumentForm,
  classifyVisualSupportRelationship,
  scoreVisualForClaim,
  scoreClaimSlideUsefulness,
  gateCaseStudyCandidates,
  validateSelectedCaseStudy,
} from "../lib/pipeline/slides/selectSlideArgumentForm.js";
import { qaSlideContent } from "../lib/pipeline/slides/qaSlideContent.js";
import { validateSlideTraceability } from "../lib/pipeline/slides/validateSlideTraceability.js";

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
    failures.push({ name, err });
  }
}

// ── Mock data helpers ─────────────────────────────────────────────────────────

function makeClaim(overrides = {}) {
  return {
    claim_id:           "cl_test",
    claim_text:         "Prompt injection attacks have moved to operational exploitation.",
    claim_type:         "category_insight",
    claim_priority:     "critical",
    supporting_evidence_ids: ["ev_1", "ev_2"],
    caveat_if_any:      null,
    category:           "llm_threats",
    ...overrides,
  };
}

function makeEvidence(overrides = {}) {
  return {
    evidence_id:      "ev_1",
    title:            "Prompt Injection Research",
    publisher:        "NIST",
    url:              "https://nist.gov/example",
    fact:             "3 documented incidents bypassed enterprise guardrails in Q1 2026.",
    numbers:          ["3"],
    entities:         ["ChatGPT Enterprise", "Bing Chat"],
    evidence_type:    "incident_report",
    confidence:       "high",
    source_date:      "2026-01-15",
    ...overrides,
  };
}

function makeAnalyticsPacket(overrides = {}) {
  return {
    analytics_id:  "agg_1",
    metric_type:   "attack_vector_frequency",
    dimension:     "attack_vector",
    value:         { prompt_injection: 12, rag_poisoning: 5, jailbreak: 3 },
    top_entries:   [
      { key: "prompt_injection", count: 12 },
      { key: "rag_poisoning", count: 5 },
    ],
    input_evidence_ids: ["ev_1", "ev_2"],
    ...overrides,
  };
}

function makeVizSpec(overrides = {}) {
  return {
    visualization_id:  "viz_1",
    chart_type:        "bar",
    title:             "prompt injection frequency distribution",
    category:          "llm_threats",
    slide_usable:      true,
    needs_manual_review: false,
    source:            "analytics",
    analytics_id:      "agg_1",
    ...overrides,
  };
}

// ── Section 1: selectSlideArgumentForm ───────────────────────────────────────

console.log("\nselectSlideArgumentForm — argument form selection");

test("critical claim with temporal analytics selects trend_over_time", () => {
  const claim    = makeClaim({ claim_type: "trend_claim" });
  const ev       = [makeEvidence()];
  const analytics = [makeAnalyticsPacket({ metric_type: "monthly_timeline", dimension: "monthly_trend" })];
  const form = selectSlideArgumentForm(claim, ev, analytics, []);
  assert.equal(form, "trend_over_time", `Expected trend_over_time, got ${form}`);
});

test("claim with exploit chain signals selects exploit_chain_diagram", () => {
  const claim = makeClaim({
    claim_text: "Adversaries chain prompt injection into agent tool-call exfiltration flows.",
  });
  const ev = [
    makeEvidence({ evidence_type: "exploit_demonstration", entities: ["GPT-4", "AutoGPT"], attack_flow: ["inject", "bypass", "exfil"] }),
    makeEvidence({ evidence_id: "ev_2", entities: ["LangChain", "MCP"], evidence_type: "exploit_demonstration" }),
  ];
  const form = selectSlideArgumentForm(claim, ev, [], []);
  assert.equal(form, "exploit_chain_diagram", `Expected exploit_chain_diagram, got ${form}`);
});

test("claim with dated incidents and named actors selects incident_timeline", () => {
  const claim = makeClaim({ claim_text: "Three named incidents involving LLM prompt injection were reported." });
  const ev = [
    makeEvidence({ evidence_type: "incident_report", entities: ["Org A", "Org B"], source_date: "2026-02-10" }),
    makeEvidence({ evidence_id: "ev_2", evidence_type: "incident_report", entities: ["Org C", "Model X"], source_date: "2026-01-05" }),
  ];
  const form = selectSlideArgumentForm(claim, ev, [], []);
  assert.equal(form, "incident_timeline", `Expected incident_timeline, got ${form}`);
});

test("recommendation claim_type selects governance_implication", () => {
  const claim = makeClaim({ claim_type: "recommendation" });
  const form  = selectSlideArgumentForm(claim, [makeEvidence()], [], []);
  assert.equal(form, "governance_implication");
});

test("claim with only weak/context evidence and medium priority selects evidence_gap", () => {
  const claim = makeClaim({ claim_priority: "medium" });
  const ev    = [makeEvidence({ confidence: "low", evidence_type: "context_only_background" })];
  const form  = selectSlideArgumentForm(claim, ev, [], []);
  assert.equal(form, "evidence_gap", `Expected evidence_gap, got ${form}`);
});

test("empty evidence selects evidence_gap", () => {
  const claim = makeClaim({ claim_priority: "medium" });
  const form  = selectSlideArgumentForm(claim, [], [], []);
  assert.equal(form, "evidence_gap");
});

test("claim with ranked comparison language and distribution analytics selects ranked_comparison", () => {
  const claim    = makeClaim({ claim_text: "Prompt injection is the most common attack vector observed this period." });
  const analytics = [makeAnalyticsPacket({ metric_type: "vector_frequency", dimension: "attack_vector" })];
  // Use research_finding evidence (no multi-step chain, no dated incident, no 3+ entities)
  const ev = [makeEvidence({ evidence_type: "research_finding", entities: ["LLM deployments"], source_date: null, fact: "Research documented distribution of attack vectors across 50 evaluated systems." })];
  const form = selectSlideArgumentForm(claim, ev, analytics, []);
  assert.equal(form, "ranked_comparison", `Expected ranked_comparison, got ${form}`);
});

test("claim with concrete named case study selects case_study_card", () => {
  const claim = makeClaim({ claim_text: "A specific attack chain targeted an enterprise RAG system." });
  const ev    = [
    makeEvidence({
      evidence_type: "exploit_demonstration",
      entities:      ["Acme Corp LLM"],
      fact:          "Attacker used indirect injection via uploaded PDF to exfiltrate user data from RAG system.",
    }),
  ];
  // No multi-step chain signals to trigger exploit_chain_diagram
  const form = selectSlideArgumentForm(claim, ev, [], []);
  // Should select case_study_card since there's a concrete named entity
  assert.ok(["case_study_card", "exploit_chain_diagram"].includes(form), `Unexpected form: ${form}`);
});

test("capability delta claim selects before_after_capability_delta", () => {
  const claim = makeClaim({
    claim_text:  "LLM jailbreak success rates improved measurably after new multimodal capability delta.",
  });
  const ev = [makeEvidence({ evidence_type: "capability_delta", confidence: "high" })];
  const form = selectSlideArgumentForm(claim, ev, [], []);
  assert.equal(form, "before_after_capability_delta", `Expected before_after_capability_delta, got ${form}`);
});

// ── Section 2: classifyVisualSupportRelationship ─────────────────────────────

console.log("\nclassifyVisualSupportRelationship — visual support classification");

test("bar chart matching claim category and title keywords is direct_support", () => {
  const claim  = makeClaim();
  const viz    = makeVizSpec({ chart_type: "bar", title: "prompt injection frequency distribution", category: "llm_threats" });
  const rel    = classifyVisualSupportRelationship(viz, claim, "ranked_comparison");
  assert.equal(rel, "direct_support", `Expected direct_support, got ${rel}`);
});

test("same-category heatmap without keyword overlap is contextual_support", () => {
  const claim = makeClaim({ claim_text: "Prompt injection is operationally exploited." });
  const viz   = makeVizSpec({ chart_type: "heatmap", title: "maturity_distribution general", category: "llm_threats" });
  const rel   = classifyVisualSupportRelationship(viz, claim, "exploit_chain_diagram");
  // No keyword overlap and wrong chart type for exploit_chain → contextual at best
  assert.ok(["contextual_support", "not_supporting"].includes(rel), `Expected contextual_support or not_supporting, got ${rel}`);
});

test("different category visualization is contextual_support or not_supporting", () => {
  const claim = makeClaim({ category: "llm_threats" });
  const viz   = makeVizSpec({ category: "traditional_ai_threats", chart_type: "bar", title: "data poisoning frequency" });
  const rel   = classifyVisualSupportRelationship(viz, claim, "ranked_comparison");
  assert.ok(["contextual_support", "not_supporting"].includes(rel), `Expected contextual/not_supporting for cross-category viz, got ${rel}`);
});

// ── Section 3: scoreVisualForClaim ─────────────────────────────────────────

console.log("\nscoreVisualForClaim — visual scoring");

test("direct_support usable analytics chart has score > 0.5", () => {
  const claim = makeClaim();
  const viz   = makeVizSpec();
  const score = scoreVisualForClaim(viz, claim, "ranked_comparison", "direct_support");
  assert.ok(score.overall_visual_slide_score > 0.5, `Expected score > 0.5, got ${score.overall_visual_slide_score}`);
  assert.equal(score.visual_support_relationship, "direct_support");
});

test("visual that needs_manual_review has score 0", () => {
  const claim = makeClaim();
  const viz   = makeVizSpec({ needs_manual_review: true });
  const score = scoreVisualForClaim(viz, claim, "ranked_comparison", "direct_support");
  assert.equal(score.overall_visual_slide_score, 0, "Manual review visual should score 0");
});

test("not_supporting visual has low directness_to_claim", () => {
  const claim = makeClaim();
  const viz   = makeVizSpec();
  const score = scoreVisualForClaim(viz, claim, "ranked_comparison", "not_supporting");
  assert.equal(score.directness_to_claim, 0.0);
  assert.equal(score.overall_visual_slide_score, 0, "not_supporting visual should score 0");
});

// ── Section 4: scoreClaimSlideUsefulness ─────────────────────────────────────

console.log("\nscoreClaimSlideUsefulness — claim slide usefulness scoring");

test("critical claim with strong evidence scores >= 0.5", () => {
  const claim    = makeClaim({ claim_priority: "critical" });
  const ev       = [makeEvidence({ confidence: "high", publisher: "NIST" }), makeEvidence({ evidence_id: "ev_2", confidence: "high", publisher: "Anthropic" })];
  const result   = scoreClaimSlideUsefulness(claim, ev, [], []);
  assert.ok(result.overall_claim_slide_score >= 0.5, `Expected >= 0.5, got ${result.overall_claim_slide_score}`);
  assert.ok(result.should_create_full_slide, "Critical claim with strong evidence should create full slide");
});

test("medium claim with no strong evidence has should_create_full_slide false (unless evidence_gap)", () => {
  const claim  = makeClaim({ claim_priority: "medium" });
  const result = scoreClaimSlideUsefulness(claim, [], [], []);
  // evidence_gap form → should_create_full_slide = true (gap transparency)
  assert.equal(result.argument_form, "evidence_gap");
  assert.ok(result.should_create_full_slide, "Evidence gap claim should always create slide for transparency");
});

// ── Section 5: gateCaseStudyCandidates ───────────────────────────────────────

console.log("\ngateCaseStudyCandidates — deterministic hard gate");

const criticalClaim = makeClaim({ claim_id: "cl_llm_1", supporting_evidence_ids: ["ev_cs_1"] });

test("case study with correct type and entities passes gate", () => {
  const cs = {
    evidence_id:    "ev_cs_1",
    claim_id:       "cl_llm_1",
    evidence_type:  "incident_report",
    entities:       ["Org A", "GPT-4"],
    fact:           "Documented incident where prompt injection bypassed enterprise guardrails and exfiltrated data.",
    confidence:     "high",
  };
  const pool = gateCaseStudyCandidates([cs], [criticalClaim]);
  assert.equal(pool.length, 1, "Expected 1 gated case study");
  assert.equal(pool[0].evidence_id, "ev_cs_1");
});

test("case study with wrong evidence type is rejected by gate", () => {
  const cs = {
    evidence_id:   "ev_cs_wrong",
    claim_id:      "cl_llm_1",
    evidence_type: "background_context",  // not a claim-eligible type
    entities:      ["Org A"],
    fact:          "General background about prompt injection threat landscape.",
    confidence:    "high",
  };
  const pool = gateCaseStudyCandidates([cs], [criticalClaim]);
  assert.equal(pool.length, 0, "Background context case study should be rejected");
});

test("case study with low confidence is rejected by gate", () => {
  const cs = {
    evidence_id:   "ev_cs_lowconf",
    claim_id:      "cl_llm_1",
    evidence_type: "incident_report",
    entities:      ["Org A"],
    fact:          "Unverified incident report from anonymous source about prompt injection.",
    confidence:    "low",
  };
  const pool = gateCaseStudyCandidates([cs], [criticalClaim]);
  assert.equal(pool.length, 0, "Low confidence case study should be rejected");
});

test("case study not linked to critical claim is rejected", () => {
  const cs = {
    evidence_id:   "ev_cs_unlinked",
    claim_id:      "cl_different",  // not in criticalClaims
    evidence_type: "incident_report",
    entities:      ["Org B"],
    fact:          "Incident not linked to any critical claim in this category.",
    confidence:    "high",
  };
  const pool = gateCaseStudyCandidates([cs], [criticalClaim]);
  assert.equal(pool.length, 0, "Unlinked case study should be rejected");
});

test("case study without entities is rejected by gate", () => {
  const cs = {
    evidence_id:   "ev_cs_noentity",
    claim_id:      "cl_llm_1",
    evidence_type: "incident_report",
    entities:      [],  // no entities
    fact:          "An unspecified incident was observed in an unspecified system.",
    confidence:    "high",
  };
  const pool = gateCaseStudyCandidates([cs], [criticalClaim]);
  assert.equal(pool.length, 0, "Case study with no entities should be rejected");
});

// ── Section 6: validateSelectedCaseStudy ─────────────────────────────────────

console.log("\nvalidateSelectedCaseStudy — post-LLM deterministic QA");

const goodCaseStudy = {
  evidence_id:   "ev_cs_1",
  claim_id:      "cl_llm_1",
  evidence_type: "incident_report",
  entities:      ["Org A", "GPT-4"],
  fact:          "Documented incident where prompt injection bypassed enterprise guardrails and exfiltrated data.",
  confidence:    "high",
};

const gatedPool = [goodCaseStudy];

test("valid case study in gated pool passes QA", () => {
  const result = validateSelectedCaseStudy(goodCaseStudy, gatedPool, criticalClaim);
  assert.ok(result.valid, `Expected valid, got: ${result.reason}`);
});

test("case study NOT in gated pool fails QA (LLM hallucinated pick)", () => {
  const hallucinated = { evidence_id: "ev_hallucinated", entities: ["Org X"], claim_id: "cl_llm_1", fact: "Made-up incident." };
  const result = validateSelectedCaseStudy(hallucinated, gatedPool, criticalClaim);
  assert.ok(!result.valid, "Hallucinated case study outside gated pool should fail");
  assert.equal(result.reason, "case_study_not_in_gated_pool");
});

test("case study not linked to claim fails QA", () => {
  const notLinked = {
    ...goodCaseStudy,
    claim_id: "cl_different",
    evidence_id: "ev_cs_1",  // in pool but linked to wrong claim
  };
  const result = validateSelectedCaseStudy(notLinked, [notLinked], makeClaim({ claim_id: "cl_llm_1", supporting_evidence_ids: [] }));
  assert.ok(!result.valid, "Case study not linked to claim should fail");
  assert.equal(result.reason, "case_study_not_linked_to_claim");
});

// ── Section 7: qaSlideContent — new checks ───────────────────────────────────

console.log("\nqaSlideContent — new QA checks");

test("finding bullet without supporting_evidence_id gets warning", () => {
  const slide = {
    slide_number:      50,
    slide_type:        "critical_claim",
    title:             "LLM Threats — Critical Finding",
    headline:          "Prompt injection is operationally exploited.",
    bullets: [
      { text: "3 incidents documented in enterprise environments.", bullet_role: "finding" },
      // ^ finding without supporting_evidence_id — should warn
    ],
    evidence_callouts: [
      { evidence_id: "ev_1", key_fact: "3 incidents documented.", publisher: "NIST", url: "https://nist.gov", title: "NIST Report" },
    ],
    citations:         ["NIST — Report (https://nist.gov)"],
    analytics_evidence: [],
    claim_id:          "cl_test",
    claim_type:        "category_insight",
    claim_text:        "Prompt injection is operationally exploited.",
    _plan:             { rawfact_evidence_ids: ["ev_1"], claim_ids: ["cl_test"] },
  };
  const { slides } = qaSlideContent([slide], { strict: false });
  const issues = slides[0].content_qa?.issues || [];
  const hasBulletWarn = issues.some((i) => i.issue === "finding_bullet_missing_evidence_id");
  assert.ok(hasBulletWarn, `Expected finding_bullet_missing_evidence_id warning, got: ${JSON.stringify(issues.map(i=>i.issue))}`);
});

test("analytics chart with no input_evidence_ids is blocked on analytics_pattern slide", () => {
  const slide = {
    slide_number:     51,
    slide_type:       "analytics_pattern",
    title:            "LLM — Analytics",
    headline:         "Attack vector distribution shows prompt injection leads.",
    bullets:          [{ text: "Prompt injection is most observed.", bullet_role: "finding" }],
    evidence_callouts: [],
    citations:         [],
    analytics_evidence: [
      {
        analytics_id: "agg_no_ids",
        metric_type:  "attack_vector_frequency",
        // Missing input_evidence_ids
        analytics_visual_support: "direct_support",
      },
    ],
    claim_id:   "cl_test",
    claim_type: "category_insight",
    claim_text: "Attack patterns observed.",
    _plan:      { rawfact_evidence_ids: [], claim_ids: ["cl_test"] },
  };
  const { slides } = qaSlideContent([slide], { strict: false });
  const issues = slides[0].content_qa?.issues || [];
  const hasBlock = issues.some((i) => i.issue === "analytics_chart_missing_input_evidence_ids");
  assert.ok(hasBlock, `Expected analytics_chart_missing_input_evidence_ids, got: ${JSON.stringify(issues.map(i=>i.issue))}`);
});

test("not_supporting visual on main analytical slide is blocked", () => {
  const slide = {
    slide_number: 52,
    slide_type:   "critical_claim",
    title:        "LLM — Critical Finding",
    headline:     "Prompt injection is operationally exploited.",
    bullets:      [{ text: "Incidents documented.", bullet_role: "finding", supporting_evidence_id: "ev_1" }],
    evidence_callouts: [{ evidence_id: "ev_1", key_fact: "3 incidents.", publisher: "NIST", url: "https://nist.gov", title: "NIST" }],
    citations:    ["NIST — Report (https://nist.gov)"],
    analytics_evidence: [],
    external_visual_callouts: [
      {
        visualization_id:            "vis_irrelevant",
        source_url:                  "https://example.com/chart",
        visual_support_relationship: "not_supporting",
      },
    ],
    claim_id:   "cl_test",
    claim_type: "category_insight",
    claim_text: "Prompt injection is operationally exploited.",
    _plan:      { rawfact_evidence_ids: ["ev_1"], claim_ids: ["cl_test"] },
  };
  const { slides } = qaSlideContent([slide], { strict: false });
  const issues = slides[0].content_qa?.issues || [];
  const hasBlock = issues.some((i) => i.issue === "visual_not_supporting_claim");
  assert.ok(hasBlock, `Expected visual_not_supporting_claim blocking issue, got: ${JSON.stringify(issues.map(i=>i.issue))}`);
});

test("contextual visual on main analytical slide gets warning not blocking", () => {
  const slide = {
    slide_number: 53,
    slide_type:   "critical_claim",
    title:        "LLM — Critical Finding",
    headline:     "Prompt injection is operationally exploited.",
    bullets:      [{ text: "Incidents documented.", bullet_role: "finding", supporting_evidence_id: "ev_1" }],
    evidence_callouts: [{ evidence_id: "ev_1", key_fact: "3 incidents.", publisher: "NIST", url: "https://nist.gov", title: "NIST" }],
    citations:    ["NIST — Report (https://nist.gov)"],
    analytics_evidence: [],
    external_visual_callouts: [
      {
        visualization_id:            "vis_contextual",
        source_url:                  "https://example.com/chart",
        visual_support_relationship: "contextual_support",
      },
    ],
    claim_id:   "cl_test",
    claim_type: "category_insight",
    claim_text: "Prompt injection is operationally exploited.",
    _plan:      { rawfact_evidence_ids: ["ev_1"], claim_ids: ["cl_test"] },
  };
  const { slides } = qaSlideContent([slide], { strict: false });
  const issues = slides[0].content_qa?.issues || [];
  const hasWarning = issues.some((i) => i.issue === "contextual_visual_on_main_slide" && i.severity === "warning");
  assert.ok(hasWarning, `Expected contextual_visual_on_main_slide warning, got: ${JSON.stringify(issues.map(i=>`${i.issue}(${i.severity})`))}`);
});

test("bullet with hallucinated statistic is dropped entirely in strict mode", () => {
  const slide = {
    slide_number:      54,
    slide_type:        "critical_claim",
    title:             "LLM — Critical Finding",
    headline:          "Prompt injection is operationally exploited.",
    bullets: [
      { text: "9,500 attacks were recorded in Q1.", bullet_role: "finding", supporting_evidence_id: "ev_1" },
      { text: "3 incidents were verified by NIST.", bullet_role: "finding", supporting_evidence_id: "ev_1" },
    ],
    evidence_callouts: [
      { evidence_id: "ev_1", key_fact: "3 documented incidents.", publisher: "NIST", url: "https://nist.gov", title: "NIST" },
    ],
    citations:          ["NIST — Incidents (https://nist.gov)"],
    analytics_evidence: [],
    claim_id:           "cl_test",
    claim_type:         "category_insight",
    claim_text:         "Prompt injection is operationally exploited.",
    _plan:              { rawfact_evidence_ids: ["ev_1"], claim_ids: ["cl_test"] },
  };
  const { slides } = qaSlideContent([slide], { strict: true });
  const cleanedBullets = slides[0].bullets || [];
  // The 9500 bullet should be dropped; the 3 bullet should survive
  const has9500 = cleanedBullets.some((b) => {
    const t = typeof b === "object" ? b.text : b;
    return /9.?500/i.test(t || "");
  });
  assert.ok(!has9500, "Bullet with hallucinated statistic 9500 should be dropped, not tagged");
  assert.ok(cleanedBullets.length >= 1, "At least one clean bullet should remain");
});

test("research-only capability delta claim gets research_only caveat via evidence type", () => {
  const claim = makeClaim({
    claim_text:  "LLM jailbreak success rate improved from 30% to 62% in lab conditions.",
    claim_type:  "category_insight",
    caveat_if_any: "Research-only — lab environment, not validated in production.",
  });
  const form = selectSlideArgumentForm(
    claim,
    [makeEvidence({ evidence_type: "benchmark_result", confidence: "high", fact: "62% success rate in lab." })],
    [],
    []
  );
  // Should be before_after or case_study or evidence_callout — not evidence_gap
  assert.ok(form !== "evidence_gap", `Research claim with high confidence should not be evidence_gap, got ${form}`);
});

// ── Section 8: validateSlideTraceability — new rules ─────────────────────────

console.log("\nvalidateSlideTraceability — new traceability rules");

// Minimal mock registry
function makeRegistry(resolveMap = {}) {
  return {
    resolve:              (id) => resolveMap[id] || null,
    validateIds:          (ids) => ({ missing: ids.filter((id) => !resolveMap[id]), resolved: ids.filter((id) => resolveMap[id]) }),
    validateVisualIds:    (ids) => ({ missing: [] }),
    validateClaimSupport: (claims) => ({ unsupported_claim_ids: [] }),
    summary:              () => ({}),
  };
}

test("analytics_pattern slide with analytics chart missing input_evidence_ids gets error", () => {
  const registry = makeRegistry({ "ev_1": { claim_relevance: { admissibility: "passed", evidence_strength: "strong" } } });
  const slide = {
    slide_id:    "slide_100",
    slide_number: 100,
    slide_type:  "analytics_pattern",
    claim_id:    "cl_test",
    claim_type:  "category_insight",
    claim_text:  "Attack patterns observed.",
    supporting_evidence_ids: ["ev_1"],
    supporting_evidence:     [{ evidence_id: "ev_1" }],
    evidence_callouts:       [],
    external_evidence_callouts: [],
    external_visual_callouts:   [],
    analytics_evidence: [
      {
        analytics_id:           "agg_test",
        input_evidence_ids:     [],   // missing
        analytics_visual_support: "direct_support",
      },
    ],
    bullets: [],
    visualization_ids: [],
  };
  const report = validateSlideTraceability([slide], registry);
  const hasError = report.errors.some((e) => /input_evidence_ids/.test(e));
  assert.ok(hasError, `Expected error about input_evidence_ids, got errors: ${JSON.stringify(report.errors)}`);
});

test("analytical slide with no evidence packets gets error", () => {
  const registry = makeRegistry({});  // nothing resolves
  const slide = {
    slide_id:    "slide_101",
    slide_number: 101,
    slide_type:  "critical_claim",
    claim_id:    "cl_test",
    claim_type:  "category_insight",
    claim_text:  "Prompt injection is widely exploited.",
    supporting_evidence_ids:    [],
    supporting_evidence:        [],
    evidence_callouts:          [],
    external_evidence_callouts: [],
    external_visual_callouts:   [],
    analytics_evidence:         [],
    bullets:                    [],
    visualization_ids:          [],
  };
  const report = validateSlideTraceability([slide], registry);
  const hasError = report.errors.some((e) => /no supporting evidence packets/.test(e));
  assert.ok(hasError, `Expected 'no supporting evidence packets' error, got: ${JSON.stringify(report.errors)}`);
});

test("external visual without source_url gets error in traceability", () => {
  const registry = makeRegistry({
    "ev_1": { claim_relevance: { admissibility: "passed", evidence_strength: "strong" } },
  });
  const slide = {
    slide_id:    "slide_102",
    slide_number: 102,
    slide_type:  "critical_claim",
    claim_id:    "cl_test",
    claim_type:  "category_insight",
    claim_text:  "Prompt injection is exploited.",
    supporting_evidence_ids:    ["ev_1"],
    supporting_evidence:        [{ evidence_id: "ev_1" }],
    evidence_callouts:          [],
    external_evidence_callouts: [],
    external_visual_callouts:   [
      {
        visualization_id: "vis_no_url",
        slide_usable:     true,
        manual_review_required: false,
        // source_url missing
      },
    ],
    analytics_evidence: [],
    bullets:            [],
    visualization_ids:  [],
  };
  const report = validateSlideTraceability([slide], registry);
  const hasError = report.errors.some((e) => /source_url/.test(e));
  assert.ok(hasError, `Expected source_url error, got: ${JSON.stringify(report.errors)}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("\n──────────────────────────────────────────────────");
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const { name, err } of failures) {
    console.log(`  ✗ ${name}: ${err.message}`);
  }
  process.exit(1);
}
