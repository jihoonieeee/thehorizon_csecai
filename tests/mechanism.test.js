/**
 * Tests for the mechanism-first taxonomy mapping (Phase 0).
 * Covers every mapping-table row + every known-correction from
 * docs/taxonomy-feedback.md. Pure JS, no API.
 * Run: node --test tests/mechanism.test.js
 */
import assert from "node:assert/strict";
import { mapToTaxonomy, resolveDomain } from "../lib/pipeline/mechanism.js";
import { isValidTag } from "../lib/pipeline/taxonomy.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// helper: assert a mapping result
function expectMap(sig, { domain, primary, secondary, keep }) {
  const r = mapToTaxonomy(sig);
  if (domain !== undefined) assert.equal(r.domain, domain, `domain: got ${r.domain} (${r.rationale})`);
  if (primary !== undefined) assert.equal(r.primary_tag, primary, `primary: got ${r.primary_tag} (${r.rationale})`);
  if (secondary !== undefined) assert.deepEqual(r.secondary_tags, secondary, `secondary: got ${JSON.stringify(r.secondary_tags)}`);
  if (keep !== undefined) assert.equal(r.keep, keep, `keep: got ${r.keep} (${r.rationale})`);
  return r;
}

// ── All produced primary tags must be valid taxonomy IDs ────────────────────────
console.log("\n── tag validity ──");
const ALL_MECHS = [
  ["jailbreak_safety_bypass", "none"], ["prompt_injection", "none"],
  ["prompt_injection", "data_exfiltration"], ["prompt_injection", "tool_execution"],
  ["prompt_injection", "code_execution"], ["prompt_injection", "memory_persistence"],
  ["sensitive_info_disclosure", "data_exfiltration"], ["system_prompt_leakage", "data_exfiltration"],
  ["rag_knowledge_poisoning", "false_information"], ["vector_embedding_attack", "training_data_recovery"],
  ["unsafe_output_execution", "code_execution"], ["excessive_agency", "tool_execution"],
  ["resource_exhaustion", "resource_exhaustion"], ["misinformation_generation", "false_information"],
  ["data_poisoning", "none"], ["model_poisoning", "none"], ["adversarial_evasion", "response_manipulation"],
  ["model_extraction", "model_theft"], ["model_inversion", "training_data_recovery"],
  ["membership_inference", "training_data_recovery"], ["ai_social_engineering", "none"],
  ["ai_malware", "none"], ["ai_deepfake", "none"],
];
for (const [mech, cons] of ALL_MECHS) test(`valid tag: ${mech}/${cons}`, () => {
  const r = mapToTaxonomy({ primary_exploit_mechanism: mech, primary_consequence: cons });
  if (r.primary_tag !== null) assert.ok(isValidTag(r.primary_tag), `invalid tag ${r.primary_tag}`);
  for (const s of r.secondary_tags) assert.ok(isValidTag(s), `invalid secondary ${s}`);
});

// ── Known corrections (from feedback doc) ───────────────────────────────────────
console.log("\n── known corrections ──");

test("jailbreak → LLM11 (not LLM01/LLM09)", () => {
  expectMap({ primary_exploit_mechanism: "jailbreak_safety_bypass", primary_consequence: "response_manipulation", affected_layer: "prompt" },
    { domain: "llm_threats", primary: "LLM11_jailbreak_safety_bypass", keep: true });
});

test("RAG poisoning → LLM04 (not LLM08)", () => {
  expectMap({ primary_exploit_mechanism: "rag_knowledge_poisoning", primary_consequence: "false_information", affected_layer: "retrieval" },
    { domain: "llm_threats", primary: "LLM04_data_model_poisoning", keep: true });
});

test("embedding inversion → LLM08 (not LLM04)", () => {
  expectMap({ primary_exploit_mechanism: "vector_embedding_attack", primary_consequence: "training_data_recovery", affected_layer: "vector_database" },
    { domain: "llm_threats", primary: "LLM08_vector_embedding_weakness", keep: true });
});

test("credential theft → LLM02, LLM01 secondary only via injection", () => {
  // standalone disclosure
  expectMap({ primary_exploit_mechanism: "sensitive_info_disclosure", primary_consequence: "data_exfiltration", affected_layer: "application" },
    { domain: "llm_threats", primary: "LLM02_sensitive_info_disclosure", secondary: [] });
  // exfil via injection → LLM02 primary + LLM01 secondary
  expectMap({ primary_exploit_mechanism: "prompt_injection", primary_consequence: "data_exfiltration", affected_layer: "prompt" },
    { domain: "llm_threats", primary: "LLM02_sensitive_info_disclosure", secondary: ["LLM01_prompt_injection"] });
});

test("prompt injection → tool execution → ASI02 + LLM01 secondary (domain flips agentic)", () => {
  expectMap({ primary_exploit_mechanism: "prompt_injection", primary_consequence: "tool_execution", affected_layer: "agent" },
    { domain: "agentic_ai_threats", primary: "ASI02_tool_misuse_exploitation", secondary: ["LLM01_prompt_injection"] });
});

test("prompt injection → code execution → ASI05 + LLM01 secondary", () => {
  expectMap({ primary_exploit_mechanism: "prompt_injection", primary_consequence: "code_execution", affected_layer: "agent" },
    { domain: "agentic_ai_threats", primary: "ASI05_unexpected_code_execution", secondary: ["LLM01_prompt_injection"] });
});

test("prompt injection → memory persistence → ASI06 + LLM01 secondary", () => {
  expectMap({ primary_exploit_mechanism: "prompt_injection", primary_consequence: "memory_persistence", affected_layer: "agent" },
    { domain: "agentic_ai_threats", primary: "ASI06_memory_context_poisoning", secondary: ["LLM01_prompt_injection"] });
});

test("unsafe MD/HTML rendering of LLM output → LLM05", () => {
  expectMap({ primary_exploit_mechanism: "unsafe_output_rendering", primary_consequence: "response_manipulation", affected_layer: "application" },
    { domain: "llm_threats", primary: "LLM05_improper_output_handling", keep: true });
});

test("generic LLM product CVE → unclear (not LLM03/LLM05)", () => {
  expectMap({ primary_exploit_mechanism: "generic_software_vulnerability", is_cve: true, affected_layer: "application" },
    { domain: "unclear_or_adjacent", primary: null, keep: false });
});

test("hallucination central → LLM09", () => {
  expectMap({ primary_exploit_mechanism: "hallucination_generation", primary_consequence: "false_information" },
    { domain: "llm_threats", primary: "LLM09_misinformation", keep: true });
});

test("generic vuln detection / secure code gen → unclear", () => {
  expectMap({ primary_exploit_mechanism: "unknown", affected_layer: "application" },
    { domain: "unclear_or_adjacent", primary: null, keep: false });
});

// ── Traditional AI ──────────────────────────────────────────────────────────────
console.log("\n── traditional AI ──");
test("data poisoning → TAI01", () => {
  expectMap({ primary_exploit_mechanism: "data_poisoning", affected_layer: "dataset" },
    { domain: "traditional_ai_threats", primary: "TAI01_data_poisoning", keep: true });
});
test("model/weight/LoRA poisoning → TAI02", () => {
  expectMap({ primary_exploit_mechanism: "model_poisoning", affected_layer: "model" },
    { domain: "traditional_ai_threats", primary: "TAI02_model_poisoning", keep: true });
});
test("adversarial evasion → TAI03", () => {
  expectMap({ primary_exploit_mechanism: "adversarial_evasion", primary_consequence: "response_manipulation", affected_layer: "model" },
    { domain: "traditional_ai_threats", primary: "TAI03_adversarial_evasion", keep: true });
});
test("model extraction → TAI05 (not membership/inversion)", () => {
  expectMap({ primary_exploit_mechanism: "model_extraction", primary_consequence: "model_theft", affected_layer: "model" },
    { domain: "traditional_ai_threats", primary: "TAI05_model_extraction", keep: true });
});
test("model inversion → TAI06", () => {
  expectMap({ primary_exploit_mechanism: "model_inversion", primary_consequence: "training_data_recovery", affected_layer: "model" },
    { domain: "traditional_ai_threats", primary: "TAI06_model_inversion", keep: true });
});
test("membership inference → TAI07 (not extraction/inversion)", () => {
  expectMap({ primary_exploit_mechanism: "membership_inference", primary_consequence: "training_data_recovery", affected_layer: "model" },
    { domain: "traditional_ai_threats", primary: "TAI07_membership_inference", keep: true });
});
test("deprecated TAI04 is never produced", () => {
  for (const [mech, cons] of ALL_MECHS) {
    const r = mapToTaxonomy({ primary_exploit_mechanism: mech, primary_consequence: cons, affected_layer: "model" });
    assert.notEqual(r.primary_tag, "TAI04_adversarial_data");
  }
});

// ── AI-Enabled ──────────────────────────────────────────────────────────────────
console.log("\n── AI-enabled ──");
test("AI phishing → AE02 (not AE05 even if malware delivered)", () => {
  expectMap({ primary_exploit_mechanism: "ai_social_engineering", affected_layer: "application" },
    { domain: "ai_enabled_threats", primary: "AE02_ai_social_engineering", keep: true });
});
test("AI deepfake → AE10", () => {
  expectMap({ primary_exploit_mechanism: "ai_deepfake" },
    { domain: "ai_enabled_threats", primary: "AE10_ai_deepfake", keep: true });
});

// ── Supply chain routes by domain ───────────────────────────────────────────────
console.log("\n── supply chain domain routing ──");
test("supply chain: llm plugin → LLM03", () => {
  expectMap({ primary_exploit_mechanism: "supply_chain_compromise", affected_layer: "plugin_extension" },
    { domain: "llm_threats", primary: "LLM03_llm_supply_chain", keep: true });
});
test("supply chain: traditional model artifact → TAI10", () => {
  expectMap({ primary_exploit_mechanism: "supply_chain_compromise", affected_layer: "model" },
    { domain: "traditional_ai_threats", primary: "TAI10_ai_supply_chain_compromise", keep: true });
});
test("supply chain: agent ecosystem → ASI04", () => {
  expectMap({ primary_exploit_mechanism: "supply_chain_compromise", affected_layer: "agent" },
    { domain: "agentic_ai_threats", primary: "ASI04_agentic_supply_chain", keep: true });
});
test("supply chain: model-load RCE stays TAI10 (code_exec does NOT flip agentic)", () => {
  expectMap({ primary_exploit_mechanism: "supply_chain_compromise", primary_consequence: "code_execution", affected_layer: "model" },
    { domain: "traditional_ai_threats", primary: "TAI10_ai_supply_chain_compromise", keep: true });
});
test("LLM fine-tuning poisoning at app layer → LLM04 (not TAI01)", () => {
  expectMap({ primary_exploit_mechanism: "data_poisoning", affected_layer: "application", primary_consequence: "false_information" },
    { domain: "llm_threats", primary: "LLM04_data_model_poisoning", keep: true });
});
test("LLM RLHF poisoning via target_is_llm → LLM04 even at fine_tuning layer", () => {
  expectMap({ primary_exploit_mechanism: "data_poisoning", affected_layer: "fine_tuning", target_is_llm: true },
    { domain: "llm_threats", primary: "LLM04_data_model_poisoning", keep: true });
});
test("classic-ML poisoning at fine_tuning layer (no llm flag) stays TAI01", () => {
  expectMap({ primary_exploit_mechanism: "data_poisoning", affected_layer: "fine_tuning" },
    { domain: "traditional_ai_threats", primary: "TAI01_data_poisoning", keep: true });
});

// ── Benchmark / defense handling ────────────────────────────────────────────────
console.log("\n── benchmark / defense ──");
test("benchmark evaluating jailbreak → LLM11, role=benchmark", () => {
  const r = mapToTaxonomy({ primary_exploit_mechanism: "benchmark_or_evaluation", benchmark_target_mechanism: "jailbreak_safety_bypass" });
  assert.equal(r.primary_tag, "LLM11_jailbreak_safety_bypass");
  assert.equal(r.evidence_role, "benchmark");
});
test("general benchmark not tied to a mechanism → unclear", () => {
  expectMap({ primary_exploit_mechanism: "benchmark_or_evaluation" },
    { domain: "unclear_or_adjacent", primary: null, keep: false });
});
test("defense keeps defended category + is_defensive", () => {
  const r = mapToTaxonomy({ primary_exploit_mechanism: "jailbreak_safety_bypass", evidence_role: "defense", primary_consequence: "response_manipulation" });
  assert.equal(r.primary_tag, "LLM11_jailbreak_safety_bypass");
  assert.equal(r.is_defensive, true);
});

// ── resolveDomain direct checks ─────────────────────────────────────────────────
console.log("\n── resolveDomain ──");
test("consequence sets domain, not layer keyword", () => {
  // even with affected_layer=prompt, a tool_execution consequence is agentic
  assert.equal(resolveDomain({ primary_exploit_mechanism: "prompt_injection", affected_layer: "prompt", primary_consequence: "tool_execution" }), "agentic_ai_threats");
  // response manipulation stays llm
  assert.equal(resolveDomain({ primary_exploit_mechanism: "prompt_injection", affected_layer: "prompt", primary_consequence: "response_manipulation" }), "llm_threats");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
