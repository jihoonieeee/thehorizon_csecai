/**
 * Validation layer tests (Layer 3). Deterministic — no network, no DB.
 * The LLM is injected via opts.llmFn so nothing hits Anthropic.
 * Run with: node tests/validationLayer.test.js
 */

import assert from "node:assert/strict";

import {
  assessAiRelevance, hasAiSignal, deriveRelevanceFromFocus,
} from "../lib/pipeline/validation/aiRelevance.js";
import {
  validateAndTypeSource, validateAndTypeSources, VALIDATION_VERSION,
} from "../lib/pipeline/validation/validateAndTypeSource.js";
import { annotateSourceContext } from "../lib/pipeline/validation/trustAssessment.js";
import { checkSourceValidity } from "../lib/pipeline/validation/sourceValidity.js";
import { classifyPublisherCanonical, classifyForTrust, classifyForOrigin } from "../lib/pipeline/validation/publisherClass.js";

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

// ── Unified LLM stub ────────────────────────────────────────────────────────
// The Layer 3 unified call uses task "layer3_validation" and returns a single
// structured object. mkLlm wraps a full L3 result for injection via opts.llmFn.
function mkLlm(l3Result) {
  return async (_sys, _user, opts) => {
    if (opts.task === "layer3_validation") {
      return { result: l3Result, llm_metadata: { llm_used: true } };
    }
    return { result: null, llm_metadata: { llm_used: false } };
  };
}

// Default "central pass" L3 result — a genuine offensive finding.
const CENTRAL_L3 = {
  verdict:           "pass",
  rejection_reason:  null,
  ai_threat_focus:   "central",
  ai_materiality:    "material",
  content_quality:   "substantive",
  evidence_origin:   "original_research",
  evidence_quality:  "strong",
  claim_support:     "direct",
  publisher_role:    "researcher",
  reading_value:     "recommended",
  distribution_recommendation: { overview_dashboard: true, email_newsletter: true, analyst_library: true },
  recommendation_reason: "First demonstrated MCP tool-poisoning technique with working PoC against a production assistant.",
  trust_tier:        "high",
  trust_tier_reason: "Adversa AI is a known AI-security research firm publishing original research.",
  source_type:       "research_finding",
  candidate_domain:  "agentic_ai_threats",
  secondary_domain:  null,
  affected_ai_layer: "agent_autonomy",
  boundary_rationale: "Exploits delegated autonomy — the MCP tool call is the attack vector.",
  summary:           "Researchers show an indirect prompt injection that hijacks an LLM agent over MCP to exfiltrate data. The exploit works against a production assistant.",
  confidence:        "high",
  reasoning:         "Centrally about an agentic LLM injection attack.",
};

// ── Deterministic pre-gate ────────────────────────────────────────────────────
console.log("\npre-gate (word-boundary AI-signal detection)");

await test("no AI signal — word-boundary avoids 'retailer'/'source' false positives", () => {
  assert.equal(hasAiSignal({ full_text: "The retailer reviewed its source code and logistics." }).has_ai_signal, false);
});
await test("generic AI mention + concrete cyber threat passes to the LLM (recall hedge)", () => {
  // No high/medium AI keyword, but "AI" + a concrete CVE/RCE → worth an LLM check.
  const s = hasAiSignal({ full_text: "An AI feature contained a vulnerability allowing remote code execution (RCE)." });
  assert.equal(s.has_ai_signal, true);
  assert.equal(s.signal_strength, "low_ai_cyber");
});

await test("generic AI mention WITHOUT a concrete cyber threat is still discarded", () => {
  assert.equal(hasAiSignal({ full_text: "The company uses AI and automation to improve logistics." }).has_ai_signal, false);
});

await test("real AI terms trip the signal", () => {
  assert.equal(hasAiSignal({ full_text: "A prompt injection attack on the LLM agent." }).has_ai_signal, true);
});

// ── LLM path (single unified call) ───────────────────────────────────────────
console.log("\nLLM unified call path");

await test("central source is accepted with summary, type, domain", async () => {
  const r = await validateAndTypeSource(mkSource(), { llmFn: mkLlm(CENTRAL_L3) });
  assert.notEqual(r.validation_status, "reject");
  assert.equal(r.ai_threat_focus, "central");
  assert.equal(r.source_type, "research_finding");
  assert.equal(r.candidate_domain, "agentic_ai_threats");
  assert.equal(r.validation_relevance_method, "llm");
  assert.equal(r.validation_qa_status, "unified");
  assert.ok(r.validation_summary && r.validation_summary.length > 20, "summary present");
  assert.equal(r.validation_version, VALIDATION_VERSION);
});

await test("passing (incidental) mention is rejected and domain cleared", async () => {
  const l3 = {
    verdict: "reject", rejection_reason: "no_ai_threat",
    ai_threat_focus: "passing", content_quality: "substantive",
    trust_tier: "medium", trust_tier_reason: "stub",
    source_type: "incident", candidate_domain: "unclear_or_adjacent",
    summary: "A ransomware breach; the vendor mentions AI in passing.",
    confidence: "high", reasoning: "AI is incidental.",
  };
  const src = mkSource({ trust_tier: "medium", full_text: "A ransomware gang breached a hospital. The vendor said it may use AI internally. ".repeat(8) });
  const r = await validateAndTypeSource(src, { llmFn: mkLlm(l3) });
  assert.equal(r.validation_status, "reject");
  assert.equal(r.relevance_tier, "off_topic");
  assert.equal(r.candidate_domain, "unclear_or_adjacent");
});

await test("adjacent (landmark reference) source is KEPT, verdict=pass, route=layer4", async () => {
  // DARPA AIxCC: centrally about AI cyber-security but not an offensive finding.
  // The unified call returns verdict="pass" for adjacent context with high confidence.
  const l3 = {
    verdict: "pass", rejection_reason: null,
    ai_threat_focus: "adjacent", content_quality: "substantive",
    trust_tier: "high", trust_tier_reason: "stub",
    source_type: "capability_demonstration", candidate_domain: "unclear_or_adjacent",
    summary: "DARPA's AI Cyber Challenge fielded autonomous systems that find and patch vulnerabilities in real codebases.",
    confidence: "high", reasoning: "Reference context — dual-use capability milestone.",
  };
  const src = mkSource({ trust_tier: "high", title: "DARPA AIxCC final results",
    full_text: "Autonomous cyber reasoning systems built on an LLM agent found and patched vulnerabilities across real open-source codebases. ".repeat(6) });
  const r = await validateAndTypeSource(src, { llmFn: mkLlm(l3), skipUrlCheck: true });
  assert.equal(r.validation_status, "pass", "adjacent context is kept, not rejected or reviewed");
  assert.equal(r.ai_threat_focus, "adjacent");
  assert.equal(r.relevance_tier, "adjacent");
  assert.equal(r.candidate_domain, "unclear_or_adjacent");
  assert.equal(r.downstream_route, "layer4");
  assert.ok((r.route_reason_codes || []).includes("adjacent_context_keep"));
});

await test("LLM returns adjacent → source kept with adjacent routing", async () => {
  // If LLM returns verdict=review for adjacent, gate respects it.
  const l3 = {
    verdict: "review", rejection_reason: null,
    ai_threat_focus: "adjacent", content_quality: "substantive",
    trust_tier: "high", trust_tier_reason: "stub",
    source_type: "governance_signal", candidate_domain: "unclear_or_adjacent",
    summary: "OWASP LLM Top 10 framework — reference context for the pipeline.",
    confidence: "high", reasoning: "Landmark reference, not an offensive finding.",
  };
  const r = await validateAndTypeSource(mkSource({ trust_tier: "high" }), { llmFn: mkLlm(l3), skipUrlCheck: true });
  assert.equal(r.ai_threat_focus, "adjacent");
  assert.equal(r.validation_status, "review");
  assert.equal(r.candidate_domain, "unclear_or_adjacent");
});

await test("LLM returns reject for marketing content — source discarded", async () => {
  const l3 = {
    verdict: "reject", rejection_reason: "marketing_content",
    ai_threat_focus: "passing", content_quality: "marketing",
    trust_tier: "medium", trust_tier_reason: "stub",
    source_type: "unknown", candidate_domain: "unclear_or_adjacent",
    summary: "Vendor announces its AI security platform.",
    confidence: "high", reasoning: "Marketing content, not a threat finding.",
  };
  const r = await validateAndTypeSource(mkSource({ trust_tier: "medium" }), { llmFn: mkLlm(l3), skipUrlCheck: true });
  assert.equal(r.validation_status, "reject");
  assert.ok(r.final_validity_reason.includes("marketing"), `unexpected reason: ${r.final_validity_reason}`);
});

await test("marketing source from medium-trust publisher is rejected", async () => {
  const l3 = {
    verdict: "reject", rejection_reason: "marketing_content",
    ai_threat_focus: "passing", content_quality: "marketing",
    trust_tier: "medium", trust_tier_reason: "stub",
    source_type: "unknown", candidate_domain: "unclear_or_adjacent",
    summary: "Vendor announcement.",
    confidence: "high", reasoning: "Marketing content.",
  };
  const src = mkSource({ trust_tier: "medium", full_text: "Announcing our new AI security platform for enterprise customers. ".repeat(8) });
  const r = await validateAndTypeSource(src, { llmFn: mkLlm(l3), skipUrlCheck: true });
  assert.equal(r.validation_status, "reject");
});

await test("LLM can downgrade trust tier based on content (not upgrade it)", async () => {
  // Source arrives with trust_tier="high" from connector; LLM sees it's a low-trust blog.
  const l3 = { ...CENTRAL_L3, trust_tier: "low", trust_tier_reason: "No verifiable authorship." };
  const src = mkSource({ trust_tier: "high" });
  const r = await validateAndTypeSource(src, { llmFn: mkLlm(l3) });
  assert.equal(r.trust_tier, "low", "LLM downgrade applied when more restrictive");
  assert.ok(r.trust_tier_reason.includes("llm_downgrade"), `unexpected reason: ${r.trust_tier_reason}`);
});

await test("LLM cannot upgrade trust tier above connector value", async () => {
  // Source arrives with trust_tier="medium"; LLM incorrectly returns "primary".
  const l3 = { ...CENTRAL_L3, trust_tier: "primary", trust_tier_reason: "Looks authoritative." };
  const src = mkSource({ trust_tier: "medium" });
  const r = await validateAndTypeSource(src, { llmFn: mkLlm(l3) });
  assert.equal(r.trust_tier, "medium", "LLM cannot upgrade trust above connector value");
});

// ── Deterministic discard (no LLM call spent) ──────────────────────────────────
console.log("\ndeterministic discard");

await test("no-signal source is pre-gate discarded without an LLM call", async () => {
  let called = false;
  const spy = async () => { called = true; return { result: CENTRAL_L3, llm_metadata: { llm_used: true } }; };
  const src = mkSource({ title: "Quarterly earnings up for retailer", trust_tier: "medium",
    full_text: "The retailer reported strong quarterly earnings from holiday sales and logistics. ".repeat(8) });
  const r = await validateAndTypeSource(src, { llmFn: spy });
  assert.equal(called, false, "LLM must not be called for a no-signal source");
  assert.equal(r.validation_relevance_method, "pre_gate_discard");
  assert.equal(r.validation_status, "reject");
});

await test("no-signal source with medium trust is rejected", async () => {
  const src = mkSource({ trust_tier: "medium", title: "Annual logistics retailer report",
    full_text: "The retailer reported steady revenue across regions and improved logistics. ".repeat(8) });
  const r = await validateAndTypeSource(src, { skipLlm: true });
  assert.equal(r.validation_status, "reject");
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

// ── Source typing via the unified call ────────────────────────────────────────
console.log("\nsource typing via unified call");

await test("source_type from unified L3 call flows to output", async () => {
  const l3 = { ...CENTRAL_L3, source_type: "exploit_disclosure" };
  const r = await validateAndTypeSource(mkSource(), { llmFn: mkLlm(l3) });
  assert.equal(r.source_type, "exploit_disclosure");
  assert.equal(r.source_type_reason, "layer3_llm");
});

await test("unknown source_type from LLM is stored as 'unknown'", async () => {
  const l3 = { ...CENTRAL_L3, source_type: "invalid_type_xyz" };
  const r = await validateAndTypeSource(mkSource(), { llmFn: mkLlm(l3) });
  assert.equal(r.source_type, "unknown", "unknown type normalised to unknown");
});

// ── Evidence + taxonomy fields ────────────────────────────────────────────────
console.log("\nevidence + taxonomy fields");

await test("new evidence fields flow from unified L3 call to enriched output", async () => {
  const r = await validateAndTypeSource(mkSource(), { llmFn: mkLlm(CENTRAL_L3), skipUrlCheck: true });
  assert.equal(r.ai_materiality,    "material");
  assert.equal(r.evidence_origin,   "original_research");
  assert.equal(r.evidence_quality,  "strong");
  assert.equal(r.claim_support,     "direct");
  assert.equal(r.publisher_role,    "researcher");
  assert.equal(r.affected_ai_layer, "agent_autonomy");
  assert.ok(r.boundary_rationale && r.boundary_rationale.length > 5, "boundary_rationale populated");
  assert.equal(r.secondary_domain,  null);
});

await test("secondary_domain flows through when valid and different from candidate_domain", async () => {
  const l3 = { ...CENTRAL_L3, secondary_domain: "llm_threats" };
  const r = await validateAndTypeSource(mkSource(), { llmFn: mkLlm(l3), skipUrlCheck: true });
  assert.equal(r.secondary_domain, "llm_threats");
});

await test("secondary_domain is null when same as candidate_domain", async () => {
  const l3 = { ...CENTRAL_L3, secondary_domain: "agentic_ai_threats" }; // same as candidate_domain
  const r = await validateAndTypeSource(mkSource(), { llmFn: mkLlm(l3), skipUrlCheck: true });
  assert.equal(r.secondary_domain, null, "secondary_domain must differ from candidate_domain");
});

await test("aggregation content quality routes to review (not reject) when links present", async () => {
  const l3 = {
    ...CENTRAL_L3,
    verdict: "review",
    content_quality: "aggregation",
    evidence_origin: "aggregation",
    evidence_quality: "weak",
    rejection_reason: null,
  };
  const r = await validateAndTypeSource(mkSource(), { llmFn: mkLlm(l3), skipUrlCheck: true });
  assert.equal(r.validation_status, "review");
  assert.equal(r.content_quality, "aggregation");
});

await test("new fields are null on skipLlm path (deterministic)", async () => {
  const r = await validateAndTypeSource(mkSource(), { skipLlm: true });
  assert.equal(r.evidence_origin,          null, "evidence_origin null on deterministic path");
  assert.equal(r.evidence_quality,         null, "evidence_quality null on deterministic path");
  assert.equal(r.ai_materiality,           null, "ai_materiality null on deterministic path");
  assert.equal(r.reading_value,            null, "reading_value null on deterministic path");
  assert.equal(r.distribution_recommendation, null, "distribution_recommendation null on deterministic path");
  assert.equal(r.recommendation_reason,   null, "recommendation_reason null on deterministic path");
});

await test("distribution_recommendation flows from unified L3 call to enriched output", async () => {
  const r = await validateAndTypeSource(mkSource(), { llmFn: mkLlm(CENTRAL_L3), skipUrlCheck: true });
  assert.deepEqual(r.distribution_recommendation, { overview_dashboard: true, email_newsletter: true, analyst_library: true });
  assert.ok(typeof r.recommendation_reason === "string" && r.recommendation_reason.length > 5, "recommendation_reason populated");
});

await test("distribution_recommendation defaults derived from reading_value when LLM omits the field", async () => {
  const l3 = { ...CENTRAL_L3 };
  delete l3.distribution_recommendation;
  l3.reading_value = "analyst";
  const r = await validateAndTypeSource(mkSource(), { llmFn: mkLlm(l3), skipUrlCheck: true });
  // analyst → no dashboard/newsletter, but analyst_library
  assert.equal(r.distribution_recommendation?.overview_dashboard, false);
  assert.equal(r.distribution_recommendation?.email_newsletter,   false);
  assert.equal(r.distribution_recommendation?.analyst_library,    true);
});

await test("background reading_value yields all-false distribution when LLM omits field", async () => {
  const l3 = { ...CENTRAL_L3, reading_value: "background", verdict: "review", ai_threat_focus: "adjacent" };
  delete l3.distribution_recommendation;
  const r = await validateAndTypeSource(mkSource(), { llmFn: mkLlm(l3), skipUrlCheck: true });
  assert.equal(r.distribution_recommendation?.overview_dashboard, false);
  assert.equal(r.distribution_recommendation?.email_newsletter,   false);
  assert.equal(r.distribution_recommendation?.analyst_library,    false);
});

// ── Batch + helpers ────────────────────────────────────────────────────────────
console.log("\nbatch + mapping helpers");

await test("deriveRelevanceFromFocus maps central→core, adjacent→adjacent, passing/none→off_topic", () => {
  assert.equal(deriveRelevanceFromFocus("central").relevance_tier, "core");
  assert.equal(deriveRelevanceFromFocus("adjacent").relevance_tier, "adjacent");
  assert.equal(deriveRelevanceFromFocus("passing").relevance_tier, "off_topic");
  assert.equal(deriveRelevanceFromFocus("none").relevance_tier, "off_topic");
});

await test("batch splits accepted vs rejected and reports stats", async () => {
  const accepted = mkSource({ id: "ok" });
  const discarded = mkSource({ id: "no", title: "Retailer earnings", trust_tier: "medium",
    full_text: "The retailer reported earnings and logistics improvements. ".repeat(8) });
  const out = await validateAndTypeSources([accepted, discarded], { llmFn: mkLlm(CENTRAL_L3), concurrency: 2 });
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
    { llmFn: mkLlm(CENTRAL_L3) }
  );
  assert.equal(r.publisher_class,        "primary_authority");
  assert.equal(r.evidence_strength_hint, "strong");
  assert.equal(r.verification_status,    "verified");
  assert.ok(!("source_credibility_score" in r), "source_credibility_score must not be present");
});

// ── Deny list uses exact/subdomain matching, not substring (F19) ──────────────

await test("denied domain matches host and subdomains, not substrings", () => {
  // reddit.com is on the deny list → hard fail
  const denied = checkSourceValidity({ title: "x", url: "https://www.reddit.com/r/x/post" });
  assert.equal(denied.hard_fail, true);
  assert.ok(denied.validity_reason.includes("denied_domain"));

  // phoenix.com must NOT be denied by the "x.com" rule (substring false positive)
  const ok = checkSourceValidity({ title: "AI threat report", url: "https://phoenix.com/research" });
  assert.equal(ok.hard_fail, false, "phoenix.com wrongly denied by substring match");
});

// ── Canonical publisher classifier is the single source of truth (F15) ────────

await test("one canonical classifier; each module maps it consistently", () => {
  // CrowdStrike: security_firm everywhere.
  assert.equal(classifyPublisherCanonical({ publisher: "CrowdStrike" }), "security_firm");
  assert.equal(classifyForTrust({ publisher: "CrowdStrike" }), "security_firm");
  assert.equal(classifyForOrigin({ publisher: "CrowdStrike" }), "security_firm");

  // Google: major_vendor for trust, folds to security_firm for origin/quality.
  assert.equal(classifyPublisherCanonical({ publisher: "Google" }), "major_vendor");
  assert.equal(classifyForTrust({ publisher: "Google" }), "major_vendor");
  assert.equal(classifyForOrigin({ publisher: "Google" }), "security_firm");

  // AI lab: major_vendor for trust, primary_authority for origin/quality.
  assert.equal(classifyPublisherCanonical({ publisher: "Anthropic" }), "ai_lab");
  assert.equal(classifyForTrust({ publisher: "Anthropic" }), "major_vendor");
  assert.equal(classifyForOrigin({ publisher: "Anthropic" }), "primary_authority");

  // Unknown small publisher: other / unknown.
  assert.equal(classifyPublisherCanonical({ publisher: "Zephyr Daily", url: "https://zephyrdaily.example/x" }), "other");
  assert.equal(classifyForOrigin({ publisher: "Zephyr Daily", url: "https://zephyrdaily.example/x" }), "unknown");
});

// ── finalGate: primary tier unconditional review pass (F20) ──────────────────

await test("known AI product + CVE is recognized as relevant via the entity/cyber pre-gate", async () => {
  // NVD CVE about an AI inference server — the title names the product (LMDeploy)
  // and a concrete cyber technique (path traversal / arbitrary file write) but no
  // explicit "AI attack" phrase. The expanded pre-gate pairs the known AI entity
  // with the high-signal cyber term and admits it as a genuine AI-security source
  // (previously it scored 0 and only survived via the trusted-tier review rescue).
  const src = mkSource({
    trust_tier:  "primary",
    publisher:   "NVD",
    source_type: "vulnerability",
    title:       "CVE-2026-99999: LMDeploy path traversal allows arbitrary file write",
    full_text:   "CVE-2026-99999 is a path traversal vulnerability in the REST API server of the LMDeploy tool. An unauthenticated attacker can issue crafted requests to overwrite arbitrary files on the target system. CVSS score: 9.1 Critical. Upgrade to version 0.6.3 or later. No workaround available. ".repeat(4),
  });
  assert.equal(hasAiSignal(src).has_ai_signal, true, "entity+cyber pair must clear the pre-gate");
  const r = await validateAndTypeSource(src, { skipLlm: true });
  assert.notEqual(r.validation_status, "reject", "recognized AI-security source must not be rejected");
  assert.notEqual(r.relevance_tier, "off_topic", "entity+cyber pair scores it above off_topic");
});

await test("high tier off-topic with no signal is still rejected", async () => {
  // Generic ML paper from arXiv without threat content — high tier, but no signal.
  const src = mkSource({
    trust_tier: "high",
    publisher:  "arXiv",
    title:      "Efficient Transformer Training on Large Datasets",
    full_text:  "We present a new method for efficient transformer training on large corpora. Our approach improves throughput by 20%. ".repeat(8),
  });
  const r = await validateAndTypeSource(src, { skipLlm: true });
  assert.equal(r.validation_status, "reject",  "high tier no-signal source must still be rejected");
  assert.ok(r.final_validity_reason.includes("off_topic"), `unexpected reason: ${r.final_validity_reason}`);
});

// ── relevance_path on the LLM path (bug fix: was null after LLM triage) ──────

await test("relevance_path is non-null after LLM triage confirms relevance", async () => {
  const src = mkSource(); // default source has AI signal keywords
  const r = await validateAndTypeSource(src, { llmFn: mkLlm(CENTRAL_L3) });
  assert.notEqual(r.relevance_path, null, "relevance_path must not be null after LLM triage");
  assert.ok(
    ["known_signal", "novelty_signal", "both", "none"].includes(r.relevance_path),
    `unexpected relevance_path: ${r.relevance_path}`
  );
});

await test("relevance_path is non-null on deterministic path too", async () => {
  const src = mkSource();
  const r = await validateAndTypeSource(src, { skipLlm: true });
  assert.notEqual(r.relevance_path, null, "relevance_path must not be null on deterministic path");
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nValidation layer: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
