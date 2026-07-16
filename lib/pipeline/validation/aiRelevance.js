/**
 * Validation 3.2 — AI-Threat Relevance (deterministic pre-gate + scoring)
 *
 * Answers the core question: is this source genuinely ABOUT an AI threat, or
 * does it merely mention an AI keyword in passing?
 *
 * Flow (orchestrated by validateAndTypeSource.js):
 *   1. hasAiSignal() — cheap deterministic keyword pre-gate. Sources with no AI
 *      signal at all are discarded WITHOUT spending an LLM call.
 *   2. runLayer3Llm() in layer3Llm.js — single unified LLM call that handles
 *      relevance, content quality, trust, and source typing in one pass.
 *
 * assessAiRelevance() is the offline / skipLlm fallback and deterministic scorer.
 * deriveRelevanceFromFocus() maps the unified LLM's ai_threat_focus to tier+score.
 */
import { DOMAINS }               from "../../config/taxonomyRegistry.js";
import {
  AI_SIGNALS, CYBER_SIGNALS, NOVELTY_SIGNAL_PATTERNS,
  KNOWN_AI_ENTITIES, MODEL_ARTIFACT_SIGNALS, CODE_EXECUTION_SIGNALS,
  TAMPER_SIGNALS, AGENT_ECOSYSTEM_SIGNALS, SUPPLY_CHAIN_SIGNALS, DOWNRANK_SIGNALS,
  isTrustedAiSecurityPublisher, normalizeText, normalizeLight,
} from "../../config/aiSignals.js";

// Offensive domains plus the catch-all — the candidate_domain hint Layer 3 passes
// to Layer 4 so the taxonomy prompt can be scoped to one domain's tags.
const VALID_CANDIDATE_DOMAINS = new Set([...DOMAINS, "unclear_or_adjacent"]);

function normaliseDomain(raw) {
  return VALID_CANDIDATE_DOMAINS.has(raw) ? raw : "unclear_or_adjacent";
}

// ── Deterministic scoring (offline / skipLlm fallback) ─────────────────────────
// Keywords imported from lib/config/aiSignals.js — edit there to update the gate.

function relevanceText(source) {
  const raw = [source.title, source.summary, source.full_text?.slice(0, 6000)]
    .filter(Boolean)
    .join(" ");
  return normalizeText(raw);
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

// ── Pair-based scoring ─────────────────────────────────────────────────────────
// A known AI product/format next to a concrete cyber signal, or a model artifact
// next to code execution, is strong evidence of an in-scope AI-security source even
// when no explicit "AI attack" phrase appears. Bonuses feed the specificity score.

/**
 * Categorical pair bonus. Word-boundary matched (via countMatches) against the
 * already-normalized text. Bonuses are additive but capped so a single well-matched
 * source can clear the "core" tier without an explicit AI-threat keyword.
 */
function scorePairBonus(text) {
  const entity      = countMatches(text, KNOWN_AI_ENTITIES)     > 0;
  const artifact    = countMatches(text, MODEL_ARTIFACT_SIGNALS) > 0;
  const codeExec    = countMatches(text, CODE_EXECUTION_SIGNALS) > 0;
  const tamper      = countMatches(text, TAMPER_SIGNALS)         > 0;
  const agentEco    = countMatches(text, AGENT_ECOSYSTEM_SIGNALS)> 0;
  const supplyChain = countMatches(text, SUPPLY_CHAIN_SIGNALS)   > 0;
  const cyberHigh   = countMatches(text, CYBER_SIGNALS.high)     > 0;

  let bonus = 0;
  if (entity && cyberHigh)            bonus += 25; // AI product + CVE/exploit/RCE
  if (artifact && (codeExec || tamper)) bonus += 30; // model format + execution/poison
  if (agentEco && (supplyChain || tamper)) bonus += 30; // agent ecosystem + abuse
  return Math.min(60, bonus);
}

/**
 * True when the text matches ONLY governance/marketing down-rank vocabulary and
 * carries no cyber, attack, or entity-pair signal — pure AI policy/marketing noise.
 */
function isDownrankOnly(text) {
  const downrank = countMatches(text, DOWNRANK_SIGNALS) > 0;
  if (!downrank) return false;
  const hasThreat =
    countMatches(text, CYBER_SIGNALS.high)   > 0 ||
    countMatches(text, CYBER_SIGNALS.medium) > 0 ||
    scorePairBonus(text) > 0;
  return !hasThreat;
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
 * Check whether a source has a novelty signal — an emerging AI-security pattern
 * that may not match standard AI-threat vocabulary. These never get pre-gate
 * discarded; they route to review for human confirmation.
 */
export function hasNoveltySignal(source) {
  const raw = [source.title, source.summary, source.full_text?.slice(0, 6000)]
    .filter(Boolean)
    .join(" ");
  // Light normalization (hyphen→space, US spelling) so patterns catch
  // "prompt-injection"/"behaviour" variants, without acronym expansion that would
  // widen the proximity windows the patterns rely on.
  const text = normalizeLight(raw);
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
  const pair_bonus            = scorePairBonus(text);
  // A known AI entity/product/format is an AI signal even without explicit
  // AI-threat vocabulary — fold the pair bonus into ai_relevance for tiering.
  const ai_with_pairs         = Math.min(100, ai_relevance_score + pair_bonus);

  let ai_specificity_score = deriveSpecificityScore(ai_with_pairs, cyber_relevance_score);

  // Down-rank governance/marketing content that carries NO real threat signal:
  // matches only DOWNRANK_SIGNALS with no cyber/attack term present.
  if (isDownrankOnly(text)) {
    ai_specificity_score = Math.min(ai_specificity_score, 9); // below the peripheral floor
  }

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
 * Recall additions (v2): many strong AI-security sources never say "AI attack".
 * They name a product (LiteLLM), a model format (safetensors), or an agent
 * protocol (MCP) next to a concrete cyber/exec/supply-chain signal. Those now
 * clear the gate via PAIR rules, a trusted-publisher bypass, or a novelty regex.
 * The goal is high recall here, with the LLM relevance call as the strict filter.
 *
 * This prevents generic tech news with one "AI" mention from consuming LLM budget,
 * while no longer requiring explicit AI-threat terminology when a known AI product
 * or model format is already present alongside a threat signal.
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

  const ret = (signal_strength) => ({ has_ai_signal: true, ai_hits, cyber_hits, signal_strength });

  // Rule a: any high-signal AI keyword (clear AI-threat topic)
  if (ai_high >= 1) return ret("high");

  // Rule (publisher): a trusted AI-security publisher — its output is in-scope
  // enough to warrant an LLM look even without keyword hits.
  if (isTrustedAiSecurityPublisher(source)) return ret("publisher_bypass");

  // Rule (novelty): an emerging-technique regex fired — route to LLM confirmation.
  if (hasNoveltySignal(source)) return ret("novelty");

  // Pair rules: known AI product/format/ecosystem next to a concrete threat signal.
  const entity      = countMatches(text, KNOWN_AI_ENTITIES)      > 0;
  const artifact    = countMatches(text, MODEL_ARTIFACT_SIGNALS) > 0;
  const codeExec    = countMatches(text, CODE_EXECUTION_SIGNALS) > 0;
  const tamper      = countMatches(text, TAMPER_SIGNALS)         > 0;
  const agentEco    = countMatches(text, AGENT_ECOSYSTEM_SIGNALS)> 0;
  const supplyChain = countMatches(text, SUPPLY_CHAIN_SIGNALS)   > 0;

  // Rule (artifact): model artifact/format + code execution or tampering.
  if (artifact && (codeExec || tamper)) return ret("model_artifact_exec");
  // Rule (entity): known AI product/entity + a concrete high-signal cyber term.
  if (entity && cyber_high >= 1) return ret("entity_cyber");
  // Rule (agent): agent ecosystem (plugin/skill/MCP/tool) + supply-chain or tampering.
  if (agentEco && (supplyChain || tamper)) return ret("agent_supply_chain");

  // Rule b: medium AI + cyber context (AI-adjacent security topic worth LLM check)
  if (ai_medium >= 1 && cyber_high >= 1) return ret("medium_cyber");
  // Rule c: two medium AI signals (governance/policy/research context)
  if (ai_medium >= 2) return ret("medium_dual");
  // Rule d: a generic AI mention alongside a concrete (high-signal) cyber threat
  // term. Recall hedge for emerging AI threats described in unfamiliar vocabulary.
  if (ai_low >= 1 && cyber_high >= 1) return ret("low_ai_cyber");

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

