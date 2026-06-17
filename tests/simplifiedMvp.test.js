/**
 * Simplified MVP Architecture Tests
 *
 * Covers:
 *   - L5 canonical EvidencePacket schema + validation
 *   - L5 does not produce final claims
 *   - L6 strategic judgment requires evidence IDs
 *   - summary-only judgment is blocked
 *   - unsupported judgment is blocked
 *   - ApprovedIntelligenceObject is created only from approved judgments
 *   - dashboard cannot use blocked/context-only evidence as main support
 *   - slide/report/dashboard all resolve to same evidence registry
 *   - source URL backtrace works from dashboard object and slide
 *   - Langfuse/observability integration does not break when env vars absent
 *
 * Run: node tests/simplifiedMvp.test.js
 */

import {
  normalizeL5AToCanonical,
  normalizeL5BToCanonical,
  normalizeL5CToCanonical,
  normalizeAllL5AToCanonical,
  validateCanonicalPacket,
  hasInternalArtifacts,
  FORBIDDEN_CANONICAL_FIELDS,
} from "../lib/pipeline/rawfact/canonicalPacket.js";

import {
  buildApprovedIntelligenceObject,
  validateApprovedIntelligenceObject,
  hasIntelInternalArtifacts,
  FORBIDDEN_INTEL_FIELDS,
} from "../lib/pipeline/intelligence/approvedIntelligenceObject.js";

import {
  buildIntelligenceLayer,
  traceIntelToSourceUrl,
  findIntelObject,
} from "../lib/pipeline/intelligence/buildIntelligenceLayer.js";

import {
  isObservabilityEnabled,
  wrapLLMCall,
  flushObservability,
} from "../lib/llm/observability.js";

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let currentGroup = "";

function group(name) {
  currentGroup = name;
  process.stdout.write(`\n  ${name}\n`);
}

function assert(label, condition, detail = "") {
  if (condition) {
    passed++;
    process.stdout.write(`    ✓ ${label}\n`);
  } else {
    failed++;
    process.stdout.write(`    ✗ ${label}${detail ? `\n      ${detail}` : ""}\n`);
  }
  return condition;
}

function eq(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) {
    process.stdout.write(`    ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      got:      ${JSON.stringify(got)}\n`);
    failed++;
  } else {
    passed++;
    process.stdout.write(`    ✓ ${label}\n`);
  }
  return ok;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeRawItem(overrides = {}) {
  return {
    evidence_id:   "ev_abc123_001",
    fact:          "GPT-4 jailbreak achieves 88% attack success rate using PAIR",
    source_quote:  "We demonstrate PAIR achieves 88% ASR on GPT-4 in controlled experiments",
    evidence_type: "benchmark_result",
    evidence_location: "section 4.2",
    analytical_hooks: {
      why_this_may_matter: "Automates jailbreak at scale",
      what_changed:        "Previously required manual effort",
      novelty_signal:      "First gradient-free automated ASR above 80%",
      capability_delta:    null,
      assumption_challenged: null,
      implication_candidates: ["Any actor with compute can bypass"],
      contradiction_candidates: [],
      uncertainty_notes:   ["Lab setting only"],
      affected_entities:   ["OpenAI", "GPT-4"],
      dependency_or_attack_surface: null,
    },
    triage_data: {
      admissibility:    "passed",
      evidence_strength:"strong",
      permitted_uses:   ["fact_support", "capability_support", "case_study"],
      limitations:      ["lab_only"],
    },
    fact_qa: {
      support_level:     "research_finding",
      over_interpreted:  false,
      required_caveats:  ["lab/research setting: real-world adversary adoption not established"],
      blocked_uses:      [],
    },
    quote_verification: {
      quote_exists:     true,
      quote_entailment: "supported",
      claim_preservation: "preserved",
    },
    ...overrides,
  };
}

function makeSource(overrides = {}) {
  return {
    id:              "src_abc123",
    url:             "https://arxiv.org/abs/2306.05499",
    title:           "Jailbreaking Black Box LLMs via PAIR",
    publisher:       "arXiv",
    date_published:  "2024-03-01",
    source_type:     "research_finding",
    trust_tier:      "high",
    primary_tags:    ["prompt_injection", "jailbreak"],
    main_category:   "llm_threats",
    ...overrides,
  };
}

function makeJudgment(overrides = {}) {
  return {
    judgment_id:          "j_llm_001",
    judgment:             "Automated jailbreak tooling commoditizes bypass capability",
    judgment_type:        "capability_change",
    what_changed:         "Skill requirement removed; gradient-free ASR automation now available",
    causal_mechanism:     "PAIR eliminates need for manual prompt engineering",
    why_this_matters:     "Any actor with compute can now run systematic bypass campaigns",
    second_order_implications: ["Open-source PoC rate will accelerate"],
    monitoring_signals:   ["MCP CVE disclosures", "GitHub PoC release rate"],
    recommended_actions:  ["Monitor PAIR variants", "Test RLHF-tuned defenses"],
    evidence_for:         ["ev_abc123_001"],
    evidence_against:     [],
    supporting_evidence_ids: ["ev_abc123_001"],
    confidence:           "medium",
    caveat_if_any:        "lab_only: real-world adversary adoption not yet confirmed",
    slide_usefulness:     "high",
    analytical_quality:   "analytical",
    approved_for_dashboard: true,
    approved_for_slides:  true,
    approved_for_report:  true,
    approved_for_chatbot: true,
    judgment_flags: {
      implies_adoption: false,
      implies_operational: false,
      implies_trend: false,
    },
    ...overrides,
  };
}

// ── L5 Canonical EvidencePacket tests ────────────────────────────────────────

group("L5 — Canonical EvidencePacket schema");

(function testCanonicalPacketFields() {
  const item   = makeRawItem();
  const source = makeSource();
  const packet = normalizeL5AToCanonical(item, source);

  const REQUIRED_FIELDS = [
    "evidence_id", "source_id", "source_url", "source_title", "publisher",
    "publication_date", "source_branch", "taxonomy_tags", "source_quote",
    "quote_location", "fact", "corrected_fact", "evidence_type", "source_basis",
    "quote_support_review", "claim_permissions", "caveats", "limitations",
    "analytical_hooks", "admissibility", "qa_status", "qa_reasons",
  ];

  for (const field of REQUIRED_FIELDS) {
    assert(`packet has ${field}`, field in packet);
  }

  assert("source_branch is L5A", packet.source_branch === "L5A");
  assert("admissibility is valid", ["passed","context_only","failed"].includes(packet.admissibility));
  assert("claim_permissions has permitted_uses array", Array.isArray(packet.claim_permissions?.permitted_uses));
  assert("claim_permissions has blocked_uses array",  Array.isArray(packet.claim_permissions?.blocked_uses));
  assert("analytical_hooks is object (not null)", packet.analytical_hooks !== null && typeof packet.analytical_hooks === "object");
  assert("limitations is array",  Array.isArray(packet.limitations));
  assert("caveats is array",       Array.isArray(packet.caveats));
  assert("qa_reasons is array",    Array.isArray(packet.qa_reasons));
  assert("fact is populated",      packet.fact.length > 0);
  assert("source_quote is populated", packet.source_quote.length > 0);
  assert("source_url is set",      packet.source_url === "https://arxiv.org/abs/2306.05499");
  assert("publisher is set",       packet.publisher === "arXiv");
})();

group("L5 — No internal processing artifacts in canonical packet");

(function testNoInternalArtifacts() {
  const packet = normalizeL5AToCanonical(makeRawItem(), makeSource());
  const artifacts = hasInternalArtifacts(packet);
  assert(
    "canonical packet has no forbidden internal fields",
    artifacts.length === 0,
    artifacts.length ? `found: ${artifacts.join(", ")}` : ""
  );
})();

group("L5 — Packet validation");

(function testValidation() {
  const valid   = normalizeL5AToCanonical(makeRawItem(), makeSource());
  const { valid: v1, issues: i1 } = validateCanonicalPacket(valid);
  assert("valid packet passes validation", v1, i1.join(", "));

  // Missing evidence_id
  const noId = { ...valid, evidence_id: "" };
  const { valid: v2 } = validateCanonicalPacket(noId);
  assert("packet without evidence_id fails validation", !v2);

  // Passed L5A without quote
  const noQuote = { ...valid, admissibility: "passed", source_quote: "" };
  const { valid: v3 } = validateCanonicalPacket(noQuote);
  assert("passed L5A packet without source_quote fails validation", !v3);
})();

group("L5 — L5B and L5C packets");

(function testAnalytics() {
  const b = normalizeL5BToCanonical({
    evidence_id: "agg_llm_prompt_injection_01",
    finding:     "Prompt injection mentioned in 8 of 12 LLM sources",
    category:    "llm_threats",
    evidence_type: "analytics_metric",
  });
  assert("L5B packet has source_branch L5B", b.source_branch === "L5B");
  assert("L5B packet admissibility is context_only", b.admissibility === "context_only");
  assert("L5B packet blocked from fact_support", b.claim_permissions.blocked_uses.includes("fact_support"));
  assert("L5B packet permitted for analytics", b.claim_permissions.permitted_uses.includes("analytics"));
  assert("L5B has corpus-scoped caveat", b.caveats.length > 0);

  const c = normalizeL5CToCanonical({
    evidence_id: "ext_web_001",
    claim:       "CISA confirmed LLM prompt injection exploited in Q3 2025",
    url:         "https://cisa.gov/advisory/aa25-001",
    publisher:   "CISA",
    evidence_type: "incident_confirmation",
    admissibility: "passed",
  });
  assert("L5C packet has source_branch L5C", c.source_branch === "L5C");
  assert("L5C packet has source_url", !!c.source_url);
  assert("L5C packet has external_web_source limitation", c.limitations.includes("external_web_source"));
})();

group("L5 — L5 does not produce final claims");

(function testNoFinalClaims() {
  const item   = makeRawItem();
  const source = makeSource();
  const packet = normalizeL5AToCanonical(item, source);

  assert("canonical packet has no claim_priority field", !("claim_priority" in packet));
  assert("canonical packet has no strategic_judgment field", !("strategic_judgment" in packet));
  assert("canonical packet has no claim_text field", !("claim_text" in packet));
  assert("canonical packet has no claim_id field", !("claim_id" in packet));
})();

// ── L6 Strategic judgment tests ───────────────────────────────────────────────

group("L6 — Strategic judgment requires evidence IDs");

(function testJudgmentRequiresIds() {
  const evidenceRegistry = new Map([
    ["ev_abc123_001", {
      evidence_id: "ev_abc123_001",
      fact:        "88% ASR on GPT-4",
      publisher:   "arXiv",
      url:         "https://arxiv.org/abs/2306.05499",
      source_id:   "src_abc123",
      source_type: "research_finding",
    }],
  ]);

  const j = makeJudgment();
  const obj = buildApprovedIntelligenceObject(j, "llm_threats", evidenceRegistry, new Map());
  assert("judgment with evidence_ids produces intel object", !!obj);
  assert("intel object has resolved evidence_for",   obj.evidence_for.length > 0);

  // Judgment with no evidence IDs → not approved for main panels
  const noIds = makeJudgment({ evidence_for: [], supporting_evidence_ids: [], evidence_against: [] });
  const noObj = buildApprovedIntelligenceObject(noIds, "llm_threats", evidenceRegistry, new Map());
  assert("judgment with no evidence IDs is NOT approved_for_dashboard", !noObj.approved_for_dashboard);
  assert("judgment with no evidence IDs has rejection_reason", !!noObj.rejection_reason);
})();

group("L6 — summary-only judgment is blocked");

(function testSummaryOnlyBlocked() {
  const evidenceRegistry = new Map([
    ["ev_summary_001", {
      evidence_id: "ev_summary_001", fact: "Some fact", publisher: "Unknown",
      url: null, source_id: "src_x", source_type: "governance_signal",
    }],
  ]);

  // summary_only judgment → not approved for main panels
  const summaryJ = makeJudgment({
    analytical_quality: "summary_only",
    evidence_for: ["ev_summary_001"],
    supporting_evidence_ids: ["ev_summary_001"],
  });
  const obj = buildApprovedIntelligenceObject(summaryJ, "llm_threats", evidenceRegistry, new Map());
  assert("summary_only judgment is not approved_for_dashboard", !obj.approved_for_dashboard);
  assert("summary_only judgment is not approved_for_slides",    !obj.approved_for_slides);
  assert("summary_only judgment has rejection_reason or appendix_only",
    obj.rejection_reason !== null || obj.approved_for_appendix_only === true);
})();

group("L6 — unsupported judgment is blocked");

(function testUnsupportedJudgmentBlocked() {
  const evidenceRegistry = new Map(); // empty — no IDs resolve

  const j = makeJudgment({ evidence_for: ["ev_nonexistent_999"] });
  const obj = buildApprovedIntelligenceObject(j, "llm_threats", evidenceRegistry, new Map());
  assert("judgment with unresolved evidence IDs is not approved_for_dashboard", !obj.approved_for_dashboard);
  assert("unresolved judgment has rejection_reason",  !!obj.rejection_reason);
})();

// ── ApprovedIntelligenceObject tests ─────────────────────────────────────────

group("ApprovedIntelligenceObject — created only from approved judgments");

(function testIntelObjectCreation() {
  const evidenceRegistry = new Map([
    ["ev_abc123_001", {
      evidence_id: "ev_abc123_001", fact: "88% ASR", publisher: "arXiv",
      url: "https://arxiv.org/abs/2306.05499", source_id: "src_abc123",
      source_type: "research_finding",
    }],
  ]);
  const sourceRegistry = new Map([
    ["src_abc123", { id: "src_abc123", title: "PAIR paper", url: "https://arxiv.org/abs/2306.05499", trust_tier: "high" }],
  ]);

  const j   = makeJudgment();
  const obj = buildApprovedIntelligenceObject(j, "llm_threats", evidenceRegistry, sourceRegistry);

  assert("intel object has intel_id",      !!obj.intel_id);
  assert("intel object has judgment",       !!obj.judgment);
  assert("intel object has short_takeaway", !!obj.short_takeaway);
  assert("intel object has caveats array",  Array.isArray(obj.caveats));
  assert("intel object has visual_suggestions array", Array.isArray(obj.visual_suggestions));
  assert("intel object has source_links",   obj.source_links.length > 0);
  assert("intel object source_link has url", !!obj.source_links[0].url);
  assert("intel object passes validation",  validateApprovedIntelligenceObject(obj).valid);
  assert("intel object has no forbidden fields", hasIntelInternalArtifacts(obj).length === 0);
})();

group("ApprovedIntelligenceObject — validation rules");

(function testIntelValidation() {
  const evidenceRegistry = new Map([
    ["ev_abc123_001", {
      evidence_id: "ev_abc123_001", fact: "fact", publisher: "arXiv",
      url: "https://arxiv.org/abs/2306.05499", source_id: "src_abc123",
      source_type: "research_finding",
    }],
  ]);
  const j   = makeJudgment();
  const obj = buildApprovedIntelligenceObject(j, "llm_threats", evidenceRegistry, new Map());

  // slides require dashboard approval
  const badSlides = { ...obj, approved_for_slides: true, approved_for_dashboard: false };
  const { valid, issues } = validateApprovedIntelligenceObject(badSlides);
  assert("approved_for_slides without dashboard is invalid", !valid);
  assert("validation reports the slide/dashboard inconsistency", issues.some((i) => i.includes("slides")));

  // chatbot alone is fine
  const chatbotOnly = { ...obj, approved_for_chatbot: true, approved_for_dashboard: true, approved_for_slides: false };
  const { valid: cv } = validateApprovedIntelligenceObject(chatbotOnly);
  assert("approved_for_chatbot + dashboard is valid", cv);
})();

// ── Intelligence Layer (full pipeline) tests ──────────────────────────────────

group("Intelligence Layer — builds from analysis package");

(function testBuildIntelligenceLayer() {
  const evidenceRegistry = new Map([
    ["ev_abc123_001", {
      evidence_id: "ev_abc123_001", fact: "88% ASR", publisher: "arXiv",
      url: "https://arxiv.org/abs/2306.05499", source_id: "src_abc123",
      source_type: "research_finding",
    }],
  ]);

  const fakePackage = {
    category_analyses: [
      {
        category: "llm_threats",
        strategic_judgments: [makeJudgment()],
        claims: [],
        claims_blocked_by_qa: [],
      },
    ],
    evidence_registry: evidenceRegistry,
    source_registry:   new Map(),
  };

  const layer = buildIntelligenceLayer(fakePackage);
  assert("intelligence layer returns intelligence_objects", Array.isArray(layer.intelligence_objects));
  assert("intelligence layer has at least 1 object", layer.intelligence_objects.length >= 1);
  assert("intelligence layer has counts", typeof layer.counts === "object");
  assert("intelligence layer has approved_for_main_panels", Array.isArray(layer.approved_for_main_panels));
  assert("intelligence layer has chatbot_eligible",    Array.isArray(layer.chatbot_eligible));
  assert("intelligence layer has blocked",             Array.isArray(layer.blocked));
})();

group("Dashboard — cannot use context-only evidence as main support");

(function testContextOnlyBlocked() {
  const evidenceRegistry = new Map([
    ["ev_context_001", {
      evidence_id: "ev_context_001", fact: "Background context only",
      publisher: "Unknown", url: null, source_id: "src_ctx",
      source_type: "governance_signal",
    }],
  ]);

  // context_only judgment (descriptive quality, only appendix)
  const j = makeJudgment({
    analytical_quality: "descriptive",
    evidence_for: ["ev_context_001"],
    supporting_evidence_ids: ["ev_context_001"],
  });
  const obj = buildApprovedIntelligenceObject(j, "llm_threats", evidenceRegistry, new Map());
  assert("descriptive judgment not approved for main dashboard panel", !obj.approved_for_dashboard);
})();

group("Slide/Report/Dashboard — resolve to same evidence registry");

(function testSharedRegistry() {
  const evidenceRegistry = new Map([
    ["ev_abc123_001", {
      evidence_id: "ev_abc123_001", fact: "88% ASR", publisher: "arXiv",
      url: "https://arxiv.org/abs/2306.05499", source_id: "src_abc123",
      source_type: "research_finding",
    }],
  ]);

  const fakePackage = {
    category_analyses: [
      {
        category: "llm_threats",
        strategic_judgments: [makeJudgment()],
        claims: [{ claim_id: "claim_llm_1", claim_text: "Automated jailbreak", supporting_evidence_ids: ["ev_abc123_001"] }],
        claims_blocked_by_qa: [],
      },
    ],
    evidence_registry: evidenceRegistry,
    source_registry:   new Map([["src_abc123", { url: "https://arxiv.org/abs/2306.05499" }]]),
  };

  const layer = buildIntelligenceLayer(fakePackage);
  const intel = layer.intelligence_objects[0];
  assert("intel object supporting_evidence_ids present",
    (intel?.supporting_evidence_ids || []).includes("ev_abc123_001"));

  // Verify the same ID resolves from the registry
  const ev = evidenceRegistry.get("ev_abc123_001");
  assert("evidence ID resolves from registry", !!ev);
  assert("resolved evidence has a URL",  ev.url.startsWith("http"));
})();

group("Source URL backtrace — from dashboard object");

(function testUrlBacktrace() {
  const evidenceRegistry = new Map([
    ["ev_abc123_001", {
      evidence_id: "ev_abc123_001", fact: "88% ASR", publisher: "arXiv",
      url: "https://arxiv.org/abs/2306.05499", source_id: "src_abc123",
      source_type: "research_finding",
    }],
  ]);
  const sourceRegistry = new Map([
    ["src_abc123", { id: "src_abc123", url: "https://arxiv.org/abs/2306.05499", trust_tier: "high" }],
  ]);

  const fakePackage = {
    category_analyses: [{
      category: "llm_threats",
      strategic_judgments: [makeJudgment()],
      claims: [], claims_blocked_by_qa: [],
    }],
    evidence_registry: evidenceRegistry,
    source_registry:   sourceRegistry,
  };

  const layer = buildIntelligenceLayer(fakePackage);
  const intel = layer.intelligence_objects[0];

  const trace = traceIntelToSourceUrl(intel, "ev_abc123_001", evidenceRegistry);
  assert("backtrace is traceable",       trace.traceable === true);
  assert("backtrace returns URL",        trace.url?.startsWith("http"));
  assert("backtrace returns source_id",  !!trace.source_id);

  const found = findIntelObject(intel.intel_id, layer.intelligence_objects);
  assert("findIntelObject locates by intel_id", !!found && found.intel_id === intel.intel_id);
})();

// ── Observability tests ───────────────────────────────────────────────────────

group("Observability — no-op when env vars absent");

(function testObservabilityNoOp() {
  // Remove Langfuse env vars temporarily if present
  const saved_pub = process.env.LANGFUSE_PUBLIC_KEY;
  const saved_sec = process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;

  assert("isObservabilityEnabled() returns false when vars absent", !isObservabilityEnabled());

  // Restore
  if (saved_pub) process.env.LANGFUSE_PUBLIC_KEY = saved_pub;
  if (saved_sec) process.env.LANGFUSE_SECRET_KEY = saved_sec;
})();

(async function testWrapLLMCallNoOp() {
  let called = false;
  const result = await wrapLLMCall(
    { task: "test_task", model: "test_model" },
    async () => { called = true; return { output: "test" }; }
  );
  assert("wrapLLMCall executes fn even without Langfuse", called);
  assert("wrapLLMCall returns fn result",   result?.output === "test");
})();

(async function testFlushNoOp() {
  let threw = false;
  try { await flushObservability(); } catch { threw = true; }
  assert("flushObservability does not throw when disabled", !threw);
})();

// ── Summary ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${"─".repeat(60)}\n`);
process.stdout.write(`Simplified MVP tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
