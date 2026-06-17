/**
 * Speaker Notes QA — argument-form-aware checks (Rules 6–10) + regression tests
 *
 * Tests:
 *   1. bullet_verbatim_copy — notes containing 8+ consecutive bullet words get warning
 *   2. new_number_in_notes — number in notes not in slide content is blocked
 *   3. phantom_publisher_in_notes — publisher in notes not in evidence gets warning
 *   4. research_only_missing_caveat — research-only evidence + research caveat, no ack → warning
 *   5. analytics_missing_corpus_scope — analytics_pattern notes without scope → warning
 *   6. case_study_notes_handled — case_study slide; no special crash, existing rules apply
 *   7. evidence_gap_fabricated_conclusion — "this confirms" in evidence_gap notes → blocking
 *   8. visual_missing_explanation — direct_support visual, notes don't mention visual → info
 *
 * Run with: node tests/speakerNotes.test.js
 */

import assert from "node:assert/strict";
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

// ── Test 1: bullet verbatim copy ──────────────────────────────────────────────

console.log("\nqaSpeakerNotes — Rule 6: no bullet verbatim copy");

test("notes repeating 8+ consecutive bullet words get bullet_verbatim_copy warning", () => {
  const bulletText = "Prompt injection via RAG documents was observed in multiple enterprise deployments this quarter";
  const slide = {
    slide_number:      1,
    slide_type:        "critical_claim",
    headline:          "Prompt injection is operational.",
    bullets:           [{ text: bulletText, bullet_role: "finding" }],
    evidence_callouts: [],
    citations:         [],
    speaker_notes:     `In this period, we saw that prompt injection via RAG documents was observed in multiple enterprise deployments this quarter, which is significant.`,
  };
  const { slides } = qaSpeakerNotes([slide], { strict: false });
  const issues = slides[0].notes_qa?.issues || [];
  const hasVerbatim = issues.some((i) => i.issue === "bullet_verbatim_copy");
  assert.ok(hasVerbatim, `Expected bullet_verbatim_copy warning. Issues: ${JSON.stringify(issues.map((i) => i.issue))}`);
});

test("notes with different phrasing do not trigger bullet_verbatim_copy", () => {
  const bulletText = "Prompt injection via RAG documents observed in enterprise deployments";
  const slide = {
    slide_number:      2,
    slide_type:        "critical_claim",
    headline:          "Prompt injection is operational.",
    bullets:           [{ text: bulletText, bullet_role: "finding" }],
    evidence_callouts: [],
    citations:         [],
    // Different phrasing — paraphrased, not verbatim
    speaker_notes:     "This finding shows that attackers are now actively exploiting document injection pathways in production systems.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: false });
  const issues = slides[0].notes_qa?.issues || [];
  const hasVerbatim = issues.some((i) => i.issue === "bullet_verbatim_copy");
  assert.ok(!hasVerbatim, `Should not flag rephrased notes. Issues: ${JSON.stringify(issues.map((i) => i.issue))}`);
});

// ── Test 2: unsupported number in notes ───────────────────────────────────────

console.log("\nqaSpeakerNotes — Rule 1: no new numbers");

test("number in notes not in slide content is blocked (new_number_in_speaker_notes)", () => {
  const slide = {
    slide_number:      3,
    slide_type:        "evidence_support",
    headline:          "Data poisoning incidents documented.",
    bullets:           [{ text: "Multiple incidents observed in training pipelines.", bullet_role: "finding" }],
    evidence_callouts: [{ evidence_id: "ev_1", key_fact: "Multiple incidents observed.", publisher: "NIST", url: "" }],
    citations:         ["NIST — Report"],
    speaker_notes:     "According to NIST, there were 4,500 data poisoning attacks in the past year.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: true });
  const issues = slides[0].notes_qa?.issues || [];
  const hasNewNum = issues.some((i) => i.issue === "new_number_in_speaker_notes");
  assert.ok(hasNewNum, `Expected new_number_in_speaker_notes. Issues: ${JSON.stringify(issues.map((i) => i.issue))}`);
});

// ── Test 3: phantom publisher in notes ────────────────────────────────────────

console.log("\nqaSpeakerNotes — Rule 2: no phantom sources");

test("publisher in notes not in evidence_callouts gets phantom_source warning", () => {
  const slide = {
    slide_number:      4,
    slide_type:        "evidence_support",
    headline:          "LLM jailbreaks are documented.",
    bullets:           [{ text: "Multiple jailbreak techniques documented by researchers.", bullet_role: "finding" }],
    evidence_callouts: [{ evidence_id: "ev_2", key_fact: "Jailbreaks observed.", publisher: "Anthropic", url: "" }],
    citations:         ["Anthropic — Jailbreak Research"],
    // "Google researchers" is not in evidence_callouts
    speaker_notes:     "According to Google researchers, over 200 jailbreak techniques have been catalogued in the past year.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: false });
  const issues = slides[0].notes_qa?.issues || [];
  const hasPhantom = issues.some((i) => i.issue === "phantom_source_in_speaker_notes");
  assert.ok(hasPhantom, `Expected phantom_source_in_speaker_notes. Issues: ${JSON.stringify(issues.map((i) => i.issue))}`);
});

// ── Test 4: research-only claim includes caveat ───────────────────────────────

console.log("\nqaSpeakerNotes — Rule 7: research-only missing caveat");

test("research-only evidence + research caveat + notes without ack → research_only_missing_caveat", () => {
  const slide = {
    slide_number:      5,
    slide_type:        "evidence_support",
    headline:          "Capability delta demonstrated in lab conditions.",
    bullets:           [{ text: "Model extraction accuracy improved to 95% in benchmarks.", bullet_role: "finding" }],
    evidence_callouts: [
      {
        evidence_id:   "ev_3",
        key_fact:      "95% extraction accuracy in lab conditions.",
        publisher:     "Academic Lab",
        url:           "",
        evidence_type: "research_finding",
      },
    ],
    citations:         ["Academic Lab — Model Extraction Study"],
    caveats:           "Research-only — not confirmed in production deployments.",
    speaker_notes:     "Defenders should monitor for model extraction attempts and deploy access controls immediately.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: false });
  const issues = slides[0].notes_qa?.issues || [];
  const hasResearchCaveat = issues.some((i) => i.issue === "research_only_missing_caveat");
  assert.ok(hasResearchCaveat, `Expected research_only_missing_caveat. Issues: ${JSON.stringify(issues.map((i) => i.issue))}`);
});

test("research-only evidence but notes acknowledge 'research' → no research_only_missing_caveat", () => {
  const slide = {
    slide_number:      6,
    slide_type:        "evidence_support",
    headline:          "Capability delta demonstrated in lab conditions.",
    bullets:           [{ text: "Model extraction accuracy improved to 95% in benchmarks.", bullet_role: "finding" }],
    evidence_callouts: [
      {
        evidence_id:   "ev_4",
        key_fact:      "95% extraction accuracy in lab conditions.",
        publisher:     "Academic Lab",
        url:           "",
        evidence_type: "research_finding",
      },
    ],
    citations:         ["Academic Lab — Model Extraction Study"],
    caveats:           "Research-only — not confirmed in production deployments.",
    speaker_notes:     "This is a research finding from a controlled lab environment; it has not been confirmed in production deployments.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: false });
  const issues = slides[0].notes_qa?.issues || [];
  const hasResearchCaveat = issues.some((i) => i.issue === "research_only_missing_caveat");
  assert.ok(!hasResearchCaveat, `Should not flag when notes acknowledge research. Issues: ${JSON.stringify(issues.map((i) => i.issue))}`);
});

// ── Test 5: analytics slide notes mention corpus scope ────────────────────────

console.log("\nqaSpeakerNotes — Rule 8: analytics_pattern corpus scope");

test("analytics_pattern notes without corpus scope → analytics_missing_corpus_scope warning", () => {
  const slide = {
    slide_number:      7,
    slide_type:        "analytics_pattern",
    headline:          "Prompt injection is the most frequently observed attack vector.",
    bullets:           [{ text: "Prompt injection accounts for the largest share of observed techniques.", bullet_role: "finding" }],
    evidence_callouts: [],
    citations:         [],
    speaker_notes:     "Prompt injection dominates the attack landscape and defenders must prioritize guardrail deployment.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: false });
  const issues = slides[0].notes_qa?.issues || [];
  const hasScope = issues.some((i) => i.issue === "analytics_missing_corpus_scope");
  assert.ok(hasScope, `Expected analytics_missing_corpus_scope. Issues: ${JSON.stringify(issues.map((i) => i.issue))}`);
});

test("analytics_pattern notes with corpus scope → no analytics_missing_corpus_scope", () => {
  const slide = {
    slide_number:      8,
    slide_type:        "analytics_pattern",
    headline:          "Prompt injection is the most frequently observed attack vector.",
    bullets:           [{ text: "Prompt injection observed most frequently in corpus.", bullet_role: "finding" }],
    evidence_callouts: [],
    citations:         [],
    speaker_notes:     "This analysis is based on collected sources in our corpus over the past quarter. Prompt injection leads the distribution.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: false });
  const issues = slides[0].notes_qa?.issues || [];
  const hasScope = issues.some((i) => i.issue === "analytics_missing_corpus_scope");
  assert.ok(!hasScope, `Should not flag when notes mention corpus. Issues: ${JSON.stringify(issues.map((i) => i.issue))}`);
});

// ── Test 6: case_study slide handled by qaSpeakerNotes without crash ─────────

console.log("\nqaSpeakerNotes — case_study slide handling");

test("case_study slide with plain notes passes QA without crash", () => {
  const slide = {
    slide_number:      9,
    slide_type:        "case_study",
    headline:          "Indirect prompt injection bypassed enterprise guardrails via RAG document.",
    bullets:           [
      { text: "Actor poisoned a SharePoint document to inject instructions.", bullet_role: "finding" },
      { text: "The LLM relayed confidential data to the attacker's endpoint.", bullet_role: "evidence" },
    ],
    evidence_callouts: [
      { evidence_id: "ev_5", key_fact: "SharePoint document used to inject malicious prompt.", publisher: "NIST", url: "" },
    ],
    citations:         ["NIST — Case Study Report"],
    speaker_notes:     "This incident illustrates how attackers can abuse enterprise document stores to bypass LLM guardrails. Defenders should validate document sources before injection.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: true });
  // Should complete without throwing and assign notes_qa
  assert.ok(slides[0].notes_qa !== undefined, "notes_qa should be present");
  const blockingIssues = slides[0].notes_qa?.issues?.filter((i) => i.severity === "blocking") || [];
  assert.equal(blockingIssues.length, 0, `No blocking issues expected. Got: ${JSON.stringify(blockingIssues.map((i) => i.issue))}`);
});

// ── Test 7: evidence-gap notes must not fabricate conclusions ─────────────────

console.log("\nqaSpeakerNotes — Rule 9: evidence_gap fabricated conclusion");

test("evidence_gap notes with 'this confirms' → evidence_gap_fabricated_conclusion blocking", () => {
  const slide = {
    slide_number:      10,
    slide_type:        "evidence_gap",
    headline:          "No validated evidence for AI-enabled threats this period.",
    bullets:           [{ text: "No validated incidents attributable to AI-enabled threats.", bullet_role: "caveat" }],
    evidence_callouts: [],
    citations:         [],
    speaker_notes:     "This confirms that AI-enabled threats remain limited in our corpus and defenders need not prioritize them.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: false });
  const issues = slides[0].notes_qa?.issues || [];
  const hasFab = issues.some((i) => i.issue === "evidence_gap_fabricated_conclusion");
  assert.ok(hasFab, `Expected evidence_gap_fabricated_conclusion. Issues: ${JSON.stringify(issues.map((i) => i.issue))}`);
  const fabIssue = issues.find((i) => i.issue === "evidence_gap_fabricated_conclusion");
  assert.equal(fabIssue?.severity, "blocking", "Should be blocking severity");
});

test("evidence_gap notes with honest gap acknowledgment pass QA", () => {
  const slide = {
    slide_number:      11,
    slide_type:        "evidence_gap",
    headline:          "No validated evidence for AI-enabled threats this period.",
    bullets:           [{ text: "No validated incidents found — this is a coverage gap.", bullet_role: "caveat" }],
    evidence_callouts: [],
    citations:         [],
    speaker_notes:     "We found no validated evidence for this category this period. This should be treated as a coverage gap, not an absence of threat. Monitor for escalating signals in the next 30 days.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: false });
  const issues = slides[0].notes_qa?.issues || [];
  const hasFab = issues.some((i) => i.issue === "evidence_gap_fabricated_conclusion");
  assert.ok(!hasFab, `Should not flag honest gap acknowledgment. Issues: ${JSON.stringify(issues.map((i) => i.issue))}`);
});

// ── Test 8: visual slide notes should explain the visual ─────────────────────

console.log("\nqaSpeakerNotes — Rule 10: visual missing explanation");

test("direct_support visual present but notes don't mention visual → visual_missing_explanation info", () => {
  const slide = {
    slide_number:      12,
    slide_type:        "analytics_pattern",
    headline:          "Prompt injection is most frequently observed.",
    bullets:           [{ text: "Prompt injection leads the distribution in corpus analytics.", bullet_role: "finding" }],
    evidence_callouts: [],
    citations:         [],
    selected_visual:   {
      visualization_id:            "viz_prompt_injection_bar",
      visual_support_relationship: "direct_support",
      chart_type:                  "bar",
      title:                       "Attack Vector Distribution",
      overall_visual_slide_score:  0.82,
    },
    speaker_notes:     "This analysis is based on our collected corpus. Prompt injection has the highest frequency of occurrence across the sources reviewed.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: false });
  const issues = slides[0].notes_qa?.issues || [];
  const hasVisualIssue = issues.some((i) => i.issue === "visual_missing_explanation");
  assert.ok(hasVisualIssue, `Expected visual_missing_explanation info. Issues: ${JSON.stringify(issues.map((i) => i.issue))}`);
  const visualIssue = issues.find((i) => i.issue === "visual_missing_explanation");
  assert.equal(visualIssue?.severity, "info", "Should be info severity (not blocking)");
});

test("direct_support visual present and notes mention 'chart' → no visual_missing_explanation", () => {
  const slide = {
    slide_number:      13,
    slide_type:        "analytics_pattern",
    headline:          "Prompt injection is most frequently observed.",
    bullets:           [{ text: "Prompt injection leads the distribution in corpus analytics.", bullet_role: "finding" }],
    evidence_callouts: [],
    citations:         [],
    selected_visual:   {
      visualization_id:            "viz_prompt_injection_bar",
      visual_support_relationship: "direct_support",
      chart_type:                  "bar",
      title:                       "Attack Vector Distribution",
      overall_visual_slide_score:  0.82,
    },
    // Notes mention "chart"
    speaker_notes:     "The bar chart on this slide shows that prompt injection accounts for the largest share of attack vectors in our collected corpus.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: false });
  const issues = slides[0].notes_qa?.issues || [];
  const hasVisualIssue = issues.some((i) => i.issue === "visual_missing_explanation");
  assert.ok(!hasVisualIssue, `Should not flag when notes explain the visual. Issues: ${JSON.stringify(issues.map((i) => i.issue))}`);
});

test("contextual_support visual (not direct_support) does not trigger visual_missing_explanation", () => {
  const slide = {
    slide_number:      14,
    slide_type:        "evidence_support",
    headline:          "LLM threats are increasing in scope.",
    bullets:           [{ text: "Multiple LLM threat vectors observed across categories.", bullet_role: "finding" }],
    evidence_callouts: [],
    citations:         [],
    selected_visual:   {
      visualization_id:            "viz_category_timeline",
      visual_support_relationship: "contextual_support",
      chart_type:                  "line",
      title:                       "Monthly Category Timeline",
      overall_visual_slide_score:  0.45,
    },
    // No mention of visual — but should NOT trigger rule (contextual, not direct)
    speaker_notes:     "The scope of LLM threat activity has broadened this reporting period, spanning multiple attack surfaces.",
  };
  const { slides } = qaSpeakerNotes([slide], { strict: false });
  const issues = slides[0].notes_qa?.issues || [];
  const hasVisualIssue = issues.some((i) => i.issue === "visual_missing_explanation");
  assert.ok(!hasVisualIssue, `Should not flag contextual_support visual. Issues: ${JSON.stringify(issues.map((i) => i.issue))}`);
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
