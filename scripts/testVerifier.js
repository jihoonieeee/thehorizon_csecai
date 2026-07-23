/**
 * testVerifier.js — manual smoke test for the verifyAnswer contradiction detection.
 *
 * Feeds the verifier a crafted answer + source set where:
 *   - src-1 (Google): input sanitization is effective against prompt injection
 *   - src-2 (Anthropic): input sanitization is recommended as primary defense
 *   - src-3 (ETH Zürich): all tested input sanitization techniques can be bypassed
 *
 * The answer states sanitization is effective WITHOUT acknowledging the bypass
 * finding in src-3. Expectation:
 *   - contradictions: [{refs:["src-1","src-3"] or ["src-2","src-3"], tension:"..."}]
 *   - unreconciled: at least one entry flagging the answer overstated effectiveness
 *   - verdict: "mostly_grounded" or "weakly_grounded"
 *
 * Uses Gemini Flash as the LLM (adapts callGemini to the callHaikuJson interface).
 *
 * Usage:
 *   node scripts/testVerifier.js
 */

import "dotenv/config";
import { callGemini } from "../lib/llm/providers/gemini.js";
import { parseJsonLoose } from "../lib/agent/agentLlm.js";
import { verifyAnswer } from "../lib/agent/verifyAnswer.js";

// ── Gemini adapter matching the callHaikuJson interface ─────────────────────

// gemini-2.5-flash: disable thinking (thinkingBudget:0) so output tokens aren't
// consumed by internal chain-of-thought before the JSON response.
const GEMINI_MODEL = "gemini-2.5-flash";

async function callGeminiJson({ system, user, maxTokens }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { data: null, usage: { input_tokens: 0, output_tokens: 0 }, error: "no GEMINI_API_KEY" };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const fullPrompt = system ? `${system}\n\n---\n\n${user}` : user;
  const body = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      maxOutputTokens: maxTokens ?? 2000,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json();
    if (!res.ok) {
      return { data: null, usage: { input_tokens: 0, output_tokens: 0 }, error: json.error?.message };
    }
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const meta = json.usageMetadata || {};
    const data = parseJsonLoose(text);
    return {
      data,
      usage: { input_tokens: meta.promptTokenCount ?? 0, output_tokens: meta.candidatesTokenCount ?? 0 },
    };
  } catch (err) {
    return { data: null, usage: { input_tokens: 0, output_tokens: 0 }, error: err.message };
  }
}

// ── Test fixture ─────────────────────────────────────────────────────────────

// The answer overstates sanitization effectiveness without acknowledging the bypass.
const TEST_ANSWER = `
Assessment: Input sanitization is an effective primary defense against prompt injection (LLM01). Research from Google and Anthropic confirms its value in production environments, and it has become a standard mitigation in enterprise LLM deployments. Confidence is high based on multiple independent validations.

1. **Input sanitization blocks the majority of prompt injection attempts.** Google's 2024 evaluation found an 80% reduction in successful injections when robust sanitization was applied in production [src-1]. Anthropic independently recommends it as the primary structural defense [src-2].

2. **Enterprise adoption is accelerating.** Both primary and high-trust sources confirm organizations are deploying sanitization at the input layer as their first-line control.

So what: Organizations should prioritize input sanitization as a mature, validated control against LLM01 attacks.

Defenders: Implement strict input sanitization at the API gateway layer before any prompt reaches the model.
`.trim();

// Sources — src-3 contradicts src-1/src-2 but the answer ignores it.
const TEST_SOURCES = [
  {
    ref: "src-1",
    publisher: "Google DeepMind",
    title: "Evaluating Prompt Injection Defenses in Production LLM Systems (2024)",
    summary: "Comprehensive evaluation of prompt injection mitigations across 12 enterprise deployments. Input sanitization reduced successful injection rate by 80% compared to undefended baselines. Authors recommend sanitization as a primary layer. Study conducted on GPT-4 and Gemini models.",
    url: "https://deepmind.google/research/prompt-injection-defenses-2024",
    trust_tier: "high",
  },
  {
    ref: "src-2",
    publisher: "Anthropic",
    title: "Structural Defenses for LLM Deployments — Anthropic Security Guide",
    summary: "Anthropic recommends input sanitization as the primary structural defense against prompt injection in enterprise deployments. Guide covers sanitization patterns, allowlisting, and output filtering. Positions sanitization as mature and production-ready.",
    url: "https://anthropic.com/security/llm-defenses",
    trust_tier: "primary",
  },
  {
    ref: "src-3",
    publisher: "ETH Zürich",
    title: "Breaking Prompt Injection Defenses: A Systematic Bypass Study (2025)",
    summary: "Systematic evaluation of 7 widely-deployed input sanitization techniques against adversarial prompt reformulation. All 7 techniques were bypassed with success rates between 67–94% using gradient-based adversarial inputs. Authors conclude sanitization alone is insufficient and call for defense-in-depth approaches. Published at IEEE S&P 2025.",
    url: "https://ethz.ch/research/prompt-injection-bypass-2025",
    trust_tier: "high",
  },
];

const TEST_EVIDENCE = [
  {
    publisher: "ETH Zürich",
    source_title: "Breaking Prompt Injection Defenses: A Systematic Bypass Study (2025)",
    source_url: "https://ethz.ch/research/prompt-injection-bypass-2025",
    fact: "All 7 tested input sanitization techniques were successfully bypassed with gradient-based adversarial inputs.",
    quote: "No sanitization technique in our evaluation resisted adversarial reformulation; bypass rates ranged from 67% to 94%.",
    quote_grounded: true,
  },
];

// ── Run ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== verifyAnswer contradiction test (Gemini Flash) ===\n");
  console.log(`Model: ${GEMINI_MODEL}`);
  console.log(`Sources: ${TEST_SOURCES.length} (src-3 contradicts src-1/src-2)`);
  console.log("Expected: contradictions detected, unreconciled non-empty, verdict not 'grounded'\n");

  const result = await verifyAnswer({
    answer:   TEST_ANSWER,
    sources:  TEST_SOURCES,
    evidence: TEST_EVIDENCE,
    llmFn:    callGeminiJson,
  });

  console.log("── Result ──────────────────────────────────────────");
  console.log(`ran:       ${result.ran}`);
  console.log(`verdict:   ${result.verdict}`);
  console.log(`notes:     ${result.notes}`);
  console.log(`tokens:    in=${result.usage.input_tokens} out=${result.usage.output_tokens}\n`);

  console.log(`contradictions (${result.contradictions.length}):`);
  for (const c of result.contradictions) {
    console.log(`  refs: [${c.refs.join(", ")}]`);
    console.log(`  tension: ${c.tension}`);
  }

  console.log(`\nunreconciled (${result.unreconciled.length}):`);
  for (const u of result.unreconciled) {
    console.log(`  - ${u}`);
  }

  console.log(`\nunsupported (${result.unsupported.length}):`);
  for (const u of result.unsupported) {
    console.log(`  - ${u}`);
  }

  // Pass/fail check
  console.log("\n── Pass/fail ────────────────────────────────────────");
  const ok = {
    ran:           result.ran === true,
    not_grounded:  result.verdict !== "grounded",
    contradiction: result.contradictions.length > 0,
    unreconciled:  result.unreconciled.length > 0,
  };
  for (const [check, passed] of Object.entries(ok)) {
    console.log(`  ${passed ? "PASS" : "FAIL"}  ${check}`);
  }
  const allPass = Object.values(ok).every(Boolean);
  console.log(`\n${allPass ? "ALL PASS" : "SOME CHECKS FAILED"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
