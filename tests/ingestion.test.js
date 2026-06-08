/**
 * Ingestion layer tests — no network calls, no DB.
 * Run with: node tests/ingestion.test.js
 */

import assert from "node:assert/strict";
import { normalizeSource } from "../lib/pipeline/ingest/normalizeSource.js";
import { dedupeSources } from "../lib/utils/dedupe.js";
import { filterAcceptableSources } from "../lib/pipeline/ingest/filterAcceptableSources.js";
import { computeEligibilityFlags } from "../lib/pipeline/ingest/eligibilityFlags.js";
import { isSafeUrl } from "../lib/pipeline/validation/urlSafety.js";

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

// ── normalizeSource ───────────────────────────────────────────────────────────

console.log("\nnormalizeSource");

test("date_confidence defaults to 'exact' when date_published is set", () => {
  const source = normalizeSource({
    title: "Test",
    url: "https://example.com/article",
    date_published: "2026-01-15T10:00:00Z",
  });
  assert.equal(source.date_confidence, "exact");
});

test("date_confidence defaults to 'none' when date_published is missing", () => {
  const source = normalizeSource({
    title: "Test",
    url: "https://example.com/article",
  });
  assert.equal(source.date_confidence, "none");
  assert.equal(source.date_published, null);
});

test("date_confidence respects explicitly passed value", () => {
  const source = normalizeSource({
    title: "Test",
    url: "https://example.com/article",
    date_published: "2026-01-15T10:00:00Z",
    date_confidence: "estimated",
  });
  assert.equal(source.date_confidence, "estimated");
});

test("date_discovered is always set to a valid ISO string", () => {
  const source = normalizeSource({
    title: "Test",
    url: "https://example.com/article",
  });
  assert.ok(source.date_discovered);
  assert.ok(!isNaN(new Date(source.date_discovered).getTime()));
});

test("date_published_actual defaults to date_published for regular sources", () => {
  const source = normalizeSource({
    title: "Test",
    url: "https://example.com/article",
    date_published: "2026-01-15T10:00:00Z",
  });
  assert.equal(source.date_published_actual, source.date_published);
});

test("date_published_actual can be set independently of date_published", () => {
  const source = normalizeSource({
    title: "LLM Discovery article",
    url: "https://example.com/2024/06/article",
    date_published: new Date().toISOString(),
    date_published_actual: null,
    date_confidence: "low",
  });
  assert.equal(source.date_published_actual, null);
  assert.equal(source.date_confidence, "low");
  assert.ok(source.date_published);  // collection time is still set
});

// ── dedupeSources — quality-based selection ───────────────────────────────────

console.log("\ndedupeSources");

test("keeps highest-trust source when two sources share a URL", () => {
  const primarySource = {
    id: "a",
    url: "https://example.com/advisory",
    title: "AI Advisory",
    trust_tier: "primary",
    full_text: "Short text",
    date_published: "2026-01-15T10:00:00Z",
    date_confidence: "exact",
    clean_text_hash: null,
  };
  const mediumSource = {
    id: "b",
    url: "https://example.com/advisory",
    title: "AI Advisory",
    trust_tier: "medium",
    full_text: "Short text",
    date_published: "2026-01-15T10:00:00Z",
    date_confidence: "exact",
    clean_text_hash: null,
  };
  const result = dedupeSources([mediumSource, primarySource]);
  assert.equal(result.length, 1);
  assert.equal(result[0].trust_tier, "primary");
});

test("keeps source with richer full_text when trust tiers are equal", () => {
  const sparse = {
    id: "a",
    url: "https://a.com/article",
    title: "CVE Report",
    trust_tier: "medium",
    full_text: "Brief mention",
    date_published: "2026-01-15T10:00:00Z",
    date_confidence: "exact",
    clean_text_hash: null,
  };
  const rich = {
    id: "b",
    url: "https://b.com/article",
    title: "CVE Report",
    trust_tier: "medium",
    full_text: "A".repeat(1500),
    date_published: "2026-01-15T10:00:00Z",
    date_confidence: "exact",
    clean_text_hash: null,
  };
  const result = dedupeSources([sparse, rich]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "b");
});

test("CVE reference boosts quality score so CVE source beats non-CVE source with same URL", () => {
  // Same canonical URL — dedup fires, quality score picks the CVE-mentioning source
  const sharedUrl = "https://example.com/ai-model-vulnerability-2026";
  const withCve = {
    id: "a",
    url: sharedUrl,
    title: "CVE-2026-1234: AI model vulnerability",
    trust_tier: "medium",
    full_text: "CVE-2026-1234 affects LLM serving infrastructure.",
    date_published: "2026-01-15T10:00:00Z",
    date_confidence: "exact",
    clean_text_hash: null,
  };
  const noCve = {
    id: "b",
    url: sharedUrl,
    title: "AI model vulnerability",
    trust_tier: "medium",
    full_text: "A vulnerability was found in an AI model serving system.",
    date_published: "2026-01-15T10:00:00Z",
    date_confidence: "exact",
    clean_text_hash: null,
  };
  const result = dedupeSources([noCve, withCve]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "a");
});

test("deduplication removes exact URL duplicates", () => {
  const s = {
    id: "a",
    url: "https://example.com/article",
    title: "Article",
    trust_tier: "medium",
    full_text: "content",
    date_published: "2026-01-15T10:00:00Z",
    date_confidence: "exact",
    clean_text_hash: null,
  };
  const result = dedupeSources([s, { ...s, id: "b" }]);
  assert.equal(result.length, 1);
});

// ── filterAcceptableSources — conditional types ───────────────────────────────

console.log("\nfilterAcceptableSources");

// Note: incident_database, ai_threat_framework, social_signal, open_source_project were
// removed from ALL_SOURCE_TYPES in taxonomy v8/v9. They are now rejected with
// "Unsupported source_type" and must be mapped to current types at ingestion.
test("incident_database is rejected (removed type — use 'incident' instead)", () => {
  const { accepted, rejected } = filterAcceptableSources([{
    id: "a", title: "AI Incident #123", url: "https://incidentdatabase.ai/123",
    source_type: "incident_database", trust_tier: "medium", tags: [],
  }]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason.includes("Unsupported source_type"),
    `expected Unsupported source_type, got: ${rejected[0].reason}`);
});

test("ai_threat_framework is rejected (removed type — use 'threat_intelligence' instead)", () => {
  const { accepted, rejected } = filterAcceptableSources([{
    id: "a", title: "MITRE ATLAS Tactic", url: "https://atlas.mitre.org/techniques/AML.T0001",
    source_type: "ai_threat_framework", trust_tier: "unknown", tags: [],
  }]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
});

test("social_signal is rejected (removed type — social content maps to other types)", () => {
  const { accepted, rejected } = filterAcceptableSources([{
    id: "a", title: "CISA tweet", url: "https://twitter.com/cisagov/status/123",
    source_type: "social_signal", trust_tier: "primary", tags: [],
  }]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
});

test("open_source_project is rejected (removed type — use 'vulnerability' or 'exploit_disclosure')", () => {
  const { accepted, rejected } = filterAcceptableSources([{
    id: "a", title: "CVE-2026-1234: security vulnerability in llama.cpp",
    url: "https://github.com/ggerganov/llama.cpp/security/advisories/GHSA-xxxx",
    source_type: "open_source_project", trust_tier: "high", tags: [],
  }]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
});

test("unknown source_type accepted with needs_review flag", () => {
  const { accepted } = filterAcceptableSources([{
    id: "a", title: "Strange source", url: "https://example.com/source",
    source_type: "unknown", trust_tier: "medium", tags: [],
  }]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].needs_review, true);
});

// ── computeEligibilityFlags ───────────────────────────────────────────────────

console.log("\ncomputeEligibilityFlags");

const DAILY_WINDOW = {
  start_utc: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  end_utc: new Date().toISOString(),
};

test("eligible_for_daily_report true for recent source with exact date", () => {
  const flags = computeEligibilityFlags({
    date_published: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    date_confidence: "exact",
    trust_tier: "high",
    source_type: "security_blog",
    publisher: "BleepingComputer",
    full_text: "A".repeat(300),
  }, DAILY_WINDOW);
  assert.equal(flags.eligible_for_daily_report, true);
  assert.equal(flags.needs_review, false);
});

test("eligible_for_daily_report false for source with date_confidence 'none'", () => {
  const flags = computeEligibilityFlags({
    date_published: new Date().toISOString(),
    date_confidence: "none",
    trust_tier: "medium",
    source_type: "security_blog",
    full_text: "A".repeat(100),
  }, DAILY_WINDOW);
  assert.equal(flags.eligible_for_daily_report, false);
  assert.equal(flags.needs_review, true);
});

test("eligible_for_reference_context true for curated and primary sources", () => {
  for (const trust_tier of ["curated", "primary", "high"]) {
    const flags = computeEligibilityFlags({
      date_published: new Date().toISOString(),
      date_confidence: "exact",
      trust_tier,
      source_type: "government_advisory",
      full_text: "A".repeat(300),
    });
    assert.equal(flags.eligible_for_reference_context, true, `trust_tier=${trust_tier}`);
  }
});

test("eligible_for_trend_analysis requires full_text > 200 chars", () => {
  const short = computeEligibilityFlags({
    date_published: new Date().toISOString(), date_confidence: "exact",
    trust_tier: "medium", source_type: "news", full_text: "Brief.",
  });
  const long = computeEligibilityFlags({
    date_published: new Date().toISOString(), date_confidence: "exact",
    trust_tier: "medium", source_type: "news", full_text: "A".repeat(300),
  });
  assert.equal(short.eligible_for_trend_analysis, false);
  assert.equal(long.eligible_for_trend_analysis, true);
});

// ── isSafeUrl ─────────────────────────────────────────────────────────────────

console.log("\nisSafeUrl");

test("HTTPS public URL is safe", () => {
  assert.equal(isSafeUrl("https://example.com/article"), true);
});

test("HTTP URL is not safe (use checkUrlSafety for redirect detection)", () => {
  assert.equal(isSafeUrl("http://example.com/article"), false);
});

test("localhost URL is not safe", () => {
  assert.equal(isSafeUrl("https://localhost/admin"), false);
});

test("private IP URL is not safe", () => {
  assert.equal(isSafeUrl("https://192.168.1.1/api"), false);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
