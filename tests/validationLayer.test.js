/**
 * Validation layer tests (Layer 3). Deterministic — no network, no DB.
 * The LLM is injected via opts.llmFn so nothing hits Anthropic.
 * Run with: node tests/validationLayer.test.js
 */

import assert from "node:assert/strict";

import {
  assessAiRelevance, hasAiSignal, runRelevanceLlm, runRelevanceQa, deriveRelevanceFromFocus,
} from "../lib/pipeline/validation/aiRelevance.js";
import {
  validateAndTypeSource, validateAndTypeSources, VALIDATION_VERSION,
} from "../lib/pipeline/validation/validateAndTypeSource.js";
import { annotateSourceContext } from "../lib/pipeline/validation/trustAssessment.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
function mkSource(over = {}) {
  return {
    id: "s1",
    title: "Prompt injection hijacks LLM agents via MCP",
    url: "https://example.com/a",
    publisher: "Adversa AI",
    trust_tier: "high",
    date_published: "2026-06-01",
    full_text: "A new prompt injection technique lets attackers hijack an LLM agent through the model context protocol to exfiltrate data. ".repeat(8),
    ...over,
  };
}

// LLM stub: returns whatever the per-task scripts dictate.
function mkLlm({ relevance, qa } = {}) {
  return async (sys, user, opts) => {
    if (opts.task === "source_relevance") {
      return { result: relevance, llm_metadata: { llm_used: true } };
    }
    if (opts.task === "source_relevance_qa") {
      return { result: qa, llm_metadata: { llm_used: true } };
    }
    return { result: null, llm_metadata: { llm_used: false } };
  };
}

const CENTRAL = {
  summary: "Researchers show an indirect prompt injection that hijacks an LLM agent over MCP to exfiltrate data. The exploit works against a production assistant.",
  ai_threat_focus: "central", is_ai_threat: true, candidate_domain: "agentic_ai_threats",
  source_type: "research_finding", source_type_confidence: "high", confidence: "high",
  reasoning: "Centrally about an agentic LLM injection attack.",
};
const QA_OK = {
  verdict_correct: true, summary_grounded: true,
  corrected_ai_threat_focus: "central", corrected_is_ai_threat: true,
  corrected_source_type: "research_finding", issues: "",
};

// ── Deterministic pre-gate ────────────────────────────────────────────────────
console.log("\npre-gate (word-boundary AI-signal detection)");

await test("no AI signal — word-boundary avoids 'retailer'/'source' false positives", () => {
  assert.equal(hasAiSignal({ full_text: "The retailer reviewed its source code and logistics." }).has_ai_signal, false);
});
await test("real AI terms trip the signal", () => {
  assert.equal(hasAiSignal({ full_text: "A prompt injection attack on the LLM agent." }).has_ai_signal, true);
});

// ── LLM relevance path ────────────────────────────────────────────────────────
console.log("\nLLM relevance + QA path");

await test("central source is accepted with summary, type, domain", async () => {
  const r = await validateAndTypeSource(mkSource(), { llmFn: mkLlm({ relevance: CENTRAL, qa: QA_OK }) });
  assert.notEqual(r.validation_status, "reject");
  assert.equal(r.ai_threat_focus, "central");
  assert.equal(r.source_type, "research_finding");
  assert.equal(r.candidate_domain, "agentic_ai_threats");
  assert.equal(r.validation_relevance_method, "llm");
  assert.equal(r.validation_qa_status, "confirmed");
  assert.ok(r.validation_summary && r.validation_summary.length > 20, "summary present");
  assert.equal(r.validation_version, VALIDATION_VERSION);
});

await test("passing (incidental) mention is rejected and domain cleared", async () => {
  const relevance = {
    summary: "A ransomware breach at a hospital; the vendor mentions AI tooling in passing.",
    ai_threat_focus: "passing", is_ai_threat: false, candidate_domain: "unclear_or_adjacent",
    source_type: "incident", confidence: "high",
  };
  const qa = { verdict_correct: true, summary_grounded: true, corrected_ai_threat_focus: "passing", corrected_is_ai_threat: false, corrected_source_type: "incident", issues: "" };
  const src = mkSource({ trust_tier: "medium", full_text: "A ransomware gang breached a hospital. The vendor said it may use AI internally. ".repeat(8) });
  const r = await validateAndTypeSource(src, { llmFn: mkLlm({ relevance, qa }) });
  assert.equal(r.validation_status, "reject");
  assert.equal(r.relevance_tier, "off_topic");
  assert.equal(r.candidate_domain, "unclear_or_adjacent");
});

await test("QA corrects a wrong verdict (central → passing) and flips to reject", async () => {
  const relevance = { ...CENTRAL };              // call #1 says central
  const qa = {                                    // QA disagrees: it's a passing mention
    verdict_correct: false, summary_grounded: true,
    corrected_ai_threat_focus: "passing", corrected_is_ai_threat: false,
    corrected_source_type: "incident", issues: "Only mentions AI in passing.",
  };
  const r = await validateAndTypeSource(mkSource({ trust_tier: "medium" }), { llmFn: mkLlm({ relevance, qa }) });
  assert.equal(r.validation_qa_status, "corrected");
  assert.equal(r.ai_threat_focus, "passing");
  assert.equal(r.validation_status, "reject");
  assert.equal(r.source_type, "incident", "QA-corrected source_type applied");
});

// ── Deterministic discard (no LLM call spent) ──────────────────────────────────
console.log("\ndeterministic discard");

await test("no-signal source is pre-gate discarded without an LLM call", async () => {
  let called = false;
  const spy = async () => { called = true; return { result: CENTRAL, llm_metadata: { llm_used: true } }; };
  const src = mkSource({ title: "Quarterly earnings up for retailer", trust_tier: "medium",
    full_text: "The retailer reported strong quarterly earnings from holiday sales and logistics. ".repeat(8) });
  const r = await validateAndTypeSource(src, { llmFn: spy });
  assert.equal(called, false, "LLM must not be called for a no-signal source");
  assert.equal(r.validation_relevance_method, "pre_gate_discard");
  assert.equal(r.validation_status, "reject");
});

await test("curated no-signal source is routed to review, never hard-rejected", async () => {
  const src = mkSource({ trust_tier: "curated", title: "Annual logistics retailer report",
    full_text: "The retailer reported steady revenue across regions and improved logistics. ".repeat(8) });
  const r = await validateAndTypeSource(src, { skipLlm: true, llmFn: mkLlm({ relevance: CENTRAL }) });
  // No AI signal → pre-gate discard tier off_topic, but curated → review (not reject).
  assert.equal(r.validation_status, "review");
});

// ── skipLlm fallback ───────────────────────────────────────────────────────────
console.log("\nskipLlm deterministic fallback");

await test("skipLlm uses deterministic scorer and produces no summary", async () => {
  const r = await validateAndTypeSource(mkSource(), { skipLlm: true });
  assert.equal(r.validation_relevance_method, "deterministic");
  assert.equal(r.validation_summary, null);
  assert.ok(["core", "adjacent", "peripheral"].includes(r.relevance_tier), "keyword scorer keeps it relevant");
});

await test("LLM-unavailable (llm_used:false) falls back deterministically", async () => {
  const noProviders = async () => ({ result: null, llm_metadata: { llm_used: false } });
  const r = await validateAndTypeSource(mkSource(), { llmFn: noProviders });
  assert.equal(r.validation_relevance_method, "deterministic_fallback");
});

// ── Batch + helpers ────────────────────────────────────────────────────────────
console.log("\nbatch + mapping helpers");

await test("deriveRelevanceFromFocus maps central→core, passing/none→off_topic", () => {
  assert.equal(deriveRelevanceFromFocus("central").relevance_tier, "core");
  assert.equal(deriveRelevanceFromFocus("passing").relevance_tier, "off_topic");
  assert.equal(deriveRelevanceFromFocus("none").relevance_tier, "off_topic");
});

await test("batch splits accepted vs rejected and reports stats", async () => {
  const accepted = mkSource({ id: "ok" });
  const discarded = mkSource({ id: "no", title: "Retailer earnings", trust_tier: "medium",
    full_text: "The retailer reported earnings and logistics improvements. ".repeat(8) });
  const out = await validateAndTypeSources([accepted, discarded], { llmFn: mkLlm({ relevance: CENTRAL, qa: QA_OK }), concurrency: 2 });
  assert.equal(out.stats.total, 2);
  assert.equal(out.accepted.length, 1);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.accepted[0].id, "ok");
});

await test("deterministic assessAiRelevance still returns the legacy shape (Layer 2 fallback)", () => {
  const rel = assessAiRelevance(mkSource());
  assert.ok(typeof rel.ai_specificity_score === "number");
  assert.ok(["core", "adjacent", "peripheral", "off_topic"].includes(rel.relevance_tier));
});

// ── Source context annotation (Layer 3.4) ─────────────────────────────────────
console.log("\nsource context annotation (Layer 3.4)");

await test("CISA source → primary_authority, strong hint, verified, independent", () => {
  const r = annotateSourceContext({ publisher: "CISA", source_type: "governance_signal", trust_tier: "primary" });
  assert.equal(r.publisher_class,        "primary_authority");
  assert.equal(r.evidence_strength_hint, "strong");
  assert.equal(r.verification_status,    "verified");
  assert.equal(r.independence_level,     "independent");
  assert.equal(r.trust_tier,             "primary");
  assert.equal(r.reliability_notes.length, 0, "no caveats for primary authority");
});

await test("NIST source via connector → primary_authority", () => {
  const r = annotateSourceContext({
    publisher: "National Institute of Standards and Technology",
    source_type: "governance_signal",
    collection_metadata: { connector_id: "nist_feed" },
  });
  assert.equal(r.publisher_class, "primary_authority");
});

await test("arXiv preprint → academic, needs_crosscheck, reliability note included", () => {
  const r = annotateSourceContext({
    publisher: "arXiv",
    source_type: "research_finding",
    collection_metadata: { connector_id: "arxiv_cs_cr" },
  });
  assert.equal(r.publisher_class,     "academic");
  assert.equal(r.verification_status, "needs_crosscheck");
  assert.equal(r.independence_level,  "independent");
  assert.ok(r.reliability_notes.some((n) => /preprint/i.test(n)), "preprint caveat present");
});

await test("vendor blog (CrowdStrike) → security_firm, vendor_interested", () => {
  const r = annotateSourceContext({ publisher: "CrowdStrike", source_type: "threat_intelligence" });
  assert.equal(r.publisher_class,    "security_firm");
  assert.equal(r.independence_level, "vendor_interested");
  assert.ok(["weak","moderate"].includes(r.evidence_strength_hint));
});

await test("news article → secondary_summary evidence_role, unverified", () => {
  const r = annotateSourceContext({ publisher: "TechCrunch", source_type: "research_finding" });
  assert.equal(r.evidence_role,       "secondary_summary");
  assert.equal(r.verification_status, "unverified");
});

await test("web-discovery source → needs_crosscheck with reliability note", () => {
  const r = annotateSourceContext({
    publisher: "Unknown Blog",
    source_origin: "web_discovery",
    source_type: "research_finding",
  });
  assert.equal(r.verification_status, "needs_crosscheck");
  assert.ok(r.reliability_notes.some((n) => /web-discover/i.test(n)));
});

await test("unknown publisher does not break the pipeline", () => {
  const r = annotateSourceContext({ publisher: "", source_type: "unknown" });
  assert.ok(r.publisher_class);
  assert.ok(r.evidence_strength_hint);
  assert.ok(Array.isArray(r.reliability_notes));
});

await test("source context fields flow through full validateAndTypeSource", async () => {
  const r = await validateAndTypeSource(
    mkSource({ publisher: "CISA", trust_tier: "primary", source_type: "governance_signal" }),
    { llmFn: mkLlm({ relevance: CENTRAL, qa: QA_OK }) }
  );
  assert.equal(r.publisher_class,        "primary_authority");
  assert.equal(r.evidence_strength_hint, "strong");
  assert.equal(r.verification_status,    "verified");
  assert.ok(!("source_credibility_score" in r), "source_credibility_score must not be present");
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nValidation layer: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
