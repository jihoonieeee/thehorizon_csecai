/**
 * Regression tests for the P2 fixes from docs/audits/layers-4-6-critical-audit.md.
 *
 *   4.5/4.6 — AI-enabled overlay: ai_enabled w/o roles → false; autonomy w/o signal → unknown
 *   5A.6    — corroboration counts independent ORIGINS (circular reporting excluded)
 *   6.6     — cross-category outputs: confidence capped at min category; dedup by evidence
 *   4.7/5B.3 — keyword-fallback sources excluded from taxonomy-derived frequency charts
 *
 * (4.1 domain re-route and 6.8 packet ordering are exercised via reasoning / the live
 *  LLM path and unexported internals; not unit-tested here.)
 *
 * Run with: node tests/p2AuditFixes.test.js
 */

import assert from "node:assert/strict";
import { validateAiEnabledOverlay } from "../lib/config/taxonomyValidation.js";
import { qaAnalyticalClaim } from "../lib/pipeline/analysis/claimQa.js";
import { enforceCrossCategoryPatterns } from "../lib/pipeline/synthesis/runCrossCategorySynthesis.js";
import { aggregateAnalytics } from "../lib/pipeline/analytics/analyticsAggregation.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

// ── 4.5 / 4.6 — AI-enabled overlay ─────────────────────────────────────────────
console.log("4.5/4.6 — AI-enabled overlay downgrades");

test("ai_enabled=true with no roles is downgraded to false", () => {
  const r = validateAiEnabledOverlay({ ai_enabled: true, ai_enabled_roles: [] });
  assert.equal(r.ai_enabled, false);
});

test("autonomy 'autonomous' with no role/capability is reset to unknown", () => {
  const r = validateAiEnabledOverlay({
    ai_enabled: false, ai_enabled_roles: [], ai_capabilities: [],
    automation_level: "autonomous", autonomy_level: "multi_agent",
  });
  assert.equal(r.autonomy_level, "unknown");
  assert.equal(r.automation_level, "unknown");
});

test("autonomy is preserved when a capability signal exists", () => {
  const r = validateAiEnabledOverlay({
    ai_enabled: true, ai_enabled_roles: ["AE08_ai_enabled_attack_orchestration"],
    ai_capabilities: ["autonomous_planning"], autonomy_level: "autonomous",
  });
  assert.equal(r.ai_enabled, true);
  assert.equal(r.autonomy_level, "autonomous");
});

// ── 5A.6 — independent-origin corroboration ────────────────────────────────────
console.log("5A.6 — corroboration counts independent origins");

function trendPkt(over = {}) {
  return {
    evidence_id: over.id, evidence_type: "incident", source_type: "incident",
    publisher: over.pub || "Pub", date_published: over.date || "2026-01-10",
    primary_origin_url: over.origin || null, independence_level: over.indep || null,
    entities: ["X"],
    triage_data: { evidence_strength: "strong", admissibility: "passed", permitted_uses: ["fact_support"], limitations: [] },
  };
}

test("3 re-reports of ONE origin do not satisfy the trend (independent origins < 2)", () => {
  const claim = { claim_type: "trend_claim", claim_text: "A growing pattern." };
  const packets = [
    trendPkt({ id: "a", pub: "OutletA", date: "2026-01-10", origin: "https://orig/report" }),
    trendPkt({ id: "b", pub: "OutletB", date: "2026-02-10", origin: "https://orig/report" }),
    trendPkt({ id: "c", pub: "OutletC", date: "2026-03-10", origin: "https://orig/report" }),
  ];
  const r = qaAnalyticalClaim(claim, packets, {});
  assert.equal(r.claim_support_status, "overgeneralized");
});

test("circular_reporting_risk members are excluded from independent-origin count", () => {
  const claim = { claim_type: "trend_claim", claim_text: "A growing pattern." };
  const packets = [
    trendPkt({ id: "a", pub: "OutletA", date: "2026-01-10", indep: "circular_reporting_risk" }),
    trendPkt({ id: "b", pub: "OutletB", date: "2026-02-10", indep: "circular_reporting_risk" }),
    trendPkt({ id: "c", pub: "OutletC", date: "2026-03-10", indep: "circular_reporting_risk" }),
  ];
  const r = qaAnalyticalClaim(claim, packets, {});
  assert.equal(r.claim_support_status, "overgeneralized");
});

test("3 genuinely independent origins across 2 months pass the trend", () => {
  const claim = { claim_type: "trend_claim", claim_text: "A growing pattern." };
  const packets = [
    trendPkt({ id: "a", pub: "OutletA", date: "2026-01-10" }),
    trendPkt({ id: "b", pub: "OutletB", date: "2026-02-10" }),
    trendPkt({ id: "c", pub: "OutletC", date: "2026-02-20" }),
  ];
  const r = qaAnalyticalClaim(claim, packets, {});
  assert.equal(r.allowed_to_proceed, true);
});

// ── 6.6 — cross-category confidence cap + dedup ────────────────────────────────
console.log("6.6 — cross-category confidence cap + dedup");

test("pattern confidence is capped at the min of its categories' confidence", () => {
  const result = {
    cross_category_patterns: [{
      pattern: "P", categories_involved: ["llm_threats", "agentic_ai_threats"],
      explanation: "x", supporting_evidence_ids: ["e1"], confidence: "high",
    }],
    overall_biggest_happenings: [], overall_early_signals: [], executive_summary: {}, strategic_outlook: {},
  };
  const cats = [
    { category: "llm_threats", analysis_confidence: "high" },
    { category: "agentic_ai_threats", analysis_confidence: "low" },
  ];
  const out = enforceCrossCategoryPatterns(result, cats);
  assert.equal(out.cross_category_patterns[0].confidence, "low");
});

test("happenings citing the identical evidence set are deduped", () => {
  const result = {
    cross_category_patterns: [],
    overall_biggest_happenings: [
      { happening: "A", supporting_evidence_ids: ["e1", "e2"], confidence: "medium", category: "llm_threats" },
      { happening: "A restated", supporting_evidence_ids: ["e2", "e1"], confidence: "medium", category: "llm_threats" },
      { happening: "B", supporting_evidence_ids: ["e3"], confidence: "low", category: "llm_threats" },
    ],
    overall_early_signals: [], executive_summary: {}, strategic_outlook: {},
  };
  const out = enforceCrossCategoryPatterns(result, [{ category: "llm_threats", analysis_confidence: "medium" }]);
  assert.equal(out.overall_biggest_happenings.length, 2);
});

// ── 4.7 / 5B.3 — fallback sources excluded from tag-derived charts ─────────────
console.log("4.7/5B.3 — keyword-fallback excluded from frequency charts");

function feat(over) {
  return {
    analytics_features: {
      source_id: over.id, main_category: "llm_threats", source_type: "research_finding", trust_tier: "high",
      date_published: "2026-05-01", month_bucket: "2026-05", analytics_use: "full_analytics",
      attack_vectors: over.vectors, attack_surfaces: [], ai_layers: [], impact_types: [],
      signal_clusters: [], recurring_themes: [], sectors: [], technologies: [], geography: [],
      operational_status: "unknown", threat_maturity: "unknown", impact_scope: "unknown",
      aggregation_weight: 1, primary_domain: "llm_threats", primary_tags: [], primary_threat_tags: [],
      sub_techniques: [], ai_enabled: false, ai_enabled_roles: [], ai_capabilities: [],
      automation_level: "unknown", autonomy_level: "unknown",
      taxonomy_validation_status: over.status,
    },
  };
}

test("a needs_manual_review source's attack vector is excluded from the chart", () => {
  const ag = aggregateAnalytics([
    feat({ id: "s1", vectors: ["prompt_injection"], status: "validated" }),
    feat({ id: "s2", vectors: ["model_extraction"], status: "needs_manual_review" }),
  ]);
  const cat = ag.category_analytics.per_category.llm_threats;
  const vectorKeys = Object.keys(cat.attack_vector_frequency || {});
  assert.ok(vectorKeys.includes("prompt_injection"), "validated source vector should be charted");
  assert.ok(!vectorKeys.includes("model_extraction"), "fallback source vector must be excluded");
  assert.equal(cat.count, 2, "both sources still counted in corpus total");
  assert.equal(cat.excluded_from_tag_charts, 1);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n──────────────────────────────────────────────────");
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
