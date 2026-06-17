/**
 * Tests for removed deterministic grading and fake precision (2026-06-17).
 *
 * Verifies:
 *   1. hype_flag does not cap evidence_strength
 *   2. null judgment_flags → gates return false, not regex-fired
 *   3. Regex patterns (ADOPTION_TERMS/TREND_SCOPE) are not used as load-bearing decisions
 *   4. Number grounding: off-by-one is flagged as ungrounded (no ±5% tolerance)
 *   5. inferSupportLevel returns fallback_unreviewed (not semantic label) without LLM
 *   6. tone_strength / tone_evidence_mismatch / evidence_strength absent from sourceIntent
 *   7. fallback_unreviewed blocks adoption_support in claim permissions
 *   8. validateCategoryAnalysis: adoption gate does NOT fire when implies_adoption is null
 *
 * Run: node tests/removedFakePrecision.test.js
 */

import assert from "node:assert/strict";
import { triageEvidenceItem } from "../lib/pipeline/evidenceTriage/evidenceTriage.js";
import { classifyFactSupport } from "../lib/pipeline/rawfact/evidenceFactQa.js";
import { classifySourceIntent } from "../lib/pipeline/rawfact/sourceIntent.js";
import { validateCategoryAnalysis } from "../lib/pipeline/analysis/validateCategoryAnalysis.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. hype_flag does NOT cap evidence_strength
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n1. hype_flag no longer caps evidence_strength");

test("item with hype_flag=true + concreteness_level=low can still be strong when LLM confirms", () => {
  // LLM says direct_demonstration=true + concrete_claim=true → should be strong
  // Previously, applyHypeCap would have capped this to usable.
  const item = {
    evidence_id: "ev1",
    evidence_type: "incident_event",
    fact: "Unprecedented surge: APT29 compromised 12 banks using AI-generated spear-phishing.",
    source_quote: "APT29 used AI-generated spear-phishing to compromise 12 banks in Q4 2025.",
    entities: ["APT29"],
    numbers: ["12"],
    hype_flag: true,
    concreteness_level: "low",  // pattern-derived low concreteness despite real content
    is_atomic: true,
    quote_verified: true,
  };
  const source = {
    id: "src1",
    url: "https://example.com/article",
    source_type: "threat_intelligence",
    trust_tier: "high",
  };
  const llm = {
    direct_demonstration: true,
    concrete_claim: true,
    source_type_fit: true,
    observed_use: true,
    quote_support: "directly_supports",
    support_level: "direct_fact",
    limitations: [],
  };
  const result = triageEvidenceItem(item, source, llm);
  // semantic_review_status = "reviewed" because LLM ran
  assert.equal(result.semantic_review_status, "reviewed",
    "LLM judgment → reviewed status");
  // strength should be strong — hype_flag cannot override LLM judgment
  assert.equal(result.evidence_strength, "strong",
    `hype_flag must not cap strength when LLM confirms: got ${result.evidence_strength}`);
  assert.ok(!result.limitations.includes("hype_flag_caps_strength"),
    "hype_flag_caps_strength limitation must not be added");
});

test("item with hype_flag=true without LLM → fallback_unreviewed (not strength-capped by regex)", () => {
  const item = {
    evidence_id: "ev2",
    evidence_type: "attack_method",
    fact: "AI-powered attacks are exploding at unprecedented scale.",
    source_quote: "",
    entities: [],
    numbers: [],
    hype_flag: true,
    concreteness_level: "low",
    is_atomic: true,
    quote_verified: false,
  };
  const source = {
    id: "src2", url: "https://example.com/blog",
    source_type: "research_finding", trust_tier: "medium",
  };
  // No LLM judgment
  const result = triageEvidenceItem(item, source, {});
  // Strength should be context_only (admissibility fails due to no quote) — not because of hype
  // The key point: hype_flag did NOT determine this; admissibility gate did
  assert.ok(["context_only", "context", "failed", "archive"].includes(
    result.admissibility === "failed" ? "failed" : result.evidence_strength
  ), "No quote → context or archive (not hype-capped)");
  assert.ok(!result.limitations.includes("hype_flag_caps_strength"),
    "hype_flag_caps_strength must not appear (function removed)");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. null judgment_flags → gates return false (no regex)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n2. null judgment_flags → gate returns false, not regex");

function makeCompactDossier(entries = []) {
  return {
    category: "llm_threats",
    id_index: new Map(entries.map(([id, meta]) => [id, meta])),
  };
}

const EV_RESEARCH = ["ev_r1", {
  origin: "5A_rawfact", source_type: "research_finding",
  evidence_strength: "usable", permitted_uses: ["fact_support"],
  limitations: [], publisher: "Lab", date: "2026-01-01",
}];

function makeJudgmentWithNullFlags(overrides = {}) {
  return {
    judgment_id: "j1",
    judgment_type: "capability_change",
    judgment: "Adversaries are actively deploying prompt injection in the wild at scale.",
    what_changed: "Deployment of prompt injection moved from lab to production environments.",
    causal_mechanism: "Increased LLM adoption created new attack surface at scale.",
    why_this_matters: "Defenders need to implement input validation immediately.",
    uncertainty: "Limited operational evidence — primarily research findings.",
    evidence_for: ["ev_r1"],
    evidence_against: [],
    confidence: "high",
    caveat_if_any: null,
    short_takeaway: "Prompt injection now deployed in production environments.",
    // judgment_flags missing → null after normalization
    judgment_flags: null,
    ...overrides,
  };
}

test("judgment with null judgment_flags: adoption gate does NOT fire (no regex fallback)", () => {
  // Text contains "adversaries are actively deploying" + "in the wild"
  // Old behavior: ADOPTION_TERMS regex would fire → gate fires → confidence capped to low
  // New behavior: flags are null → gate returns false → confidence NOT capped
  const raw = {
    strategic_judgments: [makeJudgmentWithNullFlags()],
    outlook_6_months: { observed_basis: "Research only.", projected_trajectory: "May continue.",
      reasoning: "Based on lab findings.", confidence: "low", supporting_evidence_ids: [] },
    evidence_gaps: [],
  };
  const v = validateCategoryAnalysis(raw, makeCompactDossier([EV_RESEARCH]));
  const j = v.strategic_judgments[0];
  assert.ok(j, "judgment should survive (null flags don't block outright)");
  // With null flags, adoption gate does NOT fire → confidence stays at high (only Gate 3 applies: 1 item → medium)
  assert.notEqual(j?.confidence, "low",
    "adoption gate must NOT cap to low when judgment_flags.implies_adoption is null");
});

test("judgment with explicit implies_adoption=true: adoption gate fires (LLM decision respected)", () => {
  // LLM explicitly flagged implies_adoption=true → gate should fire
  // Research evidence only → no observed_use → cap to low
  const raw = {
    strategic_judgments: [makeJudgmentWithNullFlags({
      judgment_flags: {
        implies_adoption: true, implies_operational: false, implies_trend: false,
        is_forward_looking: false, is_market_wide: false, is_lab_only: false,
      },
    })],
    outlook_6_months: { observed_basis: "Research.", projected_trajectory: "May grow.",
      reasoning: "Lab finding.", confidence: "low", supporting_evidence_ids: [] },
    evidence_gaps: [],
  };
  const v = validateCategoryAnalysis(raw, makeCompactDossier([EV_RESEARCH]));
  const j = v.strategic_judgments[0];
  assert.ok(j, "judgment should survive");
  // adoption gate fires because implies_adoption=true and no observed evidence
  assert.equal(j?.confidence, "low",
    "adoption gate MUST fire when LLM explicitly set implies_adoption=true");
});

test("judgment with explicit implies_adoption=false: adoption gate does NOT fire (text has adoption language)", () => {
  // LLM explicitly said false → gate must NOT fire even though text says "in the wild"
  const raw = {
    strategic_judgments: [makeJudgmentWithNullFlags({
      judgment_flags: {
        implies_adoption: false, implies_operational: false, implies_trend: false,
        is_forward_looking: false, is_market_wide: false, is_lab_only: true,
      },
    })],
    outlook_6_months: { observed_basis: "Research only.", projected_trajectory: "May continue.",
      reasoning: "Lab finding.", confidence: "low", supporting_evidence_ids: [] },
    evidence_gaps: [],
  };
  const v = validateCategoryAnalysis(raw, makeCompactDossier([EV_RESEARCH]));
  const j = v.strategic_judgments[0];
  assert.ok(j, "judgment should survive");
  assert.notEqual(j?.confidence, "low",
    "adoption gate must NOT fire when LLM explicitly set implies_adoption=false");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ADOPTION_TERMS / TREND_SCOPE not used as decisions
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n3. Regex patterns not used as load-bearing decisions");

test("trend scope text with null flags: trend gate does NOT fire", () => {
  const raw = {
    strategic_judgments: [makeJudgmentWithNullFlags({
      judgment: "Prompt injection attacks are increasingly common and growing rapidly.",
      what_changed: "Growing number of reported prompt injection incidents across platforms.",
      judgment_flags: null,
    })],
    outlook_6_months: { observed_basis: "Corpus data.", projected_trajectory: "May continue.",
      reasoning: "Corpus trend.", confidence: "low", supporting_evidence_ids: [] },
    evidence_gaps: [],
  };
  const v = validateCategoryAnalysis(raw, makeCompactDossier([EV_RESEARCH]));
  const j = v.strategic_judgments[0];
  // With null flags, trend gate does NOT fire → no "trend-scope claim" caveat
  assert.ok(j, "judgment should survive");
  const caveat = j?.caveat_if_any || "";
  assert.ok(!caveat.includes("trend-scope"),
    "trend-scope caveat must NOT be added when judgment_flags.implies_trend is null");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Number grounding: off-by-one flagged as ungrounded (no ±5% tolerance)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n4. Number grounding: no ±5% tolerance");

import { normalizeAllEvidenceItems } from "../lib/pipeline/rawfact/normalizeEvidenceItems.js";

function mkNormalizeSource(fact, quote, sourceText, over = {}) {
  return {
    id: "src1",
    url: "https://example.com/article",
    source_type: "research_finding",
    trust_tier: "high",
    full_text: sourceText,
    summary: sourceText.slice(0, 200),
    evidence_items_raw: [{
      evidence_id: "ev1",
      evidence_type: "benchmark_result",
      fact,
      source_quote: quote,
      entities: [],
      numbers: [],
      ...over,
    }],
    ...over,
  };
}

test("exact number in quote → item.number_grounded = true", () => {
  const sources = normalizeAllEvidenceItems([mkNormalizeSource(
    "The attack achieved 88% success rate.",
    "We achieved an 88% attack success rate on GPT-4.",
    "Full source with 88% attack success rate."
  )]);
  const item = sources[0]?.evidence_items?.[0];
  assert.ok(item, "evidence item should be normalized");
  // number_grounding_pass=true means 88% was found verbatim
  assert.equal(item.number_grounding_pass, true, `expected grounded, got ${item.number_grounding_pass}`);
});

test("off-by-one integer count → item.number_grounded = false, no tolerance", () => {
  // NUMBER_PATTERN extracts comma-formatted integers like "5,500" and "10,000".
  // Previously ±5% tolerance would accept 5,300 when source says 5,500.
  // Now strict: only verbatim match.
  const sources = normalizeAllEvidenceItems([mkNormalizeSource(
    "Over 5,300 repositories were affected in the campaign.",
    "We scanned 5,500 repositories and found malicious code.",
    "Full scan covered 5,500 repositories over three months."
  )]);
  const item = sources[0]?.evidence_items?.[0];
  assert.ok(item, "evidence item should be normalized");
  // 5,300 is not in source (source says 5,500) → should be ungrounded
  assert.equal(item.number_grounding_pass, false,
    "5,300 vs 5,500 must be flagged as ungrounded — ±5% tolerance was removed");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. inferSupportLevel returns fallback_unreviewed without LLM
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n5. classifyFactSupport returns fallback_unreviewed without LLM");

test("item without triage_judgment: support_level = fallback_unreviewed", () => {
  const item = {
    evidence_id: "ev1",
    source_type: "incident",  // previously would have returned "direct_fact"
    fact: "APT29 breached a financial institution using AI-generated phishing.",
    source_quote: "APT29 used AI-generated phishing to breach a financial institution.",
    triage_judgment: undefined,  // no LLM judgment
  };
  const qa = classifyFactSupport(item);
  assert.equal(qa.support_level, "fallback_unreviewed",
    `incident without LLM must be fallback_unreviewed, not direct_fact. Got: ${qa.support_level}`);
});

test("item without triage_judgment: blocked_uses includes adoption_support", () => {
  const item = {
    evidence_id: "ev1",
    source_type: "threat_intelligence",
    fact: "Threat actors are using AI for reconnaissance.",
    source_quote: "Threat actors have been observed using AI for reconnaissance.",
    triage_judgment: undefined,
  };
  const qa = classifyFactSupport(item);
  assert.ok(qa.blocked_uses.includes("adoption_support"),
    "fallback_unreviewed must block adoption_support");
  assert.ok(qa.blocked_uses.includes("fact_support"),
    "fallback_unreviewed must block fact_support");
});

test("item WITH triage_judgment: support_level is LLM-assigned", () => {
  const item = {
    evidence_id: "ev1",
    source_type: "research_finding",
    fact: "GPT-4 jailbroken at 88% ASR using PAIR.",
    source_quote: "We achieve 88% ASR on GPT-4 using PAIR in black-box mode.",
    triage_judgment: {
      support_level: "research_finding",
      quote_support: "directly_supports",
      direct_demonstration: true,
      concrete_claim: true,
    },
  };
  const qa = classifyFactSupport(item);
  assert.equal(qa.support_level, "research_finding",
    "LLM-assigned support_level must be used when present");
  assert.notEqual(qa.support_level, "fallback_unreviewed");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. tone_strength / tone_evidence_mismatch absent from sourceIntent output
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n6. sourceIntent no longer produces tone grading");

test("classifySourceIntent does not return tone_strength", () => {
  const source = {
    title: "Unprecedented Surge: AI-Powered Attacks Are Exploding at Alarming Scale",
    full_text: "The threat landscape has reached an all-time high with exponential growth of AI attacks.",
    source_type: "research_finding",
    publisher: "SecurityBlog",
    trust_tier: "medium",
  };
  const intent = classifySourceIntent(source);
  assert.ok(!("tone_strength" in intent),
    "tone_strength must not be present (removed 2026-06-17)");
  assert.ok(!("tone_evidence_mismatch" in intent),
    "tone_evidence_mismatch must not be present (removed)");
  assert.ok(!("evidence_strength" in intent),
    "evidence_strength must not be present in sourceIntent (removed)");
});

test("classifySourceIntent still returns intent_class, commercial_interest, evidence_posture", () => {
  const source = {
    title: "CVE-2025-1234: Remote Code Execution in Langflow",
    full_text: "CVE-2025-1234 allows unauthenticated RCE in Langflow 1.2.x.",
    source_type: "vulnerability",
    publisher: "NVD",
    trust_tier: "primary",
  };
  const intent = classifySourceIntent(source);
  assert.ok("intent_class" in intent, "intent_class must be present");
  assert.ok("commercial_interest" in intent, "commercial_interest must be present");
  assert.ok("evidence_posture" in intent, "evidence_posture must be present");
  assert.equal(intent.intent_class, "exploit_disclosure");
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. fallback_unreviewed blocks adoption in claim permissions
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n7. fallback_unreviewed blocks load-bearing claim permissions");

import { buildClaimPermissions } from "../lib/pipeline/rawfact/buildClaimPermissions.js";

test("fallback_unreviewed factQa blocks adoption in buildClaimPermissions", () => {
  const item = {
    evidence_id: "ev1",
    source_type: "incident",
    triage_data: { evidence_strength: "usable", permitted_uses: ["adoption_support", "fact_support"] },
    triage_judgment: undefined,  // no LLM → fallback_unreviewed
    fact: "APT29 attacked financial institutions.",
    source_quote: "APT29 attacked financial institutions.",
  };
  const factQa = classifyFactSupport(item);
  const perms = buildClaimPermissions(item, "incident", factQa, null);
  // adoption should be blocked because factQa.support_level = "fallback_unreviewed"
  assert.ok(perms.blocked_claim_types.includes("adoption"),
    "fallback_unreviewed factQa must block adoption claim type");
});

test("LLM-reviewed item with direct_fact can support adoption for inherently-observed types", () => {
  const item = {
    evidence_id: "ev1",
    source_type: "incident",
    triage_data: {
      evidence_strength: "strong",
      permitted_uses: ["adoption_support", "fact_support", "case_study"],
      observed_use: true,
    },
    triage_judgment: {
      support_level: "direct_fact",
      quote_support: "directly_supports",
      direct_demonstration: true,
      concrete_claim: true,
      observed_use: true,
    },
    fact: "APT29 compromised 12 banks using AI-generated spear-phishing.",
    source_quote: "APT29 used AI-generated phishing to compromise 12 banks.",
  };
  const factQa = classifyFactSupport(item);
  const perms = buildClaimPermissions(item, "incident", factQa, null);
  assert.ok(!perms.blocked_claim_types.includes("adoption"),
    "LLM-reviewed direct_fact incident must NOT block adoption");
  assert.ok(perms.permitted_claim_types.includes("adoption"),
    "LLM-reviewed incident should permit adoption claim");
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`Removed fake precision: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
