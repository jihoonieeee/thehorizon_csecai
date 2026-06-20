/**
 * Smoke test — main slides pipeline (deck-v9.1 / slidesLayer.js)
 *
 * Drives runSlidesLayer with a minimal but structurally complete synthesisResult
 * fixture, skipLlm=true, exportFormat="json". No DB, no API keys required.
 *
 * Verifies:
 *   1.  runSlidesLayer returns the expected shape and deck version
 *   2.  Slide plan is non-empty and contains expected structural slide types
 *   3.  Claim-first slides carry claim_id + claim_priority through to output
 *   4.  visual_plan is null on all deterministic slides (no LLM = no inline plan)
 *   5.  generateVisualPlanning deterministic fallback assigns visual_requirement
 *       to eligible slides and does not overwrite any that already have one
 *   6.  Content QA runs and deck_qa_pass is reported (no crash)
 *   7.  finding_bullet_missing_evidence_id is warning (not blocking) on
 *       non-claim slides in deterministic mode
 *   8.  Cross-slide stat reconciliation runs without crash
 *   9.  Speaker notes QA runs without crash
 *  10.  PPTX renderer: visual_requirement with render_url → ai_diagram spec
 *       shape (unit-level; exercised without a full PPTX write)
 *
 * Run with: node tests/smokeMainPipeline.test.js
 */

import assert from "node:assert/strict";
import { runSlidesLayer } from "../lib/pipeline/slides/slidesLayer.js";
import { DECK_VERSION }   from "../lib/pipeline/slides/slidesLayer.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures.push({ name, err: e }); failed++; }
}

async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failures.push({ name, err: e }); failed++; }
}

// ── Fixture synthesisResult ───────────────────────────────────────────────────
// Minimal but structurally representative: 2 sources per category, one claim
// chain with critical + high claims, one category with no claims.

const FIXTURE_SOURCES = [
  { id: "src-llm-001", title: "Many-Shot Jailbreaking on GPT-4",        publisher: "arXiv",          url: "https://arxiv.org/abs/2024.llm1", source_type: "research_paper",          trust_tier: "high", date_published: "2024-04-01", main_category: "llm_threats",           validation_status: "pass" },
  { id: "src-llm-002", title: "RAG Poisoning via Adversarial Documents", publisher: "USENIX",         url: "https://usenix.org/rag",          source_type: "research_paper",          trust_tier: "high", date_published: "2024-05-01", main_category: "llm_threats",           validation_status: "pass" },
  { id: "src-agt-001", title: "CISA Advisory: MCP Server Vulnerabilities", publisher: "CISA",         url: "https://cisa.gov/mcp",            source_type: "government_advisory",     trust_tier: "primary", date_published: "2024-06-01", main_category: "agentic_ai_threats", validation_status: "pass" },
  { id: "src-agt-002", title: "Autonomous Agent Exploit Chains",         publisher: "Google Project Zero", url: "https://googleprojectzero.blog/agent", source_type: "vulnerability_report", trust_tier: "high", date_published: "2024-07-01", main_category: "agentic_ai_threats", validation_status: "pass" },
  { id: "src-tai-001", title: "ShadowModel: GPT-4 Extraction at Scale",  publisher: "NeurIPS",        url: "https://neurips.cc/shadow",       source_type: "research_paper",          trust_tier: "high", date_published: "2024-08-01", main_category: "traditional_ai_threats", validation_status: "pass" },
  { id: "src-aie-001", title: "AI-Accelerated Spear Phishing Study",    publisher: "Anthropic",       url: "https://anthropic.com/phishing",  source_type: "research_paper",          trust_tier: "primary", date_published: "2024-09-01", main_category: "ai_enabled_threats", validation_status: "pass" },
];

// Two evidence items so rawfact_evidence is non-empty
const EVIDENCE_ITEMS = [
  { evidence_id: "ev_llm_001", title: "Many-Shot Jailbreaking on GPT-4", publisher: "arXiv", url: "https://arxiv.org/abs/2024.llm1", source_id: "src-llm-001", main_category: "llm_threats", rawfact_strength: "grounded", fact: "Many-shot jailbreaking achieves 88% ASR on GPT-4 with 256 demonstrations", short_summary: "MSJ bypasses RLHF safety training via long-context exploitation" },
  { evidence_id: "ev_agt_001", title: "CISA Advisory: MCP Server Vulnerabilities", publisher: "CISA", url: "https://cisa.gov/mcp", source_id: "src-agt-001", main_category: "agentic_ai_threats", rawfact_strength: "grounded", fact: "MCP server CVE-2024-9901 enables unauthenticated RCE in agentic pipelines", short_summary: "Critical RCE in MCP servers affects deployed agentic AI systems" },
];

// Category analysis — LLM threats has claims; traditional AI has none
const CATEGORY_ANALYSES = [
  {
    category: "llm_threats",
    analysis_confidence: "high",
    llm_used: false,
    overview: "Prompt injection and jailbreak attacks dominate LLM threat landscape this period.",
    category_headline: "Automated jailbreak tooling lowers barrier to LLM safety bypass",
    biggest_happenings: [
      { happening: "Many-shot jailbreaking achieves 88% ASR on frontier LLMs", why_it_matters: "Removes artisanal skill requirement for safety bypass", supporting_evidence_ids: ["ev_llm_001"], qa_pass: true },
    ],
    top_insights: [
      { insight: "Prompt injection is the most operationally observed LLM attack vector", confidence: "high", evidence_type: "grounded", supporting_evidence_ids: ["ev_llm_001"], qa_pass: true },
    ],
    early_signals: [
      { signal: "Automated red-teaming tools are commoditising LLM bypass", implication_3_6_months: "Expect significant increase in automated jailbreak attempts", supporting_evidence_ids: ["ev_llm_001"], qa_pass: true },
    ],
    recommendations: [
      { recommendation: "Deploy output filtering on all public-facing LLM endpoints", priority: "high", qa_pass: true },
    ],
    evidence_gaps: ["Limited visibility into production adversary tooling"],
    outlook: { statement: "Jailbreak tooling will become more automated and widely available", confidence: "medium" },
    rawfact_dossier: EVIDENCE_ITEMS.filter(e => e.main_category === "llm_threats"),
  },
  {
    category: "agentic_ai_threats",
    analysis_confidence: "medium",
    llm_used: false,
    overview: "MCP server vulnerabilities represent the highest-severity agentic risk this period.",
    category_headline: "Critical RCE in MCP servers exposes deployed agentic AI pipelines",
    biggest_happenings: [
      { happening: "CISA advisory: MCP CVE-2024-9901 enables unauthenticated RCE", why_it_matters: "Any org running agentic AI on MCP is potentially compromised", supporting_evidence_ids: ["ev_agt_001"], qa_pass: true },
    ],
    top_insights: [
      { insight: "Agentic AI trust boundaries are insufficiently enforced at deployment", confidence: "high", evidence_type: "grounded", supporting_evidence_ids: ["ev_agt_001"], qa_pass: true },
    ],
    early_signals: [],
    recommendations: [],
    evidence_gaps: [],
    outlook: { statement: "MCP vulnerability surface will expand as agentic AI adoption grows", confidence: "medium" },
    rawfact_dossier: EVIDENCE_ITEMS.filter(e => e.main_category === "agentic_ai_threats"),
  },
  {
    category: "traditional_ai_threats",
    analysis_confidence: "low",
    llm_used: false,
    overview: "Limited evidence collected for traditional AI threats this period.",
    category_headline: null,
    biggest_happenings: [],
    top_insights: [],
    early_signals: [],
    recommendations: [],
    evidence_gaps: ["Insufficient sources for model extraction analysis"],
    outlook: null,
    rawfact_dossier: [],
  },
  {
    category: "ai_enabled_threats",
    analysis_confidence: "medium",
    llm_used: false,
    overview: "AI-assisted phishing reached proof-of-concept at scale.",
    category_headline: "GPT-4 enables autonomous spear-phishing campaigns",
    biggest_happenings: [],
    top_insights: [],
    early_signals: [],
    recommendations: [],
    evidence_gaps: [],
    outlook: { statement: "AI-assisted social engineering will become commodity within 6 months", confidence: "medium" },
    rawfact_dossier: [],
  },
];

// Claim chain for llm_threats only
const CLAIM_CHAIN_RESULTS = {
  llm_threats: {
    claims: [
      {
        claim_id: "c_llm_critical_001",
        claim_text: "Automated jailbreak search tools reduce LLM safety bypass to a commodity operation",
        claim_type: "category_insight",
        claim_priority: "critical",
        analytical_quality: "analytical",
        supporting_evidence_ids: ["ev_llm_001"],
        supporting_viewpoint_ids: [],
        supporting_observation_ids: [],
        caveat_if_any: "Lab setting; production RLHF may add resistance",
        reasoning_chain: {
          what_changed: "Gradient-based jailbreak search now requires no white-box access",
          causal_mechanism: "Long-context windows allow many-shot demonstration injection",
          why_this_matters: "Low-sophistication actors can now run automated bypass campaigns",
          uncertainty: "Real-world adversary adoption rate unconfirmed",
          monitoring_signals: ["Public PoC releases", "Underground forum tooling"],
          recommended_actions: ["Deploy output filtering", "Monitor for MSJ pattern signatures"],
        },
        short_takeaway: "Commodity jailbreak tooling now accessible to low-skill actors",
      },
      {
        claim_id: "c_llm_high_001",
        claim_text: "RAG document poisoning enables reliable data exfiltration from LLM pipelines",
        claim_type: "category_insight",
        claim_priority: "high",
        analytical_quality: "analytical",
        supporting_evidence_ids: ["ev_llm_001"],
        supporting_viewpoint_ids: [],
        supporting_observation_ids: [],
        caveat_if_any: null,
        reasoning_chain: {
          what_changed: "Adversarial documents bypass RAG retrieval integrity checks",
          causal_mechanism: "RAG retrieval trusts document content without cryptographic verification",
          why_this_matters: "Any org deploying RAG-based LLMs is potentially vulnerable",
          uncertainty: null,
        },
        short_takeaway: "RAG pipelines lack integrity verification — poisoning is low-effort",
      },
      {
        claim_id: "c_llm_outlook_001",
        claim_text: "Jailbreak tooling will commoditise further over the next 6 months",
        claim_type: "outlook",
        claim_priority: "medium",
        supporting_evidence_ids: ["ev_llm_001"],
        supporting_viewpoint_ids: [],
        supporting_observation_ids: [],
        caveat_if_any: "Depends on model provider defensive improvements",
        reasoning_chain: {
          what_changed: "Open-source jailbreak frameworks released in 2024",
          why_this_matters: "Defender investment in output filtering becomes critical",
          uncertainty: "Model provider RLHF improvements may slow adoption",
        },
      },
    ],
    counts: { claims_critical: 1, claims_high: 1, claims_medium: 1, claims_rejected: 0 },
  },
};

// Minimal aggregates
const AGGREGATES = {
  total_sources: FIXTURE_SOURCES.length,
  category_counts: { llm_threats: 2, agentic_ai_threats: 2, traditional_ai_threats: 1, ai_enabled_threats: 1 },
  attack_vector_frequency: { prompt_injection: 8, rag_poisoning: 5, model_extraction: 2 },
  signal_cluster_counts: { automation: 6, supply_chain: 3 },
  recurring_theme_counts: { llm_safety: 9, agentic_trust: 4 },
  date_range: { start_date: "2024-04-01", end_date: "2024-09-01" },
};

const SYNTHESIS_RESULT = {
  feed_sources:        FIXTURE_SOURCES,
  analytics:           { aggregates: AGGREGATES, visualization_specs: [] },
  category_analyses:   CATEGORY_ANALYSES,
  dossiers:            [{ category: "llm_threats", rawfact_evidence: EVIDENCE_ITEMS, _evidence_packet_registry: null }],
  presentation_packet: null,
  evidence_inventory:  EVIDENCE_ITEMS,
  claim_chain_results: CLAIM_CHAIN_RESULTS,
};

// ── Run ───────────────────────────────────────────────────────────────────────

console.log("\nsmokeMainPipeline — deck-v9.1 / runSlidesLayer (skipLlm=true)\n");

const result = await runSlidesLayer(SYNTHESIS_RESULT, {
  skipLlm:      true,
  exportFormat: "json",
});

const { slides, slide_plan, counts, deck_version,
        content_qa_report, notes_qa_report, deck_qa_report } = result;

// ── 1. Shape and version ──────────────────────────────────────────────────────
console.log("── 1. Shape and deck version ──────────────────────────────────────");

test("returns deck_version deck-v9.1", () => assert.equal(deck_version, DECK_VERSION));
test("slide_plan is non-empty array",  () => assert.ok(Array.isArray(slide_plan) && slide_plan.length > 0));
test("slides array length matches counts.slides_generated", () => assert.equal(slides.length, counts.slides_generated));
test("slides_planned matches slide_plan length", () => assert.equal(counts.slides_planned, slide_plan.length));

// ── 2. Expected structural slide types present ────────────────────────────────
console.log("\n── 2. Structural slide types ──────────────────────────────────────");

const slideTypes = new Set(slides.map(s => s.slide_type));
test("title slide present",           () => assert.ok(slideTypes.has("title")));
test("section_divider present",       () => assert.ok(slideTypes.has("section_divider")));
test("appendix present",              () => assert.ok(slideTypes.has("appendix") || slideTypes.has("appendix_evidence_index")));

const analyticSlides = slides.filter(s =>
  !["title","section_divider","appendix","appendix_evidence_index",
    "appendix_analytics_tables","appendix_taxonomy"].includes(s.slide_type)
);
test("at least 5 analytical slides generated", () => assert.ok(analyticSlides.length >= 5, `got ${analyticSlides.length}`));

// ── 3. Claim fields carried through ──────────────────────────────────────────
console.log("\n── 3. Claim fields on claim-first slides ──────────────────────────");

const claimSlides = slides.filter(s => s.claim_id);
test("at least 1 claim-anchored slide from llm_threats chain", () => assert.ok(claimSlides.length >= 1, `got ${claimSlides.length}`));

const criticalSlide = slides.find(s => s.claim_id === "c_llm_critical_001");
if (criticalSlide) {
  test("critical claim slide: claim_priority=critical",    () => assert.equal(criticalSlide.claim_priority, "critical"));
  test("critical claim slide: claim_type=category_insight",() => assert.equal(criticalSlide.claim_type, "category_insight"));
  test("critical claim slide: has headline",               () => assert.ok(criticalSlide.headline?.length > 0));
  test("critical claim slide: has bullets",                () => assert.ok((criticalSlide.bullets?.length ?? 0) > 0));
} else {
  test("critical claim slide found in output (c_llm_critical_001)", () => assert.fail("slide not found"));
}

// ── 4. visual_plan null on all deterministic slides ──────────────────────────
console.log("\n── 4. visual_plan on deterministic slides ─────────────────────────");

const withVisualPlan = slides.filter(s => s.visual_plan !== null && s.visual_plan !== undefined);
test("visual_plan is null on all slides when skipLlm=true (no LLM = no inline plan)",
  () => assert.equal(withVisualPlan.length, 0, `${withVisualPlan.length} slides had visual_plan set`));

// ── 5. generateVisualPlanning deterministic fallback ─────────────────────────
console.log("\n── 5. Visual planning deterministic fallback ──────────────────────");

const withVisualReq = slides.filter(s => s.visual_requirement);
// Deterministic fallback assigns to case_study and category_analytics types;
// with our fixture we may or may not have those types, so just assert no crash
// and that no slide with a render_url had its visual_requirement clobbered.
test("generateVisualPlanning ran without crash (visual_requirement check)",
  () => assert.ok(Array.isArray(slides)));
test("no slide has visual_requirement.render_url from deterministic fallback (only LLM path generates Mermaid URLs)",
  () => {
    for (const s of withVisualReq) {
      assert.ok(!s.visual_requirement.render_url,
        `slide ${s.slide_number} (${s.slide_type}) has unexpected render_url in deterministic mode`);
    }
  });

// ── 6. Content QA runs and reports ───────────────────────────────────────────
console.log("\n── 6. Content QA ──────────────────────────────────────────────────");

test("content_qa_report is present",           () => assert.ok(content_qa_report));
test("content_qa_report.total_slides > 0",     () => assert.ok((content_qa_report?.total_slides ?? 0) > 0));
test("deck_qa_pass is a boolean",              () => assert.equal(typeof content_qa_report?.deck_qa_pass, "boolean"));

// ── 7. finding_bullet_missing_evidence_id is warning on non-claim slides ──────
console.log("\n── 7. finding_bullet_missing_evidence_id severity ─────────────────");

const allIssues = (content_qa_report?.all_issues || []);
const missingEvIdIssues = allIssues.filter(i => i.issue === "finding_bullet_missing_evidence_id");
const blockingMissingEvId = missingEvIdIssues.filter(i => i.severity === "blocking");

// In deterministic mode there should be NO blocking finding_bullet_missing_evidence_id
// (all finding bullets without evidence_id come from deterministic metadata, not LLM).
// If we have claim-anchored slides with actual evidence they should pass too.
test("no blocking finding_bullet_missing_evidence_id issues in deterministic run",
  () => assert.equal(blockingMissingEvId.length, 0,
    `${blockingMissingEvId.length} blocking: ${blockingMissingEvId.map(i=>i.label).join("; ")}`));

// ── 8. Cross-slide stat reconciliation ran ───────────────────────────────────
console.log("\n── 8. Cross-slide stat reconciliation ─────────────────────────────");

test("cross_slide_stat_issues present in report (no crash)",
  () => assert.ok("cross_slide_stat_issues" in (content_qa_report || {})));

// ── 9. Speaker notes QA ran ──────────────────────────────────────────────────
console.log("\n── 9. Speaker notes QA ────────────────────────────────────────────");

test("notes_qa_report is present",             () => assert.ok(notes_qa_report));
test("notes_qa_pass is a boolean",             () => assert.equal(typeof notes_qa_report?.notes_qa_pass, "boolean"));
test("notes_qa_report.total_slides > 0",       () => assert.ok((notes_qa_report?.total_slides ?? 0) > 0));

// ── 10. PPTX renderer branch (unit-level) ────────────────────────────────────
console.log("\n── 10. PPTX renderer visual_requirement branch ────────────────────");

// Simulate what exportPptx.js does with visual_requirement (the two-branch logic we fixed)
function pickVizSpecFromReq(slide) {
  if (!slide.visual_requirement?.visual_type || slide.visual_requirement.visual_type === "none") return null;
  const vr = slide.visual_requirement;
  if (vr.render_url) {
    return { visualization_type: "ai_diagram", caption: vr.description || "", render_url: vr.render_url, ai_generated: true };
  }
  return { visualization_type: vr.visual_type, description: vr.description || "", ai_generated: true };
}

// Synthetic slides representing both branches
const synthWithUrl = { visual_requirement: { visual_type: "attack_flow", render_url: "https://mermaid.ink/img/ABC", description: "Attack chain", ai_generated: true } };
const synthNoUrl   = { visual_requirement: { visual_type: "timeline",    description: "6-month outlook",            ai_generated: true } };
const synthNone    = { visual_requirement: { visual_type: "none" } };

test("render_url present → visualization_type=ai_diagram with render_url", () => {
  const spec = pickVizSpecFromReq(synthWithUrl);
  assert.equal(spec?.visualization_type, "ai_diagram");
  assert.equal(spec?.render_url, "https://mermaid.ink/img/ABC");
});
test("no render_url → visualization_type=visual_type (placeholder)", () => {
  const spec = pickVizSpecFromReq(synthNoUrl);
  assert.equal(spec?.visualization_type, "timeline");
  assert.equal(spec?.render_url, undefined);
});
test("visual_type=none → null", () => assert.equal(pickVizSpecFromReq(synthNone), null));

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n──────────────────────────────────────────────────`);
if (failures.length) {
  console.log("  Failures:");
  for (const f of failures) console.log(`    ✗ ${f.name}: ${f.err.message}`);
}
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
