/**
 * Tests for the combined source-signal ranking used by dashboard insight-gen.
 * Pure/deterministic — no LLM.
 * Run: node --test tests/sourceSignal.test.js
 */
import assert from "node:assert/strict";
import {
  sourceSignalScore, isNoiseSource, bySignalThenRecency, partitionBySignal,
} from "../lib/pipeline/sourceSignal.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// Helpers to build source rows that computeImportance/significanceRank understand.
const incident   = (trust = "high") => ({ source_type: "incident", trust_tier: trust });          // realized
const proven     = (trust = "high") => ({ source_type: "exploit_disclosure", trust_tier: trust }); // proven
const research   = (sig, trust = "high") => ({
  source_type: "research_finding", trust_tier: trust,
  intelligence: sig ? { significance: { level: sig } } : {},
});                                                                                                 // research
const cve        = (trust = "high") => ({ source_type: "vulnerability", trust_tier: trust });      // disclosure→noise-ish

console.log("\n── sourceSignalScore ordering ──");
test("realized incident outranks any research paper (reality dominates)", () => {
  assert.ok(sourceSignalScore(incident()) > sourceSignalScore(research("landmark")),
    `incident=${sourceSignalScore(incident())} vs landmark=${sourceSignalScore(research("landmark"))}`);
});
test("landmark research outranks routine research (significance lifts within a band)", () => {
  assert.ok(sourceSignalScore(research("landmark")) > sourceSignalScore(research("routine")));
});
test("notable research outranks unscored research", () => {
  assert.ok(sourceSignalScore(research("notable")) > sourceSignalScore(research(null)));
});
test("higher trust lifts an otherwise-equal source", () => {
  assert.ok(sourceSignalScore(incident("primary")) > sourceSignalScore(incident("low")));
});
test("significance never leapfrogs a whole reality band (landmark research < proven exploit)", () => {
  assert.ok(sourceSignalScore(research("landmark")) < sourceSignalScore(proven()),
    `landmark=${sourceSignalScore(research("landmark"))} should be < proven=${sourceSignalScore(proven())}`);
});

console.log("\n── isNoiseSource ──");
test("a bare CVE (disclosure tier) with no significance is noise", () => {
  assert.equal(isNoiseSource(cve()), true);
});
test("a realized incident is never noise", () => {
  assert.equal(isNoiseSource(incident()), false);
});
test("a landmark research paper is NEVER noise even if its tier is low", () => {
  // research tier maps to 'research' not 'noise', but assert the significance rescue explicitly:
  const lowResearch = { source_type: "research_finding", trust_tier: "low", intelligence: { significance: { level: "landmark" } } };
  assert.equal(isNoiseSource(lowResearch), false);
});

console.log("\n── partitionBySignal ──");
test("splits noise from signal and sorts each strongest-first", () => {
  const rows = [
    research("routine", "low"),        // weak
    incident("primary"),               // strongest
    cve("medium"),                     // noise
    research("landmark", "high"),      // strong
  ];
  const { signal, noise } = partitionBySignal(rows);
  assert.ok(noise.every(isNoiseSource), "noise bucket only holds noise");
  assert.ok(signal.length >= 2);
  // strongest signal source first
  assert.equal(signal[0].source_type, "incident");
  // signal sorted descending
  for (let i = 1; i < signal.length; i++) {
    assert.ok(sourceSignalScore(signal[i - 1]) >= sourceSignalScore(signal[i]), "signal sorted desc");
  }
});
test("bySignalThenRecency breaks ties by date", () => {
  const a = { ...incident(), date_published: "2026-06-01" };
  const b = { ...incident(), date_published: "2026-01-01" };
  assert.ok(bySignalThenRecency(a, b) < 0, "newer first when signal equal");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
