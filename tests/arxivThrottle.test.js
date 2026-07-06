/**
 * Tests for the arXiv corpus-share throttle (pure scale function).
 * Run: node tests/arxivThrottle.test.js
 */
import assert from "node:assert/strict";
import { arxivShareScale, ARXIV_SHARE_TARGET } from "../lib/pipeline/ingest/connectors/arxivConnector.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log("\n── arxivShareScale ──");
test("at/under target → full intake (1.0)", () => {
  assert.equal(arxivShareScale(0.10), 1);
  assert.equal(arxivShareScale(ARXIV_SHARE_TARGET), 1);
});
test("over target → throttled proportionally (target/share)", () => {
  assert.equal(arxivShareScale(0.40), 0.5);          // 20/40
  assert.ok(Math.abs(arxivShareScale(0.62) - 0.32) < 0.01);
});
test("never fully off — always ≥ 0.2 floor", () => {
  assert.equal(arxivShareScale(0.80), 0.25);
  assert.ok(arxivShareScale(0.99) >= 0.2);           // 20/99 ≈ 0.202, above the floor
  assert.ok(arxivShareScale(0.62) >= 0.2);
});
test("monotonic: higher share → lower or equal scale", () => {
  const shares = [0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 0.99];
  for (let i = 1; i < shares.length; i++) {
    assert.ok(arxivShareScale(shares[i]) <= arxivShareScale(shares[i - 1]),
      `scale should not increase as share rises (${shares[i]})`);
  }
});
test("degenerate inputs → full intake (never blocks ingestion)", () => {
  assert.equal(arxivShareScale(0), 1);
  assert.equal(arxivShareScale(null), 1);
  assert.equal(arxivShareScale(NaN), 1);
});
test("custom target respected", () => {
  assert.equal(arxivShareScale(0.30, 0.30), 1);      // at custom target
  assert.equal(arxivShareScale(0.60, 0.30), 0.5);    // 2x custom target
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
