/**
 * Web Discovery — Candidate Triage + Routing (Layer 1C)
 *
 * Two stages:
 *   A. Cheap-LLM semantic enrichment (optional). Gemini Flash-Lite judges the
 *      things deterministic rules cannot: is this genuinely an AI threat, how
 *      novel, how operationalised, marketing/defensive/prediction flags, and a
 *      taxonomy hint. The LLM may RAISE ai_threat_specificity above the
 *      deterministic anchor floor; it may never lower it below the floor (the
 *      floor is hard evidence). Skipped entirely when no LLM is configured.
 *   B. Deterministic early-signal + routing. computeEarlySignal() decides the
 *      categorical signal; routeCandidate() decides accept / accept_with_review
 *      / archive_only / reject from the gate states. No numbers.
 *
 * Routing is SEPARATE from early-signal promotion: a candidate with
 * early_signal_value="none" can still be accepted if it is AI-threat relevant
 * and useful for context/taxonomy coverage/corroboration.
 */

import { routedLLM } from "../../llm/llmRouter.js";
import {
  VALID_AI_THREAT_SPECIFICITY, VALID_NOVELTY_ASSESSMENT,
  VALID_OPERATIONALIZATION_STAGE, VALID_EARLY_SIGNAL_TYPE,
  VALID_EVIDENCE_NOVELTY, VALID_DEFENSIVE_CONTENT_TYPE, VALID_RELEVANCE_PATH,
  NEGATIVE_CONTENT_PATTERNS, LOW_VALUE_DOMAIN_FRAGMENTS,
} from "../../config/webDiscoveryVocab.js";
import { computeEarlySignal } from "./earlySignal.js";
import { detectAiThreatAnchors } from "./candidateGates.js";
import { loadPrompt } from "../../prompts/promptLoader.js";

const SPECIFICITY_ORDER = { none: 0, weak: 1, moderate: 2, strong: 3 };

// ── Deterministic operationalization-stage floor ─────────────────────────────
// Conservative: only sets actor_observed on explicit incident/active-exploitation
// language. Anything stronger than the floor is left to the LLM, and moderate/
// strong signals get a frontier QA pass anyway.
function inferStageFloor(candidate) {
  const text = `${candidate.candidate_claim} ${candidate.verbatim_quote} ${candidate.summary || ""}`;
  if (/exploited in the wild|active(?:ly)? exploit|observed (?:campaign|attack)|threat actor (?:is )?(?:using|adopting)|confirmed.*(?:use|attack)/i.test(text))
    return "actor_observed";
  if (/proof[\s-]?of[\s-]?concept|\bPoC\b|reproducible|we release|publicly available tool|github\.com/i.test(text))
    return "reproducible_poc";
  if (/we (?:propose|demonstrate|present)|benchmark|evaluation|lab(?:oratory)? (?:test|setting)/i.test(text))
    return "lab_validated";
  return "unknown";
}

// ── Negative-filter detection ─────────────────────────────────────────────────
function isLowValueContent(candidate) {
  const hay = `${candidate.title} ${candidate.candidate_claim} ${candidate.publisher} ${candidate.summary || ""}`.toLowerCase();
  const patternHit = NEGATIVE_CONTENT_PATTERNS.some((p) => hay.includes(p));
  const url = (candidate.opened_url || "").toLowerCase();
  const domainHit = LOW_VALUE_DOMAIN_FRAGMENTS.some((d) => url.includes(d));
  return patternHit || domainHit;
}

// ── Stage A: cheap-LLM enrichment ─────────────────────────────────────────────

const TRIAGE_SCHEMA = {
  type: "object",
  required: ["is_ai_threat", "ai_threat_specificity", "novelty_assessment", "operationalization_stage"],
  properties: {
    is_ai_threat:             { type: "boolean" },
    ai_threat_specificity:    { type: "string", enum: ["none", "weak", "moderate", "strong"] },
    novelty_assessment:       { type: "string", enum: ["known", "variation", "emerging", "genuinely_new", "unknown"] },
    operationalization_stage: { type: "string", enum: ["conceptual", "lab_validated", "reproducible_poc", "tool_available", "actor_observed", "confirmed_operational_use", "unknown"] },
    early_signal_type:        { type: "string" },
    quote_claim_fair:         { type: "boolean" },
    is_marketing:             { type: "boolean" },
    is_prediction_only:       { type: "boolean" },
    adds_new_evidence:        { type: "boolean" },
    // NEW: replaces boolean is_defensive_only with richer enum
    defensive_content_type:   {
      type: "string",
      enum: ["defensive_only", "defensive_with_offensive_findings", "threat_finding_with_defensive_context", "not_defensive", "unknown"],
    },
    // NEW: evidence novelty classification
    evidence_novelty: {
      type: "string",
      enum: ["new_fact", "new_case_study", "new_adoption_signal", "new_actor", "new_attack_path", "new_vulnerability", "new_metric", "duplicate_fact", "duplicate_reporting", "context_only", "unknown"],
    },
    // NEW: relevance_path
    relevance_path: {
      type: "string",
      enum: ["known_signal", "novelty_signal", "both", "none"],
    },
    taxonomy_primary_domain:  { type: "string" },
    taxonomy_primary_tags:    { type: "array", items: { type: "string" } },
    ai_enabled:               { type: "boolean" },
  },
};

const TRIAGE_SYSTEM = loadPrompt("discovery/triage").system;

function buildTriagePrompt(c) {
  return [
    `TITLE: ${c.title || "(none)"}`,
    `PUBLISHER: ${c.publisher || "(none)"}  SOURCE_CLASS: ${c.source_class}`,
    `PUBLISHED: ${c.published_date || "(unknown)"}  EVENT: ${c.event_date || "(unknown)"}`,
    `CLAIM: ${c.candidate_claim || "(none)"}`,
    `QUOTE: ${c.verbatim_quote ? `"${c.verbatim_quote.slice(0, 400)}"` : "(none yet — may need cleaning)"}`,
    `DETERMINISTIC ANCHORS FOUND: ${(c.ai_threat_anchors || []).join(", ") || "(none)"}`,
    `SUMMARY: ${c.summary || "(none)"}`,
  ].join("\n");
}

async function enrichWithLlm(candidate) {
  try {
    const { result } = await routedLLM(TRIAGE_SYSTEM, buildTriagePrompt(candidate), {
      task: "discovery_triage",
      schema: TRIAGE_SCHEMA,
      logLabel: `L1C-triage-${(candidate.candidate_id || "").slice(0, 12)}`,
    });
    if (!result || typeof result !== "object") return null;
    return result;
  } catch {
    return null;
  }
}

function applyEnrichment(candidate, llm) {
  const out = { ...candidate };
  if (!llm) {
    // Deterministic-only path: keep floors, infer a stage floor.
    if (out.operationalization_stage === "unknown") out.operationalization_stage = inferStageFloor(out);
    return out;
  }

  // ai_threat_specificity: LLM may RAISE above the anchor floor, never lower it.
  if (VALID_AI_THREAT_SPECIFICITY.has(llm.ai_threat_specificity)) {
    const floor = SPECIFICITY_ORDER[out.ai_threat_specificity] ?? 0;
    const llmVal = SPECIFICITY_ORDER[llm.ai_threat_specificity] ?? 0;
    out.ai_threat_specificity = llmVal > floor ? llm.ai_threat_specificity : out.ai_threat_specificity;
  }
  // If the LLM says it isn't an AI threat at all, force specificity to none
  // ONLY when no hard anchors exist (anchors are hard evidence).
  if (llm.is_ai_threat === false && (out.ai_threat_anchors || []).length === 0) {
    out.ai_threat_specificity = "none";
  }

  if (VALID_NOVELTY_ASSESSMENT.has(llm.novelty_assessment)) out.novelty_assessment = llm.novelty_assessment;
  if (VALID_OPERATIONALIZATION_STAGE.has(llm.operationalization_stage)) out.operationalization_stage = llm.operationalization_stage;
  else if (out.operationalization_stage === "unknown") out.operationalization_stage = inferStageFloor(out);

  out._llm_early_signal_type = VALID_EARLY_SIGNAL_TYPE.has(llm.early_signal_type) ? llm.early_signal_type : null;
  out._llm_quote_claim_fair = llm.quote_claim_fair;
  out._llm_is_marketing = llm.is_marketing === true;
  out._llm_is_prediction_only = llm.is_prediction_only === true;
  out._llm_adds_new_evidence = llm.adds_new_evidence !== false;

  // New defensive_content_type (replaces boolean is_defensive_only)
  if (VALID_DEFENSIVE_CONTENT_TYPE.has(llm.defensive_content_type)) {
    out.defensive_content_type = llm.defensive_content_type;
  }
  // Backward-compat: derive is_defensive_only from new enum
  out._llm_is_defensive_only = out.defensive_content_type === "defensive_only";

  // New evidence_novelty
  if (VALID_EVIDENCE_NOVELTY.has(llm.evidence_novelty)) {
    out.evidence_novelty = llm.evidence_novelty;
  }

  // New relevance_path
  if (VALID_RELEVANCE_PATH.has(llm.relevance_path)) {
    out.relevance_path = llm.relevance_path;
  }

  out.taxonomy_hint = {
    primary_domain: llm.taxonomy_primary_domain || null,
    primary_tags: Array.isArray(llm.taxonomy_primary_tags) ? llm.taxonomy_primary_tags.slice(0, 4) : [],
    ai_enabled: llm.ai_enabled === true,
  };

  // A deterministic mismatch stays a mismatch even if the LLM disagrees, but the
  // LLM CAN downgrade a deterministic "match"/"partial" to mismatch (stricter).
  if (out.quote_claim_match_status !== "mismatch" && llm.quote_claim_fair === false && out.quote_status === "present") {
    out.quote_claim_match_status = "mismatch";
  }
  return out;
}

// ── Stage B: deterministic early signal + routing ─────────────────────────────

export function computeSignalForCandidate(candidate) {
  const signal = computeEarlySignal({
    operationalization_stage: candidate.operationalization_stage,
    corroboration_status: candidate.corroboration_status,
    source_quality: candidate.source_quality,
    novelty_assessment: candidate.novelty_assessment,
    ai_threat_specificity: candidate.ai_threat_specificity,
    freshness_interpretation: candidate.freshness_interpretation,
    discovery_mission: candidate.discovery_mission,
    early_signal_type: candidate._llm_early_signal_type || null,
    adds_new_evidence: candidate._llm_adds_new_evidence !== false,
    is_marketing: candidate._llm_is_marketing || isLowValueContent(candidate),
    is_defensive_only: candidate._llm_is_defensive_only || false,
    is_prediction_only: candidate._llm_is_prediction_only || false,
    restated_old_as_new: candidate.freshness_interpretation === "fresh_publication_old_event" &&
      candidate._llm_adds_new_evidence === false,
  });
  return signal;
}

/**
 * Decide the route from gate states. Deterministic precedence.
 *
 * Routes (ordered strongest → weakest):
 *   accept_high_priority    — novel + primary source + strong signal
 *   accept_evidence_candidate — passes all gates, ready for evidence extraction
 *   accept_with_review      — useful but needs human/LLM review
 *   context_only            — real but only useful as context, not primary evidence
 *   archive_only            — keep for audit, not this run
 *   reject                  — not useful
 */
export function routeCandidate(candidate) {
  const reasons = [];  // candidate_route_reasons[]
  const flags = [];    // legacy route_flags (kept for backward compat)

  const out = (route, ...reasonCodes) => ({
    route,
    route_reason:            reasonCodes[0] || route,  // legacy single string
    candidate_route_reasons: [...reasons, ...reasonCodes].filter(Boolean),
    route_flags:             flags,
    manual_review_required:  route === "accept_with_review",
    rejection_reason:        route === "reject" ? (reasonCodes[0] || route) : null,
  });

  // ── HARD REJECTS ─────────────────────────────────────────────────────────────

  if (!candidate.opened_url_confirmed) return out("reject", "url_not_opened_or_grounded");
  if (candidate.hallucination_risk === "high") return out("reject", "url_not_opened_or_grounded");

  // 0 anchors → reject (no concrete AI-threat signal whatsoever)
  if (candidate.ai_threat_specificity === "none") return out("reject", "zero_ai_threat_anchors");

  // Missing quote on a non-preclean source → reject
  if (candidate.quote_status === "missing") return out("reject", "quote_missing");

  // Marketing → reject
  if (candidate._llm_is_marketing) return out("reject", "marketing_detected");

  // Prediction-only → reject
  if (candidate._llm_is_prediction_only) return out("reject", "prediction_only");

  // ── NOVELTY REVIEW — single anchor → do NOT reject, route to review ──────────
  // Horizon scanning must preserve novel signals even with only 1 anchor, because
  // emerging terminology may not yet be in the known-signal vocabulary.
  // NOTE: quote_support=unsupported check is DEFERRED for weak-specificity candidates
  // because token overlap is unreliable for novel terminology — entailment QA will verify.
  if (candidate.ai_threat_specificity === "weak") {
    reasons.push("single_anchor_novelty_review");
    flags.push("single_anchor_novelty_review");
    // unsupported = very low overlap (<30%) — even the LLM is unlikely to find support.
    // requires_entailment_qa / lexically_matched → route to review for LLM to confirm.
    if (candidate.quote_support === "unsupported") {
      reasons.push("quote_unsupported");
      reasons.push("requires_entailment_qa");
    } else if (candidate.requires_entailment_qa || candidate.quote_support === "requires_entailment_qa") {
      reasons.push("requires_entailment_qa");
    }
    return out("accept_with_review", "single_anchor_novelty_review");
  }

  // "unsupported" = token overlap < 0.3 — fast mechanical rejection.
  // Candidates needing entailment QA (requires_entailment_qa or "lexically_matched")
  // are NOT rejected here; they proceed so the triage LLM can confirm semantic support.
  if (candidate.quote_support === "unsupported") return out("reject", "quote_unsupported");

  // requires_entailment_qa: overlap is inconclusive — route to accept_with_review
  // so the triage LLM can perform a proper semantic entailment check.
  if (candidate.quote_support === "requires_entailment_qa" || candidate.requires_entailment_qa) {
    reasons.push("requires_entailment_qa");
    flags.push("requires_entailment_qa");
  }

  // ── ARCHIVE-ONLY ─────────────────────────────────────────────────────────────

  if (candidate.is_cluster_representative === false) {
    return out("archive_only", "duplicate_reporting");
  }

  // Historical foundational sources (standards/frameworks) → context_only, not discard
  const freshClass = candidate.freshness_class || "unknown_date";
  if (freshClass === "historical_foundational") {
    reasons.push("historical_foundational");
    return out("context_only", "historical_foundational");
  }

  // Historical stale: no new evidence, not foundational → archive
  if (freshClass === "historical_stale" || (candidate.freshness_status === "historical" && !candidate._llm_adds_new_evidence)) {
    return out("archive_only", "stale_no_new_evidence");
  }

  // Stale (120–365d) with no new evidence → archive
  if (candidate.freshness_status === "stale" && candidate._llm_adds_new_evidence === false) {
    return out("archive_only", "stale_no_new_evidence");
  }

  // duplicate_reporting or duplicate_fact → archive unless it adds new analysis
  if (["duplicate_reporting", "duplicate_fact"].includes(candidate.evidence_novelty) && !candidate._llm_adds_new_evidence) {
    return out("archive_only", "duplicate_reporting");
  }

  // Defensive-only (no offensive findings) → context_only for recommendation input
  if (candidate.defensive_content_type === "defensive_only") {
    return out("context_only", "defensive_only");
  }

  // ── ACCEPT-WITH-REVIEW (useful but ambiguous) ─────────────────────────────────

  // Defensive with offensive findings → review (valuable but needs confirmation)
  if (candidate.defensive_content_type === "defensive_with_offensive_findings") {
    reasons.push("defensive_with_offensive_findings");
    return out("accept_with_review", "defensive_with_offensive_findings");
  }

  // Quote anchor-bearing gate: quote present but no AI-threat anchor in the quote itself
  if (candidate.quote_status === "present" &&
      candidate.quote_anchor_bearing === false &&
      candidate.quote_claim_match_status === "unverified") {
    flags.push("quote_not_anchor_bearing");
    return out("accept_with_review", "quote_present_but_not_anchor_bearing");
  }

  if (candidate.quote_status === "missing_preclean") {
    flags.push("quote_pending_preclean");
    return out("accept_with_review", "quote_pending_preclean");
  }
  if (freshClass === "unknown_date" || candidate.freshness_status === "unknown") {
    flags.push("date_missing");
    return out("accept_with_review", "date_missing");
  }
  if (candidate.hallucination_risk === "medium") {
    flags.push("hallucination_risk_medium");
    return out("accept_with_review", "hallucination_risk_medium");
  }
  if (candidate.independence_level === "unknown" || candidate.source_independence_status === "unknown") {
    flags.push("independence_unverified");
    reasons.push("independence_unverified");
    return out("accept_with_review", "independence_unverified");
  }
  if (candidate.quote_support === "partially_supported" || candidate.quote_claim_match_status === "partial") {
    flags.push("quote_partially_supported");
    return out("accept_with_review", "quote_partially_supported");
  }

  // ── ACCEPT ───────────────────────────────────────────────────────────────────

  // Determine accept tier based on evidence quality
  const isHighPriority =
    (candidate.ai_threat_specificity === "strong" || candidate.ai_threat_specificity === "moderate") &&
    (candidate.novelty_assessment === "genuinely_new" || candidate.novelty_assessment === "emerging") &&
    (candidate.source_quality === "primary" || candidate.source_quality === "high") &&
    (candidate.early_signal_value === "strong" || candidate.early_signal_value === "moderate");

  const evidenceNoveltyHighPriority = ["new_vulnerability", "new_case_study", "new_adoption_signal", "new_actor"].includes(candidate.evidence_novelty);

  if (isHighPriority || evidenceNoveltyHighPriority) {
    reasons.push(...["multi_anchor_specific_signal",
      evidenceNoveltyHighPriority ? `new_${candidate.evidence_novelty}` : null,
    ].filter(Boolean));
    return out("accept_high_priority",
      evidenceNoveltyHighPriority ? candidate.evidence_novelty : "multi_anchor_specific_signal",
    );
  }

  reasons.push("multi_anchor_specific_signal");
  return out("accept_evidence_candidate", "multi_anchor_specific_signal");
}

/**
 * Compute candidate_usefulness_roles from categorical evidence states.
 * Deterministic — no LLM. Called after routing so evidence_novelty is known.
 */
function computeCandidateUsefulness(candidate) {
  const roles = [];
  const ev = candidate.evidence_novelty || "unknown";
  const stage = candidate.operationalization_stage || "unknown";
  const spec = candidate.ai_threat_specificity || "none";
  const defType = candidate.defensive_content_type || "unknown";
  const route = candidate.route || "reject";

  if (["reject", "archive_only"].includes(route)) return ["archive_only"];

  if (route === "context_only") return ["context_only"];

  if (ev === "new_vulnerability" || ev === "new_case_study") roles.push("case_study_candidate", "primary_evidence_candidate");
  if (ev === "new_adoption_signal" || ev === "new_actor") roles.push("adoption_signal_candidate", "primary_evidence_candidate");
  if (ev === "new_attack_path" || ev === "new_fact") roles.push("supporting_evidence_candidate");
  if (ev === "new_metric") roles.push("analytics_only", "trend_input_candidate");
  if (ev === "context_only") roles.push("context_only");

  if (["actor_observed", "confirmed_operational_use"].includes(stage)) {
    if (!roles.includes("primary_evidence_candidate")) roles.unshift("primary_evidence_candidate");
  } else if (["reproducible_poc", "tool_available"].includes(stage)) {
    if (!roles.includes("supporting_evidence_candidate")) roles.push("supporting_evidence_candidate");
  }

  if (spec === "strong" || spec === "moderate") roles.push("trend_input_candidate");

  if (["defensive_with_offensive_findings", "threat_finding_with_defensive_context"].includes(defType)) {
    roles.push("recommendation_input_candidate");
  }

  if (candidate.source_quality === "primary" || candidate.source_quality === "high") {
    roles.push("outlook_input_candidate");
  }

  if (roles.length === 0) roles.push("supporting_evidence_candidate");
  return [...new Set(roles)];
}

/**
 * Triage a single candidate deterministically (no LLM). Assumes enrichment (if
 * any) already applied. Sets early-signal + route fields.
 */
export function triageCandidateDeterministic(candidate) {
  const c = { ...candidate };
  // Is the verbatim quote itself anchor-bearing (a concrete AI-threat artefact),
  // or did the specificity floor come from title/summary alone?
  if (c.quote_anchor_bearing === undefined) {
    c.quote_anchor_bearing = detectAiThreatAnchors(c.verbatim_quote || "").anchors.length > 0;
  }

  // Derive relevance_path when not already set by LLM
  if (!c.relevance_path) {
    const anchorCount = (c.ai_threat_anchors || []).length;
    const isNovelty = c.novelty_assessment === "genuinely_new" || c.novelty_assessment === "emerging";
    if (anchorCount >= 2 && isNovelty)   c.relevance_path = "both";
    else if (anchorCount >= 2)           c.relevance_path = "known_signal";
    else if (anchorCount === 1 && isNovelty) c.relevance_path = "novelty_signal";
    else if (anchorCount === 1)          c.relevance_path = "known_signal";
    else                                  c.relevance_path = "none";
  }

  const signal = computeSignalForCandidate(c);
  Object.assign(c, signal);
  const routing = routeCandidate(c);
  Object.assign(c, routing);

  // Compute usefulness roles after routing
  c.candidate_usefulness_roles = computeCandidateUsefulness(c);

  return c;
}

/**
 * Triage a batch. Runs cheap-LLM enrichment (if available) then deterministic
 * early-signal + routing.
 *
 * @param {object[]} candidates
 * @param {object}   [opts] { skipLlm, concurrency }
 * @returns {Promise<object[]>}
 */
export async function triageCandidates(candidates = [], opts = {}) {
  const { skipLlm = false, concurrency = 5 } = opts;
  const hasLlm = !skipLlm && !!(
    process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2 ||
    process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY ||
    process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY
  );

  const out = new Array(candidates.length);
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const done = await Promise.all(batch.map(async (cand) => {
      const llm = hasLlm ? await enrichWithLlm(cand) : null;
      const enriched = applyEnrichment(cand, llm);
      return triageCandidateDeterministic(enriched);
    }));
    for (let j = 0; j < batch.length; j++) out[i + j] = done[j];
  }
  return out;
}
