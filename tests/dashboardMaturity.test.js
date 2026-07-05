import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDashboardState } from "../lib/pipeline/dashboard.js";

// Minimal runResult: one category whose evidence spans the lifecycle.
function runResult(evidenceTypes) {
  return {
    run_id: "test", run_date: "2026-07-05",
    category_analyses: [{ category: "agentic_ai_threats", assessment_status: "active", judgments: [] }],
    evidence_items: evidenceTypes.map((source_type, i) => ({
      evidence_id: `ev-${i}`, category: "agentic_ai_threats", is_cluster_rep: true, source_type,
    })),
    corpus_summary: {}, cross_category: {},
  };
}

test("threat_maturity splits a category's evidence by lifecycle", () => {
  const state = buildDashboardState(runResult(["incident", "incident", "capability_demonstration", "research_finding"]));
  const card = state.category_cards.find(c => c.category === "agentic_ai_threats");
  assert.deepEqual(
    { realized: card.threat_maturity.realized, proven: card.threat_maturity.proven, research: card.threat_maturity.research },
    { realized: 2, proven: 1, research: 1 }
  );
});

test("dominant maturity is the most-real non-empty bucket", () => {
  const emerging = buildDashboardState(runResult(["research_finding", "research_finding", "capability_demonstration"]));
  assert.equal(emerging.category_cards[0].threat_maturity.dominant, "proven"); // proven outranks research
  const live = buildDashboardState(runResult(["research_finding", "incident"]));
  assert.equal(live.category_cards[0].threat_maturity.dominant, "realized");   // realized outranks all
});

test("no evidence → dominant 'none'", () => {
  const state = buildDashboardState(runResult([]));
  assert.equal(state.category_cards[0].threat_maturity.dominant, "none");
});
