/**
 * Layer 3.3 — Source Data Typing
 *
 * Classifies what kind of source this is.
 * Uses deterministic rules first (classifySourceType.js).
 * Falls back to LLM disambiguation only when rule-based returns "unknown"
 * and the source has enough text to classify.
 *
 * Output field is source_type_reason (not source_type_method).
 */

import { classifySourceType }     from "../classifySourceType.js";
import { ALL_SOURCE_TYPES, OLD_SOURCE_TYPE_MAP } from "../../../config/sourceTypes.js";
import { loadPrompt, interpolate } from "../../../prompts/promptLoader.js";
import { routedLLM }              from "../../../llm/llmRouter.js";

// Legacy type map for LLM output — the prompt may still return old strings on
// cached/warm model responses. Normalise before the ALL_SOURCE_TYPES check.
const LLM_LEGACY_NORMALISE = {
  ...OLD_SOURCE_TYPE_MAP,
  // Extra aliases that appear in older prompt versions or model hallucinations
  tooling_platform_development: "ecosystem_signal",
  policy_regulatory_signal:     "governance_signal",
  ecosystem_market_signal:      "ecosystem_signal",
  academic_research:            "research_finding",
  governance_organizational_response: "governance_signal",
  strategic_foresight_signal:   "strategic_signal",
};

async function disambiguateSourceType(source) {
  try {
    const { system, user } = loadPrompt("layer3-sourceTyping");
    // Use up to 1500 chars — hard cases need more context, not less.
    const excerpt = (source.summary || source.full_text || "").slice(0, 1500);
    const filledUser = interpolate(user, {
      title:                   source.title || "",
      publisher:               source.publisher || "Unknown",
      summary_or_text_excerpt: excerpt,
      tags:                    (source.tags || []).join(", ") || "none",
    });

    const { result } = await routedLLM(system, filledUser, {
      task:          "source_typing",   // dedicated lightweight profile
      requires_json: true,
      logLabel:      `L3-source-typing-${(source.id || "").slice(0, 16)}`,
    });
    const parsed = result;

    // Normalise legacy strings before validity check
    const rawType = parsed?.source_type;
    const resolvedType = LLM_LEGACY_NORMALISE[rawType] || rawType;

    if (ALL_SOURCE_TYPES.includes(resolvedType)) {
      return {
        source_type:        resolvedType,
        confidence:         parsed.confidence || "medium",
        source_type_reason: `llm_disambiguation${resolvedType !== rawType ? `(normalised from ${rawType})` : ""}`,
      };
    }
  } catch {
    // LLM failed — fall through to "unknown"
  }
  return null;
}

/**
 * Classify the source_type of a source.
 *
 * @param {object} source
 * @param {object} opts
 * @param {boolean} opts.skipLlm        — skip LLM entirely (fast mode)
 * @param {boolean} opts.forceLlmTyping — force LLM even for rule-matched sources
 * @returns {Promise<{
 *   source_type: string,
 *   source_type_confidence: "high"|"medium"|"low",
 *   source_type_reason: string,
 * }>}
 */
export async function classifyDataType(source, opts = {}) {
  const { skipLlm = false, forceLlmTyping = false } = opts;

  let { type: source_type, confidence: source_type_confidence, method: source_type_reason } =
    classifySourceType(source);

  const textLen = source.full_text?.length ?? 0;
  const shouldCallLlm = !skipLlm && (
    forceLlmTyping ||
    (source_type === "unknown" && textLen >= 100)
  );

  if (shouldCallLlm) {
    const llmResult = await disambiguateSourceType(source);
    if (llmResult) {
      source_type            = llmResult.source_type;
      source_type_confidence = llmResult.confidence;
      source_type_reason     = llmResult.source_type_reason;
    }
  }

  return { source_type, source_type_confidence, source_type_reason };
}
