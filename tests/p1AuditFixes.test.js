/**
 * Regression tests for the P1 fixes from docs/audits/layers-4-6-critical-audit.md.
 *
 *   5A.2 — statistical_use carried through normalization + gates the statistics bucket
 *   6.3  — trend-scope language on a non-trend insight is confidence-capped
 *   6.4  — operational-language insight routes to the factual gate and is blocked
 *          when operational evidence is absent
 *   6.7  — a claim backed only by context/external evidence cannot be critical/high
 *   4.2  — emerging_unmapped sources are restricted to framing-level uses
 *
 * Run with: node tests/p1AuditFixes.test.js
 */

import assert from "node:assert/strict";
import { normalizeSourceEvidenceItems } from "../lib/pipeline/rawfact/normalizeEvidenceItems.js";
import { assembleEvidencePacks } from "../lib/pipeline/rawfact/assembleEvidencePacks.js";
import { validateCategoryAnalysis } from "../lib/pipeline/analysis/validateCategoryAnalysis.js";
import { qaAnalyticalClaim } from "../lib/pipeline/analysis/claimQa.js";
import { analyzeCategory } from "../lib/pipeline/analysis/analyzeCategory.js";
import { triageEvidenceItem } from "../lib/pipeline/evidenceTriage/evidenceTriage.js";
import { generateVisualizationSpecs } from "../lib/pipeline/analytics/visualizationSpecs.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => { console.log(`  ✓ ${name}`); passed++; }).catch((e) => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

function pkt(over = {}) {
  return {
    evidence_id: over.id || "p", evidence_type: over.etype || "incident",
    source_type: over.stype || "incident", publisher: over.pub || "PubA",
    date_published: over.date || "2026-01-15", entities: over.entities || ["EntityX"],
    triage_data: {
      evidence_strength: over.strength || "strong", admissibility: "passed",
      observed_use: over.observed === true,
      permitted_uses: over.observed ? ["adoption_support", "fact_support"] : ["fact_support"],
      limitations: over.limitations || [],
    },
  };
}

const run = async () => {

// ── 5A.2 — statistical_use ─────────────────────────────────────────────────────
console.log("5A.2 — method quality gates the chartable statistics bucket");

test("normalizeItem carries statistical_use / method_quality forward", () => {
  const src = {
    id: "s1", source_type: "benchmark_evaluation", main_category: "llm_threats",
    clean_text: "Attack success rate of 87% was reported by the vendor.",
    evidence_eligibility: { evidence_use: "supporting_evidence" },
    extraction_profile: { allowed_evidence_types: ["benchmark_result"], max_items: 3 },
    evidence_items_raw: [{
      evidence_id: "ev_s1_1", evidence_type: "benchmark_result",
      fact: "Attack success rate of 87% was reported by the vendor.",
      source_quote: "Attack success rate of 87% was reported by the vendor.",
      numbers: ["87%"], evidence_confidence: "medium", best_used_for: ["chart_annotation"],
      method_quality: "anecdotal", statistical_use: "context_only", method_reason: "vendor single point",
    }],
  };
  const out = normalizeSourceEvidenceItems(src);
  assert.equal(out.evidence_items[0].statistical_use, "context_only");
  assert.equal(out.evidence_items[0].method_quality, "anecdotal");
});

test("context_only-method number is excluded from the statistics bucket; chart_allowed is kept", () => {
  const src = {
    id: "s2", source_type: "benchmark_evaluation", trust_tier: "high", main_category: "llm_threats",
    evidence_items: [
      { evidence_id: "ev_ctx", evidence_type: "benchmark_result", fact: "Vendor claims an 87% success rate.", numbers: ["87%"], category_hint: "llm_threats", statistical_use: "context_only", triage_data: { evidence_strength: "usable", permitted_uses: ["fact_support"], limitations: [] }, evidence_cluster: { is_representative: true } },
      { evidence_id: "ev_ok", evidence_type: "benchmark_result", fact: "Jailbreak succeeded on 42% of 100 tested prompts.", numbers: ["42%"], category_hint: "llm_threats", statistical_use: "chart_allowed", triage_data: { evidence_strength: "strong", permitted_uses: ["fact_support"], limitations: [] }, evidence_cluster: { is_representative: true } },
    ],
  };
  const pack = assembleEvidencePacks([src]).find((p) => p.category === "llm_threats");
  const statIds = pack.statistics.map((i) => i.evidence_id);
  assert.ok(statIds.includes("ev_ok"), "chart_allowed stat should be present");
  assert.ok(!statIds.includes("ev_ctx"), "context_only-method stat must be excluded from charts");
});

// ── 6.3 — trend-scope language gate ────────────────────────────────────────────
console.log("6.3 — trend-scope language without trend evidence is capped");

test("'increasingly common' insight with one item is capped below high + caveated", () => {
  const compact = { category: "llm_threats", id_index: new Map([
    ["ev_a", { origin: "5A_rawfact", source_type: "research_finding", evidence_strength: "usable", permitted_uses: ["fact_support"], limitations: [], publisher: "Lab", date: "2026-01-01" }],
  ]) };
  // Uses new strategic_judgments schema (validateCategoryAnalysis v3.0+)
  const raw = {
    strategic_judgments: [{
      judgment_id: "j1", judgment_type: "technique_evolution",
      judgment: "Prompt injection attacks are increasingly common this year.",
      what_changed: "Increased frequency of prompt injection attempts observed across deployed LLMs.",
      causal_mechanism: "Wider LLM deployment without input validation creates attack surface.",
      why_this_matters: "Defenders must prioritize prompt injection mitigations.",
      uncertainty: "Based on single source — limited corroboration.",
      evidence_for: ["ev_a"], evidence_against: [], confidence: "high", caveat_if_any: null,
      // LLM must set implies_trend=true for trend gate to fire (regex fallback removed)
      judgment_flags: { implies_adoption: false, implies_operational: false, implies_trend: true,
        is_forward_looking: false, is_market_wide: false, is_lab_only: false },
      short_takeaway: "Prompt injection frequency increasing across deployed LLMs.",
    }],
    outlook_6_months: { observed_basis: "Single lab finding.", projected_trajectory: "Activity may continue.", reasoning: "Limited evidence.", confidence: "low", supporting_evidence_ids: [] },
    evidence_gaps: [],
  };
  const v = validateCategoryAnalysis(raw, compact);
  const ins = v.strategic_judgments[0];
  assert.ok(ins, "judgment should exist");
  assert.notEqual(ins.confidence, "high");
  assert.ok((ins.caveat_if_any || "").includes("trend-scope"));
});

// ── 6.4 — operational language routes to factual gate and blocks ──────────────
console.log("6.4 — operational-language insight is blocked without operational evidence");

test("'actively exploited in production' insight is blocked when operational evidence is sparse", () => {
  const claim = { claim_type: "category_insight", claim_text: "This vulnerability is being actively exploited in production attacks." };
  const corpusAudit = { analysis_allowed: "limited", evidence_gap_flags: ["operational_evidence_sparse"], source_concentration_flags: [] };
  const r = qaAnalyticalClaim(claim, [pkt({ id: "e1", strength: "strong", stype: "research_finding" })], corpusAudit);
  assert.equal(r.allowed_to_proceed, false);
});

// ── 6.7 — strong/usable floor on claims[] ─────────────────────────────────────
console.log("6.7 — claim backed only by context evidence cannot be critical/high");

await test("context-only insight is capped to medium priority via analyzeCategory", async () => {
  const dossier = {
    category: "llm_threats", source_count: 5,
    sources: [
      { source_type: "incident", publisher: "CISA",  trust_tier: "primary", date_published: "2026-01-05", origin_role: "primary_origin" },
      { source_type: "incident", publisher: "NCSC",  trust_tier: "primary", date_published: "2026-02-05", origin_role: "primary_origin" },
      { source_type: "threat_intelligence", publisher: "Mandiant", trust_tier: "high", date_published: "2026-02-10" },
    ],
    rawfact: {
      strong_evidence: [], usable_evidence: [],
      context_evidence: [{ evidence_id: "ev_c1", evidence_type: "research_result", source_type: "research_finding", fact: "A lab observation about prompt handling.", triage_data: { evidence_strength: "context", permitted_uses: ["context_only"], limitations: [] }, publisher: "Lab", date: "2026-01-01" }],
      case_study_candidates: [], statistics: [], outlook_inputs: [], exposure_inputs: [], recommendation_inputs: [],
    },
    rawfact_evidence: [],
  };
  const fakeLlm = async () => ({
    result: {
      strategic_judgments: [{
        judgment_id: "j1", judgment_type: "risk_elevation",
        judgment: "Prompt injection is the leading LLM attack vector.",
        what_changed: "Multiple lab studies confirm prompt injection as the dominant LLM attack vector.",
        causal_mechanism: "LLMs cannot natively distinguish instruction from data in user input.",
        why_this_matters: "Defenders must implement prompt injection mitigations before production deployment.",
        uncertainty: "Limited to lab settings — no confirmed adversary production use yet.",
        evidence_for: ["ev_c1"], evidence_against: [], confidence: "high", caveat_if_any: null,
        slide_usefulness: "high", recommended_actions: [],
        judgment_flags: { implies_adoption: false, implies_operational: false, implies_trend: false,
          is_forward_looking: false, is_market_wide: false, is_lab_only: true },
        short_takeaway: "Prompt injection remains top LLM vector — mitigate at input layer.",
      }],
      outlook_6_months: { observed_basis: "Lab finding only.", projected_trajectory: "Prompt injection may remain prevalent.", reasoning: "No operational data yet.", confidence: "low", supporting_evidence_ids: [] },
      evidence_gaps: [],
    },
    llm_metadata: { llm_used: true, model_used: "test" },
  });
  const out = await analyzeCategory(dossier, { llmFn: fakeLlm });
  const insightClaim = (out.claims || []).find((c) => c.claim_type === "category_insight");
  assert.ok(insightClaim, "insight claim should exist");
  assert.equal(insightClaim.claim_priority, "medium");
  assert.ok((insightClaim.caveat_if_any || "").includes("context-level"));
});

// emerging_unmapped restriction removed 2026-06-15: status no longer exists.
// Sources that cannot map to taxonomy are discarded at the taxonomy gate.

test("a normal (validated) incident still keeps adoption_support", () => {
  const source = { id: "s10", url: "https://x", source_type: "incident", taxonomy_validation_status: "validated" };
  const item = { evidence_id: "e10", evidence_type: "incident_event", fact: "APT99 compromised a bank using a known toolkit in a confirmed breach.", source_quote: "APT99 compromised a bank using a known toolkit in a confirmed breach.", entities: ["APT99"], numbers: [] };
  const t = triageEvidenceItem(item, source, { observed_use: true });
  assert.ok(t.permitted_uses.includes("adoption_support"), "validated incident keeps adoption_support");
});

// ── 5B.1 — corpus-scoped captions ──────────────────────────────────────────────
console.log("5B.1 — every analytics chart spec is corpus-scoped with a caveat");

test("generated visualization specs all carry corpus_scoped + a caveat", () => {
  // Aggregates reads many flat *_counts keys; yield {} for any we don't provide so
  // the generator runs without crafting the full aggregate shape. The corpus_scoped
  // stamping happens in finalizeSpec→specDefaults, which is what we are asserting.
  const base = {
    category_counts: { llm_threats: 5, agentic_ai_threats: 2 },
    source_type_counts: { incident: 3, research_finding: 2 },
  };
  // Missing count-keys → {}; the one array-typed key (timeline_events) → [].
  const ag = new Proxy(base, { get: (t, p) => (p in t ? t[p] : (p === "timeline_events" ? [] : {})) });
  const specs = generateVisualizationSpecs(ag, []);
  assert.ok(specs.length > 0);
  for (const s of specs) {
    assert.equal(s.corpus_scoped, true, `${s.visualization_id} must be corpus_scoped`);
    assert.ok(s.caveat_if_any && s.caveat_if_any.length > 0, `${s.visualization_id} must carry a caveat`);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n──────────────────────────────────────────────────");
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
};

run();
