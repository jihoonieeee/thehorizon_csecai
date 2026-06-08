/**
 * Validation Layer (Layer 3) — Validity, AI-Threat Relevance & Data Typing
 *
 * Orchestrates the sublayers in sequence:
 *
 *   3.1  checkSourceValidity        Is the source structurally usable?
 *   3.2  AI-threat relevance        Deterministic AI-signal pre-gate, then a cheap
 *                                   LLM (Haiku) summary + focus verdict + source_type,
 *                                   then a second LLM QA check. (aiRelevance.js)
 *   3.3  source typing              Produced by the 3.2 LLM call; deterministic
 *                                   classifyDataType is the offline fallback.
 *   3.4  annotateSourceContext       Source context & reliability annotation
 *   3.5  applyFinalGate             Pass, review, or discard?
 *
 * Cost control: a source with no AI signal at all is discarded by the deterministic
 * pre-gate WITHOUT any LLM call. Only keyword-positive sources reach the LLM, which
 * confirms whether the AI angle is central or just a passing mention. The QA call
 * runs only on accepted/borderline sources.
 *
 * Rejected sources are never silently dropped — they are returned with
 * validation_status = "reject" and a reason describing why.
 */

import { checkSourceValidity }       from "./sourceValidity.js";
import {
  assessAiRelevance,
  hasAiSignal,
  runRelevanceLlm,
  runRelevanceQa,
  deriveRelevanceFromFocus,
}                                    from "./aiRelevance.js";
import { classifyDataType }          from "./dataTyping.js";
import { annotateSourceContext } from "./trustAssessment.js";
import { applyFinalGate }            from "./finalGate.js";

export const VALIDATION_VERSION = "validation-v1.0";

const DEFAULT_CONCURRENCY = Number(process.env.VALIDATION_CONCURRENCY || 5);

// ── Single-source validation ───────────────────────────────────────────────────

/**
 * Run the full validation layer on a single source.
 *
 * @param {object} source
 * @param {object} [opts]
 * @param {boolean}  [opts.skipLlm=false]  Force the deterministic path (no LLM calls).
 * @param {boolean}  [opts.runQa=true]     Run the second-model QA call on accepted/borderline.
 * @param {Function} [opts.llmFn]          Injectable LLM fn (same signature as routedLLM); for tests.
 * @returns {Promise<object>} source enriched with all validation fields.
 */
export async function validateAndTypeSource(source, opts = {}) {
  const { skipLlm = false, runQa = true, llmFn } = opts;

  // 3.1 — structural validity
  const validity = checkSourceValidity(source);
  // 3.4 — trust (needed for the curated/authoritative review path)
  const trust = annotateSourceContext(source);

  // Relevance + typing state, filled by one of the paths below.
  let relevance;                 // { relevance_tier, ai_specificity_score, ai_relevance_score?, cyber_relevance_score? }
  let typing;                    // { source_type, source_type_confidence, source_type_reason }
  let validation_summary = null;
  let ai_threat_focus    = null;
  let candidate_domain   = "unclear_or_adjacent";
  let relevance_method   = "deterministic";
  let qa_status          = "n/a";
  let reasoning          = "";

  const signal = hasAiSignal(source);

  if (validity.hard_fail) {
    // Structurally unusable — don't spend any LLM budget; the gate will reject.
    relevance = { ...assessAiRelevance(source), relevance_tier: "off_topic" };
    typing = await classifyDataType(source, { skipLlm: true });
    relevance_method = "skipped_invalid";
  } else if (!signal.has_ai_signal) {
    // Deterministic pre-gate discard: no AI signal at all → not an AI threat.
    relevance = { ...assessAiRelevance(source), relevance_tier: "off_topic", ai_specificity_score: 0 };
    typing = await classifyDataType(source, { skipLlm: true });
    relevance_method = "pre_gate_discard";
  } else {
    // Keyword-positive — let the LLM confirm real focus vs. a passing mention.
    let llmResult = null;
    if (!skipLlm) {
      llmResult = await runRelevanceLlm(source, { llmFn });
    }

    if (llmResult) {
      let focus       = llmResult.ai_threat_focus;
      let isAiThreat  = llmResult.is_ai_threat;
      let sourceType  = llmResult.source_type;
      validation_summary = llmResult.summary;
      candidate_domain   = llmResult.candidate_domain || "unclear_or_adjacent";
      reasoning          = llmResult.reasoning;
      relevance_method   = "llm";

      // QA only on accepted/borderline (anything not a clear "none" reject).
      const clearReject = focus === "none" && !isAiThreat;
      if (runQa && !clearReject) {
        const qa = await runRelevanceQa(source, llmResult, { llmFn });
        if (qa) {
          focus      = qa.corrected_ai_threat_focus;
          isAiThreat = qa.corrected_is_ai_threat;
          if (qa.corrected_source_type) sourceType = qa.corrected_source_type;
          // A downgraded focus invalidates the domain hint.
          if (focus !== "central") candidate_domain = "unclear_or_adjacent";
          qa_status = qa.verdict_correct && qa.summary_grounded ? "confirmed" : "corrected";
          if (!qa.summary_grounded && qa.issues) reasoning = `${reasoning} | qa: ${qa.issues}`.trim();
        } else {
          qa_status = "failed";
        }
      } else {
        qa_status = "skipped";
      }

      ai_threat_focus = focus;
      const derived = deriveRelevanceFromFocus(focus);
      const det     = assessAiRelevance(source); // keep keyword scores for the audit record
      relevance = {
        relevance_tier:        derived.relevance_tier,
        ai_specificity_score:  derived.ai_specificity_score,
        ai_relevance_score:    det.ai_relevance_score,
        cyber_relevance_score: det.cyber_relevance_score,
      };

      // Source type from the LLM; deterministic fallback only if the LLM omitted it.
      if (sourceType) {
        typing = {
          source_type:            sourceType,
          source_type_confidence: llmResult.source_type_confidence,
          source_type_reason:     "validation_relevance_llm",
        };
      } else {
        typing = await classifyDataType(source, { skipLlm: true });
      }
    } else {
      // LLM unavailable / skipped / failed → deterministic fallback. Force
      // deterministic typing too: if the relevance LLM was unavailable, the
      // typing LLM will be as well — don't spend a doomed call.
      relevance = assessAiRelevance(source);
      typing    = await classifyDataType(source, { skipLlm: true });
      relevance_method = skipLlm ? "deterministic" : "deterministic_fallback";
      ai_threat_focus  = ["core", "adjacent"].includes(relevance.relevance_tier) ? "central" : "none";
    }
  }

  // 3.5 — final gate
  const gate = applyFinalGate(validity, relevance, typing, trust);

  return {
    ...source,
    // 3.1 — Source validity
    is_valid:                 validity.is_valid,
    validity_reason:          validity.validity_reason,
    filter_flags:             validity.filter_flags,
    text_quality_score:       validity.text_quality_score,
    publish_date_confidence:  validity.publish_date_confidence,
    // 3.2 — AI-threat relevance
    ai_relevance_score:       relevance.ai_relevance_score ?? null,
    cyber_relevance_score:    relevance.cyber_relevance_score ?? null,
    ai_specificity_score:     relevance.ai_specificity_score,
    relevance_tier:           relevance.relevance_tier,
    ai_threat_focus:          ai_threat_focus,
    candidate_domain:         candidate_domain,
    validation_summary:       validation_summary,
    validation_relevance_method: relevance_method,
    validation_qa_status:     qa_status,
    validation_reasoning:     reasoning || null,
    // 3.3 — Data typing
    source_type:              typing.source_type,
    source_type_confidence:   typing.source_type_confidence,
    source_type_reason:       typing.source_type_reason,
    // 3.4 — Source context & reliability annotation
    trust_tier:              trust.trust_tier,
    trust_tier_reason:       trust.trust_tier_reason,
    publisher_class:         trust.publisher_class,
    evidence_role:           trust.evidence_role,
    independence_level:      trust.independence_level,
    verification_status:     trust.verification_status,
    evidence_strength_hint:  trust.evidence_strength_hint,
    reliability_notes:       trust.reliability_notes,
    // 3.5 — Final gate (validation_status is canonical; layer3_status kept for compat)
    validation_status:        gate.layer3_status,
    layer3_status:            gate.layer3_status,
    final_validity_reason:    gate.final_validity_reason,
    downstream_route:         gate.downstream_route,
    validation_version:       VALIDATION_VERSION,
  };
}

// ── Batch validation ───────────────────────────────────────────────────────────

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function run() {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, run));
  return results;
}

/**
 * Run the validation layer over a batch of sources with bounded concurrency.
 *
 * All sources are returned. `accepted` holds pass + review (these proceed and are
 * archived); `rejected` holds discards (kept for audit, never written to the
 * sources table).
 *
 * @param {object[]} sources
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @param {boolean}  [opts.runQa=true]
 * @param {Function} [opts.llmFn]
 * @param {number}   [opts.concurrency=VALIDATION_CONCURRENCY|5]
 * @returns {Promise<{ sources, accepted, rejected, stats }>}
 */
export async function validateAndTypeSources(sources, opts = {}) {
  const { concurrency = DEFAULT_CONCURRENCY } = opts;

  const results = await runWithConcurrency(
    sources,
    concurrency,
    (source) => validateAndTypeSource(source, opts)
  );

  const accepted = results.filter((s) => s.validation_status !== "reject");
  const rejected = results.filter((s) => s.validation_status === "reject");

  const methodCounts = {};
  let llmCalls = 0;
  for (const s of results) {
    methodCounts[s.validation_relevance_method] = (methodCounts[s.validation_relevance_method] || 0) + 1;
    if (s.validation_relevance_method === "llm") llmCalls++;
  }

  return {
    sources:  results,
    accepted,
    rejected,
    stats: {
      total:        sources.length,
      pass_count:   results.filter((s) => s.validation_status === "pass").length,
      review_count: results.filter((s) => s.validation_status === "review").length,
      reject_count: rejected.length,
      llm_calls:    llmCalls,
      method_frequency: methodCounts,
    },
  };
}
