/**
 * Layer 3 — Unified LLM call
 *
 * Single entry point for all non-deterministic Layer 3 logic. Replaces three
 * separate LLM calls (runRelevanceLlm, runRelevanceQa, runContentQualityGate)
 * with one call that sees the full picture and produces a holistic verdict.
 *
 * Edit lib/prompts/validation/layer3.md to change what the LLM does.
 * Edit this file to change how the output is validated and normalised.
 *
 * @module layer3Llm
 */

import { routedLLM }              from "../../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";
import { ALL_SOURCE_TYPES, OLD_SOURCE_TYPE_MAP } from "../../config/sourceTypes.js";
import { DOMAINS }                from "../../config/taxonomyRegistry.js";

// ── Allowed value sets ────────────────────────────────────────────────────────

const VALID_FOCUS       = new Set(["central", "adjacent", "passing", "none"]);
const VALID_QUALITY     = new Set(["substantive", "thin_content", "marketing", "keyword_stuffing", "aggregation"]);
const VALID_TRUST       = new Set(["primary", "high", "medium", "low", "unknown"]);
const VALID_VERDICT     = new Set(["pass", "review", "reject"]);
const VALID_DOMAINS     = new Set([...DOMAINS, "unclear_or_adjacent"]);
const VALID_READING     = new Set(["essential", "recommended", "analyst", "background"]);
const VALID_MATERIALITY = new Set(["material", "incidental", "absent"]);
const VALID_EV_ORIGIN   = new Set(["first_party", "original_research", "secondary_reporting", "aggregation", "unclear"]);
const VALID_EV_QUALITY  = new Set(["strong", "adequate", "weak", "unverifiable"]);
const VALID_CLAIM_SUPP  = new Set(["direct", "indirect", "speculative"]);
const VALID_PUB_ROLE    = new Set(["vendor", "victim", "researcher", "government", "journalist", "aggregator"]);
const VALID_AI_LAYER    = new Set([
  "model_artifact", "training", "inference", "llm_processing", "rag_retrieval",
  "agent_autonomy", "ai_infrastructure", "ai_as_weapon", "governance_policy", "none",
]);

// ── Source type normalisation ─────────────────────────────────────────────────

const TYPE_ALIASES = {
  ...OLD_SOURCE_TYPE_MAP,
  academic_research:            "research_finding",
  policy_regulatory_signal:     "governance_signal",
  ecosystem_market_signal:      "attack_surface_signal",
  strategic_foresight_signal:   "attack_surface_signal",
  news_article:                 "incident",   // operational coverage maps to incident
};

function normaliseType(raw) {
  if (!raw || typeof raw !== "string") return "unknown";
  const resolved = TYPE_ALIASES[raw.trim()] ?? raw.trim();
  return ALL_SOURCE_TYPES.includes(resolved) ? resolved : "unknown";
}

function normaliseDomain(raw, focus) {
  if (focus !== "central") return "unclear_or_adjacent";
  return VALID_DOMAINS.has(raw) ? raw : "unclear_or_adjacent";
}

// ── Text excerpt builder ──────────────────────────────────────────────────────

function buildExcerpt(source) {
  // Prefer full_text, fall back to summary. 4000 chars gives the model enough
  // context to assess quality and trust without burning excessive tokens.
  return (
    source.full_text?.length > 200
      ? source.full_text
      : source.summary || source.full_text || ""
  ).slice(0, 4000);
}

// ── Prior trust context (passed to LLM as advisory input) ────────────────────

function buildPriorTrustContext(priorTrust) {
  const parts = [
    `Publisher class: ${priorTrust.publisher_class || "unknown"}`,
    `Connector-assigned trust: ${priorTrust.trust_tier || "unknown"}`,
  ];
  const note = priorTrust.reliability_notes?.[0];
  if (note) parts.push(`Note: ${note}`);
  return parts.join(". ");
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run the unified Layer 3 LLM call on a single source.
 *
 * @param {object} source       Full source object (needs title, publisher, url, full_text / summary)
 * @param {object} priorTrust   Output of annotateSourceContext() — advisory context for the LLM
 * @param {object} [opts]
 * @param {Function} [opts.llmFn=routedLLM]   Injectable LLM fn (same signature as routedLLM)
 * @returns {Promise<{
 *   verdict: "pass"|"review"|"reject",
 *   rejection_reason: string|null,
 *   ai_threat_focus: "central"|"adjacent"|"passing"|"none",
 *   ai_materiality: "material"|"incidental"|"absent",
 *   content_quality: "substantive"|"thin_content"|"marketing"|"keyword_stuffing"|"aggregation",
 *   evidence_origin: "first_party"|"original_research"|"secondary_reporting"|"aggregation"|"unclear",
 *   evidence_quality: "strong"|"adequate"|"weak"|"unverifiable",
 *   claim_support: "direct"|"indirect"|"speculative",
 *   publisher_role: "vendor"|"victim"|"researcher"|"government"|"journalist"|"aggregator",
 *   trust_tier: "primary"|"high"|"medium"|"low"|"unknown",
 *   trust_tier_reason: string,
 *   source_type: string,
 *   candidate_domain: string,
 *   secondary_domain: string|null,
 *   affected_ai_layer: string,
 *   boundary_rationale: string,
 *   reading_value: "essential"|"recommended"|"analyst"|"background",
 *   distribution_recommendation: { overview_dashboard: boolean, email_newsletter: boolean, analyst_library: boolean },
 *   recommendation_reason: string,
 *   summary: string|null,
 *   confidence: "high"|"medium"|"low",
 *   reasoning: string,
 *   llm_used: true,
 * }|null>}
 *
 * Returns null when the LLM is unavailable or returns an invalid response.
 * Callers must fall back to the deterministic path when this returns null.
 */
export async function runLayer3Llm(source, priorTrust, opts = {}) {
  const { llmFn = routedLLM } = opts;

  try {
    const { system, user } = loadPrompt("validation/layer3");
    const text_excerpt = buildExcerpt(source);

    const filledUser = interpolate(user, {
      title:               source.title        || "(no title)",
      publisher:           source.publisher    || "Unknown",
      url:                 source.url          || "",
      date_published:      source.date_published || "unknown",
      prior_trust_context: buildPriorTrustContext(priorTrust),
      text_excerpt:        text_excerpt || "(no text available)",
    });

    const { result, llm_metadata } = await llmFn(system, filledUser, {
      task:          "layer3_validation",
      requires_json: true,
      logLabel:      `L3-${(source.id || "").slice(0, 16)}`,
    });

    if (!result || llm_metadata?.llm_used === false) return null;

    // ── Validate all fields ───────────────────────────────────────────────────
    const focus = VALID_FOCUS.has(result.ai_threat_focus) ? result.ai_threat_focus : null;
    if (!focus) return null;   // non-negotiable: without a focus verdict we can't route

    const content_quality = VALID_QUALITY.has(result.content_quality)
      ? result.content_quality
      : "substantive";   // fail open on quality (final gate handles the rest)

    const trust_tier = VALID_TRUST.has(result.trust_tier)
      ? result.trust_tier
      : "unknown";

    const verdict = VALID_VERDICT.has(result.verdict)
      ? result.verdict
      : "review";   // fail to review, not reject, when verdict is missing/invalid

    const source_type = normaliseType(result.source_type);

    const candidate_domain = normaliseDomain(result.candidate_domain, focus);

    const secondary_domain = (() => {
      const raw = result.secondary_domain;
      if (!raw || raw === "null") return null;
      return VALID_DOMAINS.has(raw) && raw !== "unclear_or_adjacent" && raw !== candidate_domain
        ? raw : null;
    })();

    const summary = typeof result.summary === "string"
      ? result.summary.trim().slice(0, 600)
      : null;

    const trust_tier_reason = typeof result.trust_tier_reason === "string"
      ? result.trust_tier_reason.trim().slice(0, 250)
      : "";

    const rejection_reason = verdict === "reject" && typeof result.rejection_reason === "string"
      ? result.rejection_reason.trim().slice(0, 150)
      : null;

    const confidence = ["high", "medium", "low"].includes(result.confidence)
      ? result.confidence
      : "medium";

    const reasoning = typeof result.reasoning === "string"
      ? result.reasoning.trim().slice(0, 300)
      : "";

    // ── New evidence + taxonomy fields (fail-safe with defaults) ─────────────
    const ai_materiality = VALID_MATERIALITY.has(result.ai_materiality)
      ? result.ai_materiality
      : (focus === "none" || focus === "passing" ? "incidental" : "material");

    const evidence_origin = VALID_EV_ORIGIN.has(result.evidence_origin)
      ? result.evidence_origin
      : "unclear";

    const evidence_quality = VALID_EV_QUALITY.has(result.evidence_quality)
      ? result.evidence_quality
      : "adequate";

    const claim_support = VALID_CLAIM_SUPP.has(result.claim_support)
      ? result.claim_support
      : "indirect";

    const publisher_role = VALID_PUB_ROLE.has(result.publisher_role)
      ? result.publisher_role
      : "journalist";

    const affected_ai_layer = VALID_AI_LAYER.has(result.affected_ai_layer)
      ? result.affected_ai_layer
      : "none";

    const boundary_rationale = typeof result.boundary_rationale === "string"
      ? result.boundary_rationale.trim().slice(0, 300)
      : "";

    const reading_value = VALID_READING.has(result.reading_value)
      ? result.reading_value
      : (focus === "central" ? "analyst" : "background");   // safe default

    // distribution_recommendation — fail-safe: derive sensible defaults from reading_value
    // when the LLM omits or malforms the field.
    const dist_raw = result.distribution_recommendation;
    const distribution_recommendation = (dist_raw && typeof dist_raw === "object" && !Array.isArray(dist_raw))
      ? {
          overview_dashboard: Boolean(dist_raw.overview_dashboard),
          email_newsletter:   Boolean(dist_raw.email_newsletter),
          analyst_library:    Boolean(dist_raw.analyst_library),
        }
      : {
          overview_dashboard: reading_value === "essential" || reading_value === "recommended",
          email_newsletter:   reading_value === "essential" || reading_value === "recommended",
          analyst_library:    reading_value !== "background",
        };

    const recommendation_reason = typeof result.recommendation_reason === "string"
      ? result.recommendation_reason.trim().slice(0, 300)
      : "";

    return {
      verdict,
      rejection_reason,
      ai_threat_focus:  focus,
      ai_materiality,
      content_quality,
      evidence_origin,
      evidence_quality,
      claim_support,
      publisher_role,
      reading_value,
      distribution_recommendation,
      recommendation_reason,
      trust_tier,
      trust_tier_reason,
      source_type,
      candidate_domain,
      secondary_domain,
      affected_ai_layer,
      boundary_rationale,
      summary,
      confidence,
      reasoning,
      llm_used: true,
    };

  } catch {
    // LLM error — caller falls back to deterministic path.
    return null;
  }
}
