/**
 * URL-variant folding tests — arXiv abs/pdf/html + version collapse to one
 * canonical URL, so in-batch dedup and the source ID treat them as one source.
 * Run with: node tests/urlCanonical.test.js
 */

import assert from "node:assert/strict";
import { foldUrlVariants } from "../lib/utils/urlCanonical.js";
import { dedupeSources } from "../lib/utils/dedupe.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

const ABS = "https://arxiv.org/abs/2509.10540";

console.log("\nfoldUrlVariants — arXiv");

test("/pdf/ folds to /abs/", () => {
  assert.equal(foldUrlVariants("https://arxiv.org/pdf/2509.10540"), ABS);
});
test("/html/ + version folds to /abs/ (no version)", () => {
  assert.equal(foldUrlVariants("https://arxiv.org/html/2509.10540v2"), ABS);
});
test("/abs/ + version strips the version", () => {
  assert.equal(foldUrlVariants("https://arxiv.org/abs/2509.10540v1"), ABS);
});
test("trailing .pdf is stripped", () => {
  assert.equal(foldUrlVariants("https://arxiv.org/pdf/2509.10540v1.pdf"), ABS);
});
test("www. host still folds", () => {
  assert.equal(foldUrlVariants("https://www.arxiv.org/pdf/2509.10540"), ABS);
});
test("old-style archive/class id folds", () => {
  assert.equal(foldUrlVariants("https://arxiv.org/pdf/cs/0112017v1"), "https://arxiv.org/abs/cs/0112017");
});
test("already-canonical /abs/ is unchanged", () => {
  assert.equal(foldUrlVariants(ABS), ABS);
});
test("non-arxiv URL is untouched", () => {
  const u = "https://redcanary.com/blog/news-events/cfp-tracker-october-2025";
  assert.equal(foldUrlVariants(u), u);
});
test("arxiv non-paper path (e.g. /list/) is untouched", () => {
  const u = "https://arxiv.org/list/cs.CR/recent";
  assert.equal(foldUrlVariants(u), u);
});
test("garbage / empty input does not throw", () => {
  assert.equal(foldUrlVariants(""), "");
  assert.equal(foldUrlVariants("not a url"), "not a url");
});

console.log("\ndedupeSources — arXiv variants collapse in-batch");

test("abs + pdf + html of the same paper dedupe to one, keeping richest text", () => {
  const out = dedupeSources([
    { id: "a", url: "https://arxiv.org/abs/2509.10540v1",  title: "EchoLeak zero-click prompt injection study", trust_tier: "high", full_text: "short" },
    { id: "b", url: "https://arxiv.org/pdf/2509.10540",     title: "EchoLeak zero-click prompt injection study", trust_tier: "high", full_text: "x".repeat(4000) },
    { id: "c", url: "https://arxiv.org/html/2509.10540v2",  title: "EchoLeak zero-click prompt injection study", trust_tier: "high", full_text: "medium text body" },
  ]);
  assert.equal(out.length, 1, `expected 1 row, got ${out.length}`);
  assert.equal(out[0].id, "b", "should keep the row with the richest full_text");
});

test("two genuinely different arxiv papers are NOT merged", () => {
  const out = dedupeSources([
    { id: "a", url: "https://arxiv.org/abs/2509.10540", title: "Paper one about prompt injection attacks", trust_tier: "high", full_text: "aaaa" },
    { id: "b", url: "https://arxiv.org/pdf/2602.11495", title: "Paper two about jailbreak trace detection", trust_tier: "high", full_text: "bbbb" },
  ]);
  assert.equal(out.length, 2);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
