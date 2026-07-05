import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeImportance, RULES_VERSION,
  strongestReality, confidenceCeilingForEvidence,
} from "../lib/pipeline/importance.js";

const tier = (s) => computeImportance(s).tier;

// ── The reality ladder: realized / proven / research (offensive, in-scope) ──
test("incident → realized", () => {
  assert.equal(tier({ source_type: "incident", main_category: "ai_enabled_threats", trust_tier: "high" }), "realized");
});
test("threat_intelligence (tracked adversary use) → realized", () => {
  assert.equal(tier({ source_type: "threat_intelligence", main_category: "ai_enabled_threats", trust_tier: "primary" }), "realized");
});
test("exploit_disclosure (PoC) → proven, NOT realized", () => {
  assert.equal(tier({ source_type: "exploit_disclosure", main_category: "agentic_ai_threats", trust_tier: "medium" }), "proven");
});
test("capability_demonstration → proven", () => {
  assert.equal(tier({ source_type: "capability_demonstration", main_category: "llm_threats", trust_tier: "high" }), "proven");
});
test("research_finding → research", () => {
  assert.equal(tier({ source_type: "research_finding", main_category: "llm_threats", trust_tier: "high" }), "research");
});

// ── In-the-wild phrase upgrades a CVE/PoC to realized (CISA-KEV semantics) ──
test("CVE text saying 'actively exploited' → realized", () => {
  assert.equal(tier({ source_type: "vulnerability", main_category: "agentic_ai_threats", trust_tier: "primary",
    short_summary: "This flaw is actively exploited in attacks." }), "realized");
});
test("plain CVE (no in-wild marker) → noise (disclosure, not realized)", () => {
  assert.equal(tier({ source_type: "vulnerability", main_category: "agentic_ai_threats", trust_tier: "primary",
    short_summary: "A broken access control vulnerability." }), "noise");
});

// ── Reference: authoritative advisory (any scope) ──
test("authoritative governance advisory → reference", () => {
  assert.equal(tier({ source_type: "governance_signal", main_category: "unclear_or_adjacent", trust_tier: "primary" }), "reference");
});
test("non-authoritative advisory → noise (provenance gates ONLY reference)", () => {
  assert.equal(tier({ source_type: "governance_signal", main_category: "unclear_or_adjacent", trust_tier: "medium" }), "noise");
});

// ── Noise: defenses, adjacent/unclear ──
test("defensive source → noise", () => {
  assert.equal(tier({ source_type: "defensive_capability", main_category: "llm_threats", trust_tier: "high" }), "noise");
});
test("adjacent/unclear offensive-typed → noise", () => {
  assert.equal(tier({ source_type: "incident", main_category: "unclear_or_adjacent", trust_tier: "high" }), "noise");
});

// ── Provenance NEVER gates the substance tiers: a weak-source real incident is still realized ──
test("weak-source in-the-wild incident → realized (substance beats prestige)", () => {
  const t = tier({ source_type: "incident", main_category: "ai_enabled_threats", trust_tier: "low" });
  assert.equal(t, "realized");
});

// ── is_defensive PRECEDENCE: resort judgment (mechanism_classification) wins over a stale flag ──
test("mc.is_defensive=false overrides a stale intelligence.is_defensive=true", () => {
  const s = { source_type: "research_finding", main_category: "llm_threats", trust_tier: "high",
    intelligence: { is_defensive: true, mechanism_classification: { is_defensive: false } } };
  assert.equal(tier(s), "research"); // offensive: the resort call (false) wins
});
test("mc.is_defensive absent → falls back to intelligence.is_defensive=true → noise", () => {
  const s = { source_type: "research_finding", main_category: "llm_threats", trust_tier: "high",
    intelligence: { is_defensive: true, mechanism_classification: {} } };
  assert.equal(tier(s), "noise"); // defensive via canonical flag
});

// ── Both source shapes work: normalise() output uses top-level fields ──
test("normalise() output shape (category + top-level is_defensive) tiers correctly", () => {
  const normaliseOutput = { source_type: "incident", category: "ai_enabled_threats", trust_tier: "high", is_defensive: false };
  assert.equal(tier(normaliseOutput), "realized");
  const defensiveOutput = { source_type: "research_finding", category: "llm_threats", trust_tier: "high", is_defensive: true };
  assert.equal(tier(defensiveOutput), "noise");
});

// ── Evidence-strength helpers (drive the claim-QA confidence ceiling) ──
test("strongestReality picks the most-real evidence item", () => {
  const evidence = [
    { source_type: "research_finding" },   // research
    { source_type: "capability_demonstration" }, // proven
    { source_type: "incident" },           // realized
  ];
  assert.equal(strongestReality(evidence), "realized");
});
test("strongestReality of research-only evidence is research", () => {
  assert.equal(strongestReality([{ source_type: "research_finding" }, { source_type: "benchmark_evaluation" }]), "research");
});
test("strongestReality of no substantive evidence is null", () => {
  assert.equal(strongestReality([{ source_type: "vulnerability" }, { source_type: "governance_signal" }]), null);
});
test("confidence ceiling: realized evidence → high", () => {
  assert.equal(confidenceCeilingForEvidence([{ source_type: "incident" }]), "high");
});
test("confidence ceiling: proven (PoC) evidence → medium", () => {
  assert.equal(confidenceCeilingForEvidence([{ source_type: "exploit_disclosure" }]), "medium");
});
test("confidence ceiling: research-only evidence → low", () => {
  assert.equal(confidenceCeilingForEvidence([{ source_type: "research_finding" }]), "low");
});
test("confidence ceiling: empty evidence → low", () => {
  assert.equal(confidenceCeilingForEvidence([]), "low");
});

// ── The record carries facets + version for traceability ──
test("computeImportance returns facets + rules_version", () => {
  const rec = computeImportance({ source_type: "incident", main_category: "ai_enabled_threats", trust_tier: "high" });
  assert.deepEqual(
    { tier: rec.tier, reality: rec.reality, posture: rec.posture, provenance: rec.provenance, rules_version: rec.rules_version },
    { tier: "realized", reality: "realized", posture: "offensive", provenance: "established", rules_version: RULES_VERSION }
  );
});
