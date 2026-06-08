/**
 * Validation 3.2 — AI-Threat Relevance (LLM-led, deterministic pre-gate)
 *
 * Answers the core question: is this source genuinely ABOUT an AI threat, or
 * does it merely mention an AI keyword in passing?
 *
 * Flow (orchestrated by validateAndTypeSource.js):
 *   1. hasAiSignal() — cheap deterministic keyword pre-gate. Sources with no AI
 *      signal at all are discarded WITHOUT spending an LLM call.
 *   2. runRelevanceLlm() — cheap LLM (Haiku) reads the source and returns a
 *      2-3 sentence filler-free summary, an AI-threat focus verdict
 *      (central | passing | none), and the source_type, in one call.
 *   3. runRelevanceQa() — a second LLM (Haiku) verifies the verdict + summary
 *      are correct and grounded, and may correct the verdict / source_type.
 *
 * assessAiRelevance() (the original deterministic keyword scorer) is retained as
 * the offline / skipLlm fallback and is still used by the Layer 2 validator
 * (lib/pipeline/validate/validateSource.js).
 */

import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";
import { routedLLM }              from "../../llm/llmRouter.js";
import { ALL_SOURCE_TYPES, OLD_SOURCE_TYPE_MAP } from "../../config/sourceTypes.js";
import { DOMAINS }               from "../../config/taxonomyRegistry.js";

// Offensive domains plus the catch-all — the candidate_domain hint Layer 3 passes
// to Layer 4 so the taxonomy prompt can be scoped to one domain's tags.
const VALID_CANDIDATE_DOMAINS = new Set([...DOMAINS, "unclear_or_adjacent"]);

function normaliseDomain(raw) {
  return VALID_CANDIDATE_DOMAINS.has(raw) ? raw : "unclear_or_adjacent";
}

// ── Signal dictionaries ───────────────────────────────────────────────────────

const AI_SIGNALS = {
  high: [
    "prompt injection", "jailbreak", "llm", "large language model", "gpt", "gemini",
    "claude", "adversarial", "ai model", "machine learning attack", "data poisoning",
    "model extraction", "deepfake", "ai agent", "mcp", "agentic", "ai-enabled threat",
    "ai-powered attack", "ai safety", "ai security", "model backdoor", "rag poisoning",
    "model context protocol", "synthetic media", "voice cloning", "ai malware",
    "ai phishing", "training data poisoning", "model inversion", "foundation model attack",
    "embedding attack", "agent hijacking", "tool poisoning", "llm vulnerability",
  ],
  medium: [
    "artificial intelligence", "generative ai", "foundation model", "neural network",
    "ai system", "ai tool", "ai generated", "ai chatbot", "language model",
    "machine learning", "ml model", "ai bias", "responsible ai", "ai governance",
    "ai act", "ai regulation", "ai risk", "ai ethics",
  ],
  low: [
    "ai", "automation", "algorithm", "predictive", "intelligent system",
  ],
};

const CYBER_SIGNALS = {
  high: [
    "vulnerability", "cve-", "exploit", "malware", "ransomware", "threat actor",
    "apt", "zero-day", "0-day", "data breach", "attack campaign", "ioc",
    "indicators of compromise", "command and control", "c2", "ttps",
    "remote code execution", "rce", "privilege escalation", "lateral movement",
    "phishing", "social engineering", "supply chain attack", "backdoor",
  ],
  medium: [
    "cybersecurity", "security vulnerability", "security advisory", "patch",
    "mitigation", "threat intelligence", "incident response", "soc", "siem",
    "penetration testing", "red team", "blue team", "security research",
    "disclosure", "security incident", "data exfiltration",
  ],
  low: [
    "security", "risk", "attack", "defense", "hacking", "breach",
  ],
};

// ── Deterministic scoring (offline / skipLlm fallback) ─────────────────────────

function relevanceText(source) {
  return [source.title, source.summary, source.full_text?.slice(0, 2000)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function scoreSignals(text, signals) {
  const high   = signals.high.filter((s) => text.includes(s)).length;
  const medium = signals.medium.filter((s) => text.includes(s)).length;
  const low    = signals.low.filter((s) => text.includes(s)).length;

  let score = 0;
  score += Math.min(high,   5) * 14; // up to 70
  score += Math.min(medium, 3) * 8;  // up to 24
  score += Math.min(low,    2) * 3;  // up to 6
  return Math.min(100, score);
}

// ai_specificity: how central AI-cyber is to the source, not just mentioned.
function deriveSpecificityScore(aiScore, cyberScore) {
  const cyberBonus = Math.min(15, Math.round(cyberScore * 0.15));
  return Math.min(100, aiScore + cyberBonus);
}

function deriveRelevanceTier(specificityScore) {
  if (specificityScore >= 40) return "core";
  if (specificityScore >= 20) return "adjacent";
  if (specificityScore >= 10) return "peripheral";
  return "off_topic";
}

/**
 * Deterministic AI/cyber relevance scorer. Retained as the offline fallback and
 * for the Layer 2 validator. Not the primary path — see runRelevanceLlm().
 *
 * @param {object} source
 * @returns {{ ai_relevance_score, cyber_relevance_score, ai_specificity_score, relevance_tier }}
 */
export function assessAiRelevance(source) {
  const text = relevanceText(source);

  const ai_relevance_score    = scoreSignals(text, AI_SIGNALS);
  const cyber_relevance_score = scoreSignals(text, CYBER_SIGNALS);
  const ai_specificity_score  = deriveSpecificityScore(ai_relevance_score, cyber_relevance_score);
  const relevance_tier        = deriveRelevanceTier(ai_specificity_score);

  return { ai_relevance_score, cyber_relevance_score, ai_specificity_score, relevance_tier };
}

// ── Deterministic pre-gate ─────────────────────────────────────────────────────

// Word-boundary matching for the pre-gate. Naive substring matching produces
// false positives ("retailer" contains "ai", "source" contains "rce") that would
// leak nearly every source to the LLM and defeat the cost control. Anchoring on
// word boundaries keeps the pre-gate precise.
const _signalRegexCache = new Map();
function signalRegex(signal) {
  let re = _signalRegexCache.get(signal);
  if (!re) {
    const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`\\b${escaped}\\b`);
    _signalRegexCache.set(signal, re);
  }
  return re;
}
function countMatches(text, signals) {
  return signals.filter((s) => signalRegex(s).test(text)).length;
}

/**
 * Cheap pre-gate run BEFORE any LLM call. A source with no AI signal at all is
 * not about an AI threat — discard it without spending tokens. A source with at
 * least one AI keyword is a candidate the LLM must confirm (real focus vs. a
 * passing mention).
 *
 * @param {object} source
 * @returns {{ has_ai_signal: boolean, ai_hits: number, cyber_hits: number }}
 */
export function hasAiSignal(source) {
  const text = relevanceText(source);
  const ai_hits =
    countMatches(text, AI_SIGNALS.high) +
    countMatches(text, AI_SIGNALS.medium) +
    countMatches(text, AI_SIGNALS.low);
  const cyber_hits =
    countMatches(text, CYBER_SIGNALS.high) +
    countMatches(text, CYBER_SIGNALS.medium);
  return { has_ai_signal: ai_hits > 0, ai_hits, cyber_hits };
}

// ── Verdict → storage-field mapping ────────────────────────────────────────────

// Only a "central" focus is kept. A "passing" mention (the LLM confirming the
// source merely name-drops AI) is treated as off_topic so the final gate discards
// it — matching the product rule: keep only sources genuinely about an AI threat.
const FOCUS_TIER = {
  central: { relevance_tier: "core",      ai_specificity_score: 80 },
  passing: { relevance_tier: "off_topic", ai_specificity_score: 20 },
  none:    { relevance_tier: "off_topic", ai_specificity_score: 5 },
};

/**
 * Map an ai_threat_focus verdict to relevance_tier + a nominal ai_specificity_score.
 * (Layer 4 may refine ai_specificity_score later.)
 */
export function deriveRelevanceFromFocus(focus) {
  return FOCUS_TIER[focus] || FOCUS_TIER.none;
}

// ── source_type normalisation ──────────────────────────────────────────────────

const LLM_TYPE_NORMALISE = {
  ...OLD_SOURCE_TYPE_MAP,
  academic_research:            "research_finding",
  policy_regulatory_signal:     "governance_signal",
  ecosystem_market_signal:      "attack_surface_signal",
  strategic_foresight_signal:   "attack_surface_signal",
};

function normaliseSourceType(rawType) {
  if (!rawType) return null;
  const resolved = LLM_TYPE_NORMALISE[rawType] || rawType;
  return ALL_SOURCE_TYPES.includes(resolved) ? resolved : null;
}

function buildExcerpt(source) {
  // Hard cases need context — use up to 2500 chars of the best text available.
  return (source.summary && source.summary.length > 200
    ? source.summary
    : source.full_text || source.summary || "").slice(0, 2500);
}

const VALID_FOCUS = new Set(["central", "passing", "none"]);

// ── LLM call #1 — relevance + summary + source_type ────────────────────────────

/**
 * Haiku call #1. Reads the source and returns a filler-free 2-3 sentence summary,
 * an AI-threat focus verdict, and the source_type in a single call.
 *
 * @param {object} source
 * @param {object} [opts]
 * @param {Function} [opts.llmFn=routedLLM]  Injectable for tests; same signature as routedLLM.
 * @returns {Promise<{
 *   summary: string|null,
 *   ai_threat_focus: "central"|"passing"|"none",
 *   is_ai_threat: boolean,
 *   source_type: string|null,
 *   source_type_confidence: string,
 *   confidence: string,
 *   reasoning: string,
 *   llm_used: boolean,
 * }|null>}
 */
export async function runRelevanceLlm(source, opts = {}) {
  const { llmFn = routedLLM } = opts;
  try {
    const { system, user } = loadPrompt("validation-relevance");
    const filledUser = interpolate(user, {
      title:        source.title || "",
      publisher:    source.publisher || "Unknown",
      text_excerpt: buildExcerpt(source),
      tags:         (source.tags || []).join(", ") || "none",
    });

    const { result, llm_metadata } = await llmFn(system, filledUser, {
      task:          "source_relevance",
      requires_json: true,
      logLabel:      `L3-validation-relevance-${(source.id || "").slice(0, 16)}`,
    });

    if (!result || llm_metadata?.llm_used === false) return null;

    const focus = VALID_FOCUS.has(result.ai_threat_focus) ? result.ai_threat_focus : null;
    if (!focus) return null;

    return {
      summary:                typeof result.summary === "string" ? result.summary.trim() : null,
      ai_threat_focus:        focus,
      is_ai_threat:           result.is_ai_threat === true || focus === "central",
      candidate_domain:       focus === "central" ? normaliseDomain(result.candidate_domain) : "unclear_or_adjacent",
      source_type:            normaliseSourceType(result.source_type),
      source_type_confidence: result.source_type_confidence || result.confidence || "medium",
      confidence:             result.confidence || "medium",
      reasoning:              result.reasoning || "",
      llm_used:               true,
    };
  } catch {
    // LLM failure — caller falls back to the deterministic path.
    return null;
  }
}

// ── LLM call #2 — quality check ────────────────────────────────────────────────

/**
 * Haiku call #2. Independently verifies that call #1's summary is grounded in
 * the source and that the focus verdict + source_type are correct. May correct
 * either. Run only on accepted/borderline sources (cost control).
 *
 * @param {object} source
 * @param {object} firstResult  Output of runRelevanceLlm()
 * @param {object} [opts]
 * @param {Function} [opts.llmFn=routedLLM]
 * @returns {Promise<{
 *   verdict_correct: boolean,
 *   summary_grounded: boolean,
 *   corrected_ai_threat_focus: "central"|"passing"|"none",
 *   corrected_is_ai_threat: boolean,
 *   corrected_source_type: string|null,
 *   issues: string,
 *   llm_used: boolean,
 * }|null>}
 */
export async function runRelevanceQa(source, firstResult, opts = {}) {
  const { llmFn = routedLLM } = opts;
  try {
    const { system, user } = loadPrompt("validation-relevance-qa");
    const filledUser = interpolate(user, {
      title:           source.title || "",
      publisher:       source.publisher || "Unknown",
      text_excerpt:    buildExcerpt(source),
      summary:         firstResult.summary || "",
      ai_threat_focus: firstResult.ai_threat_focus,
      source_type:     firstResult.source_type || "unknown",
    });

    const { result, llm_metadata } = await llmFn(system, filledUser, {
      task:          "source_relevance_qa",
      requires_json: true,
      logLabel:      `L3-validation-relevance-qa-${(source.id || "").slice(0, 16)}`,
    });

    if (!result || llm_metadata?.llm_used === false) return null;

    const correctedFocus = VALID_FOCUS.has(result.corrected_ai_threat_focus)
      ? result.corrected_ai_threat_focus
      : firstResult.ai_threat_focus;

    return {
      verdict_correct:           result.verdict_correct !== false,
      summary_grounded:          result.summary_grounded !== false,
      corrected_ai_threat_focus: correctedFocus,
      corrected_is_ai_threat:
        typeof result.corrected_is_ai_threat === "boolean"
          ? result.corrected_is_ai_threat
          : correctedFocus === "central",
      corrected_source_type:     normaliseSourceType(result.corrected_source_type),
      issues:                    result.issues || "",
      llm_used:                  true,
    };
  } catch {
    return null;
  }
}
