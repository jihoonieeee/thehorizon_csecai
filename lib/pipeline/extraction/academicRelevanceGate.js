/**
 * academicRelevanceGate()
 *
 * Determines whether an academic/arXiv source contributes an offensive finding
 * worth deep extraction, or is a defensive/evaluation/survey paper that should
 * only receive a thin context item.
 *
 * Pass → extractAcademicEvidence will run its full specialist prompt.
 * Skip → a single low-specificity context item is returned (not discarded —
 *         useful for dashboard source counts and topic coverage).
 *
 * Deterministic rules handle the clear cases; an optional Haiku call resolves
 * ambiguous papers (e.g. a paper that mentions an attack but is primarily defensive).
 */

import { callLLM } from "../../llm/callLLM.js";

// ── Deterministic pass signals ────────────────────────────────────────────────

// Any of these in the summary/abstract indicates the paper proposes or demonstrates
// an offensive capability — pass without LLM.
const OFFENSIVE_SIGNALS = [
  "attack", "exploit", "poison", "bypass", "jailbreak", "adversarial",
  "extract", "inject", "evade", "evasion", "backdoor", "trojan",
  "manipulation", "we demonstrate", "we show", "we propose", "we present",
  "proof-of-concept", "proof of concept", "feasibility", "achieves",
  "success rate", "attack success", "we achieve", "our attack",
  "our method", "inversion", "membership inference", "extraction attack",
  "red-team", "red team", "offensive",
];

// Any of these as the PRIMARY content signal — skip without LLM.
const SKIP_SIGNALS = [
  "systematic review", "survey of", "sok:", "sok —", "sok–",
  "we survey", "literature review", "a review of",
  "benchmark of", "evaluation of defenses", "evaluation of defense",
  "defense against", "detection of", "we detect", "we defend",
  "mitigation", "we mitigate",
];

function textLower(source) {
  return (source.short_summary || source.summary || source.full_text || "")
    .slice(0, 2000)
    .toLowerCase();
}

// ── Deterministic gate ────────────────────────────────────────────────────────

function deterministicGate(source) {
  // Already classified as offensive by the understand layer — always pass.
  if (source.disposition === "offensive") return "pass";

  // Primary tag in offensive taxonomy → offensive paper.
  const tag = source.primary_tag || "";
  if (tag.startsWith("TAI") || tag.startsWith("LLM") ||
      tag.startsWith("ASI") || tag.startsWith("AE")) return "pass";

  // Explicit defensive source — skip deep extraction.
  if (source.is_defensive === true) return "skip";

  // Benchmark-only or evaluation-only source types.
  if (source.source_type === "benchmark_evaluation") return "skip";

  // Thin content — nothing to extract.
  if (source.content_quality === "thin_content") return "skip";

  const text = textLower(source);

  // Skip signals checked first (survey/SoK/defense papers).
  if (SKIP_SIGNALS.some(s => text.includes(s))) return "skip";

  // Offensive signals → pass.
  if (OFFENSIVE_SIGNALS.some(s => text.includes(s))) return "pass";

  // Ambiguous — let LLM decide.
  return "ambiguous";
}

// ── LLM tiebreaker ───────────────────────────────────────────────────────────

const GATE_SYSTEM = `You are an AI threat intelligence analyst evaluating whether an academic paper contributes a NEW OFFENSIVE finding worth deep evidence extraction.

Answer "pass" if the paper:
- Proposes, demonstrates, or evaluates a new attack on AI systems (models, LLMs, agents, training data, inference)
- Shows a meaningful feasibility shift (e.g. reduces adversary cost, skill, or compute)
- Introduces a new attack surface, vulnerability class, or evasion technique

Answer "skip" if the paper:
- Is primarily defensive, detection-focused, or mitigation-focused
- Is a survey, SoK, benchmark evaluation, or literature review without offensive contribution
- Describes capability improvements to AI models without an attack angle

Return ONLY valid JSON: {"gate": "pass"|"skip", "reason": "<one sentence>"}`;

async function llmGate(source, llmFn) {
  const abstract = (source.short_summary || source.summary || source.full_text || "")
    .slice(0, 1200);
  const usr = `TITLE: ${source.title}\nABSTRACT:\n${abstract}`;
  try {
    const fn = llmFn || callLLM;
    const raw = await fn(GATE_SYSTEM, usr, { json: true });
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      gate:   ["pass", "skip"].includes(parsed?.gate) ? parsed.gate : "pass",
      reason: parsed?.reason || "",
    };
  } catch {
    return { gate: "pass", reason: "llm_gate_failed_defaulting_to_pass" };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {object} source   - Post-understand source object
 * @param {object} [opts]
 * @param {Function} [opts.llmFn] - Injectable LLM function for testing
 * @returns {Promise<{gate: "pass"|"skip", reason: string}>}
 */
export async function academicRelevanceGate(source, opts = {}) {
  const deterministic = deterministicGate(source);
  if (deterministic !== "ambiguous") {
    return { gate: deterministic, reason: `deterministic_${deterministic}` };
  }
  return llmGate(source, opts.llmFn);
}
