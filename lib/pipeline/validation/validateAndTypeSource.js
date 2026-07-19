/**
 * Validation Layer (Layer 3) — Unified single-call orchestrator
 *
 * Flow:
 *   3.1  checkSourceValidity     — structural: missing URL/title, stale, too short
 *   3.2  hasAiSignal             — deterministic pre-gate (no LLM spend on zero-signal sources)
 *   3.3  annotateSourceContext   — deterministic trust/publisher context (advisory input to LLM)
 *   3.4  runLayer3Llm            — ONE LLM call: relevance + quality + trust + typing + verdict
 *   3.5  applyFinalGate          — structural hard overrides (URL safety, research gate backstop,
 *                                  adjacent backstop) then routes via the LLM verdict
 *   3.6  origin / quality / evidence-potential — additive post-gate annotation
 *
 * Cost control: sources with no AI signal at all are discarded by the deterministic
 * pre-gate WITHOUT any LLM call. The single unified call replaces three separate
 * LLM tasks (source_relevance, source_relevance_qa, source_quality_gate).
 *
 * Edit lib/prompts/validation/layer3.md to change LLM behaviour.
 * Edit lib/pipeline/validation/layer3Llm.js to change output validation.
 * Edit finalGate.js to change structural routing overrides.
 */

import { checkSourceValidity }       from "./sourceValidity.js";
import {
  assessAiRelevance,
  hasAiSignal,
  deriveRelevanceFromFocus,
}                                    from "./aiRelevance.js";
import { runLayer3Llm }              from "./layer3Llm.js";
import { runResearchGate, isResearchSourceType } from "./researchGate.js";
import { resolveAndVerifyUrl }       from "./urlSafety.js";
import { annotateSourceContext }     from "./trustAssessment.js";
import { applyFinalGate }            from "./finalGate.js";
import { assessSourceQuality }       from "./sourceQuality.js";
import { inferOriginRole, resetCircularRegistry, prepopulateCircularRegistry } from "./originTracking.js";
import {
  computeEvidencePotential,
  deriveSourceRoute,
  classifyContentStatus,
}                                    from "./evidencePotential.js";

export const VALIDATION_VERSION = "validation-v1.4";

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
 * @param {boolean}  [opts.skipLlm=false]    Force the deterministic path (no LLM calls).
 * @param {boolean}  [opts.runQa]            No-op — QA is now folded into the unified call.
 * @param {boolean}  [opts.skipUrlCheck]     Skip the network URL-reachability probe.
 * @param {Function} [opts.llmFn]            Injectable LLM fn (same signature as routedLLM).
 * @returns {Promise<object>} source enriched with all validation fields.
 */
export async function validateAndTypeSource(source, opts = {}) {
  const { skipLlm = false, llmFn, skipUrlCheck = skipLlm } = opts;

  // 3.1 — structural validity
  const validity = checkSourceValidity(source);

  // 3.3 — deterministic trust context (advisory input to the LLM, not a gate)
  const trust = annotateSourceContext(source);

  // State filled by one of the paths below.
  let relevance;
  let typing;
  let validation_summary  = null;
  let ai_threat_focus     = null;
  let candidate_domain    = "unclear_or_adjacent";
  let relevance_method    = "deterministic";
  let qa_status           = "n/a";
  let reasoning           = "";
  let content_quality     = "substantive";
  let quality_reason      = "";
  let signal_strength     = "none";
  let llm_verdict         = null;
  let llm_rejection_reason = null;
  // New evidence/taxonomy fields from the unified LLM call.
  let ai_materiality      = null;
  let evidence_origin     = null;
  let evidence_quality    = null;
  let claim_support       = null;
  let publisher_role      = null;
  let secondary_domain    = null;
  let affected_ai_layer   = null;
  let boundary_rationale  = null;
  let reading_value            = null;
  let distribution_recommendation = null;
  let recommendation_reason    = null;
  // Research gate fields (only populated for research source types).
  let research_gate_verdict         = null;
  let research_gate_read_value      = null;
  let research_gate_reject_reason   = null;
  let research_gate_contribution_type = null;
  let research_gate_maturity        = null;
  // LLM may adjust trust tier based on actual content; deterministic value is the baseline.
  let effective_trust_tier        = trust.trust_tier;
  let effective_trust_tier_reason = trust.trust_tier_reason;

  const signal = hasAiSignal(source);
  signal_strength = signal.signal_strength || "none";

  if (validity.hard_fail) {
    // Structurally unusable — skip LLM.
    relevance = { ...assessAiRelevance(source), relevance_tier: "off_topic" };
    typing    = { source_type: source.source_type || "unknown", source_type_confidence: "low", source_type_reason: "validity_fail" };
    relevance_method = "skipped_invalid";

  } else if (!signal.has_ai_signal && !isPrimaryAuthoritySource(source)) {
    // Deterministic pre-gate: no AI signal → no LLM spend.
    // Primary-authority publishers bypass this — they may use non-standard vocabulary.
    relevance = { ...assessAiRelevance(source), relevance_tier: "off_topic", ai_specificity_score: 0 };
    typing    = { source_type: source.source_type || "unknown", source_type_confidence: "low", source_type_reason: "pre_gate_discard" };
    relevance_method = "pre_gate_discard";

  } else if (!skipLlm) {
    // 3.4 — unified Layer 3 LLM call (single call replacing relevance + QA + quality gate)
    const l3 = await runLayer3Llm(source, trust, { llmFn });

    if (l3) {
      ai_threat_focus      = l3.ai_threat_focus;
      validation_summary   = l3.summary;
      candidate_domain     = l3.candidate_domain;
      reasoning            = l3.reasoning;
      content_quality      = l3.content_quality;
      quality_reason       = l3.trust_tier_reason;
      llm_verdict          = l3.verdict;
      llm_rejection_reason = l3.rejection_reason;
      relevance_method     = "llm";
      qa_status            = "unified";   // QA is folded into the single call
      // New evidence + taxonomy fields
      ai_materiality     = l3.ai_materiality     ?? null;
      evidence_origin    = l3.evidence_origin    ?? null;
      evidence_quality   = l3.evidence_quality   ?? null;
      claim_support      = l3.claim_support      ?? null;
      publisher_role     = l3.publisher_role     ?? null;
      secondary_domain   = l3.secondary_domain   ?? null;
      affected_ai_layer  = l3.affected_ai_layer  ?? null;
      boundary_rationale = l3.boundary_rationale ?? null;
      reading_value               = l3.reading_value               ?? null;
      distribution_recommendation = l3.distribution_recommendation ?? null;
      recommendation_reason       = l3.recommendation_reason       ?? null;

      // Trust tier: take the more restrictive of deterministic and LLM assessments.
      // LLM sees actual content and can downgrade (e.g. "high" publisher → "medium"
      // quality marketing piece). Never let the LLM upgrade beyond the connector value
      // (connector has access to source metadata the LLM doesn't).
      const TRUST_RANK = { primary: 4, curated: 4, high: 3, medium: 2, low: 1, unknown: 0 };
      const detRank = TRUST_RANK[trust.trust_tier] ?? 0;
      const llmRank = TRUST_RANK[l3.trust_tier]   ?? 0;
      if (llmRank < detRank) {
        effective_trust_tier        = l3.trust_tier;
        effective_trust_tier_reason = `llm_downgrade: ${l3.trust_tier_reason}`;
      }

      // LLM typing is authoritative over any connector-assigned source_type.
      // The connector sets a coarse type from feed metadata; L3 sees full text
      // and produces a more accurate semantic type. Unlike trust_tier (where we
      // take the more restrictive of LLM vs connector), source_type has no safe
      // "conservative" direction — the LLM reading is simply better evidence.
      typing = {
        source_type:            l3.source_type,
        source_type_confidence: l3.confidence,
        source_type_reason:     "layer3_llm",
      };

      // ── Research gate — harder pass/fail for academic papers ─────────────────
      // Runs only when L3 has not already rejected the source and source_type is
      // a research type. Only "essential" and "recommended" papers pass this gate;
      // "analyst"-level incremental tests, benchmarks, surveys, and defensive-primary
      // papers are rejected here regardless of the L3 verdict.
      //
      // ATLAS case studies are confirmed real-world incidents — always pass the research gate.
      const isAtlasSource = !!(source.intelligence?.atlas_id || (source.url || "").includes("atlas.mitre.org"));
      const researchGateApplies = isResearchSourceType(l3.source_type)
        && llm_verdict !== "reject"
        && !isAtlasSource;
      if (researchGateApplies) {
        const rg = await runResearchGate(source, { llmFn });
        if (rg) {
          research_gate_verdict          = rg.verdict;
          research_gate_read_value       = rg.read_value;
          research_gate_reject_reason    = rg.reject_reason;
          research_gate_contribution_type = rg.contribution_type;
          research_gate_maturity         = rg.maturity;

          if (rg.verdict === "reject") {
            // Override the L3 pass to reject — research gate is the authoritative filter.
            llm_verdict          = "reject";
            llm_rejection_reason = rg.reject_reason || "research_gate_reject";
            reading_value        = "background";   // ensure final gate also rejects
          } else {
            // Research gate approved — its read_value is more precise than L3's for papers.
            reading_value = rg.read_value;   // "essential" or "recommended"
          }
        }
        // If rg is null (LLM error), fall through with the L3 verdict unchanged.
        // finalGate.js will still apply the analyst-reading-value hard reject as a backstop.
      }

      const derived = deriveRelevanceFromFocus(l3.ai_threat_focus);
      const det     = assessAiRelevance(source);
      relevance = {
        relevance_tier:        derived.relevance_tier,
        ai_specificity_score:  derived.ai_specificity_score,
        ai_relevance_score:    det.ai_relevance_score,
        cyber_relevance_score: det.cyber_relevance_score,
        relevance_path:        det.relevance_path,
      };

    } else {
      // LLM failed → deterministic fallback.
      relevance = assessAiRelevance(source);
      typing    = { source_type: source.source_type || "unknown", source_type_confidence: "low", source_type_reason: "llm_fallback" };
      relevance_method = "deterministic_fallback";
      ai_threat_focus  = ["core", "adjacent"].includes(relevance.relevance_tier) ? "central" : "none";
    }

  } else {
    // skipLlm path — fully deterministic.
    relevance = assessAiRelevance(source);
    typing    = { source_type: source.source_type || "unknown", source_type_confidence: "low", source_type_reason: "skip_llm" };
    relevance_method = "deterministic";
    ai_threat_focus  = ["core", "adjacent"].includes(relevance.relevance_tier) ? "central" : "none";
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

  // 3.5 — final gate
  // Structural hard overrides (URL safety, validity, curated) are always deterministic.
  // The LLM verdict is used as the primary quality/relevance routing signal.
  // Pass effective_trust_tier (the more restrictive of deterministic + LLM) so the
  // curated/primary exceptions in the gate still work correctly.
  const gate = applyFinalGate(
    validity,
    relevance,
    typing,
    { ...trust, trust_tier: effective_trust_tier },
    {
      content_quality,
      url_safety_status,
      url_reachable,
      ai_threat_focus,
      llm_verdict,
      llm_rejection_reason,
      reading_value,
      source,
    }
  );

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
    // effective_trust_tier is the more restrictive of deterministic + LLM assessments.
    trust_tier:              effective_trust_tier,
    trust_tier_reason:       effective_trust_tier_reason,
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
    // Evidence + taxonomy fields from unified LLM call
    ai_materiality,
    evidence_origin,
    evidence_quality,
    claim_support,
    publisher_role,
    secondary_domain,
    affected_ai_layer,
    boundary_rationale,
    reading_value,
    distribution_recommendation,
    recommendation_reason,
    // Research gate fields (null for non-research source types)
    research_gate_verdict,
    research_gate_read_value,
    research_gate_reject_reason,
    research_gate_contribution_type,
    research_gate_maturity,
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
      reject_count: rejected.length,
      llm_calls:    llmCalls,
      method_frequency: methodCounts,
    },
  };
}
