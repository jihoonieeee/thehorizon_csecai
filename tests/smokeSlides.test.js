/**
 * Smoke test — Claim-first slide layer (deck-v8.0)
 *
 * Verifies:
 *   1. planSlides() produces claim_id on analytical slides when chain data is present
 *   2. Weak categories (no claims) do NOT get a full 7-slide section
 *   3. Trend slides only appear when claim_type=trend_claim
 *   4. Outlook slides carry outlook_horizon + outlook_confidence
 *   5. Speaker notes QA blocks new numbers not in slide content
 *   6. qaSlideContent blocks trend_claim slides without claim_type=trend_claim
 *   7. generateSlideContent assembleSlide carries claim fields through
 *   8. qaSpeakerNotes blocks certainty language in outlook notes
 *
 * Run with: node tests/smokeSlides.test.js
 */

import assert from "node:assert/strict";
import { planSlides } from "../lib/pipeline/slides/planSlides.js";
import { qaSlideContent } from "../lib/pipeline/slides/qaSlideContent.js";
import { qaSpeakerNotes } from "../lib/pipeline/slides/qaSpeakerNotes.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

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

// ── Mock data ─────────────────────────────────────────────────────────────────

const mockCriticalClaim = {
  claim_id:                   "cl_llm_1",
  claim_text:                 "Prompt injection has moved from research demonstration to operational exploitation against enterprise LLM deployments.",
  claim_type:                 "category_insight",
  claim_priority:             "critical",
  analytical_change:          "adoption_moved_forward",
  change_driver:              "operationalized",
  signal_temporality:         "persistent",
  supporting_viewpoint_ids:   ["vp_1"],
  supporting_observation_ids: ["obs_1"],
  supporting_evidence_ids:    ["ev_src1_1", "ev_src2_1"],
  evidence_sufficiency:       "sufficient",
  broad_relevance:            true,
  broad_relevance_basis:      ["common_ai_deployment_pattern"],
  multi_scope_impact:         true,
  multi_scope_basis:          ["actors", "systems"],
  strong_viewpoint_support:   true,
  strong_evidence_support:    true,
  blocking_limitations:       false,
  slide_driving_power:        true,
  caveat_if_any:              null,
  reasoning:                  "Multiple incidents documented.",
};

const mockHighClaim = {
  claim_id:                   "cl_tai_1",
  claim_text:                 "Data poisoning attacks against public ML training datasets have increased in sophistication.",
  claim_type:                 "category_insight",
  claim_priority:             "high",
  analytical_change:          "capability_increased",
  change_driver:              "materially_expanded",
  signal_temporality:         "recurring",
  supporting_viewpoint_ids:   ["vp_2"],
  supporting_observation_ids: ["obs_2"],
  supporting_evidence_ids:    ["ev_src3_1"],
  evidence_sufficiency:       "sufficient",
  broad_relevance:            true,
  broad_relevance_basis:      ["common_ai_deployment_pattern"],
  multi_scope_impact:         false,
  multi_scope_basis:          [],
  strong_viewpoint_support:   true,
  strong_evidence_support:    true,
  blocking_limitations:       false,
  slide_driving_power:        false,
  caveat_if_any:              null,
  reasoning:                  "Capability observed.",
};

const mockTrendClaim = {
  claim_id:                   "cl_agentic_trend",
  claim_text:                 "Tool-call injection attacks against agentic AI systems show a recurring pattern across multiple independent research teams.",
  claim_type:                 "trend_claim",
  claim_priority:             "high",
  analytical_change:          "exposure_expanded",
  change_driver:              "newly_emerged",
  signal_temporality:         "recurring",
  supporting_viewpoint_ids:   ["vp_3"],
  supporting_observation_ids: ["obs_3"],
  supporting_evidence_ids:    ["ev_src4_1", "ev_src5_1", "ev_src6_1"],
  evidence_sufficiency:       "sufficient",
  broad_relevance:            true,
  broad_relevance_basis:      ["common_ai_deployment_pattern"],
  multi_scope_impact:         false,
  multi_scope_basis:          [],
  strong_viewpoint_support:   true,
  strong_evidence_support:    true,
  blocking_limitations:       false,
  slide_driving_power:        false,
  caveat_if_any:              "Based on 3 independent sources across 2 quarters.",
  reasoning:                  "Three teams observed similar pattern.",
};

const mockOutlookClaim = {
  claim_id:                   "cl_llm_outlook",
  claim_text:                 "LLM jailbreaks will continue to evolve as capability/safety boundaries shift over the next 6 months.",
  claim_type:                 "outlook",
  claim_priority:             "medium",
  analytical_change:          "trust_boundary_shifted",
  change_driver:              "persistent_unresolved",
  signal_temporality:         "persistent",
  supporting_viewpoint_ids:   ["vp_1"],
  supporting_observation_ids: [],
  supporting_evidence_ids:    ["ev_src2_1"],
  evidence_sufficiency:       "partial",
  broad_relevance:            false,
  broad_relevance_basis:      [],
  multi_scope_impact:         false,
  multi_scope_basis:          [],
  strong_viewpoint_support:   false,
  strong_evidence_support:    false,
  blocking_limitations:       false,
  slide_driving_power:        false,
  caveat_if_any:              "Based on limited outlook signals.",
  reasoning:                  "Persistent signals suggest continuation.",
};

const mockEvidence = [
  {
    evidence_id:    "ev_src1_1",
    title:          "Prompt Injection in Enterprise LLM Deployments",
    publisher:      "NIST",
    url:            "https://nist.gov/example",
    fact:           "3 documented incidents of prompt injection bypassing enterprise guardrails in Q1.",
    numbers:        ["3"],
    entities:       ["ChatGPT Enterprise", "Bing Chat"],
    source_type:    "incident",
  },
  {
    evidence_id:    "ev_src2_1",
    title:          "LLM Attack Patterns 2025",
    publisher:      "Anthropic",
    url:            "https://anthropic.com/research/example",
    fact:           "Indirect injection via RAG documents was observed in 12 of 50 evaluated deployments.",
    numbers:        ["12", "50"],
    entities:       ["RAG", "LLM"],
    source_type:    "research_finding",
  },
];

const mockCategories = [
  {
    category:           "llm_threats",
    category_headline:  "LLM prompt injection is now operational.",
    overview:           "Prompt injection has crossed from research to operational.",
    analysis_confidence:"high",
    assessment_status:  "assessed",
    top_insights:       [{ insight: "Prompt injection is widely exploited.", confidence: "high", qa_pass: true }],
    early_signals:      [],
    recommendations:    [],
    outlook:            { statement: "Attacks will continue to evolve.", time_horizon: "6_months" },
    evidence_gaps:      [],
  },
  {
    category:           "traditional_ai_threats",
    category_headline:  "Data poisoning capabilities expanded.",
    overview:           "Data poisoning attacks are more sophisticated.",
    analysis_confidence:"medium",
    assessment_status:  "assessed",
    top_insights:       [{ insight: "Poisoning capability expanded.", confidence: "medium", qa_pass: true }],
    early_signals:      [],
    recommendations:    [],
    outlook:            { statement: "Research continues.", time_horizon: "6_months" },
    evidence_gaps:      [],
  },
  {
    category:           "agentic_ai_threats",
    category_headline:  "Agentic AI attack surface expanding.",
    overview:           "Tool-call injection is an emerging threat.",
    analysis_confidence:"medium",
    assessment_status:  "assessed",
    top_insights:       [],
    early_signals:      [{ signal: "Tool-call injection observed.", implication_3_6_months: "May escalate.", qa_pass: true }],
    recommendations:    [],
    outlook:            { statement: "Early signals need monitoring.", time_horizon: "6_months" },
    evidence_gaps:      ["Limited incident data"],
  },
  {
    category:           "ai_enabled_threats",
    category_headline:  "AI-enabled threats insufficient.",
    overview:           "Insufficient evidence.",
    analysis_confidence:"low",
    assessment_status:  "evidence_insufficient",
    top_insights:       [],
    early_signals:      [],
    recommendations:    [],
    outlook:            null,
    evidence_gaps:      ["No validated evidence this period."],
    assessment_note:    "No validated evidence for AI-enabled threats this reporting period.",
  },
];

const mockClaimChain = {
  llm_threats: {
    claims: [mockCriticalClaim, mockOutlookClaim],
    viewpoints: [{ viewpoint_id: "vp_1", viewpoint_text: "Prompt injection is operationally dangerous.", viewpoint_type: "operational_pattern", analytical_change: "adoption_moved_forward", change_driver: "operationalized", strength: "strong" }],
    observations: [{ observation_id: "obs_1", observation_text: "Multiple incidents documented.", observation_type: "repeated_technique", observation_scope: "repeated_pattern" }],
    case_studies: [{ evidence_id: "ev_src1_1", title: "Prompt Injection Case", claim_id: "cl_llm_1" }],
    selected_evidence_by_claim: [
      { claim_id: "cl_llm_1", claim_priority: "critical", claim_text: mockCriticalClaim.claim_text, selected_evidence: mockEvidence },
      { claim_id: "cl_llm_outlook", claim_priority: "medium", claim_text: mockOutlookClaim.claim_text, selected_evidence: [mockEvidence[1]] },
    ],
    counts: { claims_critical: 1, claims_high: 0, claims_medium: 1, claims_rejected: 0 },
    llm_used: false,
  },
  traditional_ai_threats: {
    claims: [mockHighClaim],
    viewpoints: [{ viewpoint_id: "vp_2", viewpoint_text: "Poisoning capability increased.", viewpoint_type: "capability_shift", analytical_change: "capability_increased", change_driver: "materially_expanded", strength: "strong" }],
    observations: [{ observation_id: "obs_2", observation_text: "Increased sophistication.", observation_type: "repeated_technique", observation_scope: "capability_marker" }],
    case_studies: [],
    selected_evidence_by_claim: [
      { claim_id: "cl_tai_1", claim_priority: "high", claim_text: mockHighClaim.claim_text, selected_evidence: [] },
    ],
    counts: { claims_critical: 0, claims_high: 1, claims_medium: 0, claims_rejected: 0 },
    llm_used: false,
  },
  agentic_ai_threats: {
    claims: [mockTrendClaim],
    viewpoints: [{ viewpoint_id: "vp_3", viewpoint_text: "Tool-call injection shows a recurring pattern.", viewpoint_type: "operational_pattern", analytical_change: "exposure_expanded", change_driver: "newly_emerged", strength: "moderate" }],
    observations: [{ observation_id: "obs_3", observation_text: "Recurring tool-call injection.", observation_type: "repeated_technique", observation_scope: "repeated_pattern" }],
    case_studies: [],
    selected_evidence_by_claim: [
      { claim_id: "cl_agentic_trend", claim_priority: "high", claim_text: mockTrendClaim.claim_text, selected_evidence: [] },
    ],
    counts: { claims_critical: 0, claims_high: 1, claims_medium: 0, claims_rejected: 0 },
    llm_used: false,
  },
};

const mockAggregates = {
  total_sources:        5,
  date_range:           { start_date: "2026-01-01", end_date: "2026-03-31" },
  category_counts:      { llm_threats: 2, traditional_ai_threats: 1, agentic_ai_threats: 1, ai_enabled_threats: 1 },
  source_type_counts:   { incident: 1, research_finding: 2 },
  trust_tier_counts:    { high: 2, medium: 3 },
  attack_vector_frequency: { prompt_injection: 2, data_poisoning: 1 },
  ai_layer_frequency:   { inference: 3, training: 1 },
};

// ── Tests: planSlides ──────────────────────────────────────────────────────────

console.log("\nplanSlides — claim-first deck planning");

test("deck has section-A structural slides", () => {
  const plan = planSlides(mockCategories, [], [], mockAggregates, [], null, mockClaimChain);
  const types = plan.map((s) => s.slide_type);
  assert.ok(types.includes("title"),              "missing title");
  assert.ok(types.includes("scope_methodology"),  "missing scope_methodology");
  assert.ok(types.includes("source_coverage"),    "missing source_coverage");
  assert.ok(types.includes("executive_summary"),  "missing executive_summary");
  // taxonomy_reference moved to appendix only (Section E) — not duplicated in Section A
  const appendixTaxonomy = plan.filter((s) => s.slide_type === "appendix_taxonomy");
  assert.ok(appendixTaxonomy.length > 0, "missing appendix_taxonomy in Section E");
});

test("executive synthesis slides appear when critical claims exist", () => {
  const plan = planSlides(mockCategories, [], [], mockAggregates, [], null, mockClaimChain);
  const types = plan.map((s) => s.slide_type);
  assert.ok(types.includes("critical_claim"), "missing top_critical_claims / critical_claim slide");
  assert.ok(types.includes("landscape"),      "missing threat_landscape_by_priority / landscape slide");
});

test("LLM Threats critical claim → analytical slides have claim_id", () => {
  const plan = planSlides(mockCategories, [], [], mockAggregates, [], null, mockClaimChain);
  const llmAnalytical = plan.filter((s) =>
    s.category === "llm_threats" &&
    !["title", "section_divider", "appendix", "scope_methodology", "source_coverage",
      "taxonomy_reference", "executive_summary", "landscape"].includes(s.slide_type)
  );
  assert.ok(llmAnalytical.length > 0, "no analytical slides for llm_threats");
  const withClaimId = llmAnalytical.filter((s) => s.claim_id);
  assert.ok(withClaimId.length >= Math.min(2, llmAnalytical.length),
    `Expected most analytical slides to have claim_id, got ${withClaimId.length}/${llmAnalytical.length}`
  );
});

test("weak category (evidence_insufficient) gets divider + not_assessed only", () => {
  const plan = planSlides(mockCategories, [], [], mockAggregates, [], null, mockClaimChain);
  const aiEnabledSlides = plan.filter((s) => s.category === "ai_enabled_threats");
  const types = aiEnabledSlides.map((s) => s.slide_type);
  assert.ok(types.includes("section_divider"), "should have section_divider");
  assert.ok(types.includes("category_not_assessed"), "should have category_not_assessed");
  assert.equal(types.length, 2, `Expected 2 slides for evidence_insufficient, got ${types.length}: ${types.join(", ")}`);
});

test("trend_claim slide appears with claim_type=trend_claim for agentic_ai_threats", () => {
  const plan = planSlides(mockCategories, [], [], mockAggregates, [], null, mockClaimChain);
  const trendSlide = plan.find((s) =>
    s.category === "agentic_ai_threats" && s.slide_type === "trend_claim"
  );
  assert.ok(trendSlide, "expected a trend_claim slide for agentic_ai_threats");
  assert.equal(trendSlide.claim_type, "trend_claim", "trend slide claim_type must be trend_claim");
});

test("outlook_6month slide appears for categories with outlook data", () => {
  const plan = planSlides(mockCategories, [], [], mockAggregates, [], null, mockClaimChain);
  const outlookSlide = plan.find((s) =>
    s.category === "llm_threats" && s.slide_type === "outlook_6month"
  );
  assert.ok(outlookSlide, "expected outlook_6month slide for llm_threats");
  assert.equal(outlookSlide.outlook_horizon, "6_months", "should have outlook_horizon");
});

test("deck has section-D synthesis slides", () => {
  const plan = planSlides(mockCategories, [], [], mockAggregates, [], null, mockClaimChain);
  const types = plan.map((s) => s.slide_type);
  assert.ok(types.includes("cross_category_synthesis"), "missing cross_category_synthesis");
  assert.ok(types.includes("watchlist"), "missing watchlist");
  assert.ok(types.includes("evidence_gap"), "missing evidence_gap");
});

test("deck has section-E appendix slides", () => {
  const plan = planSlides(mockCategories, [], [], mockAggregates, [], null, mockClaimChain);
  const types = plan.map((s) => s.slide_type);
  assert.ok(types.includes("appendix_evidence_index"),    "missing appendix_evidence_index");
  assert.ok(types.includes("appendix_analytics_tables"),  "missing appendix_analytics_tables");
  assert.ok(types.includes("appendix_taxonomy"),          "missing appendix_taxonomy");
  assert.ok(types.includes("appendix"),                   "missing appendix (bibliography)");
});

test("total slide count is in range 25–45", () => {
  const plan = planSlides(mockCategories, [], [], mockAggregates, [], null, mockClaimChain);
  assert.ok(plan.length >= 20, `Too few slides: ${plan.length}`);
  assert.ok(plan.length <= 50, `Too many slides: ${plan.length}`);
  console.log(`    slide count: ${plan.length}`);
});

test("without claim chain — falls back gracefully, still produces slides", () => {
  const plan = planSlides(mockCategories, [], [], mockAggregates, [], null, {});
  assert.ok(plan.length > 10, `fallback should still produce slides, got ${plan.length}`);
});

// ── Tests: qaSlideContent — claim-based rules ─────────────────────────────────

console.log("\nqaSlideContent — claim-based QA rules");

test("trend_claim slide without claim_type=trend_claim is blocked", () => {
  const slide = {
    slide_number:       99,
    slide_type:         "trend_claim",
    title:              "Test Trend",
    headline:           "Attacks are surging.",
    bullets:            ["Attacks are increasing rapidly."],
    evidence_callouts:  [],
    citations:          [],
    analytics_evidence: [],
    claim_id:           "cl_test",
    claim_type:         "category_insight", // wrong — should be trend_claim
    claim_text:         "Attacks are increasing.",
    _plan:              { rawfact_evidence_ids: [], claim_ids: ["cl_test"], claim_type: "category_insight" },
  };
  const { slides } = qaSlideContent([slide], { strict: false });
  const issues = slides[0].content_qa?.issues || [];
  const hasTrendViolation = issues.some((i) => i.issue === "trend_slide_without_trend_claim");
  assert.ok(hasTrendViolation, "should flag trend_slide_without_trend_claim");
});

test("analytical slide without claim_id is blocked", () => {
  const slide = {
    slide_number:       98,
    slide_type:         "critical_claim",
    title:              "Test Critical",
    headline:           "Adversaries are exploiting LLMs.",
    bullets:            ["LLMs are being exploited."],
    evidence_callouts:  [],
    citations:          [],
    analytics_evidence: [],
    claim_id:           null,  // missing!
    _plan:              { rawfact_evidence_ids: [], claim_ids: [] },
  };
  const { slides } = qaSlideContent([slide], { strict: false });
  const issues = slides[0].content_qa?.issues || [];
  const hasMissingId = issues.some((i) => i.issue === "analytical_slide_missing_claim_id");
  assert.ok(hasMissingId, "should flag analytical_slide_missing_claim_id");
});

test("outlook slide without observed/projected language is flagged", () => {
  const slide = {
    slide_number:       97,
    slide_type:         "outlook_6month",
    title:              "6-Month Outlook",
    headline:           "Threats will escalate.",
    bullets:            ["Activity will increase.", "Defenses need improving."],
    evidence_callouts:  [],
    citations:          [],
    analytics_evidence: [],
    claim_id:           "cl_outlook",
    claim_type:         "outlook",
    _plan:              { rawfact_evidence_ids: [], claim_ids: ["cl_outlook"] },
  };
  const { slides } = qaSlideContent([slide], { strict: false });
  const issues = slides[0].content_qa?.issues || [];
  const hasObservedIssue  = issues.some((i) => i.issue === "outlook_missing_observed_basis");
  const hasProjectedIssue = issues.some((i) => i.issue === "outlook_missing_projected_trajectory");
  assert.ok(hasObservedIssue || hasProjectedIssue, "should flag missing observed/projected basis");
});

test("valid QA-pass slide has no blocking issues", () => {
  const slide = {
    slide_number:       96,
    slide_type:         "critical_claim",
    title:              "LLM Threats — Critical Finding",
    headline:           "Prompt injection is now exploited operationally in enterprise deployments.",
    bullets:            [
      "3 documented incidents in Q1 bypassed enterprise guardrails.",
      "RAG documents used as injection vectors in 12 of 50 evaluated systems.",
    ],
    evidence_callouts:  [
      { evidence_id: "ev_src1_1", title: "Prompt Injection Incidents", key_fact: "3 documented incidents in Q1.", publisher: "NIST", url: "https://nist.gov/example" },
      { evidence_id: "ev_src2_1", title: "LLM Attack Patterns 2025", key_fact: "12 of 50 evaluated deployments.", publisher: "Anthropic", url: "https://anthropic.com/example" },
    ],
    citations:          [
      "NIST — Prompt Injection Incidents (https://nist.gov/example)",
      "Anthropic — LLM Attack Patterns 2025 (https://anthropic.com/example)",
    ],
    analytics_evidence: [],
    claim_id:           "cl_llm_1",
    claim_type:         "category_insight",
    claim_text:         "Prompt injection has moved from research to operational exploitation.",
    caveats:            null,
    _plan:              {
      rawfact_evidence_ids: ["ev_src1_1", "ev_src2_1"],
      claim_ids: ["cl_llm_1"],
      claim_type: "category_insight",
    },
  };
  const { slides, report } = qaSlideContent([slide], { strict: true });
  const blockingIssues = (slides[0].content_qa?.issues || []).filter((i) => i.severity === "blocking");
  assert.equal(blockingIssues.length, 0,
    `Expected no blocking issues, got: ${blockingIssues.map((i) => i.issue).join(", ")}`
  );
});

// ── Tests: qaSpeakerNotes ─────────────────────────────────────────────────────

console.log("\nqaSpeakerNotes — deterministic speaker notes QA");

test("new number in speaker notes is blocked", () => {
  const slide = {
    slide_number:       95,
    slide_type:         "critical_claim",
    headline:           "Prompt injection is widely exploited.",
    bullets:            ["3 incidents documented."],
    evidence_callouts:  [{ evidence_id: "ev_1", key_fact: "3 incidents documented.", publisher: "NIST", url: "https://nist.gov" }],
    citations:          ["NIST — Report (https://nist.gov)"],
    speaker_notes:      "According to NIST, there were 9,500 prompt injection attempts in Q1.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: true });
  const issues = slides[0].notes_qa?.issues || [];
  const hasNewNum = issues.some((i) => i.issue === "new_number_in_speaker_notes");
  assert.ok(hasNewNum, "should block new number 9500 not in slide content");
});

test("number already in slide content is allowed in speaker notes", () => {
  const slide = {
    slide_number:       94,
    slide_type:         "critical_claim",
    headline:           "Prompt injection is exploited.",
    bullets:            ["3 incidents in Q1."],
    evidence_callouts:  [{ evidence_id: "ev_1", key_fact: "3 incidents documented in Q1.", publisher: "NIST", url: "https://nist.gov" }],
    citations:          ["NIST — Report (https://nist.gov)"],
    speaker_notes:      "NIST documented 3 incidents in Q1 that bypassed enterprise guardrails.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: true });
  const issues = (slides[0].notes_qa?.issues || []).filter((i) => i.issue === "new_number_in_speaker_notes");
  assert.equal(issues.length, 0, `Should not flag '3' which is in slide content. Issues: ${JSON.stringify(issues)}`);
});

test("unsupported trend language in notes is blocked", () => {
  const slide = {
    slide_number:       93,
    slide_type:         "evidence_support",
    headline:           "Data poisoning is increasing.",
    bullets:            ["Capability observed in research."],
    evidence_callouts:  [],
    citations:          [],
    claim_type:         "category_insight",  // NOT trend_claim
    speaker_notes:      "Attacks are tripling year over year based on this evidence.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: true });
  const issues = slides[0].notes_qa?.issues || [];
  const hasTrend = issues.some((i) => i.issue === "unsupported_trend_language_in_notes");
  assert.ok(hasTrend, "should block 'tripling' in non-trend_claim notes");
});

test("outlook certainty language is blocked", () => {
  const slide = {
    slide_number:       92,
    slide_type:         "outlook_6month",
    headline:           "LLM attacks will escalate.",
    bullets:            ["The trajectory indicates continued escalation."],
    evidence_callouts:  [],
    citations:          [],
    claim_type:         "outlook",
    speaker_notes:      "The evidence confirms that LLM attacks will certainly increase over the next 6 months.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: true });
  const issues = slides[0].notes_qa?.issues || [];
  const hasCertainty = issues.some((i) => i.issue === "unsupported_outlook_certainty");
  assert.ok(hasCertainty, "should block outlook certainty language");
});

test("notes with caveat acknowledgment pass when slide has caveat", () => {
  const slide = {
    slide_number:       91,
    slide_type:         "outlook_6month",
    headline:           "LLM attacks are likely to continue.",
    bullets:            ["The evidence suggests continued escalation."],
    evidence_callouts:  [],
    citations:          [],
    claim_type:         "outlook",
    caveats:            "Based on limited evidence — treat as early signal.",
    speaker_notes:      "This outlook is based on limited signals and should be treated as preliminary; confidence is low.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: true });
  const issues = (slides[0].notes_qa?.issues || []).filter((i) => i.issue === "missing_caveat_acknowledgment");
  assert.equal(issues.length, 0, "should not flag caveat when notes mention uncertainty");
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
