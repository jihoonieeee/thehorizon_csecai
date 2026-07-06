/**
 * Tests for the categorical source label (critical/important/supporting/archive).
 * Pure/deterministic. Run: node tests/sourceLabel.test.js
 */
import assert from "node:assert/strict";
import { labelOf, labelRank } from "../lib/pipeline/scoring/sourceLabel.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const incident   = () => ({ source_type: "incident", trust_tier: "high", main_category: "ai_enabled_threats", title: "X exploited in the wild" });
const proven     = () => ({ source_type: "exploit_disclosure", trust_tier: "high", main_category: "llm_threats" });
const landmark   = () => ({ source_type: "research_finding", trust_tier: "high", main_category: "agentic_ai_threats", intelligence: { significance: { level: "landmark" } } });
const notable    = () => ({ source_type: "research_finding", trust_tier: "high", main_category: "llm_threats", intelligence: { significance: { level: "notable" } } });
const routine    = () => ({ source_type: "research_finding", trust_tier: "high", main_category: "llm_threats" });
const report     = () => ({ source_type: "threat_intelligence", trust_tier: "primary", main_category: "ai_enabled_threats", is_digest: true, intelligence: { digest_item_count: 20 } });
const genericCve = () => ({ source_type: "vulnerability", trust_tier: "high", main_category: "unclear_or_adjacent" });
const finding    = () => ({ source_type: "incident", trust_tier: "high", main_category: "llm_threats", intelligence: { report_finding: { importance_label: "critical" } } });

console.log("\n── labelOf ──");
test("realized incident (in the wild) → critical", () => assert.equal(labelOf(incident()), "critical"));
test("landmark research → critical (first public report)", () => assert.equal(labelOf(landmark()), "critical"));
test("authoritative multi-finding report → critical", () => assert.equal(labelOf(report()), "critical"));
test("proven exploit → important", () => assert.equal(labelOf(proven()), "important"));
test("notable research → important", () => assert.equal(labelOf(notable()), "important"));
test("routine research → supporting", () => assert.equal(labelOf(routine()), "supporting"));
test("generic CVE in unclear (noise) → archive", () => assert.equal(labelOf(genericCve()), "archive"));
test("explicit report_finding.importance_label is authoritative", () => assert.equal(labelOf(finding()), "critical"));
test("labelRank orders critical > important > supporting > archive", () => {
  assert.ok(labelRank(incident()) > labelRank(proven()));
  assert.ok(labelRank(proven()) > labelRank(routine()));
  assert.ok(labelRank(routine()) > labelRank(genericCve()));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
