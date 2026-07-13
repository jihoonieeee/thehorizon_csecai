/**
 * temporal.test.js — tests for normalizeTemporalOutput() and temporalFallback().
 *
 * Tests model-driven path (normalizeTemporalOutput with mock Haiku outputs)
 * and the deterministic fallback path (temporalFallback with raw query strings).
 * No network calls; all dates anchored to TODAY = "2026-07-13" for reproducibility.
 *
 * Run: node tests/temporal.test.js
 */

import assert from "node:assert/strict";
import { normalizeTemporalOutput, temporalFallback, TEMPORAL_INTENTS } from "../lib/agent/temporal.js";

const TODAY = "2026-07-13";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}
function section(name) { console.log(`\n${name}`); }

// ── TEMPORAL_INTENTS contract ─────────────────────────────────────────────────

section("TEMPORAL_INTENTS");

test("exports the six canonical intent strings", () => {
  assert.deepEqual(TEMPORAL_INTENTS, [
    "none","historical","current","recent","bounded_period","forward_looking",
  ]);
});

// ── normalizeTemporalOutput — happy paths ─────────────────────────────────────

section("normalizeTemporalOutput — valid Haiku output");

test("none intent → all_time with no dates", () => {
  const r = normalizeTemporalOutput(
    { temporal_intent: "none", start_date: null, end_date: null, requires_fresh_sources: false, reasoning_summary: "all time" },
    TODAY
  );
  assert.equal(r.all_time, true);
  assert.equal(r.date_from, null);
  assert.equal(r.date_to, null);
  assert.equal(r.temporal_intent, "none");
  assert.equal(r.requires_fresh_sources, false);
});

test("current intent with start_date → preserves dates and flags fresh", () => {
  const r = normalizeTemporalOutput(
    { temporal_intent: "current", start_date: "2026-01-01", end_date: null, requires_fresh_sources: true, reasoning_summary: "2026 year-to-date" },
    TODAY
  );
  assert.equal(r.date_from, "2026-01-01");
  assert.equal(r.date_to, null);
  assert.equal(r.temporal_intent, "current");
  assert.equal(r.requires_fresh_sources, true);
  assert.equal(r.scope_label, "2026 year-to-date");
  assert.equal(r.all_time, false);
});

test("historical intent with closed window", () => {
  const r = normalizeTemporalOutput(
    { temporal_intent: "historical", start_date: "2025-01-01", end_date: "2025-12-31", requires_fresh_sources: false, reasoning_summary: "2025" },
    TODAY
  );
  assert.equal(r.date_from, "2025-01-01");
  assert.equal(r.date_to, "2025-12-31");
  assert.equal(r.temporal_intent, "historical");
  assert.equal(r.requires_fresh_sources, false);
});

test("bounded_period: Q3 2025 to today", () => {
  const r = normalizeTemporalOutput(
    { temporal_intent: "bounded_period", start_date: "2025-07-01", end_date: null, requires_fresh_sources: false, reasoning_summary: "Q3 2025 to today" },
    TODAY
  );
  assert.equal(r.date_from, "2025-07-01");
  assert.equal(r.date_to, null);
  assert.equal(r.temporal_intent, "bounded_period");
});

test("bounded_period: June 2026", () => {
  const r = normalizeTemporalOutput(
    { temporal_intent: "bounded_period", start_date: "2026-06-01", end_date: "2026-06-30", requires_fresh_sources: false, reasoning_summary: "June 2026" },
    TODAY
  );
  assert.equal(r.date_from, "2026-06-01");
  assert.equal(r.date_to, "2026-06-30");
});

test("recent intent → fresh-required, correct dates", () => {
  const r = normalizeTemporalOutput(
    { temporal_intent: "recent", start_date: "2026-04-14", end_date: null, requires_fresh_sources: true, reasoning_summary: "last 90 days" },
    TODAY
  );
  assert.equal(r.temporal_intent, "recent");
  assert.equal(r.requires_fresh_sources, true);
  assert.equal(r.date_from, "2026-04-14");
});

test("forward_looking with horizon → no hard date_from required; gets 6mo default", () => {
  const r = normalizeTemporalOutput(
    { temporal_intent: "forward_looking", start_date: null, end_date: null, requires_fresh_sources: true, forecast_horizon: "18 months", reasoning_summary: "forward outlook: next 18 months" },
    TODAY
  );
  assert.equal(r.temporal_intent, "forward_looking");
  assert.equal(r.requires_fresh_sources, true);
  assert.equal(r.forecast_horizon, "18 months");
  assert.ok(r.date_from, "should have a date_from (6mo default)");
  assert.ok(r.date_from < TODAY, "default start should be in the past");
});

test("requires_fresh_sources forced true for current intent even if model says false", () => {
  const r = normalizeTemporalOutput(
    { temporal_intent: "current", start_date: "2026-01-01", requires_fresh_sources: false, reasoning_summary: "YTD" },
    TODAY
  );
  assert.equal(r.requires_fresh_sources, true);
});

test("requires_fresh_sources forced true for recent intent even if model says false", () => {
  const r = normalizeTemporalOutput(
    { temporal_intent: "recent", start_date: "2026-04-01", requires_fresh_sources: false, reasoning_summary: "recently" },
    TODAY
  );
  assert.equal(r.requires_fresh_sources, true);
});

// ── normalizeTemporalOutput — guardrail failures fall back ────────────────────

section("normalizeTemporalOutput — guardrail failures");

test("null input → falls back (returns a valid plan)", () => {
  const r = normalizeTemporalOutput(null, TODAY, "recent incidents");
  assert.ok(TEMPORAL_INTENTS.includes(r.temporal_intent));
  assert.ok("date_from" in r);
});

test("missing temporal_intent → falls back", () => {
  const r = normalizeTemporalOutput({ start_date: "2026-01-01" }, TODAY, "test query");
  assert.ok(TEMPORAL_INTENTS.includes(r.temporal_intent));
});

test("impossible range (start > end) → falls back to query-derived plan", () => {
  const r = normalizeTemporalOutput(
    { temporal_intent: "bounded_period", start_date: "2026-06-30", end_date: "2026-01-01" },
    TODAY, "last month"
  );
  // Falls back to temporalFallback("last month") — expect recent
  assert.ok(TEMPORAL_INTENTS.includes(r.temporal_intent));
  // start must not be after end in the result
  if (r.date_from && r.date_to) assert.ok(r.date_from <= r.date_to);
});

test("start_date in the future → falls back", () => {
  const r = normalizeTemporalOutput(
    { temporal_intent: "current", start_date: "2027-01-01", end_date: null },
    TODAY, "this year"
  );
  assert.ok(TEMPORAL_INTENTS.includes(r.temporal_intent));
  if (r.date_from) assert.ok(r.date_from <= TODAY);
});

test("malformed date string → falls back", () => {
  const r = normalizeTemporalOutput(
    { temporal_intent: "historical", start_date: "not-a-date", end_date: null },
    TODAY, "last year"
  );
  assert.ok(TEMPORAL_INTENTS.includes(r.temporal_intent));
});

test("current/recent without start_date → falls back", () => {
  const r = normalizeTemporalOutput(
    { temporal_intent: "current", start_date: null, requires_fresh_sources: true },
    TODAY, "in 2026 so far"
  );
  // Falls back to temporalFallback("in 2026 so far") → current, 2026-01-01
  assert.equal(r.temporal_intent, "current");
  assert.equal(r.date_from, "2026-01-01");
});

// ── temporalFallback — diverse query corpus ───────────────────────────────────

section("temporalFallback — query-driven patterns");

test('"developments in 2026 so far" → current, 2026-01-01', () => {
  const r = temporalFallback("developments in 2026 so far", TODAY);
  assert.equal(r.temporal_intent, "current");
  assert.equal(r.date_from, "2026-01-01");
  assert.equal(r.date_to, null);
  assert.equal(r.requires_fresh_sources, true);
});

test('"based on developments in 2026 so far" → current, 2026-01-01', () => {
  const r = temporalFallback("based on developments in 2026 so far", TODAY);
  assert.equal(r.temporal_intent, "current");
  assert.equal(r.date_from, "2026-01-01");
});

test('"during 2025" → historical, full year', () => {
  const r = temporalFallback("during 2025", TODAY);
  assert.equal(r.temporal_intent, "historical");
  assert.equal(r.date_from, "2025-01-01");
  assert.equal(r.date_to, "2025-12-31");
  assert.equal(r.requires_fresh_sources, false);
});

test('"over the past 18 months" → historical, ~18 months ago', () => {
  const r = temporalFallback("over the past 18 months", TODAY);
  assert.equal(r.temporal_intent, "historical");
  assert.ok(r.date_from, "should have a start date");
  // 18 months ≈ 540 days from 2026-07-13 → roughly 2025-01
  assert.ok(r.date_from < "2025-03-01", `expected < 2025-03, got ${r.date_from}`);
  assert.equal(r.requires_fresh_sources, false);
});

test('"last 6 months" → recent', () => {
  const r = temporalFallback("last 6 months", TODAY);
  assert.equal(r.temporal_intent, "recent");
  assert.ok(r.date_from < TODAY);
});

test('"last 2 years" → historical', () => {
  const r = temporalFallback("last 2 years", TODAY);
  assert.equal(r.temporal_intent, "historical");
  assert.ok(r.date_from < "2025-01-01");
});

test('"what is emerging now" → recent, requires_fresh', () => {
  const r = temporalFallback("what is emerging now", TODAY);
  assert.equal(r.temporal_intent, "recent");
  assert.equal(r.requires_fresh_sources, true);
});

test('"latest operational incidents" → recent, requires_fresh', () => {
  const r = temporalFallback("latest operational incidents", TODAY);
  assert.equal(r.temporal_intent, "recent");
  assert.equal(r.requires_fresh_sources, true);
});

test('"current AI threat landscape" → recent, requires_fresh', () => {
  const r = temporalFallback("current AI threat landscape", TODAY);
  assert.equal(r.requires_fresh_sources, true);
});

test('"what should CISOs prepare for next" → forward_looking', () => {
  const r = temporalFallback("what should CISOs prepare for next", TODAY);
  assert.equal(r.temporal_intent, "forward_looking");
  assert.equal(r.requires_fresh_sources, true);
});

test('"what should leaders prioritise over the next 18 months" → forward_looking with horizon', () => {
  const r = temporalFallback("what should leaders prioritise over the next 18 months", TODAY);
  assert.equal(r.temporal_intent, "forward_looking");
  assert.ok(r.forecast_horizon, "should have a forecast_horizon");
});

test('"between Q3 2025 and today" → bounded_period, 2025-07-01', () => {
  const r = temporalFallback("between Q3 2025 and today", TODAY);
  assert.equal(r.temporal_intent, "bounded_period");
  assert.equal(r.date_from, "2025-07-01");
  assert.equal(r.date_to, null);
});

test('"Q4 2024" → bounded_period, closed window', () => {
  const r = temporalFallback("Q4 2024", TODAY);
  assert.equal(r.temporal_intent, "bounded_period");
  assert.equal(r.date_from, "2024-10-01");
  assert.equal(r.date_to, "2024-12-31");
});

test('"Q3 2025" → bounded_period, July to September', () => {
  const r = temporalFallback("Q3 2025", TODAY);
  assert.equal(r.date_from, "2025-07-01");
  assert.equal(r.date_to, "2025-09-30");
});

test('"this year" → current, 2026-01-01', () => {
  const r = temporalFallback("this year", TODAY);
  assert.equal(r.temporal_intent, "current");
  assert.equal(r.date_from, "2026-01-01");
  assert.equal(r.requires_fresh_sources, true);
});

test('"year to date" → current', () => {
  const r = temporalFallback("year to date threat analysis", TODAY);
  assert.equal(r.temporal_intent, "current");
  assert.equal(r.date_from, "2026-01-01");
});

test('"YTD" → current', () => {
  const r = temporalFallback("YTD summary of LLM threats", TODAY);
  assert.equal(r.temporal_intent, "current");
});

test('"this month" → current', () => {
  const r = temporalFallback("this month", TODAY);
  assert.equal(r.temporal_intent, "current");
  assert.equal(r.date_from, "2026-07-01");
});

test('"this week" → current, last 7 days', () => {
  const r = temporalFallback("this week", TODAY);
  assert.equal(r.temporal_intent, "current");
  assert.equal(r.date_from, "2026-07-06");
});

test('"since May 2026" → historical, open end', () => {
  const r = temporalFallback("since May 2026", TODAY);
  assert.equal(r.temporal_intent, "historical");
  assert.equal(r.date_from, "2026-05-01");
  assert.equal(r.date_to, null);
});

test('"in June 2026" → bounded_period, closed month', () => {
  const r = temporalFallback("in June 2026", TODAY);
  assert.equal(r.temporal_intent, "bounded_period");
  assert.equal(r.date_from, "2026-06-01");
  assert.equal(r.date_to, "2026-06-30");
});

test('"how does prompt injection work" → no time context → default', () => {
  const r = temporalFallback("how does prompt injection work", TODAY);
  // No temporal signals → 90-day default
  assert.ok(TEMPORAL_INTENTS.includes(r.temporal_intent));
  assert.ok(r.date_from, "should still have a date_from for retrieval");
  assert.equal(r.all_time, false);
  assert.equal(r.forecast_horizon, null);
});

test("no query string → returns a valid default plan", () => {
  const r = temporalFallback(undefined, TODAY);
  assert.ok(TEMPORAL_INTENTS.includes(r.temporal_intent));
  assert.ok("date_from" in r);
  assert.ok("requires_fresh_sources" in r);
});

test("all-time query → none intent", () => {
  const r = temporalFallback("show me all time data on adversarial ML", TODAY);
  assert.equal(r.temporal_intent, "none");
  assert.equal(r.all_time, true);
  assert.equal(r.date_from, null);
});

// ── TemporalPlan shape contract ───────────────────────────────────────────────

section("TemporalPlan shape contract");

const REQUIRED_KEYS = ["date_from","date_to","scope_label","all_time","temporal_intent","requires_fresh_sources","forecast_horizon"];

test("normalizeTemporalOutput always returns all required keys", () => {
  const cases = [
    { temporal_intent: "none" },
    { temporal_intent: "current", start_date: "2026-01-01" },
    { temporal_intent: "forward_looking" },
    null,
    { bad: "object" },
  ];
  for (const raw of cases) {
    const r = normalizeTemporalOutput(raw, TODAY, "test");
    for (const k of REQUIRED_KEYS) {
      assert.ok(k in r, `missing key "${k}" for input ${JSON.stringify(raw)}`);
    }
  }
});

test("temporalFallback always returns all required keys", () => {
  const queries = [
    "in 2026 so far", "last 18 months", "Q3 2025", "this week",
    "next 18 months", "how does it work", "", "all time",
  ];
  for (const q of queries) {
    const r = temporalFallback(q, TODAY);
    for (const k of REQUIRED_KEYS) {
      assert.ok(k in r, `missing key "${k}" for query "${q}"`);
    }
    assert.ok(TEMPORAL_INTENTS.includes(r.temporal_intent), `invalid intent for "${q}"`);
  }
});

test("all_time is only true when temporal_intent is 'none'", () => {
  const queries = ["in 2026", "last 90 days", "Q3 2025", "next year", "all time data"];
  for (const q of queries) {
    const r = temporalFallback(q, TODAY);
    if (r.all_time) assert.equal(r.temporal_intent, "none", `all_time=true but intent=${r.temporal_intent} for "${q}"`);
    if (r.temporal_intent === "none") assert.equal(r.all_time, true, `intent=none but all_time=false for "${q}"`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
