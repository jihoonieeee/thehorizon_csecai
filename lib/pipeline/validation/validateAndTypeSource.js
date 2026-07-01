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
import { runContentQualityGate }     from "./contentQualityGate.js";
import { resolveAndVerifyUrl }       from "./urlSafety.js";
import { classifyDataType }          from "./dataTyping.js";
import { annotateSourceContext }     from "./trustAssessment.js";
import { applyFinalGate }            from "./finalGate.js";
import { assessSourceQuality }       from "./sourceQuality.js";
import { inferOriginRole, resetCircularRegistry, prepopulateCircularRegistry } from "./originTracking.js";
import {
  computeEvidencePotential,
  deriveSourceRoute,
  classifyContentStatus,
}                                    from "./evidencePotential.js";

export const VALIDATION_VERSION = "validation-v1.3";

const DEFAULT_CONCURRENCY = Number(process.env.VALIDATION_CONCURRENCY || 5);

// Primary-authority publisher patterns — used to bypass the keyword pre-gate.
// These publishers may issue AI-threat content in non-standard vocabulary (e.g.
// "AI Threat Era patching", "ML robustness guidance") that the keyword list
// doesn't yet cover. A false-negative at the pre-gate discards authoritative signals.
// Checks publisher_class (if already set) AND publisher string (for sources loaded
// from DB where publisher_class may not be pre-populated).
const PRIMARY_AUTHORITY_PUBLISHERS = /\b(cisa|nist|ncsc|nsa|enisa|mitre|fbi|dhs|europol|gchq|aisi|uk\.gov|cyber\.gov)\b/i;

function isPrimaryAuthoritySource(source) {
  if (source.publisher_class === "primary_authority") return true;
  if (source.trust_tier === "primary") return true;
  const pub = (source.publisher || "").toLowerCase();
  const url = (source.url || "").toLowerCase();
  return PRIMARY_AUTHORITY_PUBLISHERS.test(pub) || PRIMARY_AUTHORITY_PUBLISHERS.test(url);
}

// ── Single-source validation ───────────────────────────────────────────────────

/**
 * Run the full validation layer on a single source.
 *
 * @param {object} source
 * @param {object} [opts]
 * @param {boolean}  [opts.skipLlm=false]  Force the deterministic path (no LLM calls).
 * @param {boolean}  [opts.runQa=true]     Run the second-model QA call on accepted/borderline.
 * @param {boolean}  [opts.skipUrlCheck]   Skip the network URL-reachability probe. Defaults
 *                                         to skipLlm so existing offline/test runs are
 *                                         unchanged, but a degraded LLM run that still has
 *                                         network can pass false to keep dead-link gating.
 * @param {Function} [opts.llmFn]          Injectable LLM fn (same signature as routedLLM); for tests.
 * @returns {Promise<object>} source enriched with all validation fields.
 */
export async function validateAndTypeSource(source, opts = {}) {
  const { skipLlm = false, runQa = true, llmFn, skipUrlCheck = skipLlm } = opts;

  // 3.1 — structural validity
  const validity = checkSourceValidity(source);
  // 3.4 — trust (needed for the curated/authoritative review path)
  const trust = annotateSourceContext(source);

  // Relevance + typing state, filled by one of the paths below.
  let relevance;                 // { relevance_tier, ai_specificity_score, ai_relevance_score?, cyber_relevance_score? }
  let typing;                    // { source_type, source_type_confidence, source_type_reason }
  let validation_summary  = null;
  let ai_threat_focus     = null;
  let candidate_domain    = "unclear_or_adjacent";
  let relevance_method    = "deterministic";
  let qa_status           = "n/a";
  let reasoning           = "";
  let content_quality     = "substantive";  // set by contentQualityGate (3.3)
  let quality_reason      = "";
  let signal_strength     = "none";

  const signal = hasAiSignal(source);
  signal_strength = signal.signal_strength || "none";

  if (validity.hard_fail) {
    // Structurally unusable — don't spend any LLM budget; the gate will reject.
    relevance = { ...assessAiRelevance(source), relevance_tier: "off_topic" };
    typing = await classifyDataType(source, { skipLlm: true });
    relevance_method = "skipped_invalid";
  } else if (!signal.has_ai_signal && !isPrimaryAuthoritySource(source)) {
    // Strengthened pre-gate: insufficient AI signal → not an AI threat.
    // Exception: primary_authority publishers (CISA, NIST, NSA, etc.) always reach the
    // LLM relevance call — they may publish AI-threat content in language the keyword
    // vocabulary doesn't yet cover, and a false-negative here discards authoritative signals.
    // We check both publisher_class (set if already derived) AND publisher string (for
    // sources loaded from DB that may not have publisher_class pre-populated).
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
      const det     = assessAiRelevance(source);
      relevance = {
        relevance_tier:        derived.relevance_tier,
        ai_specificity_score:  derived.ai_specificity_score,
        ai_relevance_score:    det.ai_relevance_score,
        cyber_relevance_score: det.cyber_relevance_score,
        relevance_path:        det.relevance_path,
      };

      if (sourceType) {
        typing = {
          source_type:            sourceType,
          source_type_confidence: llmResult.source_type_confidence,
          source_type_reason:     "validation_relevance_llm",
        };
      } else {
        typing = await classifyDataType(source, { skipLlm: true });
      }

      // ── 3.3 Content Quality Gate ─────────────────────────────────────────────
      // Runs on central AND adjacent sources. Adjacent sources that are really
      // marketing/SEO content should not reach Layer 4 just because a trusted
      // publisher wrote them. The gate is cheap (deterministic + optional LLM).
      if ((focus === "central" || focus === "passing") && !skipLlm) {
        const qualityResult = await runContentQualityGate(source, llmResult, { llmFn });
        content_quality = qualityResult.content_quality;
        quality_reason  = qualityResult.quality_reason;
      }
    } else {
      // LLM unavailable / skipped / failed → deterministic fallback.
      relevance = assessAiRelevance(source);
      typing    = await classifyDataType(source, { skipLlm: true });
      relevance_method = skipLlm ? "deterministic" : "deterministic_fallback";
      ai_threat_focus  = ["core", "adjacent"].includes(relevance.relevance_tier) ? "central" : "none";
    }
  }

  // ── URL resolution — runs before the final gate so results feed into routing ─
  // Resolves HTTP→HTTPS redirects, detects domain-switch and dead-end redirects,
  // and confirms reachability (HEAD→GET). This is a pure network op, independent
  // of the LLM, so it is gated on skipUrlCheck (not skipLlm) — a degraded LLM run
  // that still has network keeps gating dead links. Skipped when URL resolution
  // already ran on a previous pass (url_safety_status set).
  let url_safety_status = source.url_safety_status || null;
  let final_url         = source.final_url || source.url || null;
  let url_reachable     = source.url_reachable ?? null;

  if (source.url && !skipUrlCheck && url_safety_status === null) {
    try {
      const urlResult = await resolveAndVerifyUrl(source.url, { timeoutMs: 5000 });
      url_safety_status = urlResult.url_safety_status;
      final_url         = urlResult.final_url || final_url;
      url_reachable     = urlResult.url_reachable;
    } catch {
      // Non-fatal — proceed with unknown status
    }
  }

  // 3.5 — final gate (receives URL results so it can gate on domain-switch / dead-end)
  const gate = applyFinalGate(validity, relevance, typing, trust, {
    content_quality,
    url_safety_status,
    url_reachable,
  });

  // 3.5b — source content status (how much usable text we actually have)
  const source_content_status = classifyContentStatus({
    ...source,
    source_type: typing.source_type,
    content_quality,
  });

  // 3.5c — processing cache check
  // If content_hash matches a previously processed version at the same pipeline
  // version, expensive LLM re-calls can be skipped on subsequent runs.
  const processing_cache_status = (() => {
    if (!source.content_hash) return "no_hash";
    if (source.validation_version === VALIDATION_VERSION &&
        source.validation_status && source.validation_status !== "pending") {
      return "cached";
    }
    return "fresh";
  })();

  // Build the enriched source object so post-gate layers have access to
  // all validation fields (trust_tier, source_type, content_quality, etc.).
  const enriched = {
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
    relevance_path:           relevance.relevance_path ?? null,
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
    // 3.5 — Final gate
    validation_status:        gate.layer3_status,
    layer3_status:            gate.layer3_status,
    final_validity_reason:    gate.final_validity_reason,
    downstream_route:         gate.downstream_route,
    // 3.3 — Content quality gate
    content_quality,
    content_quality_reason:   quality_reason || null,
    // Pre-gate signal strength
    ai_signal_strength:       signal_strength,
    // URL resolution
    url_safety_status,
    final_url,
    url_reachable,
    // Display URL: prefer the resolved final_url, fall back to stored url
    display_url: final_url || source.url || null,
    // Source content availability
    source_content_status,
    // Processing cache
    processing_cache_status,
    validation_version: VALIDATION_VERSION,
  };

  // 3.6 — Origin tracking (additive — runs after final gate so trust_tier / source_type are set)
  const origin = inferOriginRole(enriched);
  enriched.origin_role         = origin.origin_role;
  enriched.primary_origin_url  = origin.primary_origin_url;
  enriched.cited_sources       = origin.cited_sources;
  enriched.origin_reasoning    = origin.origin_reasoning;
  // independence_level from originTracking takes precedence over trust assessment's
  // independence_level when origin can be determined more precisely.
  if (origin.independence_level !== "unknown") {
    enriched.independence_level = origin.independence_level;
  }

  // 3.7 — Source quality (runs last so independence_level and content_quality are set)
  const quality = assessSourceQuality(enriched);
  enriched.source_quality_status  = quality.source_quality_status;
  enriched.source_quality_reasons = quality.source_quality_reasons;

  // 3.8 — Evidence potential + source usefulness roles
  // Runs after all other context is set (trust_tier, publisher_class, origin_role,
  // content_quality, source_type) so it has the full picture.
  const potential = computeEvidencePotential(enriched);
  enriched.evidence_potential      = potential.evidence_potential;
  enriched.source_usefulness_roles = potential.source_usefulness_roles;

  // 3.9 — Richer source route (replaces downstream_route as the canonical routing field)
  // downstream_route kept for backwards compatibility with existing consumers.
  enriched.source_route       = deriveSourceRoute(
    potential.evidence_potential,
    gate.layer3_status,
    gate.downstream_route
  );
  enriched.route_reason_codes = gate.route_reason_codes || [];

  return enriched;
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

  // Circular-reporting detection must be deterministic and must not leak across
  // runs. Clear the registry, then register every source's citations BEFORE any
  // per-source labeling so the ≥3-publisher verdict is independent of the
  // (concurrent) processing order.
  resetCircularRegistry();
  prepopulateCircularRegistry(sources);

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
