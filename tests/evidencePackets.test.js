/**
 * EvidencePacket schema, normalizers, registry, and traceability QA tests.
 *
 * Run with: node tests/evidencePackets.test.js
 */

import {
  makeEvidencePacket,
  makeAnalyticsEvidencePacket,
  makeVisualRef,
  validatePacket,
  validateVisualRef,
  canSupportClaim,
  packetPermits,
} from "../lib/schemas/evidencePacketSchema.js";

import {
  normalizeL5AToPacket,
  normalizeL5BToPacket,
  normalizeL5CToPacket,
  normalizeL5CVisualToVisualRef,
  normalizeAllL5ToPackets,
} from "../lib/pipeline/evidence/normalizeToPackets.js";

import {
  EvidencePacketRegistry,
  createRegistry,
} from "../lib/pipeline/evidence/evidencePacketRegistry.js";

import {
  validateSlideTraceability,
  validateClaimTraceability,
} from "../lib/pipeline/slides/validateSlideTraceability.js";

// ── Test harness ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const groups = {};
let currentGroup = "ungrouped";

function group(name) {
  currentGroup = name;
  if (!groups[name]) groups[name] = [];
}

function check(label, got, expected) {
  const ok = got === expected;
  const result = ok ? "✓" : "✗";
  if (!groups[currentGroup]) groups[currentGroup] = [];
  groups[currentGroup].push({ label, ok });
  if (ok) { passed++; }
  else { failed++; process.stdout.write(`  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    got:      ${JSON.stringify(got)}\n`); }
  return ok;
}

function assert(label, condition, note = "") {
  return check(label, condition, true);
}

function assertFalse(label, condition) {
  return check(label, condition, false);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const goodL5AItem = {
  evidence_id: "ev_src1_001",
  source_id: "src1",
  evidence_type: "exploit_demonstration",
  fact: "A working jailbreak was demonstrated against GPT-4o using nested role reversal prompts, bypassing safety guardrails.",
  source_quote: "We demonstrate that nested role reversal prompts bypass GPT-4o safety filters in 73% of test cases.",
  is_atomic: true,
  quote_verified: true,
  entities: ["GPT-4o", "OpenAI"],
  numbers: ["73%"],
  triage_data: {
    admissibility: "passed",
    evidence_strength: "strong",
    permitted_uses: ["claim_support", "case_study", "visual_support"],
    limitations: [],
  },
};

const goodSource = {
  id: "src1",
  title: "GPT-4o Jailbreak Study 2025",
  publisher: "arXiv",
  url: "https://arxiv.org/abs/2506.12345",
  date_published: "2026-04-15",
  source_type: "research_finding",
  main_category: "llm_threats",
  evidence_items: [goodL5AItem],
};

const goodL5BItem = {
  analytics_evidence_id: "ae_abc001",
  metric_type: "frequency_distribution",
  finding: "Within the collected corpus, prompt_injection is the most frequent attack vector (47 sources, 38%).",
  domain: "llm_threats",
  source_ids: ["src1", "src2", "src3"],
  metric_ids: ["threat_pattern_analytics.attack_vector_frequency"],
  confidence: "high",
  caveat_if_any: null,
  supports_claim_types: ["frequency_claim", "category_insight"],
  recommended_visualization_ids: ["attack_vector_frequency"],
};

const goodL5CItem = {
  external_evidence_id: "extev_cisa001",
  category: "llm_threats",
  evidence_type: "authoritative_statistic",
  finding: "CISA reports 45% of LLM deployments in critical infrastructure have insufficient prompt injection mitigations.",
  source_title: "CISA LLM Security Advisory 2025",
  publisher: "CISA",
  url: "https://cisa.gov/advisory/llm-2025",
  opened_url: true,
  source_quote: "45% of LLM deployments in critical infrastructure sectors lack sufficient prompt injection mitigations.",
  quote_verified: true,
  source_date: "2026-05-15",
  freshness_status: "current",
  source_quality: "authoritative",
  supports_claim_types: ["trend_claim", "frequency_claim"],
  permitted_uses: ["statistic_support", "fact_support"],
  limitations: [],
  confidence: "high",
  caveat_if_any: null,
  evidence_confidence: "high",
  needs_manual_review: false,
  statistics: [{ metric: "llm_deployment_vulnerability_rate", value: "45%", quote: "45% of LLM deployments..." }],
};

const weakL5CItem = {
  external_evidence_id: "extev_weak001",
  category: "agentic_ai_threats",
  evidence_type: "background_context",
  finding: "Some blog post claims MCP is risky.",
  publisher: "random_blog",
  url: null,           // no URL
  opened_url: false,   // not opened
  source_quality: "weak",
  confidence: "low",
  needs_manual_review: false,
  permitted_uses: [],
  limitations: ["url_not_opened"],
  evidence_confidence: "low",
  freshness_status: "unknown",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

// Group 1: Schema factory and validation
group("EvidencePacket factory + validation");

{
  const p = makeEvidencePacket({
    evidence_id: "ev_test1",
    source_id: "src1",
    evidence_type: "exploit_demonstration",
    evidence_class: "research",
    category: "llm_threats",
    claim_relevance: {
      admissibility: "passed",
      evidence_strength: "strong",
      permitted_uses: ["claim_support", "case_study"],
      limitations: [],
    },
    content: { summary: "GPT-4o jailbreak via role reversal", normalized_fact: "73% bypass rate demonstrated" },
    provenance: { title: "GPT-4o Jailbreak Study", publisher: "arXiv", url: "https://arxiv.org/abc", extraction_layer: "L5A" },
  });

  assert("factory produces evidence_id",         !!p.evidence_id);
  assert("factory produces correct evidence_type",p.evidence_type === "exploit_demonstration");
  assert("factory produces claim_relevance",      !!p.claim_relevance);
  assert("factory produces content.summary",      !!p.content.summary);
  assert("factory produces provenance",           !!p.provenance.publisher);
  assert("factory produces empty linked_claim_ids", Array.isArray(p.linked_claim_ids) && p.linked_claim_ids.length === 0);

  const errs = validatePacket(p);
  assert("valid packet produces no errors",       errs.length === 0);
}

// Group 2: AnalyticsEvidencePacket
group("AnalyticsEvidencePacket");

{
  const ap = makeAnalyticsEvidencePacket({
    evidence_id: "metric_test1",
    evidence_type: "analytics_metric",
    category: "llm_threats",
    content: { summary: "Prompt injection is most frequent", normalized_fact: "38% of vector-tagged sources" },
    provenance: {
      computation_method: "count_by_field",
      aggregation_logic:  "threat_pattern_analytics.attack_vector_frequency",
      input_evidence_ids: ["ev_src1_001", "ev_src2_001"],
      generated_at:       new Date().toISOString(),
    },
  });

  assert("analytics packet has L5B layer",      ap.provenance.extraction_layer === "L5B");
  assert("analytics packet has no source_id",   ap.source_id === null);
  assert("analytics packet has no external URL", ap.provenance.url === null);
  assert("analytics packet corpus_scoped flag",  ap.quality_flags.includes("corpus_scoped_language_required"));

  const errs = validatePacket(ap);
  assert("valid analytics packet no errors",     errs.length === 0);

  // Analytics packet missing computation_method should fail
  const badAp = makeAnalyticsEvidencePacket({
    evidence_id: "metric_bad1",
    content: { summary: "some metric" },
    provenance: { input_evidence_ids: [], aggregation_logic: "x" }, // missing computation_method
  });
  const badErrs = validatePacket(badAp);
  assert("missing computation_method fails validation", badErrs.some((e) => e.includes("computation_method")));
}

// Group 3: VisualRef
group("VisualRef factory + validation");

{
  // External figure with source_evidence_id
  const vr = makeVisualRef({
    visual_id: "fig_test1",
    type: "external_figure",
    source_url: "https://cisa.gov/advisory/figure1.png",
    source_evidence_id: "ev_test1",
    caption: "LLM vulnerability distribution 2025",
    allowed_slide_use: true,
    usage_rights_status: "known",
  });

  assert("visual has visual_id",                  !!vr.visual_id);
  assert("visual has source_evidence_id",          !!vr.source_evidence_id);
  const errs = validateVisualRef(vr);
  assert("valid external visual no errors",        errs.length === 0);

  // Visual without provenance should fail
  const badVr = makeVisualRef({ visual_id: "fig_bad1", type: "external_figure" });
  const badErrs = validateVisualRef(badVr);
  assert("visual without source or metrics fails",
    badErrs.some((e) => e.includes("no source_evidence_id or generated_from_metric_ids")));

  // Generated chart must have generated_from_metric_ids
  const genBad = makeVisualRef({ visual_id: "fig_gen1", type: "generated_chart" });
  const genErrs = validateVisualRef(genBad);
  assert("generated_chart without metric_ids fails",
    genErrs.some((e) => e.includes("generated_from_metric_ids")));
}

// Group 4: L5A normalizer
group("L5A normalizer");

{
  const packet = normalizeL5AToPacket(goodL5AItem, goodSource);

  assert("L5A packet has evidence_id",            !!packet.evidence_id);
  assert("L5A packet extraction_layer = L5A",     packet.provenance.extraction_layer === "L5A");
  assert("L5A packet has publisher",              !!packet.provenance.publisher);
  assert("L5A packet has url",                    !!packet.provenance.url);
  assert("L5A packet content.normalized_fact",    !!packet.content.normalized_fact);
  assert("L5A packet admissibility=passed",       packet.claim_relevance.admissibility === "passed");
  assert("L5A packet claim_support permitted",    packet.claim_relevance.permitted_uses.includes("claim_support"));
  assert("L5A packet canSupportClaim=true",       canSupportClaim(packet));
}

// Group 5: L5B normalizer
group("L5B normalizer");

{
  const packet = normalizeL5BToPacket(goodL5BItem);

  assert("L5B packet has evidence_id",            !!packet.evidence_id);
  assert("L5B packet extraction_layer = L5B",     packet.provenance.extraction_layer === "L5B");
  assert("L5B packet has computation_method",     !!packet.provenance.computation_method);
  assert("L5B packet has input_evidence_ids",     Array.isArray(packet.provenance.input_evidence_ids));
  assert("L5B packet corpus_scoped quality flag", packet.quality_flags.includes("corpus_scoped_language_required"));
  assert("L5B packet has visual_refs for viz IDs",packet.visual_refs.length > 0);
  assert("L5B visual_ref has generated_from_metric_ids",
    packet.visual_refs[0].generated_from_metric_ids?.length >= 0);
}

// Group 6: L5C normalizer
group("L5C normalizer");

{
  const packet = normalizeL5CToPacket(goodL5CItem);

  assert("L5C packet has evidence_id",            !!packet.evidence_id);
  assert("L5C packet extraction_layer = L5C",     packet.provenance.extraction_layer === "L5C");
  assert("L5C packet has url",                    !!packet.provenance.url);
  assert("L5C packet has publisher",              !!packet.provenance.publisher);
  assert("L5C packet admissibility=passed",       packet.claim_relevance.admissibility === "passed");

  // Weak L5C item (no opened URL, weak source) must be context_only
  const weakPacket = normalizeL5CToPacket(weakL5CItem);
  assert("weak L5C = context_only admissibility", weakPacket.claim_relevance.admissibility === "context_only");
  assertFalse("weak L5C cannot support claim",    canSupportClaim(weakPacket));
  assert("weak L5C has weak_source quality flag", weakPacket.quality_flags.includes("weak_source"));

  // L5C without URL fails validatePacket
  const errs = validatePacket(weakPacket);
  assert("L5C without url fails validation",      errs.some((e) => e.includes("provenance.url")));
}

// Group 7: EvidencePacketRegistry
group("EvidencePacketRegistry");

{
  const registry = new EvidencePacketRegistry();
  const p1 = normalizeL5AToPacket(goodL5AItem, goodSource);
  const p2 = normalizeL5BToPacket(goodL5BItem);
  const p3 = normalizeL5CToPacket(goodL5CItem);

  registry.register([p1, p2, p3]);

  assert("registry has 3 packets",               registry.size === 3);
  assert("registry resolves p1 by ID",            registry.resolve(p1.evidence_id) === p1);
  assert("registry returns null for unknown ID",  registry.resolve("ev_unknown") === null);

  const { valid, missing } = registry.validateIds([p1.evidence_id, p2.evidence_id, "ev_missing"]);
  assertFalse("validateIds with missing ID = invalid", valid);
  assert("validateIds reports missing ID",        missing.includes("ev_missing"));

  const { valid: allValid } = registry.validateIds([p1.evidence_id, p2.evidence_id]);
  assert("validateIds with all present = valid",  allValid);

  // Claim support validation
  const { unsupported_claim_ids } = registry.validateClaimSupport([
    { claim_id: "claim_001", supporting_evidence_ids: [p1.evidence_id] },  // good
    { claim_id: "claim_002", supporting_evidence_ids: ["ev_nonexistent"] }, // bad
  ]);
  assert("claim with no registry packet is unsupported", unsupported_claim_ids.includes("claim_002"));
  assertFalse("claim with valid packet is supported", unsupported_claim_ids.includes("claim_001"));
}

// Group 8: Claim writeback
group("Claim writeback (linked_claim_ids)");

{
  const registry = new EvidencePacketRegistry();
  const p1 = normalizeL5AToPacket(goodL5AItem, goodSource);
  registry.register(p1);

  registry.writeBackClaimIds([
    { claim_id: "claim_critical_001", supporting_evidence_ids: [p1.evidence_id] },
    { claim_id: "claim_high_001",     supporting_evidence_ids: [p1.evidence_id] },
  ]);

  const resolved = registry.resolve(p1.evidence_id);
  assert("packet has linked_claim_ids after writeback", resolved.linked_claim_ids.length === 2);
  assert("claim_critical_001 linked",    resolved.linked_claim_ids.includes("claim_critical_001"));
  assert("claim_high_001 linked",        resolved.linked_claim_ids.includes("claim_high_001"));
}

// Group 9: Backtracking
group("Backtracking (slide → claim → evidence → source)");

{
  const registry = new EvidencePacketRegistry();
  const p1 = normalizeL5AToPacket(goodL5AItem, goodSource);
  registry.register(p1);
  registry.writeBackClaimIds([{ claim_id: "claim_critical_001", supporting_evidence_ids: [p1.evidence_id] }]);

  const bt = registry.backtrack(p1.evidence_id);
  assert("backtrack found=true",           bt.found === true);
  assert("backtrack has claim_ids",        bt.claim_ids.includes("claim_critical_001"));
  assert("backtrack has publisher",        !!bt.provenance.publisher);
  assert("backtrack has url",              !!bt.provenance.url);
  assert("backtrack has content_summary",  !!bt.content_summary);
  assert("backtrack unknown ID found=false", registry.backtrack("ev_unknown").found === false);
}

// Group 10: Slide traceability validation
group("Slide traceability validation");

{
  const registry = new EvidencePacketRegistry();
  const p1 = normalizeL5AToPacket(goodL5AItem, goodSource);
  const p2 = normalizeL5BToPacket(goodL5BItem);
  registry.register([p1, p2]);

  // Valid slide
  const validSlide = {
    slide_id: "slide_001",
    slide_type: "critical_claim",
    claim_id: "claim_001",
    claim_type: "adoption_claim",
    supporting_evidence_ids: [p1.evidence_id],
    supporting_evidence: [{ evidence_id: p1.evidence_id }],
    evidence_callouts: [],
    external_evidence_callouts: [],
    external_visual_callouts: [],
    analytics_evidence: [],
    citations: [],
    visualization_ids: [],
  };

  const { valid } = validateSlideTraceability([validSlide], registry);
  assert("valid slide passes traceability",   valid);

  // Slide with unresolved ID
  const badSlide = {
    slide_id: "slide_002",
    slide_type: "evidence_support",
    claim_id: "claim_002",
    supporting_evidence_ids: ["ev_does_not_exist"],
    supporting_evidence: [],
    evidence_callouts: [{ evidence_id: "ev_does_not_exist_2" }],
    external_evidence_callouts: [],
    external_visual_callouts: [],
    analytics_evidence: [],
    citations: [],
    visualization_ids: [],
  };

  const badResult = validateSlideTraceability([badSlide], registry);
  assertFalse("slide with unresolved IDs fails traceability", badResult.valid);
  assert("unresolved IDs reported",    badResult.unresolved_ids.length > 0);
}

// Group 11: Visual without provenance fails
group("Visual provenance enforcement");

{
  const registry = new EvidencePacketRegistry();
  const p1 = normalizeL5AToPacket(goodL5AItem, goodSource);
  registry.register(p1);

  // Visual callout without source_url
  const slideWithBadVisual = {
    slide_id: "slide_003",
    slide_type: "case_study",
    claim_id: null,
    supporting_evidence_ids: [],
    supporting_evidence: [],
    evidence_callouts: [],
    external_evidence_callouts: [],
    external_visual_callouts: [
      {
        visualization_id: "fig_bad",
        manual_review_required: false,
        slide_usable: true,
        source_url: null,  // missing source_url
      }
    ],
    analytics_evidence: [],
    citations: [],
    visualization_ids: [],
  };

  const result = validateSlideTraceability([slideWithBadVisual], registry);
  assertFalse("slide with visual lacking source_url fails", result.valid);
  assert("error mentions source_url",
    result.errors.some((e) => e.includes("source_url")));
}

// Group 12: Full normalizeAllL5ToPackets + registry creation
group("Full L5 normalization pipeline");

{
  const allL5 = normalizeAllL5ToPackets({
    rawfactSources:    [goodSource],
    analyticsEvidence: [goodL5BItem],
    externalEvidence:  [goodL5CItem, weakL5CItem],
    externalVisuals:   [],
  });

  assert("counts.l5a = 1",              allL5.counts.l5a === 1);
  assert("counts.l5b = 1",              allL5.counts.l5b === 1);
  assert("counts.l5c = 2",              allL5.counts.l5c === 2);
  assert("total = 4",                   allL5.counts.total === 4);
  assert("byId is a Map",               allL5.byId instanceof Map);
  assert("byId has 4 entries",          allL5.byId.size === 4);

  const registry = createRegistry(allL5);
  assert("registry has 4 packets",      registry.size === 4);
  assert("registry summary has by_layer", !!registry.summary().by_layer);

  // Traceability of analytics packet (L5B IDs keep the ae_ prefix from analytics_evidence_id)
  const l5bPackets = [...allL5.byId.values()].filter((p) => p.provenance?.extraction_layer === "L5B");
  assert("analytics packet in registry",           l5bPackets.length > 0);
  const apBt = l5bPackets.length > 0 ? registry.backtrack(l5bPackets[0].evidence_id) : { provenance: {} };
  assert("analytics packet has computation_method",!!apBt.provenance?.computation_method);
  assert("analytics packet has input_evidence_ids",Array.isArray(apBt.provenance?.input_evidence_ids));
}

// ── Report ────────────────────────────────────────────────────────────────────

process.stdout.write("\n");
for (const [name, results] of Object.entries(groups)) {
  const groupPassed = results.filter((r) => r.ok).length;
  const groupTotal  = results.length;
  const status      = groupPassed === groupTotal ? "✓" : "✗";
  process.stdout.write(`  ${status} ${name} (${groupPassed}/${groupTotal})\n`);
}

process.stdout.write(`\n${"─".repeat(50)}\n`);
process.stdout.write(`  ${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);
