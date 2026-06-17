/**
 * Regression tests for the P0 fixes from docs/audits/layers-4-6-critical-audit.md.
 *
 *   5A.1 — quote entailment / claim-preservation floor is enforced into evidence_strength
 *   6.2  — claimQa reads triage_data (admissible set is no longer always empty)
 *   6.1  — claim-chain claim_type values reach the correct QA gate
 *   5C.1 — external (5C) evidence defaults to context_only unless validated + grounded
 *   5C.2 — external (5C) evidence is not treated as observed real-world use
 *
 * Run with: node tests/p0AuditFixes.test.js
 */

import assert from "node:assert/strict";
import { triageEvidenceItem } from "../lib/pipeline/evidenceTriage/evidenceTriage.js";
import { normalizeSourceEvidenceItems } from "../lib/pipeline/rawfact/normalizeEvidenceItems.js";
import { qaAnalyticalClaim } from "../lib/pipeline/analysis/claimQa.js";
import { buildCategoryEvidenceDossier } from "../lib/pipeline/analysis/buildCategoryEvidenceDossier.js";
import { validateCategoryAnalysis } from "../lib/pipeline/analysis/validateCategoryAnalysis.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

// ── 5A.1 — entailment floor enforced into strength ─────────────────────────────

const obsSource = { id: "s1", url: "https://example.com/a", source_type: "incident" };
const baseItem = {
  evidence_id: "e1",
  evidence_type: "incident_event",
  fact: "CVE-2026-1 was actively exploited in the wild by APT99 against banks.",
  source_quote: "CVE-2026-1 was actively exploited in the wild by APT99 against banks.",
  entities: ["APT99", "CVE-2026-1"],
  numbers: [],
};

console.log("5A.1 — quote entailment floor");

test("no quote_verification → passes to strong (baseline)", () => {
  const t = triageEvidenceItem(baseItem, obsSource, {});
  assert.equal(t.admissibility, "passed");
  assert.equal(t.evidence_strength, "strong");
});

test("overstated quote → capped at context_only / context", () => {
  const item = { ...baseItem, quote_verification: {
    quote_exists: true, quote_entailment: "partially_supported", claim_preservation: "overstated",
  } };
  const t = triageEvidenceItem(item, obsSource, {});
  assert.equal(t.admissibility, "context_only");
  assert.equal(t.evidence_strength, "context");
});

test("partially_supported quote → context_only", () => {
  const item = { ...baseItem, quote_verification: {
    quote_exists: true, quote_entailment: "partially_supported", claim_preservation: "preserved",
  } };
  assert.equal(triageEvidenceItem(item, obsSource, {}).admissibility, "context_only");
});

test("unsupported / changed_meaning quote → failed / archive", () => {
  const item = { ...baseItem, quote_verification: {
    quote_exists: false, quote_entailment: "unsupported", claim_preservation: "changed_meaning",
  } };
  const t = triageEvidenceItem(item, obsSource, {});
  assert.equal(t.admissibility, "failed");
  assert.equal(t.evidence_strength, "archive");
});

test("normalizeItem carries quote_verification forward (not dropped)", () => {
  const src = {
    id: "s2", source_type: "incident", main_category: "llm_threats",
    clean_text: "APT99 actively exploited CVE-2026-1 in the wild against banks.",
    evidence_eligibility: { evidence_use: "primary_evidence" },
    extraction_profile: { allowed_evidence_types: ["incident_event"], max_items: 3 },
    evidence_items_raw: [{
      evidence_id: "ev_s2_1", evidence_type: "incident_event",
      fact: "APT99 actively exploited CVE-2026-1 in the wild against banks.",
      source_quote: "APT99 actively exploited CVE-2026-1 in the wild against banks.",
      entities: ["APT99"], evidence_confidence: "high", best_used_for: ["case_study"],
      quote_verification: { quote_exists: true, quote_entailment: "supported", claim_preservation: "preserved" },
    }],
  };
  const out = normalizeSourceEvidenceItems(src);
  assert.equal(out.evidence_items.length, 1);
  assert.ok(out.evidence_items[0].quote_verification, "quote_verification should survive normalization");
  assert.equal(out.evidence_items[0].quote_verification.claim_preservation, "preserved");
});

// ── 6.2 / 6.1 — claimQa reads triage_data + claim_type routing ────────────────

function pkt(over = {}) {
  return {
    evidence_id: over.id || "p",
    evidence_type: over.etype || "incident",
    source_type: over.stype || "incident",
    publisher: over.pub || "PubA",
    date_published: over.date || "2026-01-15",
    entities: over.entities || ["EntityX"],
    triage_data: {
      evidence_strength: over.strength || "strong",
      admissibility: "passed",
      observed_use: over.observed === true,
      permitted_uses: over.observed ? ["adoption_support", "fact_support"] : ["fact_support"],
      limitations: over.limitations || [],
    },
  };
}

console.log("6.2 — claimQa reads triage_data");

test("insight with one strong triage_data packet is supported (admissible set non-empty)", () => {
  const claim = { claim_type: "category_insight", claim_text: "Prompt injection is the dominant LLM attack class." };
  const r = qaAnalyticalClaim(claim, [pkt({ id: "e1", strength: "strong" })], { analysis_allowed: "full" });
  assert.equal(r.allowed_to_proceed, true);
  assert.equal(r.claim_support_status, "supported");
});

test("insight backed only by context evidence proceeds but is flagged", () => {
  const ctxPkt = { evidence_id: "c1", entities: ["X"], triage_data: { evidence_strength: "context", admissibility: "context_only", permitted_uses: ["context_only"], limitations: [] } };
  const claim = { claim_type: "category_insight", claim_text: "An analytical observation about the category landscape." };
  const r = qaAnalyticalClaim(claim, [ctxPkt], { analysis_allowed: "full" });
  assert.equal(r.allowed_to_proceed, true);
  assert.equal(r.claim_support_status, "partially_supported");
});

console.log("6.1 — claim_type routing reaches strict gates");

test("trend_claim routes to the trend gate (single item → overgeneralized, blocked)", () => {
  const claim = { claim_type: "trend_claim", claim_text: "Attacks are surging across the ecosystem." };
  const r = qaAnalyticalClaim(claim, [pkt({ id: "e1", strength: "strong" })], {});
  assert.equal(r.claim_support_status, "overgeneralized");
  assert.equal(r.allowed_to_proceed, false);
});

test("trend with 3 items / 2 publishers / 2 months is supported", () => {
  const r = qaAnalyticalClaim(
    { claim_type: "trend_claim", claim_text: "A growing pattern across the corpus." },
    [
      pkt({ id: "e1", pub: "PubA", date: "2026-01-10" }),
      pkt({ id: "e2", pub: "PubB", date: "2026-02-10" }),
      pkt({ id: "e3", pub: "PubA", date: "2026-02-20" }),
    ], {},
  );
  assert.equal(r.allowed_to_proceed, true);
});

test("insight with adoption language routes to adoption gate (no observed → blocked)", () => {
  const claim = { claim_type: "category_insight", claim_text: "This technique is now used by attackers in the wild." };
  const r = qaAnalyticalClaim(claim, [pkt({ id: "e1", strength: "strong", observed: false })], {});
  assert.equal(r.allowed_to_proceed, false);
});

test("adoption claim with observed_use packet is supported", () => {
  const claim = { claim_type: "category_insight", claim_text: "This technique is now used by attackers in the wild." };
  const r = qaAnalyticalClaim(claim, [pkt({ id: "e1", strength: "strong", observed: true, stype: "incident" })], {});
  assert.equal(r.allowed_to_proceed, true);
});

// ── 5C.1 / 5C.2 — external evidence bounds ────────────────────────────────────

console.log("5C.1 — external evidence permitted_uses");

const webDossier = {
  category: "llm_threats", source_count: 5,
  rawfact: { external_evidence: [
    {
      evidence_id: "webev_weak", concrete_claim: "Weak external claim",
      source_grounding: { verbatim_quotes: ["a sufficiently long verbatim quote to pass the grounding check"], publisher: "RandomBlog", source_url: "https://blog.example/x" },
      validation_status: "weak",
    },
    {
      evidence_id: "webev_ok", concrete_claim: "Validated external claim",
      source_grounding: { verbatim_quotes: ["another sufficiently long verbatim quote that grounds the claim here"], publisher: "CISA", source_url: "https://cisa.gov/y" },
      validation_status: "validated",
    },
  ] },
};

test("weak external item → context_only only", () => {
  const cd = buildCategoryEvidenceDossier(webDossier);
  const m = cd.id_index.get("webev_weak");
  assert.ok(m, "weak item should still be indexed");
  assert.deepEqual(m.permitted_uses, ["context_only"]);
  assert.ok(m.limitations.includes("external_unverified"));
});

test("validated + grounded external item → may fact_support", () => {
  const cd = buildCategoryEvidenceDossier(webDossier);
  const m = cd.id_index.get("webev_ok");
  assert.ok(m.permitted_uses.includes("fact_support"));
});

console.log("5C.2 — external evidence is not observed-use");

test("adoption insight cited ONLY by 5C is downgraded (5C not observed)", () => {
  const compact = {
    category: "llm_threats",
    id_index: new Map([
      ["webev_ok", { origin: "5C_external", source_type: "external", permitted_uses: ["context_only", "fact_support"], limitations: [], observed_use: false, publisher: "CISA", date: null }],
    ]),
  };
  const raw = {
    strategic_judgments: [{
      judgment_id: "j1", judgment_type: "adversary_adoption",
      judgment: "Adversaries are adopting this technique in the wild.",
      what_changed: "Observed shift from research to operational adversary use.",
      causal_mechanism: "Low barrier to entry enables rapid adoption by threat actors.",
      why_this_matters: "Defenders face live attacks, not just theoretical risk.",
      uncertainty: "Evidence limited to single web source.",
      evidence_for: ["webev_ok"], evidence_against: [], confidence: "high", caveat_if_any: null,
      slide_usefulness: "high", recommended_actions: [],
      // LLM must set implies_adoption=true for adoption gate to fire (regex fallback removed)
      judgment_flags: { implies_adoption: true, implies_operational: false, implies_trend: false,
        is_forward_looking: false, is_market_wide: false, is_lab_only: false },
      short_takeaway: "Adversaries actively adopting this technique in the wild.",
    }],
    outlook_6_months: { observed_basis: "Web evidence only.", projected_trajectory: "Adoption may increase.", reasoning: "Early signal.", confidence: "low", supporting_evidence_ids: [] },
    evidence_gaps: [],
  };
  const v = validateCategoryAnalysis(raw, compact);
  const ins = v.strategic_judgments[0];
  assert.ok(ins, "insight should resolve (id is valid)");
  assert.equal(ins.confidence, "low", "adoption claim backed only by non-observed 5C must be capped to low");
  assert.ok((ins.caveat_if_any || "").toLowerCase().includes("adoption"));
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n──────────────────────────────────────────────────");
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
