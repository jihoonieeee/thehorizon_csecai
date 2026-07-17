/**
 * Research Gate — specialist pass/reject filter for academic research sources.
 *
 * Runs AFTER the general Layer 3 LLM call has already confirmed AI materiality and
 * assigned source_type. Called only for research-typed sources (research_finding,
 * benchmark_evaluation, capability_demonstration).
 *
 * The general L3 gate treats "analyst" reading_value as a pass (puts the source in
 * the practitioner library). This gate is harder: only "essential" and "recommended"
 * papers pass into the corpus. Routine benchmarks, incremental tests, surveys, and
 * defensive-primary papers are rejected here even if L3 passed them.
 *
 * Prompt: lib/prompts/validation/research-gate.md
 */

import { routedLLM }              from "../../llm/llmRouter.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";

// ── Source types that trigger this gate ───────────────────────────────────────

export const RESEARCH_GATE_TYPES = new Set([
  "research_finding",
  "benchmark_evaluation",
  "capability_demonstration",
]);

export function isResearchSourceType(sourceType) {
  return RESEARCH_GATE_TYPES.has(sourceType);
}

// ── Controlled vocabularies ───────────────────────────────────────────────────

const VALID_VERDICT      = new Set(["pass", "reject"]);
const VALID_READ_VALUE   = new Set(["essential", "recommended", "low"]);
const VALID_CONTRIBUTION = new Set([
  // Passing categories (essential or recommended)
  "new_attack_path",          // previously unrecognized attack path, trust boundary, or architectural assumption
  "new_technique",            // novel attack method or working exploit against a named system
  "prevalence_signal",        // large-scale empirical measurement of real-world AI attack exposure
  "capability_acceleration",  // evidence adversaries are gaining speed/cost/scale advantages via AI
  "supply_chain_vector",      // new attack pathway through model repos, training pipelines, or inference infra
  // Rejection categories
  "benchmark_only",           // evaluation framework or benchmark for existing attacks
  "defensive_primary",        // primary deliverable is a defense, guardrail, or mitigation
  "survey_or_sok",            // systematization of knowledge, literature review, survey
  "incremental_test",         // existing attack retested on more/newer models, higher ASR only
]);
const VALID_MATURITY = new Set([
  "research_only",   // controlled lab / synthetic data / toy model; no real system
  "demonstrated",    // working attack against real software or production-equivalent system
  "weaponized",      // public exploit tooling available (GitHub, packaged tool) but no confirmed in-wild use
  "observed",        // reported in real environments; not yet independently corroborated
  "operational",     // confirmed adversary use; named actors, campaigns, or multi-source corroboration
]);

// ── Text excerpt builder ──────────────────────────────────────────────────────

function buildExcerpt(source) {
  // Prefer full_text. arXiv connector fetches the full HTML paper body
  // (abstract + intro + methods/results, up to 15 000 chars). The research gate
  // needs to see the methodology and results sections — not just the abstract —
  // to distinguish "new technique with demonstrated exploit" from "incremental
  // evaluation of known attacks on more models". 8 000 chars captures the abstract,
  // full intro, and most of the methods section for the majority of cs.CR papers.
  return (
    source.full_text?.length > 200
      ? source.full_text
      : source.summary || source.full_text || ""
  ).slice(0, 8000);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run the research gate LLM call on a single research-type source.
 *
 * Returns null when the LLM is unavailable. Callers must fall back to the
 * general L3 verdict when this returns null (do not hard-reject on null).
 *
 * @param {object} source          Full source object
 * @param {object} [opts]
 * @param {Function} [opts.llmFn]  Injectable LLM fn (same signature as routedLLM)
 * @returns {Promise<{
 *   verdict: "pass" | "reject",
 *   read_value: "essential" | "recommended" | "low",
 *   offensive_primary: boolean,
 *   contribution_type: string,
 *   maturity: string,
 *   reject_reason: string | null,
 *   reasoning: string,
 * } | null>}
 */
export async function runResearchGate(source, opts = {}) {
  const { llmFn = routedLLM } = opts;

  try {
    const { system, user } = loadPrompt("validation/research-gate");
    const text_excerpt = buildExcerpt(source);

    const filledUser = interpolate(user, {
      title:          source.title          || "(no title)",
      publisher:      source.publisher      || "Unknown",
      url:            source.url            || "",
      date_published: source.date_published || "unknown",
      source_type:    source.source_type    || "unknown",
      text_excerpt:   text_excerpt          || "(no text available)",
    });

    const { result, llm_metadata } = await llmFn(system, filledUser, {
      task:          "research_gate",
      requires_json: true,
      logLabel:      `RG-${(source.id || "").slice(0, 16)}`,
    });

    if (!result || llm_metadata?.llm_used === false) return null;

    // ── Validate fields ───────────────────────────────────────────────────────

    const offensive_primary  = Boolean(result.offensive_primary);
    const contribution_type  = VALID_CONTRIBUTION.has(result.contribution_type)
      ? result.contribution_type : "incremental_test";
    const maturity           = VALID_MATURITY.has(result.maturity)
      ? result.maturity : "research_only";
    const reasoning          = typeof result.reasoning === "string"
      ? result.reasoning.trim().slice(0, 300) : "";

    // Non-offensive papers always reject, regardless of other fields.
    if (!offensive_primary) {
      const reject_reason = typeof result.reject_reason === "string"
        ? result.reject_reason.trim().slice(0, 150)
        : "not_offensive_primary";
      return {
        verdict: "reject",
        read_value: "low",
        offensive_primary: false,
        contribution_type,
        maturity,
        reject_reason,
        reasoning,
      };
    }

    const raw_verdict    = VALID_VERDICT.has(result.verdict) ? result.verdict : "reject";
    const raw_read_value = VALID_READ_VALUE.has(result.read_value) ? result.read_value : "low";

    // low read_value always rejects, even when LLM set verdict="pass".
    if (raw_read_value === "low" || raw_verdict === "reject") {
      const reject_reason = typeof result.reject_reason === "string"
        ? result.reject_reason.trim().slice(0, 150)
        : (raw_read_value === "low" ? "low_read_value" : "research_gate_reject");
      return {
        verdict: "reject",
        read_value: "low",
        offensive_primary,
        contribution_type,
        maturity,
        reject_reason,
        reasoning,
      };
    }

    return {
      verdict:          "pass",
      read_value:       raw_read_value,   // "essential" or "recommended"
      offensive_primary,
      contribution_type,
      maturity,
      reject_reason:    null,
      reasoning,
    };

  } catch {
    // LLM error — caller falls back to standard L3 judgment.
    return null;
  }
}
