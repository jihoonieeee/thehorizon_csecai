/**
 * Tests for the second-stage evidence-role classifier (LLM01 / LLM02).
 * Ground-truth examples are taken verbatim from the user's audit.
 * Run: node --test tests/classifyEvidenceRole.test.js
 */
import assert from "node:assert/strict";
import { classifyLlm02, classifyLlm01 } from "../lib/pipeline/classifyEvidenceRole.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
const src = (title, summary = "") => ({ title, short_summary: summary });

// ── LLM02: keep (confidentiality is primary) ────────────────────────────────────
console.log("\n── LLM02 keep ──");
const LLM02_KEEP = [
  ["Amazon Q Flaw Enabled Cloud Credential Theft via Malicious Repositories", "a vulnerability allowed attackers to steal AWS cloud credentials via malicious repositories, a supply-chain credential theft"],
  ["Hundreds of AI-powered iOS apps found exposing credentials", "282 of 444 iOS apps exposed API credentials and backend access through network traffic, a credential leak"],
  ["Malicious JetBrains Plugins Steal AI API Keys as Chrome Extensions Capture Chats", "malicious plugins steal AI provider API keys and credentials from developers"],
  ["Mind your key: An Empirical Study of LLM API Credential Leakage in iOS Apps", "444 iOS apps leak LLM API credentials in network traffic via JWT tokens and unauthenticated proxies"],
  ["Understanding and Mitigating Prompt Leaking Attacks in Real-World LLM-Based Applications", "over 80% of apps leak system prompts under adversarial queries, sometimes exposing API keys; proposes AREA"],
  ["Five Queries Are Enough: Membership Inference Attacks on RAG", "query-efficient membership inference attack against RAG systems infers whether documents are in the retrieval corpus"],
  ["Pop Quiz Attack: Black-box Membership Inference Attacks Against Large Language Models", "membership inference method against LLMs using quiz-style prompts to determine if training data was memorized"],
  ["E-MIA: Exam-Style Black-Box Membership Inference Attacks against RAG Systems", "black-box membership inference attack against RAG systems infers whether documents exist in a knowledge base"],
  ["IDP-Bench: Benchmarking ability of LLMs to protect personal information", "benchmark evaluating LLMs' ability to protect personal information in interdependent privacy contexts"],
  ["Bifrost: Hybrid TEE-FHE Inference for Privacy-Preserving Transformer and LLM Serving", "protects LLM inference confidentiality by keeping user prompts and sensitive data encrypted during cloud serving"],
  ["SharedRequest: Privacy-Preserving Model-Agnostic Inference for Large Language Models", "privacy-preserving inference framework protects user prompt privacy by mixing queries"],
  ["Caught in the Act(ivation): Detection of Credential Exfiltration by LLM Agents", "LLM agents expose sensitive credentials in context windows vulnerable to indirect prompt injection; proposes defenses"],
  ["CVE-2026-56268: Flowise information disclosure vulnerability", "Flowise before 3.1.2 information disclosure allows an attacker to retrieve sensitive chatflow configurations including system prompts from other workspaces"],
  ["CVE-2026-54009: Open WebUI information disclosure vulnerability", "Open WebUI allows authenticated users to access other users' files via an unvalidated image_url parameter, exfiltrating sensitive data"],
  ["CVE-2025-66389: GitHub Copilot filesystem access outside workspace", "GitHub Copilot file-handler URI permits unauthorized filesystem access outside workspace boundaries, enabling data exfiltration"],
];
for (const [t, s] of LLM02_KEEP) test(`keep: ${t.slice(0, 48)}`, () => {
  const r = classifyLlm02(src(t, s));
  assert.equal(r.keep, true, `expected keep; got role=${r.evidence_role} (${r.rationale})`);
  assert.equal(r.primary_security_property, "confidentiality");
});

// ── LLM02: move out ─────────────────────────────────────────────────────────────
console.log("\n── LLM02 move-out ──");
const LLM02_OUT = [
  ["macOS.Gaslight Rust Backdoor Turns Prompt Injection on the Analyst, Not the Sandbox", "a Rust macOS backdoor embeds a prompt-injection payload to manipulate LLM-assisted triage into aborting analysis"],
  ["NeuroArmor: Safe-Variant-Guided Representation Consistency for Jailbreak Defense", "white-box runtime defense that detects and mitigates jailbreak attacks on LLMs"],
  ["MultiTurnPSB: Evaluating Multi-Turn Jailbreak Attacks for Medical AI Safety", "benchmark extending to four-turn adversarial conversations, unsafe responses rise under jailbreak"],
  ["Adaptive Probe-based Steering for Robust LLM Jailbreaking", "adaptive probe-based steering method for jailbreaking LLMs to improve robustness"],
  ["Cordyceps: Covert Control Attacks on LLMs via Data Poisoning", "data poisoning attack teaches LLMs an information-hiding scheme enabling covert control via encoded malicious instructions"],
  ["Alignment Tampering: How RLHF Is Exploited to Optimize Misaligned Biases", "alignment tampering exploits RLHF where LLMs influence their own preference datasets, amplifying misaligned biases"],
  ["SPARK: Security Knowledge Priming for LLM-based Secure Code Generation", "inference-time defense that activates latent security knowledge for secure code generation"],
  ["Risk Under Pressure: Compute-Aware Evaluation of Adversarial Robustness in Language Models", "compute-aware evaluation framework measures adversarial robustness of LLMs by quantifying effort to jailbreak"],
  ["Representation Matters: An Empirical Study of Program Representations for LLM Vulnerability Reasoning", "empirical study of how program representation affects LLM vulnerability detection accuracy"],
  ["RealVuln: Benchmarking Security Scanners on Real-World Code", "benchmark evaluating 15 security scanners on 796 hand-labeled vulnerabilities in real-world code"],
];
for (const [t, s] of LLM02_OUT) test(`out: ${t.slice(0, 48)}`, () => {
  const r = classifyLlm02(src(t, s));
  assert.equal(r.keep, false, `expected move-out; got role=${r.evidence_role} (${r.rationale})`);
});

// ── LLM01: keep vs move-out (user's split) ──────────────────────────────────────
console.log("\n── LLM01 keep ──");
const LLM01_KEEP = [
  ["Web-Based Indirect Prompt Injection Observed in the Wild", "widespread in-the-wild indirect prompt injection embedded in web content targeting LLMs and agents"],
  ["Prompt Injection as Role Confusion", "LLMs struggle to distinguish privileged system text from untrusted user input — a role confusion vulnerability"],
  ["New AI attack hides data-theft prompts in downscaled images", "multimodal prompt injection hides malicious instructions in images exploiting downscaling"],
  ["Structural Role Injection in Handlebars-Templated LLM Prompts", "structural role injection attacks in LLM prompt templates targeting Handlebars templating"],
  ["Leave My Images Alone: Preventing MLLMs from Analyzing Images via Visual Prompt Injection", "user-side defense embedding perturbations to trigger refusal via visual prompt injection"],
];
for (const [t, s] of LLM01_KEEP) test(`keep: ${t.slice(0, 48)}`, () => {
  const r = classifyLlm01(src(t, s));
  assert.equal(r.keep, true, `expected keep; got role=${r.evidence_role} (${r.rationale})`);
});

console.log("\n── LLM01 move-out (jailbreak/other) ──");
const LLM01_OUT = [
  ["GAS-Leak-LLM: Genetic Algorithm-Based Suffix Optimization for Black-Box LLM Jailbreaking", "black-box jailbreaking using genetic algorithms to evolve adversarial suffixes bypassing safety"],
  ["JailbreakOPT: Tool-Assisted Iterative Jailbreak Prompt Optimization", "automated framework generating optimized jailbreak prompts against LLMs"],
  ["DoubtProbe: Black-Box Jailbreak Defense via Structural Verification", "inference-time defense detecting black-box LLM jailbreaks"],
  ["Babel: Jailbreaking Safety Attention via Obfuscation Distribution Optimized Sampling", "black-box jailbreak exploiting sparsely distributed safety attention heads through obfuscation"],
  ["ContextualJailbreak: Evolutionary Red-Teaming via Simulated Conversational Priming", "black-box evolutionary red-teaming automates multi-turn jailbreak attacks via contextual priming"],
  ["Cordyceps: Covert Control Attacks on LLMs via Data Poisoning", "data poisoning attack teaches LLMs an information-hiding scheme via encoded malicious instructions"],
  ["Misrouter: Exploiting Routing Mechanisms for Input-Only Attacks on Mixture-of-Experts LLMs", "input-only adversarial attack exploiting MoE routing to bypass safety alignment"],
];
for (const [t, s] of LLM01_OUT) test(`out: ${t.slice(0, 48)}`, () => {
  const r = classifyLlm01(src(t, s));
  assert.equal(r.keep, false, `expected move-out; got role=${r.evidence_role} (${r.rationale})`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
