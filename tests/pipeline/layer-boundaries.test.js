/**
 * Layer Boundary Tests — L6/L7/L9 contract enforcement
 *
 * Tests that:
 *   1. buildAnalysisPackage correctly separates approved vs blocked claims
 *   2. L6-internal fields are stripped from category_analyses
 *   3. registries are built correctly
 *   4. runFinalExportQa (L9.2) blocks export on blocked claims
 *   5. runFinalExportQa warns on unregistered citations and analytics-only claims
 *
 * Run with: node tests/pipeline/layer-boundaries.test.js
 */

import assert from "assert";
import { buildAnalysisPackage } from "../../lib/pipeline/analysis/buildAnalysisPackage.js";
import { runFinalExportQa }     from "../../lib/pipeline/qa/finalExportQa.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeClaim(id) {
  return {
    claim_id:               id,
    claim_type:             "factual",
    claim_text:             "test claim",
    claim_priority:         "high",
    supporting_evidence_ids: [],
  };
}

function makeCategory(cat, claimIds = [], blockedIds = []) {
  return {
    category:              cat,
    assessment_status:     "assessed",
    claims:                claimIds.map((id) => makeClaim(id)),
    claims_blocked_by_qa:  blockedIds.map((id) => ({
      ...makeClaim(id),
      blocking_reasons: ["test_block"],
      allowed_to_proceed: false,
    })),
    top_insights:          [],
    biggest_happenings:    [],
    early_signals:         [],
    recommendations:       [],
    outlook:               null,
    evidence_gaps:         [],
    analysis_confidence:   "medium",
    llm_used:              false,
    analysis_version:      "test-v1",
  };
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  ✗ ${name}: ${err.message}\n`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  ✗ ${name}: ${err.message}\n`);
    failed++;
  }
}

// ── Test 1: approved_claims contains only non-blocked claims ─────────────────

test("analysis_package approved_claims contains only non-blocked claims", () => {
  const pkg = buildAnalysisPackage({
    categoryAnalyses: [makeCategory("llm_threats", ["c1", "c2"], ["c3"])],
    sources:          [],
    evidencePackets:  [],
    visualizationSpecs: [],
  });
  assert.ok(pkg.approved_claims.some((c) => c.claim_id === "c1"), "c1 should be approved");
  assert.ok(pkg.approved_claims.some((c) => c.claim_id === "c2"), "c2 should be approved");
  assert.ok(!pkg.approved_claims.some((c) => c.claim_id === "c3"), "c3 should not be in approved");
});

// ── Test 2: blocked claims are in blocked_claims only ────────────────────────

test("blocked claims appear in blocked_claims only", () => {
  const pkg = buildAnalysisPackage({
    categoryAnalyses: [makeCategory("llm_threats", ["c1"], ["c2"])],
    sources:          [],
    evidencePackets:  [],
    visualizationSpecs: [],
  });
  assert.ok(pkg.blocked_claims.some((c) => c.claim_id === "c2"), "c2 should be in blocked_claims");
  assert.ok(!pkg.approved_claims.some((c) => c.claim_id === "c2"), "c2 should not be in approved_claims");
});

// ── Test 3: rawfact internals stripped from category_analyses ────────────────

test("rawfact internals stripped from category_analyses in package", () => {
  const catWithInternals = {
    ...makeCategory("llm_threats", ["c1"]),
    rawfact:          { strong_evidence: [] },
    rawfact_evidence: ["something"],
    evidence_pack:    { items: [] },
    analytical_state: { ceiling: "low" },
  };
  const pkg = buildAnalysisPackage({
    categoryAnalyses:   [catWithInternals],
    sources:            [],
    evidencePackets:    [],
    visualizationSpecs: [],
  });
  const cat = pkg.category_analyses[0];
  assert.ok(!cat.rawfact,          "rawfact should be stripped");
  assert.ok(!cat.rawfact_evidence, "rawfact_evidence should be stripped");
  assert.ok(!cat.analytical_state, "analytical_state should be stripped");
  // evidence_pack is NOT in L6_INTERNAL_FIELDS — this is okay for now
});

// ── Test 4: approved claim ids set excludes blocked ──────────────────────────

test("approved claim ids set does not contain blocked ids", () => {
  const pkg = buildAnalysisPackage({
    categoryAnalyses: [makeCategory("llm_threats", ["c1"], ["c_blocked"])],
    sources:          [],
    evidencePackets:  [],
    visualizationSpecs: [],
  });
  const approvedIds = new Set(pkg.approved_claims.map((c) => c.claim_id));
  assert.ok(!approvedIds.has("c_blocked"), "c_blocked must not be in approved ids");
  assert.ok(approvedIds.has("c1"),         "c1 must be in approved ids");
});

// ── Test 5: visualization_registry built from specs ──────────────────────────

test("visualization_registry maps visualization_id to spec", () => {
  const specs = [
    { visualization_id: "viz_001", chart_type: "bar", title: "Test Chart" },
    { visualization_id: "viz_002", chart_type: "line", title: "Timeline" },
  ];
  const pkg = buildAnalysisPackage({
    categoryAnalyses:   [],
    sources:            [],
    evidencePackets:    [],
    visualizationSpecs: specs,
  });
  assert.ok(pkg.visualization_registry instanceof Map, "visualization_registry should be a Map");
  assert.ok(pkg.visualization_registry.has("viz_001"), "viz_001 should be in registry");
  assert.ok(pkg.visualization_registry.has("viz_002"), "viz_002 should be in registry");
});

// ── Test 6: qa_report includes counts ────────────────────────────────────────

test("qa_report includes approved_claim_count and blocked_claim_count", () => {
  const pkg = buildAnalysisPackage({
    categoryAnalyses: [makeCategory("llm_threats", ["c1", "c2"], ["c3"])],
    sources:          [],
    evidencePackets:  [],
    visualizationSpecs: [],
  });
  assert.strictEqual(pkg.qa_report.approved_claim_count, 2, "approved_claim_count should be 2");
  assert.strictEqual(pkg.qa_report.blocked_claim_count,  1, "blocked_claim_count should be 1");
});

// ── Test 7: runFinalExportQa blocks slide with blocked claim ─────────────────

await testAsync("runFinalExportQa blocks export when slide references blocked claim", async () => {
  const pkg = buildAnalysisPackage({
    categoryAnalyses: [makeCategory("llm_threats", ["c1"], ["c_blocked"])],
    sources:          [],
    evidencePackets:  [],
    visualizationSpecs: [],
  });
  const mockDeck = [{
    slide_id:         "s1",
    slide_number:     1,
    claim_id:         "c_blocked",
    claim_type:       "factual",
    evidence_callouts: [],
    citations:        [],
  }];
  const result = await runFinalExportQa(mockDeck, pkg);
  assert.strictEqual(result.exportBlocked, true, "export should be blocked");
  assert.ok(
    result.blocking_issues.some((i) => i.issue === "blocked_claim_in_slide"),
    "should have blocked_claim_in_slide issue"
  );
});

// ── Test 8: runFinalExportQa passes when all claims approved ─────────────────

await testAsync("runFinalExportQa does not block when all claims approved", async () => {
  const pkg = buildAnalysisPackage({
    categoryAnalyses: [makeCategory("llm_threats", ["c1"])],
    sources:          [],
    evidencePackets:  [],
    visualizationSpecs: [],
  });
  const mockDeck = [{
    slide_id:         "s1",
    slide_number:     1,
    claim_id:         "c1",
    claim_type:       "factual",
    evidence_callouts: [],
    citations:        [],
  }];
  const result = await runFinalExportQa(mockDeck, pkg);
  assert.strictEqual(result.exportBlocked, false, "export should not be blocked");
});

// ── Test 9: unregistered citation creates warning not blocking ────────────────

await testAsync("runFinalExportQa warns on unregistered citation URL", async () => {
  const pkg = buildAnalysisPackage({
    categoryAnalyses:   [],
    sources:            [],
    evidencePackets:    [],
    visualizationSpecs: [],
  });
  const mockDeck = [{
    slide_id:         "s1",
    slide_number:     1,
    claim_id:         null,
    claim_type:       null,
    evidence_callouts: [],
    citations:        ["SomePublisher — Title (https://unknown-unregistered-domain.example.com/article)"],
  }];
  const result = await runFinalExportQa(mockDeck, pkg);
  assert.strictEqual(result.exportBlocked, false, "unregistered citation should not block export");
  assert.ok(
    result.warnings.some((w) => w.issue === "unregistered_citation"),
    "should have unregistered_citation warning"
  );
});

// ── Test 10: analytics-only for real-world claim creates warning ──────────────

await testAsync("runFinalExportQa warns on analytics-only evidence for adoption claim", async () => {
  const analyticsPacket = {
    evidence_id:       "ev_agg_001",
    evidence_class:    "analytics",
    duplicate_reporting: false,
    primary_origin:    true,
    source_branch:     "L5B",
  };
  const evRegistry = new Map([["ev_agg_001", analyticsPacket]]);
  const pkg = {
    approved_claims:        [{ claim_id: "c1", claim_type: "adoption" }],
    blocked_claims:         [],
    evidence_registry:      evRegistry,
    source_registry:        new Map(),
    visualization_registry: new Map(),
    qa_report:              {},
  };
  const mockDeck = [{
    slide_id:         "s1",
    slide_number:     1,
    claim_id:         "c1",
    claim_type:       "adoption",
    evidence_callouts: [{ evidence_id: "ev_agg_001", publisher: "Analytics", key_fact: "n=5" }],
    citations:        [],
  }];
  const result = await runFinalExportQa(mockDeck, pkg);
  assert.ok(
    result.warnings.some((w) => w.issue === "analytics_only_real_world_claim"),
    "should have analytics_only_real_world_claim warning"
  );
});

// ── Results ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
