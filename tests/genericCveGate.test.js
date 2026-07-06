/**
 * Tests for the durable generic-CVE ingest gate + widened in-the-wild detection.
 * Pure/deterministic — no LLM.
 * Run: node --test tests/genericCveGate.test.js
 */
import assert from "node:assert/strict";
import { isGenericNoiseCve } from "../lib/pipeline/ingest/genericCveGate.js";
import { realityOf } from "../lib/pipeline/scoring/importance.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const genericCve = (extra = {}) => ({
  source_type: "vulnerability",
  category: "unclear_or_adjacent",
  trust_tier: "high",
  title: "CVE-2026-1000: SQL injection in Open WebUI",
  short_summary: "A SQL injection vulnerability in Open WebUI allows authenticated users to read the database.",
  mechanism_classification: { primary_exploit_mechanism: "generic_software_vulnerability" },
  ...extra,
});

console.log("\n── isGenericNoiseCve ──");
test("a noise-tier generic CVE in unclear is gated (discarded)", () => {
  assert.equal(isGenericNoiseCve(genericCve()), true);
});
test("an ACTIVELY-EXPLOITED generic CVE survives (realized reality → not gated)", () => {
  const exploited = genericCve({
    title: "CVE-2026-1001: SQLi in LiteLLM actively exploited in the wild",
    short_summary: "Critical pre-auth SQL injection in LiteLLM, actively exploited within hours of disclosure.",
  });
  // NB: reality is realized even though the importance TIER is noise in unclear
  // (posture=adjacent). The gate checks reality, so the exploited CVE is kept.
  assert.equal(realityOf(exploited), "realized");
  assert.equal(isGenericNoiseCve(exploited), false);
});
test("a non-generic-mechanism vuln is never gated (real AI mechanism)", () => {
  const aiVuln = genericCve({ mechanism_classification: { primary_exploit_mechanism: "prompt_injection" } });
  assert.equal(isGenericNoiseCve(aiVuln), false);
});
test("a CVE placed in a real offensive category is never gated", () => {
  const placed = genericCve({ category: "llm_threats" });
  assert.equal(isGenericNoiseCve(placed), false);
});
test("a non-vulnerability source is never gated", () => {
  const research = genericCve({ source_type: "research_finding" });
  assert.equal(isGenericNoiseCve(research), false);
});
test("reads mechanism from intelligence.mechanism_classification too (DB-row shape)", () => {
  const dbRow = {
    source_type: "vulnerability", main_category: "unclear_or_adjacent", trust_tier: "high",
    title: "CVE-2026-1002: path traversal in Flowise", short_summary: "Path traversal in Flowise.",
    intelligence: { mechanism_classification: { primary_exploit_mechanism: "generic_software_vulnerability" } },
  };
  assert.equal(isGenericNoiseCve(dbRow), true);
});

console.log("\n── widened in-the-wild detection ──");
test("'exploited within 36 hours' now upgrades a CVE to realized", () => {
  const s = { source_type: "vulnerability", title: "CVE exploited within 36 hours of disclosure", short_summary: "" };
  assert.equal(realityOf(s), "realized");
});
test("'exploited by threat actors' upgrades to realized", () => {
  const s = { source_type: "vulnerability", title: "Flaw exploited by threat actors", short_summary: "" };
  assert.equal(realityOf(s), "realized");
});
test("'mass-exploited' upgrades to realized", () => {
  const s = { source_type: "vulnerability", title: "Bug mass-exploited across the internet", short_summary: "" };
  assert.equal(realityOf(s), "realized");
});
test("a plain disclosed CVE stays disclosure (not inflated)", () => {
  const s = { source_type: "vulnerability", title: "CVE-2026-2000: SSRF in some tool", short_summary: "An SSRF was found." };
  assert.equal(realityOf(s), "disclosure");
});
test("hypothetical 'could be exploited' does NOT inflate to realized", () => {
  const s = { source_type: "vulnerability", title: "Bug that could be exploited for RCE", short_summary: "This could be exploited." };
  assert.equal(realityOf(s), "disclosure");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
