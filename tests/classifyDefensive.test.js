/**
 * Tests for the defensive source sub-pipeline.
 * Run with: node tests/classifyDefensive.test.js
 */

import assert from "node:assert/strict";
import { splitByDefensive, classifyDefensiveSources } from "../lib/pipeline/classifyDefensive.js";
import { DEFENSIVE_TAG, DEFENSIVE_FOCUS_AREAS, DOMAINS } from "../lib/pipeline/taxonomy.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ── taxonomy ──────────────────────────────────────────────────────────────────

console.log("\n── Taxonomy: defensive constants ──");

test("DEFENSIVE_TAG is the string 'defensive'", () => {
  assert.equal(DEFENSIVE_TAG, "defensive");
});

test("DEFENSIVE_FOCUS_AREAS is a non-empty array of strings", () => {
  assert.ok(Array.isArray(DEFENSIVE_FOCUS_AREAS));
  assert.ok(DEFENSIVE_FOCUS_AREAS.length > 0);
  for (const a of DEFENSIVE_FOCUS_AREAS) assert.equal(typeof a, "string");
});

test("DEFENSIVE_FOCUS_AREAS contains expected entries", () => {
  assert.ok(DEFENSIVE_FOCUS_AREAS.includes("detection_and_monitoring"));
  assert.ok(DEFENSIVE_FOCUS_AREAS.includes("guardrails_and_filters"));
  assert.ok(DEFENSIVE_FOCUS_AREAS.includes("adversarial_training"));
  assert.ok(DEFENSIVE_FOCUS_AREAS.includes("red_teaming_and_evaluation"));
});

// ── taxonomy: false reasoning sub-technique ───────────────────────────────────

import { SUB_TECHNIQUES } from "../lib/pipeline/taxonomy.js";

console.log("\n── Taxonomy: false_reasoning_chain sub-technique ──");

test("false_reasoning_chain sub-technique exists under LLM09", () => {
  const sub = SUB_TECHNIQUES.find(s => s.id === "false_reasoning_chain");
  assert.ok(sub, "false_reasoning_chain not found in SUB_TECHNIQUES");
  assert.equal(sub.parent, "LLM09_misinformation");
});

// ── splitByDefensive ─────────────────────────────────────────────────────────

console.log("\n── splitByDefensive ──");

const makeSource = (id, is_defensive = false, category = "llm_threats") => ({
  id, title: `Source ${id}`, url: `https://example.com/${id}`,
  publisher: "Test", date_published: "2026-06-01",
  is_defensive, category,
  primary_tags: is_defensive ? [DEFENSIVE_TAG, "LLM01_prompt_injection"] : ["LLM01_prompt_injection"],
  defensive_techniques: is_defensive ? ["guardrails_and_filters"] : [],
  full_text: "some text",
});

test("all offensive sources go to offensive array", () => {
  const sources = [makeSource("a"), makeSource("b"), makeSource("c")];
  const { offensive, defensive } = splitByDefensive(sources);
  assert.equal(offensive.length, 3);
  assert.equal(defensive.length, 0);
});

test("all defensive sources go to defensive array", () => {
  const sources = [makeSource("a", true), makeSource("b", true)];
  const { offensive, defensive } = splitByDefensive(sources);
  assert.equal(offensive.length, 0);
  assert.equal(defensive.length, 2);
});

test("mixed sources split correctly", () => {
  const sources = [
    makeSource("off1"), makeSource("def1", true), makeSource("off2"), makeSource("def2", true),
  ];
  const { offensive, defensive } = splitByDefensive(sources);
  assert.equal(offensive.length, 2);
  assert.equal(defensive.length, 2);
  assert.ok(offensive.every(s => !s.is_defensive));
  assert.ok(defensive.every(s => s.is_defensive));
});

test("empty array returns empty offensive and defensive", () => {
  const { offensive, defensive } = splitByDefensive([]);
  assert.equal(offensive.length, 0);
  assert.equal(defensive.length, 0);
});

// ── classifyDefensiveSources ─────────────────────────────────────────────────

console.log("\n── classifyDefensiveSources (skipLlm) ──");

const makeDefSource = (id, category = "llm_threats", techniques = ["guardrails_and_filters"]) => ({
  id, title: `Defensive Source ${id}`,
  url: `https://example.com/def/${id}`,
  publisher: "OWASP", date_published: "2026-06-01",
  is_defensive: true, category,
  defended_category: category,
  primary_tags: [DEFENSIVE_TAG, "LLM01_prompt_injection"],
  defensive_techniques: techniques,
  full_text: "Mitigations for prompt injection include input sanitization and output filtering.",
  short_summary: "Guide to mitigating prompt injection attacks.",
});

await testAsync("empty input returns empty classified and zero counts", async () => {
  const { classified, qa_report, counts } = await classifyDefensiveSources([], { skipLlm: true });
  assert.equal(classified.length, 0);
  assert.equal(qa_report.length, 0);
  assert.equal(counts.total, 0);
});

await testAsync("skipLlm: classifies without LLM enrichment", async () => {
  const sources = [makeDefSource("d1"), makeDefSource("d2")];
  const { classified, qa_report, counts } = await classifyDefensiveSources(sources, { skipLlm: true });
  assert.equal(classified.length, 2);
  assert.equal(qa_report.length, 2);
  assert.equal(counts.total, 2);
  assert.equal(counts.enriched, 0, "no enrichment in skipLlm mode");
});

await testAsync("skipLlm: QA passes for well-formed defensive sources", async () => {
  const sources = [makeDefSource("d1")];
  const { qa_report, counts } = await classifyDefensiveSources(sources, { skipLlm: true });
  assert.equal(counts.qa_pass, 1, "well-formed source should pass QA");
  assert.equal(counts.qa_fail, 0);
  assert.ok(qa_report[0].pass, `expected pass, got issues: ${qa_report[0].issues.join(", ")}`);
});

await testAsync("QA flags missing defensive tag", async () => {
  const src = { ...makeDefSource("d1"), primary_tags: ["LLM01_prompt_injection"] };
  const { qa_report, counts } = await classifyDefensiveSources([src], { skipLlm: true });
  assert.equal(counts.qa_fail, 1);
  assert.ok(qa_report[0].issues.some(i => i.includes("defensive")));
});

await testAsync("QA flags unclear_or_adjacent category", async () => {
  const src = { ...makeDefSource("d1"), category: "unclear_or_adjacent", defended_category: "unclear_or_adjacent" };
  const { qa_report } = await classifyDefensiveSources([src], { skipLlm: true });
  assert.ok(qa_report[0].issues.some(i => i.includes("unclear_or_adjacent")));
});

await testAsync("QA warns (not fails) on missing defensive_techniques", async () => {
  const src = { ...makeDefSource("d1"), defensive_techniques: [] };
  const { qa_report, counts } = await classifyDefensiveSources([src], { skipLlm: true });
  // Missing optional enrichment is a soft warning — must NOT fail the source.
  assert.equal(qa_report[0].pass, true, "missing techniques should not hard-fail");
  assert.ok(qa_report[0].warnings.some(w => w.includes("defensive_techniques")));
  assert.equal(counts.qa_warn, 1);
});

await testAsync("defensive sources across all 4 domains all pass QA", async () => {
  const OFFENSIVE_DOMAINS = DOMAINS.filter(d => d !== "unclear_or_adjacent");
  const sources = OFFENSIVE_DOMAINS.map((d, i) => makeDefSource(`d${i}`, d));
  const { counts, qa_report } = await classifyDefensiveSources(sources, { skipLlm: true });
  const failures = qa_report.filter(r => !r.pass);
  assert.equal(failures.length, 0, `unexpected QA failures: ${failures.map(r => r.issues).join("; ")}`);
  assert.equal(counts.qa_pass, OFFENSIVE_DOMAINS.length);
});

await testAsync("classified sources preserve original fields", async () => {
  const src = makeDefSource("d1");
  const { classified } = await classifyDefensiveSources([src], { skipLlm: true });
  assert.equal(classified[0].id, src.id);
  assert.equal(classified[0].category, src.category);
  assert.ok(classified[0].primary_tags.includes(DEFENSIVE_TAG));
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
