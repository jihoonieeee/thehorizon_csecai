/**
 * External evidence consolidation tests (Layer 5E → 5C). Deterministic — no network.
 * Covers: webEvidenceToExternalEvidence adapter, the statistic grounding gate,
 * deterministic statistic detection, and 5C auto-enable gating.
 * Run with: node tests/externalEvidenceAdapter.test.js
 */

import assert from "node:assert/strict";

import {
  webEvidenceToExternalEvidence, attachExternalEvidenceToPacks,
  buildExternalVisualSpecsForSlides, attachEvidenceReferencesToSpecs,
} from "../lib/pipeline/synthesis/externalEvidence.js";
import { validateWebEvidence } from "../lib/pipeline/webEvidence/validateWebEvidence.js";
import { makeWebEvidenceObject } from "../lib/pipeline/webEvidence/webEvidenceSchemas.js";
import { getWebEvidenceConfig, hasSearchProvider } from "../lib/pipeline/webEvidence/webEvidenceConfig.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

// ── Adapter ───────────────────────────────────────────────────────────────────
console.log("\nwebEvidenceToExternalEvidence adapter");

function sampleWebEvidence() {
  return {
    enabled: true,
    evidence_items: [{
      web_evidence_id: "webev_1", category: "llm_threats", evidence_depth: "detailed", confidence: "high",
      concrete_claim: "Prompt injection bypassed the Acme guardrail in 73% of trials.",
      source_grounding: { title: "Acme Study", publisher: "Lakera", source_url: "https://x/y",
        verbatim_quotes: ["bypassed the Acme guardrail in 73% of trials"] },
      source_lineage: { original_source_url: "https://orig/paper" },
      statistics: [{ metric: "guardrail bypass rate", value: "73%", timeframe: "2026", source_basis: "Lakera", quote: "bypassed the Acme guardrail in 73% of trials" }],
      walkthrough_status: "not_walkthrough", manual_review_required: false,
    }],
    visual_evidence: [{
      visual_evidence_id: "webvis_1", category: "llm_threats", visual_kind: "chart",
      source_url: "https://x/y", visual_url: "https://x/y/fig.png", what_it_shows: "bypass rate by model",
      visual_usefulness: { level: "high", recommended_slide_role: "supporting_visual" },
      slide_suitability: { decision: "embed", supports_slide_claim: "capability" },
      usage: { slide_usable: true, copyright_status: "public_report" },
      supports_evidence_ids: ["webev_1"], manual_review_required: false,
    }],
  };
}

test("maps depth→confidence, statistics→metric, lineage→url", () => {
  const ext = webEvidenceToExternalEvidence(sampleWebEvidence());
  const e = ext.external_evidence[0];
  assert.equal(e.evidence_confidence, "high");        // detailed → high
  assert.equal(e.evidence_type, "benchmark_result");  // hasStats + non-authoritative source → benchmark_result
  assert.equal(e.metric_name, "guardrail bypass rate");
  assert.equal(e.metric_value, "73%");
  assert.equal(e.url, "https://orig/paper");          // prefers original source
  assert.equal(e.exact_quote, "bypassed the Acme guardrail in 73% of trials");
});

test("maps visuals to embeddable external specs", () => {
  const ext = webEvidenceToExternalEvidence(sampleWebEvidence());
  assert.equal(ext.external_visual_evidence[0].slide_usable, true);
  const specs = buildExternalVisualSpecsForSlides(ext.external_visual_evidence);
  assert.equal(specs[0].chart_type, "image_embed_candidate");
});

test("groups evidence_by_category and counts high_confidence", () => {
  const ext = webEvidenceToExternalEvidence(sampleWebEvidence());
  assert.equal(ext.evidence_by_category.llm_threats.external_evidence_count, 1);
  assert.equal(ext.evidence_by_category.llm_threats.high_confidence, 1);
});

test("enriches packs with citations + references", () => {
  const ext = webEvidenceToExternalEvidence(sampleWebEvidence());
  const packs = attachExternalEvidenceToPacks(
    [{ category: "llm_threats", strong_evidence: [{ evidence_id: "c1", evidence_confidence: "high" }], usable_evidence: [], context_evidence: [] }],
    ext.external_evidence, ext.external_visual_evidence,
  );
  assert.equal(packs[0].strong_evidence[0].citation_quality, "moderate");
  assert.equal(packs[0].strong_evidence[0].external_references.length, 1);
});

test("references attach metric_name/value to viz specs", () => {
  const ext = webEvidenceToExternalEvidence(sampleWebEvidence());
  const specs = attachEvidenceReferencesToSpecs([{ category: "llm_threats" }], ext.external_evidence);
  assert.equal(specs[0].references[0].metric_value, "73%");
  assert.equal(specs[0].citation_note, "cited");
});

test("null / disabled web evidence → empty external shape", () => {
  for (const we of [null, { enabled: false }]) {
    const ext = webEvidenceToExternalEvidence(we);
    assert.deepEqual(ext.external_evidence, []);
    assert.deepEqual(ext.manual_review_items, []);
  }
});

// ── Statistic grounding gate ────────────────────────────────────────────────────
console.log("\nstatistic grounding gate (validateWebEvidence)");

function evWithStats(stats) {
  return makeWebEvidenceObject({
    evidence_depth: "concrete",
    concrete_claim: "Acme guardrail bypassed in trials.",
    statistics: stats,
    source_grounding: { source_url: "https://x/y", opened_url_confirmed: true,
      verbatim_quotes: ["the Acme guardrail was bypassed in 73% of trials"] },
  });
}

test("keeps a grounded statistic (number appears in its quote)", () => {
  const out = validateWebEvidence(evWithStats([
    { metric: "bypass rate", value: "73%", quote: "bypassed in 73% of trials" },
  ]));
  assert.equal(out.statistics.length, 1);
  assert.notEqual(out.validation_status, "rejected");
});

test("drops an ungrounded statistic without rejecting the item", () => {
  const out = validateWebEvidence(evWithStats([
    { metric: "made up", value: "99%", quote: "no number here" },          // 99% not in quote → drop
    { metric: "bypass rate", value: "73%", quote: "bypassed in 73% of trials" },
  ]));
  assert.equal(out.statistics.length, 1);
  assert.equal(out.statistics[0].value, "73%");
  assert.notEqual(out.validation_status, "rejected");   // item survives
});

test("a stat missing metric/value/quote is dropped", () => {
  const out = validateWebEvidence(evWithStats([{ value: "73%", quote: "bypassed in 73% of trials" }]));
  assert.equal(out.statistics.length, 0);
});

// ── Gating ──────────────────────────────────────────────────────────────────────
console.log("\n5C auto-enable gating");

test("off by default; requires WEB_EVIDENCE_ENABLED=1 regardless of provider keys", () => {
  const saved = { t: process.env.TAVILY_API_KEY, s: process.env.SERPAPI_API_KEY, e: process.env.WEB_EVIDENCE_ENABLED };
  delete process.env.WEB_EVIDENCE_ENABLED;
  delete process.env.TAVILY_API_KEY; delete process.env.SERPAPI_API_KEY;

  assert.equal(getWebEvidenceConfig().enabled, false, "no keys, no override → off");

  // Provider key alone must NOT auto-enable — keys may exist for Layer 1B discovery
  process.env.TAVILY_API_KEY = "k";
  assert.equal(getWebEvidenceConfig().enabled, false, "provider key alone must not enable L5C");

  // Explicit opt-in enables
  process.env.WEB_EVIDENCE_ENABLED = "1";
  assert.equal(getWebEvidenceConfig().enabled, true, "WEB_EVIDENCE_ENABLED=1 enables");

  process.env.WEB_EVIDENCE_ENABLED = "false";
  assert.equal(getWebEvidenceConfig().enabled, false, "explicit false forces off even with key");

  // hasSearchProvider still works as a utility (used elsewhere to check key availability)
  assert.equal(hasSearchProvider(), true, "hasSearchProvider still detects the key");

  // restore
  if (saved.t == null) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = saved.t;
  if (saved.s == null) delete process.env.SERPAPI_API_KEY; else process.env.SERPAPI_API_KEY = saved.s;
  if (saved.e == null) delete process.env.WEB_EVIDENCE_ENABLED; else process.env.WEB_EVIDENCE_ENABLED = saved.e;
});

console.log(`\nExternal evidence consolidation: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
