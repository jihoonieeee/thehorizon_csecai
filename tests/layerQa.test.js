/**
 * Tests for per-layer QA checkpoints (layerQa.js).
 * Run with: node tests/layerQa.test.js
 */

import assert from "node:assert/strict";
import { qaUnderstandLayer, qaEvidenceLayer, formatLayerQa } from "../lib/pipeline/layerQa.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

const findCheck = (report, name) => report.checks.find(c => c.name === name);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const goodSource = (over = {}) => ({
  id: "abc12345", title: "t", category: "llm_threats",
  primary_tags: ["LLM01_prompt_injection"], sub_techniques: [],
  is_defensive: false, defensive_techniques: [],
  short_summary: "A clear summary of an LLM prompt injection technique demonstrated.",
  ...over,
});

const goodEvidence = (over = {}) => ({
  evidence_id: "ev-abc12345-1", source_id: "abc12345", category: "llm_threats",
  fact: "Prompt injection bypassed the guardrail in test X.",
  quote: "we bypassed the filter", quote_grounded: true,
  evidence_type: "demonstrated_capability", specificity: "high",
  numbers: [], technique_tags: ["LLM01_prompt_injection"],
  ...over,
});

// ── L3 understand QA ───────────────────────────────────────────────────────────

console.log("\n── qaUnderstandLayer ──");

test("clean corpus passes", () => {
  const r = qaUnderstandLayer([goodSource(), goodSource({ id: "b", category: "agentic_ai_threats", primary_tags: ["ASI02_tool_misuse_exploitation"] })], []);
  assert.equal(r.pass, true, `expected pass, got ${r.severity}: ${JSON.stringify(r.checks.filter(c=>c.status!=="pass"))}`);
  assert.equal(r.layer, "L3_understand");
});

test("invalid category fails category_validity", () => {
  const r = qaUnderstandLayer([goodSource({ category: "not_a_domain" })], []);
  assert.equal(findCheck(r, "category_validity").status, "fail");
  assert.equal(r.pass, false);
});

test("unknown tag fails tag_taxonomy_integrity", () => {
  const r = qaUnderstandLayer([goodSource({ primary_tags: ["BOGUS99_fake"] })], []);
  assert.equal(findCheck(r, "tag_taxonomy_integrity").status, "fail");
  assert.equal(r.pass, false);
});

test("cross-domain tag warns (not fails)", () => {
  // ASI tag on an llm_threats source — valid tag, wrong domain
  const r = qaUnderstandLayer([goodSource({ category: "llm_threats", primary_tags: ["ASI02_tool_misuse_exploitation"] })], []);
  assert.equal(findCheck(r, "tag_taxonomy_integrity").status, "warn");
  assert.equal(r.pass, true);
});

test("AE overlay tag does not trigger cross-domain warning", () => {
  const r = qaUnderstandLayer([goodSource({ category: "llm_threats", primary_tags: ["LLM01_prompt_injection", "AE05_ai_malware_dev"] })], []);
  assert.equal(findCheck(r, "tag_taxonomy_integrity").status, "pass");
});

test("defensive source without defensive tag fails defensive_coherence", () => {
  const r = qaUnderstandLayer([goodSource({ is_defensive: true, primary_tags: ["LLM01_prompt_injection"], defensive_techniques: ["guardrails_and_filters"] })], []);
  assert.equal(findCheck(r, "defensive_coherence").status, "fail");
});

test("coherent defensive source passes defensive_coherence", () => {
  const r = qaUnderstandLayer([goodSource({ is_defensive: true, primary_tags: ["LLM01_prompt_injection", "defensive"], defensive_techniques: ["guardrails_and_filters"] })], []);
  assert.equal(findCheck(r, "defensive_coherence").status, "pass");
});

test("defensive source mapped to unclear_or_adjacent fails", () => {
  const r = qaUnderstandLayer([goodSource({ is_defensive: true, category: "unclear_or_adjacent", primary_tags: ["defensive"], defensive_techniques: [] })], []);
  assert.equal(findCheck(r, "defensive_coherence").status, "fail");
});

test("low survival rate warns", () => {
  const relevant = [goodSource()];
  const discarded = Array.from({ length: 50 }, (_, i) => ({ id: `d${i}` }));
  const r = qaUnderstandLayer(relevant, discarded);
  assert.equal(findCheck(r, "relevance_survival_rate").status, "warn");
});

test("missing summaries on majority warns", () => {
  const relevant = [goodSource({ short_summary: "" }), goodSource({ id: "b", short_summary: "" }), goodSource({ id: "c", short_summary: "" })];
  const r = qaUnderstandLayer(relevant, []);
  assert.equal(findCheck(r, "summary_coverage").status, "warn");
});

test("stats include by_category and survival_pct", () => {
  const r = qaUnderstandLayer([goodSource(), goodSource({ id: "b" })], [{ id: "x" }]);
  assert.equal(r.stats.relevant, 2);
  assert.equal(r.stats.discarded, 1);
  assert.ok(r.stats.by_category.llm_threats >= 1);
});

// ── L5 evidence QA ──────────────────────────────────────────────────────────────

console.log("\n── qaEvidenceLayer ──");

const fullPacks = (over = {}) => [
  { category: "llm_threats", strong: [goodEvidence()], usable: [], context: [] },
  { category: "agentic_ai_threats", strong: [goodEvidence({ category: "agentic_ai_threats" })], usable: [], context: [] },
  { category: "traditional_ai_threats", strong: [goodEvidence({ category: "traditional_ai_threats" })], usable: [], context: [] },
  { category: "ai_enabled_threats", strong: [goodEvidence({ category: "ai_enabled_threats" })], usable: [], context: [] },
  ...(over.extra || []),
];

test("well-grounded evidence passes", () => {
  const items = [goodEvidence(), goodEvidence({ evidence_id: "ev-abc12345-2" })];
  const r = qaEvidenceLayer(items, fullPacks());
  assert.equal(r.pass, true, `got ${r.severity}: ${JSON.stringify(r.checks.filter(c=>c.status!=="pass"))}`);
  assert.equal(r.layer, "L5_evidence");
});

test("empty evidence fails grounding and coverage", () => {
  const r = qaEvidenceLayer([], []);
  assert.equal(findCheck(r, "quote_grounding_rate").status, "fail");
  assert.equal(findCheck(r, "category_evidence_coverage").status, "fail");
  assert.equal(r.pass, false);
});

test("low grounding share warns", () => {
  const items = [goodEvidence({ quote_grounded: false }), goodEvidence({ quote_grounded: false }), goodEvidence({ quote_grounded: true })];
  const r = qaEvidenceLayer(items, fullPacks());
  assert.equal(findCheck(r, "quote_grounding_rate").status, "warn");
});

test("orphan numbers warn", () => {
  const items = [goodEvidence({ numbers: [{ value: "80%", context: "" }] })];
  const r = qaEvidenceLayer(items, fullPacks());
  assert.equal(findCheck(r, "number_grounding").status, "warn");
});

test("invalid technique tags warn", () => {
  const items = [goodEvidence({ technique_tags: ["NOPE00_x"] })];
  const r = qaEvidenceLayer(items, fullPacks());
  assert.equal(findCheck(r, "evidence_tag_validity").status, "warn");
});

test("partial category coverage warns", () => {
  const packs = [{ category: "llm_threats", strong: [goodEvidence()], usable: [], context: [] }];
  const r = qaEvidenceLayer([goodEvidence()], packs);
  assert.equal(findCheck(r, "category_evidence_coverage").status, "warn");
});

test("duplicate facts warn above threshold", () => {
  const items = Array.from({ length: 10 }, (_, i) => goodEvidence({ evidence_id: `ev-${i}`, fact: "identical repeated fact" }));
  const r = qaEvidenceLayer(items, fullPacks());
  assert.equal(findCheck(r, "residual_duplicate_facts").status, "warn");
});

test("stats include grounded_pct and by_specificity", () => {
  const r = qaEvidenceLayer([goodEvidence(), goodEvidence({ specificity: "low", quote_grounded: false })], fullPacks());
  assert.equal(r.stats.total_items, 2);
  assert.equal(r.stats.by_specificity.high, 1);
  assert.equal(r.stats.by_specificity.low, 1);
});

// ── formatting ──────────────────────────────────────────────────────────────────

console.log("\n── formatLayerQa ──");

test("formats a report into icon lines", () => {
  const r = qaUnderstandLayer([goodSource()], []);
  const out = formatLayerQa(r);
  assert.ok(out.includes("L3_understand"));
  assert.ok(/[✓⚠✖]/.test(out));
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
