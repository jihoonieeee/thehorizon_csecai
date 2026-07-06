/**
 * Tests for landmark gap detection + targeted search directives (Phase 3).
 * Run: node --test tests/landmarkGaps.test.js
 */
import assert from "node:assert/strict";
import {
  detectLandmarkGaps, detectAllLandmarkGaps, buildSearchDirectives, directiveForTopic,
} from "../lib/pipeline/scoring/landmarkGaps.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log("\n── gap detection ──");
test("covered topic is not reported missing", () => {
  const missing = detectLandmarkGaps("LLM11_jailbreak_safety_bypass", [
    { title: "A new adversarial suffix attack", short_summary: "roleplay jailbreak too" },
  ]);
  assert.ok(!missing.includes("adversarial suffix"));
  assert.ok(!missing.includes("roleplay jailbreak"));
  assert.ok(missing.includes("audio jailbreak"));
});

test("empty corpus → all topics missing", () => {
  const missing = detectLandmarkGaps("LLM01_prompt_injection", []);
  assert.equal(missing.length > 0, true);
});

test("detectAllLandmarkGaps groups by tag", () => {
  const gaps = detectAllLandmarkGaps([
    { tags: ["LLM11_jailbreak_safety_bypass"], title: "adversarial suffix", short_summary: "" },
  ]);
  assert.ok(!gaps.LLM11_jailbreak_safety_bypass.includes("adversarial suffix"));
});

console.log("\n── directive routing ──");
test("framework/supply-chain topic → github_advisory", () => {
  const d = directiveForTopic("TAI10_ai_supply_chain_compromise", "malicious LoRA adapter");
  assert.equal(d.provider, "github_advisory");
});
test("AI-enabled operational topic → tavily", () => {
  const d = directiveForTopic("AE02_ai_social_engineering", "AI-assisted phishing campaign");
  assert.equal(d.provider, "tavily");
});
test("research attack topic → arxiv", () => {
  const d = directiveForTopic("TAI06_model_inversion", "gradient inversion");
  assert.equal(d.provider, "arxiv");
  assert.ok(d.query.includes("gradient inversion"));
});
test("buildSearchDirectives dedups topics shared across tags", () => {
  const dirs = buildSearchDirectives({
    LLM02_sensitive_info_disclosure: ["embedding inversion"],
    LLM08_vector_embedding_weakness: ["embedding inversion"],
  });
  assert.equal(dirs.length, 1, "shared topic should appear once");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
