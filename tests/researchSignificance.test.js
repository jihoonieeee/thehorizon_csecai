/**
 * Tests for the research significance overlay.
 * All pure/deterministic except assessSignificance, tested with an injected llmFn.
 * Run: node --test tests/researchSignificance.test.js
 */
import assert from "node:assert/strict";
import {
  isSignificanceEligible, significanceRank, validateSignificance,
  assessSignificance, makeRankedComparator, SIGNIFICANCE_RANK,
} from "../lib/pipeline/researchSignificance.js";

let passed = 0, failed = 0;
function test(name, fn) {
  const done = (p) => Promise.resolve(p).then(
    () => { console.log(`  ✓ ${name}`); passed++; },
    (e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; });
  return done((async () => fn())());
}

// ── eligibility ───────────────────────────────────────────────────────────────
console.log("\n── eligibility ──");
await test("research_finding is eligible", () => assert.equal(isSignificanceEligible({ source_type: "research_finding" }), true));
await test("benchmark_evaluation is eligible", () => assert.equal(isSignificanceEligible({ source_type: "benchmark_evaluation" }), true));
await test("incident / CVE are NOT eligible (ranked by real-world reality, not novelty)", () => {
  assert.equal(isSignificanceEligible({ source_type: "incident" }), false);
  assert.equal(isSignificanceEligible({ source_type: "vulnerability" }), false);
});

// ── validateSignificance ──────────────────────────────────────────────────────
console.log("\n── validateSignificance ──");
await test("landmark + opens_new_attack_surface passes through, derives opens_new_surface", () => {
  const v = validateSignificance({ level: "landmark", novelty: "opens_new_attack_surface", reason: "guardrail is the target" });
  assert.equal(v.level, "landmark");
  assert.equal(v.opens_new_surface, true);
});
await test("garbage level/novelty coerce to the CONSERVATIVE floor (never inflates)", () => {
  const v = validateSignificance({ level: "world-changing", novelty: "amazing", reason: "x" });
  assert.equal(v.level, "routine");
  assert.equal(v.novelty, "incremental_improvement");
  assert.equal(v.opens_new_surface, false);
});
await test("scored_at attaches when provided", () => {
  const v = validateSignificance({ level: "notable", novelty: "new_technique", reason: "x" }, { scoredAt: "2026-07-06T00:00:00Z" });
  assert.equal(v.scored_at, "2026-07-06T00:00:00Z");
});

// ── significanceRank ──────────────────────────────────────────────────────────
console.log("\n── significanceRank ──");
await test("reads intelligence.significance.level", () => {
  assert.equal(significanceRank({ intelligence: { significance: { level: "landmark" } } }), 3);
  assert.equal(significanceRank({ intelligence: { significance: { level: "incremental" } } }), 0);
});
await test("unscored / ineligible → rank 0 (falls back to importance tier only)", () => {
  assert.equal(significanceRank({}), 0);
  assert.equal(significanceRank({ intelligence: {} }), 0);
});

// ── assessSignificance (injected llmFn) ───────────────────────────────────────
console.log("\n── assessSignificance ──");
await test("returns null for an ineligible source (no LLM spent)", async () => {
  let called = false;
  const spy = async () => { called = true; return {}; };
  const r = await assessSignificance({ source_type: "incident" }, { llmFn: spy });
  assert.equal(r, null);
  assert.equal(called, false);
});
await test("throws for an eligible source with no llmFn", async () => {
  await assert.rejects(() => assessSignificance({ source_type: "research_finding" }, {}), /requires opts\.llmFn/);
});
await test("assesses an eligible source via injected llmFn", async () => {
  const fake = async () => ({ level: "landmark", novelty: "opens_new_attack_surface", transferability: "high", reason: "guardrails become a DoS surface" });
  const r = await assessSignificance(
    { source_type: "research_finding", title: "From Shield to Target: DoS on LLM guardrails" },
    { llmFn: fake, scoredAt: "2026-07-06T00:00:00Z" });
  assert.equal(r.level, "landmark");
  assert.equal(r.opens_new_surface, true);
  assert.equal(r.scored_at, "2026-07-06T00:00:00Z");
});

// ── makeRankedComparator: importance primary, significance secondary ──────────
console.log("\n── makeRankedComparator ──");
const tierRank = { realized: 5, proven: 4, research: 3, reference: 2, noise: 1 };
const impRankOf = (s) => tierRank[s.intelligence?.importance?.tier] || 0;
const mk = (tier, level, date) => ({ intelligence: { importance: { tier }, significance: level ? { level } : undefined }, date_published: date });

await test("importance tier dominates significance", () => {
  const cmp = makeRankedComparator(impRankOf);
  const proven_routine = mk("proven", "routine", "2026-01-01");
  const research_landmark = mk("research", "landmark", "2026-06-01");
  assert.ok(cmp(proven_routine, research_landmark) < 0, "proven ranks before research regardless of significance");
});
await test("within the SAME tier, landmark beats routine (this is the fix)", () => {
  const cmp = makeRankedComparator(impRankOf);
  const landmark = mk("research", "landmark", "2026-01-01");
  const routine  = mk("research", "routine",  "2026-06-01");
  assert.ok(cmp(landmark, routine) < 0, "landmark research ranks before routine research even though it's older");
});
await test("same tier + same significance → newer first", () => {
  const cmp = makeRankedComparator(impRankOf);
  const older = mk("research", "notable", "2026-01-01");
  const newer = mk("research", "notable", "2026-06-01");
  assert.ok(cmp(newer, older) < 0);
});

setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}, 50);
