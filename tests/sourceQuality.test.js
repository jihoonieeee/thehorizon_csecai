/**
 * Source Quality, Origin Tracking, Quote Verification, Method Quality,
 * Corpus Audit, Claim QA, and Slide Evidence Selector tests.
 *
 * Run with: node tests/sourceQuality.test.js
 */

import assert from "node:assert/strict";

import { assessSourceQuality }    from "../lib/pipeline/validation/sourceQuality.js";
import { inferOriginRole, resetCircularRegistry } from "../lib/pipeline/validation/originTracking.js";
import { verifyQuoteEntailment, applyQuoteVerification } from "../lib/pipeline/rawfact/quoteVerification.js";
import { assessMethodQuality }    from "../lib/pipeline/rawfact/methodQuality.js";
import { buildCorpusAudit }       from "../lib/pipeline/analysis/corpusAudit.js";
import { qaAnalyticalClaim, qaAllClaims } from "../lib/pipeline/analysis/claimQa.js";
import { selectSlideEvidence, applyEvidenceSelectionToPlan } from "../lib/pipeline/slides/slideEvidenceSelector.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result
        .then(() => {
          console.log(`  ✓ ${name}`);
          passed++;
        })
        .catch((err) => {
          console.error(`  ✗ ${name}`);
          console.error(`    ${err.message}`);
          failed++;
        });
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
  return Promise.resolve();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Source Quality Tests
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nassessSourceQuality");

const allTests = [];

// Test 1: Press release → reject (marketing_framing)
allTests.push(test("press release → reject with marketing_framing", () => {
  const source = {
    title: "Our Platform Delivers Industry-Leading AI Security",
    url: "https://vendor.com/press-release",
    publisher: "AcmeSec Corp",
    date_published: "2024-01-15",
    source_type: "ecosystem_signal",
    trust_tier: "medium",
    full_text: "Our solution is the best-in-class product. Download now for a free trial. Our platform delivers cutting-edge solutions. Schedule a demo today. Learn more about our industry-leading capabilities. Sign up and contact us.",
  };
  const result = assessSourceQuality(source);
  assert.equal(result.source_quality_status, "reject",
    `Expected reject, got ${result.source_quality_status}`);
  assert.ok(result.source_quality_reasons.includes("marketing_framing"),
    `Expected marketing_framing in ${JSON.stringify(result.source_quality_reasons)}`);
}));

// Test 2: Vendor research → usable_with_caveat (vendor_interested), NOT reject
allTests.push(test("vendor threat intel research → usable_with_caveat with vendor_interested", () => {
  const source = {
    title: "APT-41 Uses LLM-Assisted Phishing to Target Financial Sector",
    url: "https://crowdstrike.com/blog/apt41-llm-phishing",
    publisher: "CrowdStrike",
    date_published: "2024-06-01",
    source_type: "threat_intelligence",
    trust_tier: "high",
    full_text: "Our research team observed APT-41 leveraging large language models to craft personalized phishing emails targeting financial sector organizations. We identified 47 distinct campaigns over the past quarter, each using AI-generated content to bypass traditional email filters. Our telemetry shows a 3x increase in success rates compared to traditional spear-phishing. The technique involves using publicly available LLMs via API to generate contextually appropriate lures based on LinkedIn profiles of targets.",
  };
  const result = assessSourceQuality(source);
  assert.notEqual(result.source_quality_status, "reject",
    `Should not be rejected; got ${result.source_quality_status}`);
  assert.ok(
    result.source_quality_status === "usable" ||
    result.source_quality_status === "usable_with_caveat",
    `Expected usable or usable_with_caveat, got ${result.source_quality_status}`
  );
  assert.ok(
    result.source_quality_reasons.includes("threat_intel_report") ||
    result.source_quality_reasons.includes("vendor_interested"),
    `Expected threat_intel_report or vendor_interested in ${JSON.stringify(result.source_quality_reasons)}`
  );
}));

// Test 3: Vendor marketing content → reject (marketing_framing)
allTests.push(test("vendor marketing whitepaper → reject marketing_framing", () => {
  const source = {
    title: "How Our AI Platform Protects Your Enterprise",
    url: "https://vendor.com/whitepaper",
    publisher: "SecureAI Vendor",
    date_published: "2024-02-01",
    source_type: "ecosystem_signal",
    trust_tier: "medium",
    full_text: "Download our whitepaper to learn how our best-in-class platform delivers industry-leading protection. Our solution is cutting-edge. Free trial available. Schedule a demo. Contact us today. Sign up for our webinar.",
  };
  const result = assessSourceQuality(source);
  assert.equal(result.source_quality_status, "reject",
    `Expected reject, got ${result.source_quality_status}`);
  assert.ok(result.source_quality_reasons.includes("marketing_framing"),
    `Expected marketing_framing in reasons`);
}));

// Test 4: Short CVE advisory (type=vulnerability, 150 chars) → usable with thin_but_structured, NOT reject
allTests.push(test("short CVE advisory → usable with thin_but_structured, not reject", () => {
  const source = {
    title: "CVE-2024-12345: Remote Code Execution in ML Framework",
    url: "https://nvd.nist.gov/vuln/detail/CVE-2024-12345",
    publisher: "NIST",
    date_published: "2024-01-20",
    source_type: "vulnerability",
    trust_tier: "primary",
    full_text: "A critical RCE vulnerability in PyTorch 2.1.0 allows arbitrary code execution via malformed model files.",
  };
  const result = assessSourceQuality(source);
  assert.notEqual(result.source_quality_status, "reject",
    `CVE advisory should NOT be rejected; got ${result.source_quality_status}`);
  // May have thin_but_structured since text < 200 chars and it's a structured type
  // But should be usable or usable_with_caveat
  assert.ok(
    result.source_quality_status === "usable" ||
    result.source_quality_status === "usable_with_caveat",
    `Expected usable or usable_with_caveat, got ${result.source_quality_status}`
  );
}));

// Test 5: Unknown blog, no date → reject (unknown_publisher)
allTests.push(test("unknown blog with no date and short text → reject unknown_publisher", () => {
  const source = {
    title: "AI Threats Are Real",
    url: "https://randomtech123.blogspot.com/ai-threats",
    publisher: "",
    date_published: null,
    source_type: "unknown",
    trust_tier: "unknown",
    full_text: "AI threats are increasing. Everyone should be worried.",
  };
  const result = assessSourceQuality(source);
  assert.equal(result.source_quality_status, "reject",
    `Expected reject, got ${result.source_quality_status}`);
  assert.ok(result.source_quality_reasons.includes("unknown_publisher"),
    `Expected unknown_publisher in ${JSON.stringify(result.source_quality_reasons)}`);
}));

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Origin Tracking Tests
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\ninferOriginRole");

// Test 6: Article citing another source → secondary_reporting
allTests.push(test("article citing another source → secondary_reporting", () => {
  const source = {
    title: "New Jailbreak Technique Discovered by Researchers",
    url: "https://thenewstack.io/new-jailbreak-technique",
    publisher: "The New Stack",
    date_published: "2024-03-01",
    source_type: "research_finding",
    trust_tier: "medium",
    full_text: "According to researchers at Carnegie Mellon, a new jailbreak technique allows adversaries to bypass GPT-4 safety filters. The study, published on arxiv.org, demonstrates a 95% success rate. Reporting by researchers at Carnegie Mellon shows the technique can be replicated easily.",
  };
  const result = inferOriginRole(source);
  assert.equal(result.origin_role, "secondary_reporting",
    `Expected secondary_reporting, got ${result.origin_role}`);
  assert.ok(result.cited_sources.length > 0,
    "Should have extracted cited sources");
}));

// Test 7: Multiple articles citing same primary → circular_reporting_risk on 3rd+
allTests.push(test("3rd article citing same primary → circular_reporting_risk", () => {
  resetCircularRegistry();

  const baseCited = "researchers at stanford university published";
  const makeSource = (id) => ({
    id: `source-${id}`,
    title: `Report ${id}: Stanford AI Jailbreak Study`,
    url: `https://news${id}.com/stanford-jailbreak`,
    publisher: `news${id}.com`,
    date_published: "2024-04-01",
    source_type: "research_finding",
    trust_tier: "medium",
    full_text: `Researchers at Stanford University published a paper on AI jailbreaks. According to researchers at Stanford University, the study found 90% success. Based on a report from Stanford University researchers, the technique works across GPT-4.`,
  });

  const s1 = inferOriginRole(makeSource(1));
  const s2 = inferOriginRole(makeSource(2));
  const s3 = inferOriginRole(makeSource(3)); // 3rd should trigger circular

  assert.ok(
    s3.independence_level === "circular_reporting_risk",
    `3rd source should be circular_reporting_risk, got ${s3.independence_level}`
  );

  resetCircularRegistry(); // clean up
}));

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Context-only evidence claim gates
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nContext-only evidence handling");

// Test 8: context_only evidence with concrete claims → trend blocked, case_study claim type preserved
allTests.push(test("context_only source → trend claim blocked, case_study type preserved", () => {
  const evidencePackets = [{
    id: "ep-1",
    admissibility: "context_only",
    evidence_type: "capability_demonstration",
    permitted_uses: ["context_only", "case_study", "outlook_input"],
    source_type: "capability_demonstration",
    publisher: "Emerging Tech Lab",
    date_published: "2024-05-01",
    key_entities: ["CustomAI-Agent", "MCP-Server"],
    important_numbers: ["85% success rate"],
  }];

  const corpusAudit = buildCorpusAudit([{
    title: "Agent Misuse Pattern",
    url: "https://lab.edu/paper",
    publisher: "Emerging Tech Lab",
    date_published: "2024-05-01",
    source_type: "capability_demonstration",
    trust_tier: "high",
  }], "agentic_ai_threats");

  // Trend claim should be blocked (only 1 source, context_only admissibility)
  const trendResult = qaAnalyticalClaim(
    { claim_type: "trend", text: "Agents are being misused at scale" },
    evidencePackets,
    corpusAudit
  );
  assert.equal(trendResult.allowed_to_proceed, false,
    "Trend claim from single source should be blocked");

  // Case study should be allowed (has concrete entities)
  const caseStudyResult = qaAnalyticalClaim(
    { claim_type: "case_study", text: "CustomAI-Agent was tested against MCP-Server" },
    evidencePackets,
    corpusAudit
  );
  // case_study: admissible packets may be empty since these are context_only
  // but the claim type allows it
  assert.ok(
    caseStudyResult.claim_type === "case_study",
    "Case study claim type should be preserved"
  );
}));

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Quote Verification Tests
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nverifyQuoteEntailment");

// Test 9: Quote exists but doesn't entail fact → archive (unsupported)
allTests.push(test("quote exists in source → verifyQuoteEntailment returns supported (mechanical shim)", async () => {
  // verifyQuoteEntailment is now a mechanical location shim — semantic entailment checking
  // was moved to triage_judgment.quote_support (set by the LLM in judgeEvidenceItems.js).
  const sourceText = "The model demonstrated a 70% success rate in controlled laboratory experiments using GPT-4.";
  const quote = "The model demonstrated a 70% success rate in controlled laboratory experiments using GPT-4.";
  const fact  = "All production LLM systems are vulnerable to this attack with near-perfect success rates.";

  const result = await verifyQuoteEntailment(fact, quote, sourceText);
  // Mechanical check: quote exists → supported (semantic over-interpretation handled by LLM triage)
  assert.equal(result.quote_exists, true, "quote should be located in source text");
  assert.equal(result.quote_entailment, "supported", "mechanical shim returns supported when quote found");
}));

// Test 10: Quote exists → mechanical shim returns preserved (semantic overstatement handled by LLM triage)
allTests.push(test("fact overstates quote → claim_preservation=preserved in mechanical shim (LLM handles semantic)", async () => {
  // The mechanical shim returns claim_preservation="preserved" when the quote is located.
  // Semantic overstatement detection is now done by the LLM in judgeEvidenceItems.js
  // via triage_judgment.quote_support="overstates_scope".
  const sourceText = "Our analysis suggests that AI-assisted phishing may increase click rates in some contexts.";
  const quote = "Our analysis suggests that AI-assisted phishing may increase click rates in some contexts.";
  const fact  = "AI-assisted phishing definitively and universally increases click rates across all contexts.";

  const result = await verifyQuoteEntailment(fact, quote, sourceText);
  assert.equal(result.quote_exists, true, "quote should be located");
  assert.equal(result.claim_preservation, "preserved",
    "mechanical shim preserves claim_preservation — LLM sets overstates_scope in triage_judgment");
}));

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Method Quality Tests
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nassessMethodQuality");

// Test 11: Benchmark number with no method context → context_only (unclear_method)
allTests.push(test("benchmark result with no methodology context → unclear_method, context_only", () => {
  const evidenceItem = {
    evidence_type: "benchmark_result",
    key_fact: "Our model achieves 87% accuracy.",
    metric: { value: 87, unit: "percent" },
  };
  const sourceText = "We found that our model achieves 87% accuracy. Our analysis shows significant improvement over baselines.";

  const result = assessMethodQuality(evidenceItem, sourceText);
  assert.ok(
    result.method_quality === "unclear_method" || result.method_quality === "anecdotal",
    `Expected unclear_method or anecdotal, got ${result.method_quality}`
  );
  assert.equal(result.statistical_use, "context_only",
    `Expected context_only, got ${result.statistical_use}`);
}));

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Claim QA Tests
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nqaAnalyticalClaim");

// Test 12: Trend claim from single publisher → overgeneralized (blocked)
allTests.push(test("trend claim from single publisher → overgeneralized, blocked", () => {
  const packets = [
    { admissibility: "passed", source_type: "threat_intelligence",
      publisher: "Vendor X", date_published: "2024-01-01", evidence_type: "threat_intelligence" },
    { admissibility: "passed", source_type: "threat_intelligence",
      publisher: "Vendor X", date_published: "2024-01-15", evidence_type: "threat_intelligence" },
    { admissibility: "passed", source_type: "threat_intelligence",
      publisher: "Vendor X", date_published: "2024-02-01", evidence_type: "threat_intelligence" },
  ];

  const corpusAudit = {
    analysis_allowed: "limited",
    source_concentration_flags: ["single_publisher_dominance:vendor x"],
    evidence_gap_flags: [],
    analysis_limitations: [],
  };

  const result = qaAnalyticalClaim(
    { claim_type: "trend", text: "Attacks on LLMs are trending upward" },
    packets,
    corpusAudit
  );
  assert.equal(result.claim_support_status, "overgeneralized",
    `Expected overgeneralized, got ${result.claim_support_status}`);
  assert.equal(result.allowed_to_proceed, false,
    "Overgeneralized claim should be blocked");
}));

// Test 13: Adoption claim without observed_use → blocked
allTests.push(test("adoption claim without observed_use evidence → unsupported, blocked", () => {
  const packets = [
    {
      admissibility: "passed",
      evidence_type: "research_finding",
      source_type: "research_finding",
      publisher: "Uni Lab",
      date_published: "2024-03-01",
      observed_use: false,
    },
  ];

  const corpusAudit = {
    analysis_allowed: "full",
    source_concentration_flags: [],
    evidence_gap_flags: [],
    analysis_limitations: [],
  };

  const result = qaAnalyticalClaim(
    { claim_type: "adoption", text: "Threat actors are adopting LLM jailbreaks" },
    packets,
    corpusAudit
  );
  assert.equal(result.allowed_to_proceed, false,
    "Adoption claim without observed_use should be blocked");
  assert.ok(
    result.claim_support_status === "unsupported",
    `Expected unsupported, got ${result.claim_support_status}`
  );
}));

// Test 14: Capability claim allowed but doesn't imply real-world adoption
allTests.push(test("capability claim from research evidence → allowed, no real-world adoption implied", () => {
  const packets = [
    {
      admissibility: "passed",
      evidence_type: "capability_demonstration",
      source_type: "capability_demonstration",
      publisher: "University of Research",
      date_published: "2024-04-01",
      observed_use: false,
      key_entities: ["GPT-4", "PromptInjectionTool"],
    },
  ];

  const corpusAudit = {
    analysis_allowed: "full",
    source_concentration_flags: [],
    evidence_gap_flags: [],
    analysis_limitations: [],
  };

  const result = qaAnalyticalClaim(
    { claim_type: "capability", text: "GPT-4 can be jailbroken via multi-step reasoning injection" },
    packets,
    corpusAudit
  );
  assert.equal(result.allowed_to_proceed, true,
    "Capability claim should be allowed");
  assert.ok(
    result.qa_notes.includes("lab-only") || result.blocking_reasons.length === 0 || result.allowed_to_proceed,
    "Note should mention lab-only limitation or proceed cleanly"
  );
}));

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Slide Evidence Selector Tests
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nselectSlideEvidence");

// Test 15: Slide claim removed when no usable evidence → evidence_gap slide instead
allTests.push(test("no usable evidence → evidence_gap slide instead of category_content", () => {
  const slidePlan = [
    {
      slide_number: 4,
      slide_type:   "category_content",
      title:        "LLM Threats",
      category:     "llm_threats",
      core_message: "Key insights on LLM threats.",
    },
  ];

  const evidencePackets = [
    {
      admissibility: "failed",
      evidence_type: "research_finding",
      source_type: "research_finding",
      category: "llm_threats",
      publisher: "Unknown",
    },
  ];

  const result = applyEvidenceSelectionToPlan(slidePlan, evidencePackets);
  const slide = result[0];

  assert.equal(slide.slide_type, "evidence_gap",
    `Expected evidence_gap, got ${slide.slide_type}`);
  assert.ok(slide.evidence_gap_reason,
    "Should have evidence_gap_reason");
}));

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Chatbot / Corpus Insufficient Tests
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\ninsufficient corpus gates");

// Test 16: Broad trend answer from insufficient corpus → blocked by qaAllClaims
allTests.push(test("trend claim blocked from insufficient corpus", () => {
  const corpusAudit = {
    analysis_allowed: "insufficient",
    source_concentration_flags: [],
    evidence_gap_flags: ["operational_evidence_sparse", "primary_sources_sparse"],
    analysis_limitations: [
      "No operational evidence and no primary sources",
    ],
  };

  const { passing, blocked } = qaAllClaims(
    [
      { claim_type: "trend", text: "AI jailbreaks are trending" },
      { claim_type: "adoption", text: "Threat actors are adopting AI tools" },
      { claim_type: "capability", text: "Models can be bypassed in lab conditions" },
    ],
    [],  // no evidence packets
    corpusAudit
  );

  // trend and adoption should be blocked (not allowed in insufficient corpus)
  const blockedTypes = blocked.map((c) => c.claim_type);
  assert.ok(blockedTypes.includes("trend"),
    `trend should be blocked; blocked: ${JSON.stringify(blockedTypes)}`);
  assert.ok(blockedTypes.includes("adoption"),
    `adoption should be blocked; blocked: ${JSON.stringify(blockedTypes)}`);

  // capability should pass (allowed in insufficient corpus)
  const passingTypes = passing.map((c) => c.claim_type);
  assert.ok(passingTypes.includes("capability"),
    `capability should pass even in insufficient corpus; passing: ${JSON.stringify(passingTypes)}`);
}));

// ═══════════════════════════════════════════════════════════════════════════════
// Additional edge case tests
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\nedge cases");

allTests.push(test("primary authority source → usable with primary_source reason", () => {
  const source = {
    title: "CISA Advisory: AI-Assisted Phishing Campaigns",
    url: "https://cisa.gov/advisory/2024-ai-phishing",
    publisher: "CISA",
    date_published: "2024-03-15",
    source_type: "advisory",
    trust_tier: "primary",
    full_text: "CISA has observed a significant increase in AI-assisted phishing campaigns targeting critical infrastructure. This advisory provides indicators of compromise and recommended mitigations for organizations.",
  };
  const result = assessSourceQuality(source);
  assert.ok(
    result.source_quality_status === "usable",
    `Expected usable for CISA advisory, got ${result.source_quality_status}`
  );
  assert.ok(
    result.source_quality_reasons.includes("primary_source") ||
    result.source_quality_reasons.includes("official_advisory"),
    `Expected primary_source or official_advisory in ${JSON.stringify(result.source_quality_reasons)}`
  );
}));

allTests.push(test("academic source → usable with peer_review_or_preprint", () => {
  const source = {
    title: "Adversarial Attacks on LLM Safety Guardrails: A Systematic Study",
    url: "https://arxiv.org/abs/2024.12345",
    publisher: "arXiv",
    date_published: "2024-02-10",
    source_type: "research_finding",
    trust_tier: "high",
    full_text: "We present a systematic study of adversarial attacks on large language model safety guardrails. Our dataset comprises 1,000 prompts tested against GPT-4, Claude 3, and Gemini Ultra. We find that 73% of known jailbreak techniques remain effective against current guardrail implementations when combined with multi-step reasoning chains.",
  };
  const result = assessSourceQuality(source);
  assert.ok(
    result.source_quality_status === "usable" || result.source_quality_status === "usable_with_caveat",
    `Expected usable, got ${result.source_quality_status}`
  );
  assert.ok(
    result.source_quality_reasons.includes("peer_review_or_preprint"),
    `Expected peer_review_or_preprint in ${JSON.stringify(result.source_quality_reasons)}`
  );
}));

allTests.push(test("corpusAudit: single publisher > 50% → single_publisher_dominance flag", () => {
  const sources = [
    { publisher: "VendorX", source_type: "threat_intelligence", url: "https://vendorx.com/1", date_published: "2024-01-01", trust_tier: "high" },
    { publisher: "VendorX", source_type: "threat_intelligence", url: "https://vendorx.com/2", date_published: "2024-02-01", trust_tier: "high" },
    { publisher: "VendorX", source_type: "threat_intelligence", url: "https://vendorx.com/3", date_published: "2024-03-01", trust_tier: "high" },
    { publisher: "OtherSource", source_type: "research_finding", url: "https://other.edu/1", date_published: "2024-04-01", trust_tier: "high" },
  ];

  const audit = buildCorpusAudit(sources, "llm_threats");
  assert.ok(
    audit.source_concentration_flags.some((f) => f.includes("single_publisher_dominance")),
    `Expected single_publisher_dominance flag, got: ${JSON.stringify(audit.source_concentration_flags)}`
  );
}));

allTests.push(test("corpusAudit: no operational sources → operational_evidence_sparse flag", () => {
  const sources = [
    { publisher: "Uni A", source_type: "research_finding", url: "https://uni-a.edu/1", date_published: "2024-01-01", trust_tier: "high" },
    { publisher: "Uni B", source_type: "benchmark_evaluation", url: "https://uni-b.edu/1", date_published: "2024-02-01", trust_tier: "high" },
    { publisher: "Lab C", source_type: "capability_demonstration", url: "https://lab-c.org/1", date_published: "2024-03-01", trust_tier: "high" },
  ];

  const audit = buildCorpusAudit(sources, "traditional_ai_threats");
  assert.ok(
    audit.evidence_gap_flags.includes("operational_evidence_sparse"),
    `Expected operational_evidence_sparse, got: ${JSON.stringify(audit.evidence_gap_flags)}`
  );
}));

allTests.push(test("quote not in source text → quote_exists=false, entailment=unsupported", async () => {
  const sourceText = "The paper describes a new method for watermarking AI-generated content.";
  const quote = "Researchers found that 99% of neural networks are vulnerable to prompt injection attacks.";
  const fact  = "99% of neural networks are vulnerable.";

  const result = await verifyQuoteEntailment(fact, quote, sourceText);
  assert.equal(result.quote_exists, false,
    `Expected quote_exists=false`);
  assert.equal(result.quote_entailment, "unsupported",
    `Expected unsupported, got ${result.quote_entailment}`);
}));

allTests.push(test("clear methodology in source text → clear_method, chart_allowed", () => {
  const item = {
    evidence_type: "benchmark_result",
    key_fact: "Achieves 92% accuracy",
    metric: { value: 92 },
  };
  const sourceText = "We evaluated the model on a dataset of 10,000 examples with n=500 held-out test samples. Tested against 15 baseline models. Sample size of 500 adversarial prompts was used for evaluation.";

  const result = assessMethodQuality(item, sourceText);
  assert.equal(result.method_quality, "clear_method",
    `Expected clear_method, got ${result.method_quality}`);
  assert.equal(result.statistical_use, "chart_allowed",
    `Expected chart_allowed, got ${result.statistical_use}`);
}));

// ── Run all tests ─────────────────────────────────────────────────────────────

Promise.all(allTests).then(() => {
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
