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
  return [source.title, source.summary, source.full_text?.slice(0, 6000)]
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

// ── Track B: Novelty signal patterns ─────────────────────────────────────────
// Captures emerging AI-security techniques that may not yet use standard
// AI-threat vocabulary. Sources matching these never get pre-gate discarded —
// they route to review/emerging bucket for LLM confirmation.

const NOVELTY_SIGNAL_PATTERNS = [
  // Autonomous system/agent + tool use + security boundary
  /autonomous\s+(?:system|agent).{0,80}(?:tool\s+use|security\s+boundary|access\s+control)/i,
  /(?:tool\s+use|function\s+call).{0,80}(?:autonomous|security\s+boundary|privilege)/i,
  // Model/service integration + exploit/abuse/compromise
  /(?:model|service)\s+integration.{0,80}(?:exploit|abuse|compromise|attack)/i,
  /(?:exploit|abuse|compromise).{0,80}(?:model|service)\s+integration/i,
  // Identity/media synthesis + fraud/deception
  /(?:identity|media)\s+synthesis.{0,80}(?:fraud|deception|scam|impersonation)/i,
  /synthetic\s+(?:identity|media|voice|face).{0,80}(?:fraud|deception|impersonation)/i,
  // Workflow automation + credential/data/system access
  /workflow\s+automation.{0,80}(?:credential|data\s+access|system\s+access|exfiltrat)/i,
  // Agent/tool/plugin/memory/RAG/MCP/browser/"computer use" + misuse/exploit/attack
  /(?:agent|tool|plugin|memory|rag|mcp|browser|computer\s+use).{0,60}(?:misuse|failure|exploit|attack|abuse|compromise|hijack)/i,
  /(?:misuse|attack|exploit|abuse).{0,60}(?:agent|plugin|memory|rag|mcp|browser|computer\s+use)/i,
];

/**
 * Check whether a source has a novelty signal — an emerging AI-security pattern
 * that may not match standard AI-threat vocabulary. These never get pre-gate
 * discarded; they route to review for human confirmation.
 */
export function hasNoveltySignal(source) {
  const text = [source.title, source.summary, source.full_text?.slice(0, 6000)]
    .filter(Boolean)
    .join(" ");
  return NOVELTY_SIGNAL_PATTERNS.some((p) => p.test(text));
}

/**
 * Deterministic AI/cyber relevance scorer. Retained as the offline fallback and
 * for the Layer 2 validator. Not the primary path — see runRelevanceLlm().
 *
 * Returns relevance_path to distinguish known-signal vs. novelty-signal sources.
 *
 * @param {object} source
 * @returns {{ ai_relevance_score, cyber_relevance_score, ai_specificity_score, relevance_tier, relevance_path }}
 */
export function assessAiRelevance(source) {
  const text = relevanceText(source);

  const ai_relevance_score    = scoreSignals(text, AI_SIGNALS);
  const cyber_relevance_score = scoreSignals(text, CYBER_SIGNALS);
  const ai_specificity_score  = deriveSpecificityScore(ai_relevance_score, cyber_relevance_score);
  const relevance_tier        = deriveRelevanceTier(ai_specificity_score);

  // Two-track path: known_signal from keyword scoring; novelty_signal from pattern matching.
  const knownSignal   = ai_relevance_score > 0 || ai_specificity_score >= 10;
  const noveltySignal = hasNoveltySignal(source);

  let relevance_path;
  if (knownSignal && noveltySignal)       relevance_path = "both";
  else if (knownSignal && !noveltySignal) relevance_path = "known_signal";
  else if (!knownSignal && noveltySignal) relevance_path = "novelty_signal";
  else                                    relevance_path = "none";

  return { ai_relevance_score, cyber_relevance_score, ai_specificity_score, relevance_tier, relevance_path };
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
 * Cheap pre-gate run BEFORE any LLM call.
 *
 * Strengthened from v1: a single low-signal AI word ("ai", "automation") is NOT
 * enough to clear the pre-gate — sources must show at least ONE of:
 *   a) 1+ high-signal AI keyword (specific techniques, model names, attack types)
 *   b) 1+ medium-signal AI keyword AND 1+ high-signal cyber keyword
 *   c) 2+ medium-signal AI keywords (for governance/research sources)
 *   d) 1+ low-signal AI word AND 1+ high-signal cyber keyword — a generic "AI"
 *      mention next to a concrete cyber threat (CVE/exploit/RCE/malware) is a
 *      recall hedge for emerging threats described in unfamiliar vocabulary; the
 *      LLM confirms or rejects. Bounded by requiring a HIGH cyber keyword so pure
 *      tech/marketing noise (no real threat term) is still discarded for free.
 *
 * This prevents generic tech news with one "AI" mention from consuming LLM budget.
 *
 * @param {object} source
 * @returns {{ has_ai_signal: boolean, ai_hits: number, cyber_hits: number, signal_strength: string }}
 */
export function hasAiSignal(source) {
  const text = relevanceText(source);

  const ai_high   = countMatches(text, AI_SIGNALS.high);
  const ai_medium = countMatches(text, AI_SIGNALS.medium);
  const ai_low    = countMatches(text, AI_SIGNALS.low);
  const cyber_high = countMatches(text, CYBER_SIGNALS.high);

  const ai_hits    = ai_high + ai_medium + ai_low;
  const cyber_hits = cyber_high + countMatches(text, CYBER_SIGNALS.medium);

  // Rule a: any high-signal AI keyword (clear AI-threat topic)
  if (ai_high >= 1) {
    return { has_ai_signal: true, ai_hits, cyber_hits, signal_strength: "high" };
  }
  // Rule b: medium AI + cyber context (AI-adjacent security topic worth LLM check)
  if (ai_medium >= 1 && cyber_high >= 1) {
    return { has_ai_signal: true, ai_hits, cyber_hits, signal_strength: "medium_cyber" };
  }
  // Rule c: two medium AI signals (governance/policy/research context)
  if (ai_medium >= 2) {
    return { has_ai_signal: true, ai_hits, cyber_hits, signal_strength: "medium_dual" };
  }
  // Rule d: a generic AI mention alongside a concrete (high-signal) cyber threat
  // term. Recall hedge for emerging AI threats described in unfamiliar vocabulary.
  if (ai_low >= 1 && cyber_high >= 1) {
    return { has_ai_signal: true, ai_hits, cyber_hits, signal_strength: "low_ai_cyber" };
  }

  // Fails: low signals only (generic "AI" mentions, pure automation content, etc.)
  return { has_ai_signal: false, ai_hits, cyber_hits, signal_strength: "insufficient" };
}

// ── source_credibility_signal vocabulary ──────────────────────────────────────

const VALID_CREDIBILITY_SIGNALS = new Set([
  "primary_research", "authoritative_advisory", "threat_intelligence",
  "technical_disclosure", "secondary_reporting", "vendor_marketing",
  "speculative_analysis", "unknown",
]);

/**
 * Deterministic derivation of source_credibility_signal from source metadata.
 *
 * This was previously asked of the LLM in runRelevanceLlm(), which mixed an
 * unrelated classification task into the relevance/summary call. Now fully
 * deterministic — no LLM needed for credibility signal.
 *
 * @param {object} source
 * @returns {string} One of the VALID_CREDIBILITY_SIGNALS values
 */
export function deriveCredibilitySignal(source) {
  const st       = source.source_type   || "unknown";
  const pubClass = source.publisher_class || "";
  const tier     = source.trust_tier    || "unknown";
  const indep    = source.independence_level || "";
  const title    = (source.title || "").toLowerCase();
  const text     = (source.full_text || source.summary || "").slice(0, 500).toLowerCase();

  // Vendor marketing: commercial interest flag — checked BEFORE source_type rules
  // because a vendor can produce a "research_finding" type source while still being
  // primarily marketing content (e.g. CrowdStrike publishing "research" about threats
  // their product detects). independence_level is the authoritative signal here.
  if (
    indep === "vendor_interested" || indep === "self_reported" ||
    pubClass === "vendor" || pubClass === "major_vendor" ||
    /\b(announces?|launches?|now available|our (platform|product|solution)|sign up|free trial)\b/i.test(title + " " + text)
  ) {
    // Exception: even vendors can produce authoritative advisories (e.g. Google Project Zero CVE reports)
    if (/\bCVE-\d{4}-\d{4,}\b/i.test(title + " " + text) && pubClass === "major_vendor") {
      return "technical_disclosure";
    }
    return "vendor_marketing";
  }

  // Authoritative advisory: government / standards bodies
  if (
    pubClass === "primary_authority" ||
    tier === "primary" ||
    /\b(cisa|nist|ncsc|nsa|enisa|mitre|advisory|alert|guidance)\b/i.test(title + " " + text)
  ) {
    return "authoritative_advisory";
  }

  // Threat intelligence: TI firms, named actor reports
  if (
    st === "threat_intelligence" || st === "adversary_adoption_signal" ||
    /\b(apt\d+|threat actor|ttp|ioc|campaign attribution|mandiant|crowdstrike|recorded future)\b/i.test(title + " " + text)
  ) {
    return "threat_intelligence";
  }

  // Technical disclosure: CVE, exploit, vulnerability disclosure
  if (
    st === "vulnerability" || st === "exploit_disclosure" ||
    /\bCVE-\d{4}-\d{4,}\b/i.test(title + " " + text)
  ) {
    return "technical_disclosure";
  }

  // Primary research: academic / benchmark sources with methodology
  if (
    st === "research_finding" || st === "benchmark_evaluation" ||
    /\b(we (propose|evaluate|demonstrate|present)|n=\d|dataset|ablation|methodology|experiment)\b/i.test(text)
  ) {
    return "primary_research";
  }

  // Speculative analysis: prediction / opinion / thought leadership
  if (
    /\b(will become|expected to|future of|trends in|predictions for|is likely to|could enable)\b/i.test(title + " " + text)
  ) {
    return "speculative_analysis";
  }

  // Secondary reporting: news/media
  if (
    pubClass === "media" ||
    /\b(reports?|according to|citing|says that|told|says)\b/i.test(text.slice(0, 200))
  ) {
    return "secondary_reporting";
  }

  return "unknown";
}

// ── Verdict → storage-field mapping ────────────────────────────────────────────

// Three-way keep model, mirroring the v2 understand-layer's `scope` field so the
// two gates cannot disagree on borderline content:
//   central  — a genuine OFFENSIVE finding → kept, mapped to an offensive domain.
//   adjacent — genuine AI-security REFERENCE context (frameworks/standards,
//              dual-use autonomous capability, standalone defenses, SoKs) that is
//              NOT an offensive finding → KEPT as unclear_or_adjacent context, not
//              rejected. relevance_tier "adjacent" is deliberately NOT "off_topic",
//              so the final gate keeps it instead of discarding it.
//   passing  — the LLM confirmed AI is only name-dropped → off_topic → discarded.
//   none     — no real AI-threat connection → off_topic → discarded.
const FOCUS_TIER = {
  central:  { relevance_tier: "core",      ai_specificity_score: 80 },
  adjacent: { relevance_tier: "adjacent",  ai_specificity_score: 40 },
  passing:  { relevance_tier: "off_topic", ai_specificity_score: 20 },
  none:     { relevance_tier: "off_topic", ai_specificity_score: 5 },
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
    : source.full_text || source.summary || "").slice(0, 6000);
}

const VALID_FOCUS = new Set(["central", "adjacent", "passing", "none"]);

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

    // source_credibility_signal is now derived deterministically, not from the LLM.
    // This keeps the relevance call narrow (one cognitive task: relevance verdict).
    const source_credibility_signal = deriveCredibilitySignal(source);

    return {
      summary:                    typeof result.summary === "string" ? result.summary.trim() : null,
      ai_threat_focus:            focus,
      // is_ai_threat means "offensive finding" — true only for central. adjacent is
      // kept as context but is NOT an offensive finding, so is_ai_threat stays false.
      is_ai_threat:               focus === "central",
      candidate_domain:           focus === "central" ? normaliseDomain(result.candidate_domain) : "unclear_or_adjacent",
      // source_type not requested from LLM — handled by sourceTyping.js deterministic rules
      // and dataTyping.js LLM fallback only when deterministic classification fails.
      source_type:                null,   // caller uses result.source_type from sourceTyping.js
      source_type_confidence:     "medium",   // set by sourceTyping.js deterministic rules
      source_credibility_signal,              // derived deterministically above
      confidence:                 result.confidence || "medium",
      reasoning:                  result.reasoning || "",
      llm_used:                   true,
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
