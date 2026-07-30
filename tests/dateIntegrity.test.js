/**
 * validateDateIntegrity — unit tests.
 * Covers all three corruption rules + clean cases. No network.
 *
 * Run with: node tests/dateIntegrity.test.js
 */

import assert from "node:assert/strict";
import { validateDateIntegrity } from "../lib/pipeline/ingest/eligibilityFlags.js";
import { upgradeDate } from "../lib/pipeline/ingest/upgradeDate.js";
import { extractPublishDateFromHtml } from "../lib/pipeline/ingest/connectors/registryFeedConnector.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

const now     = new Date().toISOString();
const collect = now;  // collected right now

// Helpers
const src = (overrides) => ({
  date_published:  null,
  date_confidence: "exact",
  date_collected:  collect,
  ...overrides,
});

// ── Rule 1: future date ───────────────────────────────────────────────────────
console.log("\nvalidateDateIntegrity — future date");

test("date 2 days ahead → nulled, confidence=none, needs_review", () => {
  const future = new Date(Date.now() + 2 * 86400000).toISOString();
  const r = validateDateIntegrity(src({ date_published: future, date_confidence: "exact" }));
  assert.ok(r, "expected a patch");
  assert.equal(r.date_integrity_issue, "future_date");
  assert.equal(r.date_published, null);
  assert.equal(r.date_confidence, "none");
  assert.equal(r.needs_review, true);
});

test("date exactly 1 day ahead → no patch (within tolerance)", () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  assert.equal(validateDateIntegrity(src({ date_published: tomorrow })), null);
});

test("future date with estimated confidence → still nulled", () => {
  const future = new Date(Date.now() + 2 * 86400000).toISOString();
  const r = validateDateIntegrity(src({ date_published: future, date_confidence: "estimated" }));
  assert.ok(r);
  assert.equal(r.date_integrity_issue, "future_date");
});

// ── Rule 2: collection-bleed ──────────────────────────────────────────────────
console.log("\nvalidateDateIntegrity — collection bleed");

test("exact date 3 min before collection → downgrade to estimated", () => {
  const collected = new Date().toISOString();
  const bleed     = new Date(Date.now() - 3 * 60000).toISOString();
  const r = validateDateIntegrity(src({ date_published: bleed, date_collected: collected }));
  assert.ok(r, "expected patch");
  assert.equal(r.date_integrity_issue, "collection_bleed");
  assert.equal(r.date_confidence, "estimated");
  assert.equal(r.needs_review, true);
  assert.equal(r.date_published, bleed, "date is kept, only confidence changes");
});

test("exact date exactly 10 min before collection → still bleed", () => {
  const collected = new Date().toISOString();
  const bleed     = new Date(Date.now() - 10 * 60000).toISOString();
  const r = validateDateIntegrity(src({ date_published: bleed, date_collected: collected }));
  assert.ok(r);
  assert.equal(r.date_integrity_issue, "collection_bleed");
});

test("exact date 11 min before collection → no bleed", () => {
  const collected = new Date().toISOString();
  const safe      = new Date(Date.now() - 11 * 60000).toISOString();
  assert.equal(validateDateIntegrity(src({ date_published: safe, date_collected: collected })), null);
});

test("bleed only triggers for confidence=exact (not estimated)", () => {
  const collected = new Date().toISOString();
  const bleed     = new Date(Date.now() - 3 * 60000).toISOString();
  // estimated is already flagged by needs_review — bleed rule targets false-exact
  const r = validateDateIntegrity(src({ date_published: bleed, date_confidence: "estimated", date_collected: collected }));
  assert.equal(r, null);
});

test("no date_collected → bleed rule skipped", () => {
  const bleed = new Date(Date.now() - 3 * 60000).toISOString();
  const r = validateDateIntegrity(src({ date_published: bleed, date_collected: null }));
  assert.equal(r, null);
});

// ── Clean cases ───────────────────────────────────────────────────────────────
console.log("\nvalidateDateIntegrity — clean cases");

test("recent exact date, collected 1h ago → no patch", () => {
  const pub       = new Date(Date.now() - 7 * 86400000).toISOString();  // 1 week ago
  const collected = new Date(Date.now() - 3600000).toISOString();       // 1h ago
  assert.equal(validateDateIntegrity(src({ date_published: pub, date_collected: collected })), null);
});

test("null date_published → no patch", () => {
  assert.equal(validateDateIntegrity(src({ date_published: null })), null);
});

test("pre-2020 exact date → no patch (legitimate historical content)", () => {
  assert.equal(validateDateIntegrity(src({ date_published: "2018-06-15T00:00:00.000Z" })), null);
});

test("estimated date, no other issues → no patch (already gated by needs_review)", () => {
  const pub = new Date(Date.now() - 2 * 86400000).toISOString();
  assert.equal(validateDateIntegrity(src({ date_published: pub, date_confidence: "estimated" })), null);
});

// ── upgradeDate tolerance (fix 4: MAX_DELTA_DAYS = 1) ────────────────────────
console.log("\nupgradeDate — tolerance");

// upgradeDate requires full_text.length >= 50; pad tests with article prose.
const article = (dateStr) => `${dateStr} — Security researchers have identified a new attack technique targeting AI model supply chains, affecting multiple organizations across the Asia-Pacific region.`;

test("stored and extracted agree to the day → promote to exact", () => {
  const r = upgradeDate({ date_published: "2026-07-15", date_confidence: "estimated", full_text: article("Published July 15, 2026") });
  assert.ok(r, "expected promotion");
  assert.equal(r.date_confidence, "exact");
  assert.equal(r.date_published, "2026-07-15");
});

test("stored and extracted differ by 1 day → promote (timezone shift)", () => {
  const r = upgradeDate({ date_published: "2026-07-15", date_confidence: "estimated", full_text: article("Published July 14, 2026") });
  assert.ok(r, "expected promotion within 1-day tolerance");
  assert.equal(r.date_confidence, "exact");
});

test("stored and extracted differ by 2 days → reject (too far)", () => {
  const r = upgradeDate({ date_published: "2026-07-15", date_confidence: "estimated", full_text: article("Published July 13, 2026") });
  assert.equal(r, null, "2-day diff should not promote");
});

test("no stored date → promote unconditionally when text has one", () => {
  const r = upgradeDate({ date_published: null, date_confidence: "estimated", full_text: article("Published March 5, 2026") });
  assert.ok(r);
  assert.equal(r.date_published, "2026-03-05");
});

test("already exact → returns null (no-op)", () => {
  const r = upgradeDate({ date_published: "2026-07-15", date_confidence: "exact", full_text: "Published July 15, 2026" });
  assert.equal(r, null);
});

// ── extractPublishDateFromHtml (fix 3) ────────────────────────────────────────
console.log("\nextractPublishDateFromHtml — meta extraction");

test("og:article:published_time → returns date", () => {
  const html = `<html><head><meta property="article:published_time" content="2026-07-20T08:30:00+08:00"></head><body>text</body></html>`;
  assert.equal(extractPublishDateFromHtml(html), "2026-07-20");
});

test("JSON-LD datePublished → returns date", () => {
  const html = `<html><head><script type="application/ld+json">{"@type":"Article","datePublished":"2026-07-18T00:00:00Z"}</script></head><body></body></html>`;
  assert.equal(extractPublishDateFromHtml(html), "2026-07-18");
});

test("JSON-LD dateCreated fallback → returns date", () => {
  const html = `<html><head><script type="application/ld+json">{"dateCreated":"2026-06-01"}</script></head><body></body></html>`;
  assert.equal(extractPublishDateFromHtml(html), "2026-06-01");
});

test("itemprop=datePublished → returns date", () => {
  const html = `<html><head><meta itemprop="datePublished" content="2026-05-10T12:00:00Z"></head><body></body></html>`;
  assert.equal(extractPublishDateFromHtml(html), "2026-05-10");
});

test("no meta tags → null", () => {
  const html = `<html><head><title>Article</title></head><body><p>Published on July 15, 2026</p></body></html>`;
  assert.equal(extractPublishDateFromHtml(html), null);
});

test("date in body prose (not head) → null (only scans head)", () => {
  // The article:published_time is in the body, not the head — should NOT match
  const html = `<html><head></head><body><meta property="article:published_time" content="2026-07-20"></body></html>`;
  assert.equal(extractPublishDateFromHtml(html), null);
});

test("pre-2010 date → null (filtered as implausible)", () => {
  const html = `<html><head><meta property="article:published_time" content="2005-03-01T00:00:00Z"></head><body></body></html>`;
  assert.equal(extractPublishDateFromHtml(html), null);
});

test("null/empty html → null", () => {
  assert.equal(extractPublishDateFromHtml(null), null);
  assert.equal(extractPublishDateFromHtml(""), null);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${failed ? "✗" : "✓"} dateIntegrity: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
