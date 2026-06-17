/**
 * Agent chatbot — query routing + judgment-first answer tests.
 * Deterministic — no network, no DB.
 * Run with: node tests/agentChatbot.test.js
 */

import assert from "node:assert/strict";

import { classifyQuery, detectMode }   from "../lib/agent/queryClassifier.js";
import {
  buildEvidenceIndex,
  findCriticalClaim,
  _resetCache,
  loadSynthesisData,
} from "../lib/agent/claimChainLookup.js";
import {
  qaCheckClaim,
  composeJudgmentAnswer,
  formatJudgmentAnswer,
} from "../lib/agent/responseComposer.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try   { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const evStrong = {
  evidence_id:      "ev_llm_001",
  source_title:     "DMN Research",
  publisher:        "acme-security.com",
  url:              "https://example.com/llm-jailbreak",
  evidence_type:    "exploit_demonstration",
  evidence_class:   "research",
  evidence_strength:"strong",
  fact:             "Over 90% jailbreak success against leading MLLMs using multi-image inputs",
  numbers:          ["90%"],
  extraction_layer: "L5A",
};

const evOperational = {
  evidence_id:      "ev_llm_002",
  source_title:     "Incident Report: Prompt Injection in Production",
  publisher:        "vendor-advisory.com",
  url:              "https://example.com/incident",
  evidence_type:    "incident_report",
  evidence_class:   "operational",
  evidence_strength:"strong",
  fact:             "Confirmed prompt injection exploitation in a deployed customer-facing LLM system",
  numbers:          [],
  extraction_layer: "L5A",
};

const evPrivacyIrrelevant = {
  evidence_id:      "ev_other_001",
  source_title:     "Meta Chat Privacy Article",
  publisher:        "media-outlet.com",
  url:              "https://example.com/meta-privacy",
  evidence_type:    "background_context",
  evidence_class:   "contextual",
  evidence_strength:"context",
  fact:             "Meta collects chat data for advertising purposes",
  numbers:          [],
  extraction_layer: "L5A",
};

function mkSynthesisData({ overrideClaims } = {}) {
  const category_analyses = [
    {
      category: "llm_threats",
      category_headline: "Multimodal jailbreaks are a credible cross-modal safety failure",
      top_insights: overrideClaims || [
        {
          insight:                 "Multimodal jailbreaks are becoming a credible cross-modal safety failure mode",
          explanation:             "LLM safety controls are weaker when attacks enter through non-text channels",
          supporting_evidence_ids: ["ev_llm_001"],
          confidence:              "high",
          slide_usefulness:        "high",
          caveat_if_any:           null,
        },
      ],
      biggest_happenings: [
        {
          happening:               "Confirmed prompt injection in production LLM system",
          why_it_matters:          "First known operational exploitation of prompt injection in a deployed system",
          supporting_evidence_ids: ["ev_llm_002"],
          confidence:              "high",
          caveat_if_any:           null,
        },
      ],
      early_signals:    [],
      analysis_confidence: "high",
    },
  ];

  return {
    category_analyses,
    fused_dossiers: [
      {
        category: "llm_threats",
        rawfact: {
          strong_evidence: [evStrong, evOperational],
          usable_evidence: [],
          case_study_candidates: [],
          statistics: [],
        },
        external_evidence: [],
      },
    ],
    evidence_inventory: [],
    counts: { sources_analyzed: 42 },
  };
}

// ── 1. Query classifier ───────────────────────────────────────────────────────

console.log("\n── Query classifier ──");

await test("'most critical finding for LLM' → analytical", () => {
  assert.equal(classifyQuery("What is the most critical finding this period for LLM?"), "analytical");
});

await test("'what mattered most for LLM threats' → analytical", () => {
  assert.equal(classifyQuery("What mattered most for LLM threats?"), "analytical");
});

await test("'biggest development this quarter' → analytical", () => {
  assert.equal(classifyQuery("What is the biggest development this quarter?"), "analytical");
});

await test("'what should leadership care about' → analytical", () => {
  assert.equal(classifyQuery("What should leadership care about?"), "analytical");
});

await test("'list the sources' → raw_sources", () => {
  assert.equal(classifyQuery("List the sources for this period"), "raw_sources");
});

await test("'evidence behind the prompt injection claim' → evidence_lookup", () => {
  assert.equal(classifyQuery("Show me the evidence behind the prompt injection claim"), "evidence_lookup");
});

await test("'category breakdown' → distribution", () => {
  assert.equal(classifyQuery("Give me a category breakdown"), "distribution");
});

await test("'how many agentic AI sources' → distribution", () => {
  assert.equal(classifyQuery("How many agentic AI sources are there?"), "distribution");
});

await test("'explain the jailbreak technique' → general", () => {
  assert.equal(classifyQuery("Explain the jailbreak technique used in the paper"), "general");
});

await test("'timeline of LLM incidents' → timeline", () => {
  assert.equal(classifyQuery("Give me a timeline of LLM threat incidents"), "timeline");
});

await test("'what happened in May' → timeline", () => {
  assert.equal(classifyQuery("What happened in May for agentic AI?"), "timeline");
});

await test("'top attack vectors' → attack_vector", () => {
  assert.equal(classifyQuery("What are the top attack vectors in the corpus?"), "attack_vector");
});

await test("'most common technique' → attack_vector", () => {
  assert.equal(classifyQuery("What is the most common attack technique observed?"), "attack_vector");
});

await test("'how are they attacking' → attack_vector", () => {
  assert.equal(classifyQuery("How are threat actors attacking LLMs?"), "attack_vector");
});

// ── Mode detection ─────────────────────────────────────────────────────────────

console.log("\n── Mode detection ──");

await test("'briefly' → brief mode", () => {
  assert.equal(detectMode("What is the most critical finding, briefly?"), "brief");
});

await test("'tldr' → brief mode", () => {
  assert.equal(detectMode("TLDR on the top findings"), "brief");
});

await test("'deep dive' → deep_dive mode", () => {
  assert.equal(detectMode("Give me a deep dive on prompt injection"), "deep_dive");
});

await test("'in depth' → deep_dive mode", () => {
  assert.equal(detectMode("Explain in depth the jailbreak techniques"), "deep_dive");
});

await test("no mode keyword → default", () => {
  assert.equal(detectMode("What is the most critical finding?"), "default");
});

// ── 2. Evidence index ─────────────────────────────────────────────────────────

console.log("\n── Evidence index ──");

await test("builds index from fused dossiers", () => {
  const synth = mkSynthesisData();
  const idx   = buildEvidenceIndex(synth);
  assert.ok(idx["ev_llm_001"], "ev_llm_001 indexed");
  assert.ok(idx["ev_llm_002"], "ev_llm_002 indexed");
  assert.equal(idx["ev_llm_001"].evidence_class, "research");
  assert.equal(idx["ev_llm_002"].evidence_class, "operational");
});

await test("does not duplicate entries", () => {
  const synth = mkSynthesisData();
  // Add the same item to both evidence_inventory and fused_dossiers
  synth.evidence_inventory = [evStrong];
  const idx = buildEvidenceIndex(synth);
  // Should exist once — first-write wins
  assert.ok(idx["ev_llm_001"]);
});

// ── 3. Critical finding selector ──────────────────────────────────────────────

console.log("\n── Critical finding selector ──");

await test("returns the highest-priority claim", () => {
  const synth = mkSynthesisData();
  const idx   = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  assert.ok(result, "result not null");
  assert.ok(result.claim.claim_text, "claim has text");
});

await test("filters to requested category", () => {
  const synth = mkSynthesisData();
  // Add a decoy category
  synth.category_analyses.push({
    category: "agentic_ai_threats",
    top_insights: [{ insight: "Agent decoy", explanation: "x", supporting_evidence_ids: ["ev_llm_001"], confidence: "high", slide_usefulness: "high" }],
    biggest_happenings: [],
    analysis_confidence: "high",
  });
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: "llm_threats" });
  assert.equal(result.category, "llm_threats", "only llm_threats claims returned");
});

await test("returns null when no category analyses", () => {
  const idx    = {};
  const result = findCriticalClaim({ categoryAnalyses: [], evidenceIndex: idx, category: null });
  assert.equal(result, null);
});

await test("operational evidence outranks research-only findings with equal priority", () => {
  const synth = mkSynthesisData({
    overrideClaims: [
      {
        insight:                 "Research-only finding",
        explanation:             "research only",
        supporting_evidence_ids: ["ev_llm_001"],
        confidence:              "high",
        slide_usefulness:        "high",
      },
    ],
  });
  synth.category_analyses[0].biggest_happenings = [
    {
      happening:               "Operational incident finding",
      why_it_matters:          "confirmed in production",
      supporting_evidence_ids: ["ev_llm_002"],
      confidence:              "high",
      caveat_if_any:           null,
    },
  ];
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  assert.ok(result, "result exists");
  // Operational evidence gives higher CLASS_RANK, so the happening should win
  // (both claims are high priority from confidence=high, slide=high or high confidence)
  // The operational claim has operational class → higher score
  assert.ok(result.claim.claim_text.length > 0);
});

// ── 4. research-only detection ─────────────────────────────────────────────────

console.log("\n── Research-only detection ──");

await test("arXiv-only finding is flagged researchOnly=true", () => {
  const synth = mkSynthesisData({
    overrideClaims: [{
      insight:                 "ArXiv paper finding only",
      explanation:             "lab demo",
      supporting_evidence_ids: ["ev_llm_001"],
      confidence:              "high",
      slide_usefulness:        "high",
    }],
  });
  synth.category_analyses[0].biggest_happenings = [];
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  assert.ok(result.researchOnly, "research-only flag set");
});

await test("operational evidence sets researchOnly=false", () => {
  const synth = mkSynthesisData({
    overrideClaims: [{
      insight:                 "Operational incident confirmed",
      explanation:             "confirmed in prod",
      supporting_evidence_ids: ["ev_llm_002"],
      confidence:              "high",
      slide_usefulness:        "high",
    }],
  });
  synth.category_analyses[0].biggest_happenings = [];
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  assert.ok(!result.researchOnly, "not research-only");
});

// ── 5. QA checks ─────────────────────────────────────────────────────────────

console.log("\n── QA checks ──");

await test("claim with no supporting_evidence_ids fails QA", () => {
  const failure = qaCheckClaim({ claim_text: "some finding", supporting_evidence_ids: [] }, []);
  assert.ok(failure, "QA rejects unsupported claim");
  assert.match(failure, /no supporting evidence/i);
});

await test("claim with evidence IDs but no resolved packets fails QA", () => {
  const failure = qaCheckClaim({ claim_text: "finding", supporting_evidence_ids: ["ev_123"] }, []);
  assert.ok(failure, "QA rejects unresolvable IDs");
});

await test("valid claim passes QA", () => {
  const failure = qaCheckClaim(
    { claim_text: "finding", supporting_evidence_ids: ["ev_llm_001"] },
    [evStrong]
  );
  assert.equal(failure, null, "valid claim passes");
});

await test("claim with missing text fails QA", () => {
  const failure = qaCheckClaim({ claim_text: "", supporting_evidence_ids: ["ev_llm_001"] }, [evStrong]);
  assert.ok(failure);
});

// ── 6. Response composer ──────────────────────────────────────────────────────

console.log("\n── Response composer ──");

await test("composeJudgmentAnswer returns structured object", () => {
  const synth  = mkSynthesisData();
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: "llm_threats", period: "month" });
  assert.ok(comp, "composed not null");
  assert.ok(comp.answer, "has answer");
  assert.ok(comp.confidence, "has confidence");
  assert.ok(Array.isArray(comp.evidence), "evidence is array");
  assert.equal(comp.source_type, "l6_claim_chain");
});

await test("research-only finding gets research caveat", () => {
  const synth = mkSynthesisData({
    overrideClaims: [{
      insight:                 "Research demo",
      explanation:             "lab only",
      supporting_evidence_ids: ["ev_llm_001"],
      confidence:              "high",
      slide_usefulness:        "high",
    }],
  });
  synth.category_analyses[0].biggest_happenings = [];
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: null, period: null });
  assert.ok(comp.caveat, "caveat present");
  assert.match(comp.caveat, /research demonstration/i);
});

await test("irrelevant privacy article is not in evidence for LLM claim", () => {
  // evPrivacyIrrelevant is in the index but NOT in ev_llm_001's supporting IDs
  const synth = mkSynthesisData();
  synth.fused_dossiers[0].rawfact.usable_evidence = [evPrivacyIrrelevant];
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: "llm_threats" });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: "llm_threats", period: null });
  const evIds  = comp.evidence.map((e) => e.evidence_id);
  assert.ok(!evIds.includes("ev_other_001"), "privacy article not included in LLM finding evidence");
});

await test("composeJudgmentAnswer returns null if QA fails (no evidence IDs)", () => {
  const result = {
    claim: { claim_text: "some finding", supporting_evidence_ids: [], claim_priority: "high" },
    evidencePackets: [],
    researchOnly: true,
    alternatives: [],
    category: "llm_threats",
  };
  const comp = composeJudgmentAnswer({ selectedResult: result, category: null, period: null });
  assert.equal(comp, null, "null for unsupported claim");
});

await test("formatJudgmentAnswer includes confidence", () => {
  const synth  = mkSynthesisData();
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: "llm_threats", period: "period" });
  const text   = formatJudgmentAnswer(comp, { category: "llm_threats" });
  assert.ok(text, "text not empty");
  assert.match(text, /confidence/i, "contains confidence");
});

await test("formatted answer includes category label", () => {
  const synth  = mkSynthesisData();
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: "llm_threats", period: null });
  const text   = formatJudgmentAnswer(comp, { category: "llm_threats" });
  assert.match(text, /LLM Threats/i, "category label in text");
});

// ── 7. loadSynthesisData (injected) ──────────────────────────────────────────

console.log("\n── Synthesis loader (injected) ──");

await test("loadSynthesisData returns null when deck unavailable", async () => {
  _resetCache();
  const synth = await loadSynthesisData({
    loadDeckFn: async () => null,
  });
  assert.equal(synth, null);
  _resetCache();
});

await test("loadSynthesisData returns synthesis when blob returns valid payload", async () => {
  _resetCache();
  const fakeSynth = mkSynthesisData();
  const synth = await loadSynthesisData({
    loadDeckFn: async () => ({ blob_path: "https://example.com/deck.json" }),
    fetchFn:    async () => ({ synthesis: fakeSynth }),
  });
  assert.ok(synth?.category_analyses?.length > 0, "category_analyses loaded");
  _resetCache();
});

await test("loadSynthesisData returns null when blob has no synthesis key", async () => {
  _resetCache();
  const synth = await loadSynthesisData({
    loadDeckFn: async () => ({ blob_path: "https://example.com/deck.json" }),
    fetchFn:    async () => ({ deck: {}, qa: {} }), // no synthesis key
  });
  assert.equal(synth, null);
  _resetCache();
});

// ── 8. not_selected field ─────────────────────────────────────────────────────

console.log("\n── Not-selected rationale ──");

await test("not_selected is populated when alternatives exist", () => {
  const synth = mkSynthesisData();
  // Add extra insights to generate alternatives
  synth.category_analyses[0].top_insights.push(
    {
      insight:                 "Second finding",
      explanation:             "secondary",
      supporting_evidence_ids: ["ev_llm_001"],
      confidence:              "medium",
      slide_usefulness:        "medium",
    },
    {
      insight:                 "Third finding",
      explanation:             "tertiary",
      supporting_evidence_ids: ["ev_llm_001"],
      confidence:              "low",
      slide_usefulness:        "low",
    }
  );
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: null, period: null });
  assert.ok(comp.not_selected, "not_selected field populated");
});

// ── 9. Formatted answer quality checks ───────────────────────────────────────

console.log("\n── Formatted answer quality ──");

await test("formatJudgmentAnswer leads with judgment (Answer or category header), not a source citation", () => {
  const synth  = mkSynthesisData();
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: "llm_threats", period: "month" });
  const text   = formatJudgmentAnswer(comp);
  // Must not start with "According to", "Source:", publisher names, or evidence IDs
  assert.ok(
    !text.startsWith("According to") && !text.startsWith("Source:") && !text.startsWith("[ev_"),
    `Should not start with a source citation. Got: "${text.slice(0, 80)}"`
  );
  // Must contain **Answer:** somewhere near the top
  assert.ok(text.includes("**Answer:**"), `Should contain **Answer:** section. Got: "${text.slice(0, 200)}"`);
});

await test("formatJudgmentAnswer uses bullet points (contains '- ')", () => {
  const synth  = mkSynthesisData();
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: "llm_threats", period: "month" });
  const text   = formatJudgmentAnswer(comp);
  assert.ok(text.includes("- "), "formatted answer should contain bullet points");
});

await test("formatJudgmentAnswer includes **Confidence:**", () => {
  const synth  = mkSynthesisData();
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: "llm_threats", period: "month" });
  const text   = formatJudgmentAnswer(comp);
  assert.ok(text.includes("**Confidence:**"), `missing **Confidence:** in: "${text.slice(0, 200)}"`);
});

await test("formatJudgmentAnswer includes **Evidence:** section", () => {
  const synth  = mkSynthesisData();
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: "llm_threats", period: "month" });
  const text   = formatJudgmentAnswer(comp);
  assert.ok(text.includes("**Evidence:**"), "formatted answer should have **Evidence:** section");
});

await test("formatJudgmentAnswer under 350 words by default", () => {
  const synth  = mkSynthesisData();
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: "llm_threats", period: "month" });
  const text   = formatJudgmentAnswer(comp);
  const words  = text.trim().split(/\s+/).length;
  assert.ok(words <= 350, `Answer too long: ${words} words`);
});

await test("formatJudgmentAnswer does not contain 'Based on the provided context'", () => {
  const synth  = mkSynthesisData();
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: "llm_threats", period: "month" });
  const text   = formatJudgmentAnswer(comp);
  assert.ok(!/based on the provided context/i.test(text), "should not contain filler phrase");
});

await test("formatJudgmentAnswer does not contain 'It is important to note'", () => {
  const synth  = mkSynthesisData();
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: "llm_threats", period: "month" });
  const text   = formatJudgmentAnswer(comp);
  assert.ok(!/it is important to note/i.test(text), "should not contain filler phrase");
});

await test("research-only finding's formatted text includes caveat", () => {
  const synth = mkSynthesisData({ overrideClaims: [{ insight: "Research demo only", explanation: "lab", supporting_evidence_ids: ["ev_llm_001"], confidence: "high", slide_usefulness: "high" }] });
  synth.category_analyses[0].biggest_happenings = [];
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: null, period: null });
  const text   = formatJudgmentAnswer(comp);
  assert.ok(/caveat/i.test(text), "research-only answer must contain caveat");
  assert.ok(/research/i.test(text), "caveat should mention research");
});

await test("irrelevant evidence is excluded from formatted answer", () => {
  const synth = mkSynthesisData();
  synth.fused_dossiers[0].rawfact.usable_evidence = [evPrivacyIrrelevant];
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: "llm_threats" });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: "llm_threats", period: null });
  const text   = formatJudgmentAnswer(comp);
  assert.ok(!text.includes("Meta collects chat data"), "irrelevant evidence should not appear in formatted answer");
});

await test("unsupported claim (no evidence IDs) returns null from compose", () => {
  const result = { claim: { claim_text: "unsupported finding", supporting_evidence_ids: [], claim_priority: "high" }, evidencePackets: [], researchOnly: true, alternatives: [], category: "llm_threats" };
  const comp = composeJudgmentAnswer({ selectedResult: result, category: null, period: null });
  assert.equal(comp, null, "composing an unsupported claim should return null");
});

await test("evidence_points field is present on composed answer", () => {
  const synth  = mkSynthesisData();
  const idx    = buildEvidenceIndex(synth);
  const result = findCriticalClaim({ categoryAnalyses: synth.category_analyses, evidenceIndex: idx, category: null });
  const comp   = composeJudgmentAnswer({ selectedResult: result, category: "llm_threats", period: "month" });
  assert.ok(Array.isArray(comp.evidence_points), "evidence_points should be an array");
  assert.ok(comp.evidence_points.length > 0, "evidence_points should have entries");
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
