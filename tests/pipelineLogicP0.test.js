/**
 * Regression tests for the pipeline-logic audit P0 fixes
 * (docs/audits/pipeline-logic-critical-audit.md §17).
 *
 *   P0-1 chatbot claim-QA parity + grounding label   (lib/agent/answerGrounding.js)
 *   P0-2 run-level corpus representativeness gate     (lib/pipeline/analysis/runCorpusAudit.js)
 *   P0-3 web-discovery anchor-bearing quote gate      (triageCandidates / candidateGates)
 *   P0-4 non-English fidelity detection               (validation/sourceValidity.js)
 *
 * Run with: node tests/pipelineLogicP0.test.js
 */

import assert from "node:assert/strict";
import {
  assessOverclaim, applyConfidenceCap, GROUNDING_BY_ROUTE, mergeCaveat,
} from "../lib/agent/answerGrounding.js";
import {
  buildRunCorpusAudit, applyCorpusCapToCrossCategory, capConfidenceByCorpus,
} from "../lib/pipeline/analysis/runCorpusAudit.js";
import { routeCandidate, triageCandidateDeterministic } from "../lib/pipeline/discovery/triageCandidates.js";
import { checkSourceValidity } from "../lib/pipeline/validation/sourceValidity.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

// ── P0-1 — chatbot overclaim guard + grounding label ───────────────────────────
console.log("P0-1 — chatbot overclaim guard + grounding");

const researchCtx = { claims: [
  { source_type: "research_finding", publisher: "arXiv" },
  { source_type: "benchmark_evaluation", publisher: "arXiv" },
] };
const operationalCtx = { claims: [
  { source_type: "incident", publisher: "CISA" },
  { source_type: "threat_intelligence", publisher: "Mandiant" },
] };

test("adoption query over a research-only corpus is guarded + capped to low", () => {
  const g = assessOverclaim("are adversaries using prompt injection in the wild?", researchCtx);
  assert.equal(g.must_guard, true);
  assert.ok(g.directive && /do not/i.test(g.directive));
  assert.equal(g.confidence_cap, "low");
  assert.ok(g.caveat && /operational/i.test(g.caveat));
});

test("adoption query over an operational corpus is NOT guarded", () => {
  const g = assessOverclaim("are adversaries using prompt injection in the wild?", operationalCtx);
  assert.equal(g.must_guard, false);
  assert.equal(g.confidence_cap, null);
});

test("trend query with <2 independent origins is guarded", () => {
  const g = assessOverclaim("is prompt injection increasing?", { claims: [{ source_type: "incident", publisher: "CISA" }] });
  assert.equal(g.must_guard, true);
  assert.equal(g.confidence_cap, "low");
});

test("applyConfidenceCap lowers high→low and leaves low alone", () => {
  assert.equal(applyConfidenceCap("high", "low"), "low");
  assert.equal(applyConfidenceCap("low", "moderate"), "low");
  assert.equal(applyConfidenceCap("high", null), "high");
});

test("every route has a grounding label and mergeCaveat dedupes", () => {
  for (const r of ["analytical","evidence_lookup","raw_sources","timeline","attack_vector","general","web_search","distribution"]) {
    assert.ok(GROUNDING_BY_ROUTE[r], `missing grounding for ${r}`);
  }
  assert.equal(mergeCaveat("a", "a"), "a");
  assert.equal(mergeCaveat("a", "b"), "a b");
  assert.equal(mergeCaveat(null, "b"), "b");
});

// ── P0-2 — run-level corpus representativeness ─────────────────────────────────
console.log("P0-2 — run-level corpus audit");

function src(over) {
  return { source_type: "research_finding", publisher: "arXiv", trust_tier: "high", main_category: "llm_threats", date_published: "2026-05-01", ...over };
}

test("research-heavy, no-operational, single-publisher corpus → insufficient + cap low", () => {
  const sources = Array.from({ length: 8 }, () => src({}));  // all arXiv research, one month
  const a = buildRunCorpusAudit(sources);
  assert.equal(a.corpus_confidence, "insufficient");
  assert.equal(a.confidence_cap, "low");
  assert.ok(a.flags.includes("operational_evidence_absent"));
  assert.ok(a.limitations.length > 0);
});

test("balanced corpus → sufficient + no cap", () => {
  const sources = [
    src({ source_type: "incident", publisher: "CISA", trust_tier: "primary", origin_role: "primary_origin", main_category: "llm_threats", date_published: "2026-04-02" }),
    src({ source_type: "incident", publisher: "NCSC", trust_tier: "primary", origin_role: "primary_origin", main_category: "agentic_ai_threats", date_published: "2026-05-03" }),
    src({ source_type: "threat_intelligence", publisher: "Mandiant", main_category: "ai_enabled_threats", date_published: "2026-05-10" }),
    src({ source_type: "research_finding", publisher: "arXiv", main_category: "traditional_ai_threats", date_published: "2026-04-15" }),
    src({ source_type: "vulnerability", publisher: "NVD", trust_tier: "primary", origin_role: "primary_origin", main_category: "llm_threats", date_published: "2026-05-20" }),
    src({ source_type: "incident", publisher: "Recorded Future", main_category: "agentic_ai_threats", date_published: "2026-04-22" }),
    src({ source_type: "research_finding", publisher: "USENIX", main_category: "traditional_ai_threats", date_published: "2026-05-05" }),
    src({ source_type: "advisory", publisher: "CISA", trust_tier: "primary", origin_role: "primary_origin", main_category: "ai_enabled_threats", date_published: "2026-04-28" }),
    src({ source_type: "incident", publisher: "Microsoft", main_category: "llm_threats", date_published: "2026-05-12" }),
    src({ source_type: "threat_intelligence", publisher: "Google", main_category: "agentic_ai_threats", date_published: "2026-04-18" }),
  ];
  const a = buildRunCorpusAudit(sources);
  assert.equal(a.corpus_confidence, "sufficient");
  assert.equal(a.confidence_cap, null);
});

test("applyCorpusCapToCrossCategory caps an over-confident exec judgment", () => {
  const audit = { corpus_confidence: "insufficient", confidence_cap: "low", scope_note: "scoped." };
  const cross = {
    executive_summary: { headline: "x", key_judgments: [{ judgment: "j", confidence: "high", supporting_evidence_ids: ["e1"] }] },
    cross_category_patterns: [{ pattern: "p", confidence: "high" }],
    overall_biggest_happenings: [], overall_early_signals: [],
    strategic_outlook: { statement: "s", confidence: "high" },
  };
  const out = applyCorpusCapToCrossCategory(cross, audit);
  assert.equal(out.executive_summary.key_judgments[0].confidence, "low");
  assert.equal(out.cross_category_patterns[0].confidence, "low");
  assert.equal(out.strategic_outlook.confidence, "low");
  assert.ok(out.strategic_outlook.caveat_if_any.includes("scoped"));
  assert.equal(capConfidenceByCorpus("high", audit), "low");
});

// ── P0-3 — web-discovery anchor-bearing quote gate ─────────────────────────────
console.log("P0-3 — web-discovery anchor-bearing quote gate");

const baseCand = {
  opened_url_confirmed: true, hallucination_risk: "low", ai_threat_specificity: "moderate",
  quote_claim_match_status: "unverified", quote_status: "present",
  freshness_status: "current",
  freshness_class: "current",  // required since routeCandidate now uses freshness_class
  is_cluster_representative: true,
};

test("present-but-non-anchor-bearing quote with empty claim → accept_with_review", () => {
  const r = routeCandidate({ ...baseCand, quote_anchor_bearing: false });
  assert.equal(r.route, "accept_with_review");
  assert.equal(r.route_reason, "quote_present_but_not_anchor_bearing");
});

test("anchor-bearing quote → accept_evidence_candidate or accept_high_priority (gate skipped)", () => {
  const r = routeCandidate({ ...baseCand, quote_anchor_bearing: true });
  // Route vocabulary was expanded: plain "accept" is now "accept_evidence_candidate"
  assert.ok(
    r.route === "accept_evidence_candidate" || r.route === "accept_high_priority",
    `expected accept_evidence_candidate or accept_high_priority, got: ${r.route}`
  );
});

test("triageCandidateDeterministic computes quote_anchor_bearing from the quote", () => {
  const anchored = triageCandidateDeterministic({ ...baseCand, verbatim_quote: "Researchers demonstrated a prompt injection bypass against GPT-4." });
  assert.equal(anchored.quote_anchor_bearing, true);
  assert.ok(
    anchored.route === "accept_evidence_candidate" || anchored.route === "accept_high_priority",
    `expected accept route, got: ${anchored.route}`
  );

  const boilerplate = triageCandidateDeterministic({ ...baseCand, verbatim_quote: "Welcome to our blog. Please subscribe for our latest updates and offers." });
  assert.equal(boilerplate.quote_anchor_bearing, false);
  assert.equal(boilerplate.route, "accept_with_review");
});

// ── P0-4 — non-English fidelity detection ──────────────────────────────────────
console.log("P0-4 — non-English detection");

test("Latin-script Spanish source is flagged non-English (was passing as English)", () => {
  const v = checkSourceValidity({
    title: "Nuevo ataque de inyección de prompts en modelos de lenguaje",
    url: "https://example.es/articulo",
    full_text: "El nuevo ataque de inyección de prompts permite a los atacantes eludir las salvaguardas del modelo de lenguaje en la mayoría de los casos cuando se utiliza una secuencia especialmente diseñada.",
  });
  assert.equal(v.detected_language, "non_english");
  assert.ok(v.filter_flags.includes("possible_non_english"));
});

test("code-heavy English source is NOT flagged non-English", () => {
  const v = checkSourceValidity({
    title: "Mitigating prompt injection in the agent loop",
    url: "https://example.com/post",
    full_text: "The function returns the value of x. for (let i = 0; i < n; i++) { arr[i] = compute(i); } The algorithm has O(n) complexity and is the standard approach used by the defenders in this analysis.",
  });
  assert.equal(v.detected_language, "en");
  assert.ok(!v.filter_flags.includes("possible_non_english"));
});

test("ordinary English source is detected as English", () => {
  const v = checkSourceValidity({
    title: "Prompt injection bypasses guardrails",
    url: "https://example.com/x",
    full_text: "Researchers found that the attack is able to bypass the guardrails of the model in most of the tested cases and that this has implications for defenders.",
  });
  assert.equal(v.detected_language, "en");
});

console.log("\n──────────────────────────────────────────────────");
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
