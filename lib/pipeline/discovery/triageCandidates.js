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
  NEGATIVE_CONTENT_PATTERNS, LOW_VALUE_DOMAIN_FRAGMENTS,
} from "../../config/webDiscoveryVocab.js";
import { computeEarlySignal } from "./earlySignal.js";

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
    is_defensive_only:        { type: "boolean" },
    is_prediction_only:       { type: "boolean" },
    adds_new_evidence:        { type: "boolean" },
    taxonomy_primary_domain:  { type: "string" },
    taxonomy_primary_tags:    { type: "array", items: { type: "string" } },
    ai_enabled:               { type: "boolean" },
  },
};

const TRIAGE_SYSTEM = `You triage a discovered web source for an AI-threat intelligence pipeline.
You are given a title, claim, quote, publisher, and source class. Judge ONLY what the text supports — do not invent.

Return strict JSON:
- is_ai_threat: true only if the source concretely concerns a threat TO or USING AI systems (not generic AI or generic cyber).
- ai_threat_specificity: none|weak|moderate|strong. none = buzzword/generic; strong = specific attack/model/tool/actor/exploit/benchmark/incident.
- novelty_assessment: known|variation|emerging|genuinely_new|unknown.
- operationalization_stage: conceptual|lab_validated|reproducible_poc|tool_available|actor_observed|confirmed_operational_use|unknown.
- early_signal_type: new_attack_mode|new_actor_adoption|new_attack_surface|new_tool_abuse|new_exploit_path|new_defensive_bypass|operationalization_step|scale_shift|convergence|none.
- quote_claim_fair: is the claim a fair reading of the quote?
- is_marketing / is_defensive_only / is_prediction_only: booleans.
- adds_new_evidence: does it add NEW evidence (vs restating an old event)?
- taxonomy_primary_domain, taxonomy_primary_tags, ai_enabled: best taxonomy-v9 hint.

No preamble. JSON only.`;

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
  out._llm_is_defensive_only = llm.is_defensive_only === true;
  out._llm_is_prediction_only = llm.is_prediction_only === true;
  out._llm_adds_new_evidence = llm.adds_new_evidence !== false;

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
 */
export function routeCandidate(candidate) {
  const flags = [];
  const reject = (reason) => ({ route: "reject", route_reason: reason, route_flags: flags, manual_review_required: false, rejection_reason: reason });
  const archive = (reason) => ({ route: "archive_only", route_reason: reason, route_flags: flags, manual_review_required: false, rejection_reason: null });
  const review = (reason) => ({ route: "accept_with_review", route_reason: reason, route_flags: flags, manual_review_required: true, rejection_reason: null });
  const accept = (reason) => ({ route: "accept", route_reason: reason, route_flags: flags, manual_review_required: false, rejection_reason: null });

  // ── reject ──────────────────────────────────────────────────────────────────
  if (!candidate.opened_url_confirmed) return reject("url_not_opened_or_grounded");
  if (candidate.hallucination_risk === "high") return reject("hallucination_risk_high");
  if (candidate.ai_threat_specificity === "none") return reject("buzzword_only_no_ai_threat_anchor");
  if (candidate.ai_threat_specificity === "weak") return reject("weak_ai_threat_specificity");
  if (candidate.quote_claim_match_status === "mismatch") return reject("quote_claim_mismatch");
  if (candidate.quote_status === "missing") return reject("no_supporting_quote");

  // ── archive_only (relevant but duplicate / derivative) ──────────────────────
  if (candidate.is_cluster_representative === false) {
    return archive(candidate.duplicate_reason || "duplicate_non_representative");
  }

  // ── accept_with_review (useful but ambiguous) ───────────────────────────────
  if (candidate.quote_status === "missing_preclean") { flags.push("quote_pending_preclean"); return review("quote_pending_preclean"); }
  if (candidate.freshness_status === "unknown") { flags.push("date_missing"); return review("date_missing"); }
  if (candidate.hallucination_risk === "medium") { flags.push("hallucination_risk_medium"); return review("hallucination_risk_medium"); }
  if (candidate.source_independence_status === "unknown") { flags.push("independence_unverified"); return review("independence_unverified"); }
  if (candidate.quote_claim_match_status === "partial") { flags.push("quote_claim_partial"); return review("quote_claim_partial"); }

  // ── accept ──────────────────────────────────────────────────────────────────
  return accept("passes_all_gates");
}

/**
 * Triage a single candidate deterministically (no LLM). Assumes enrichment (if
 * any) already applied. Sets early-signal + route fields.
 */
export function triageCandidateDeterministic(candidate) {
  const c = { ...candidate };
  const signal = computeSignalForCandidate(c);
  Object.assign(c, signal);
  const routing = routeCandidate(c);
  Object.assign(c, routing);
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
