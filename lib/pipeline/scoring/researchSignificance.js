/**
 * researchSignificance.js — an LLM significance overlay for research sources.
 *
 * WHY: computeImportance() maps every `research_finding`/`benchmark_evaluation`
 * source to the flat tier "research", so a landmark paper (e.g. "guardrails
 * themselves are an attack surface") ranks identically to a routine incremental
 * study. The importance tier is DELIBERATELY deterministic/LLM-free (auditable,
 * stable, cheap) and we keep it that way. This module adds an ORTHOGONAL,
 * advisory signal — significance — that ranks WITHIN a tier without ever changing
 * it. If the signal is absent (LLM unavailable, not yet scored), ranking simply
 * falls back to the deterministic tier.
 *
 * significance is stored at intelligence.significance and read by:
 *   - the dashboard sort (secondary key within an importance tier)
 *   - evidence/slide selection (prefer landmark research)
 *
 * The LLM call is injectable (opts.llmFn) so this is unit-testable with no network.
 * It is idempotent: assessSignificance is only meant to run on sources that don't
 * already carry a significance record (callers pass --force to overwrite).
 */

// ── Controlled vocabularies ───────────────────────────────────────────────────

export const SIGNIFICANCE_LEVELS = ["landmark", "notable", "routine", "incremental"];

export const NOVELTY_KINDS = [
  "opens_new_attack_surface",   // introduces a NEW class/surface of threat — the strongest signal
  "new_technique",              // a genuinely new technique within a known surface
  "incremental_improvement",    // better numbers / a variation on known work
  "survey_or_reproduction",     // SoK / survey / benchmark / reproduction — synthesises, doesn't introduce
];

// Only research-shaped sources get a significance overlay; incidents/CVEs/threat-intel
// are ranked by the deterministic in-the-wild reality, not by novelty.
export const SIGNIFICANCE_ELIGIBLE_TYPES = new Set(["research_finding", "benchmark_evaluation"]);

// Rank for sorting. landmark rises to the top of its importance tier; incremental sinks.
export const SIGNIFICANCE_RANK = { landmark: 3, notable: 2, routine: 1, incremental: 0 };

/**
 * Is this source eligible for a significance overlay?
 * @param {object} source — DB row or normalise() output
 */
export function isSignificanceEligible(source = {}) {
  return SIGNIFICANCE_ELIGIBLE_TYPES.has(source.source_type);
}

/**
 * Read a source's significance rank (0 when unscored / ineligible).
 * Safe on any row shape — used as a deterministic secondary sort key.
 */
export function significanceRank(source = {}) {
  const level = source?.intelligence?.significance?.level ?? source?.significance?.level ?? null;
  return SIGNIFICANCE_RANK[level] ?? 0;
}

// ── LLM assessment ────────────────────────────────────────────────────────────

import { loadPrompt } from "../../prompts/promptLoader.js";

let _system = null;
function getSystem() {
  if (!_system) _system = loadPrompt("scoring/researchSignificance").system;
  return _system;
}

export const NOVELTY_CONFIDENCE_LEVELS = ["source_claims_first", "strong_contextual", "uncertain"];
export const OPERATIONALIZATION_LEVELS = ["immediate", "near_term", "theoretical", "constrained"];
export const TRANSFERABILITY_LEVELS    = ["high", "medium", "low", "unknown"];

export const SIGNIFICANCE_SCHEMA = {
  type: "object",
  properties: {
    level:              { type: "string", enum: SIGNIFICANCE_LEVELS },
    novelty:            { type: "string", enum: NOVELTY_KINDS },
    novelty_confidence: { type: "string", enum: NOVELTY_CONFIDENCE_LEVELS },
    operationalization: { type: "string", enum: OPERATIONALIZATION_LEVELS },
    transferability:    { type: "string", enum: TRANSFERABILITY_LEVELS },
    broken_assumption:  { type: ["string", "null"] },
    opens_new_surface:  { type: "boolean" },
    reason:             { type: "string" },
  },
  required: ["level", "novelty", "novelty_confidence", "operationalization", "transferability", "reason"],
};

export function buildSignificanceUserPrompt(source) {
  const body = (source.short_summary || source.summary || source.full_text || "").slice(0, 4000);
  return `TITLE: ${source.title || "(untitled)"}
PUBLISHER: ${source.publisher || "unknown"}
SOURCE TYPE: ${source.source_type || "unknown"}
TAGS: ${(source.tags || []).join(", ") || "—"}

SUMMARY / ABSTRACT:
${body}

Follow the steps in the system prompt in order. Return all required JSON fields.`;
}

/**
 * Coerce raw LLM output to controlled vocabularies. Conservative defaults prevent
 * a bad response from inflating a paper to "landmark".
 *
 * Key enforcement rules (beyond vocab clamping):
 *   1. novelty_confidence="uncertain" → downgrade landmark to notable (LLM cannot reliably
 *      determine historical priority; uncertain novelty must not reach landmark).
 *   2. novelty↔level consistency: level is authoritative; novelty is coerced to match.
 *   3. opens_new_surface ⟺ level=landmark AND novelty=opens_new_attack_surface.
 */
export function validateSignificance(raw = {}, opts = {}) {
  let level              = SIGNIFICANCE_LEVELS.includes(raw.level) ? raw.level : "routine";
  let novelty            = NOVELTY_KINDS.includes(raw.novelty) ? raw.novelty : "incremental_improvement";
  const novelty_confidence = NOVELTY_CONFIDENCE_LEVELS.includes(raw.novelty_confidence)
    ? raw.novelty_confidence : "uncertain";
  const operationalization = OPERATIONALIZATION_LEVELS.includes(raw.operationalization)
    ? raw.operationalization : "theoretical";
  const transferability    = TRANSFERABILITY_LEVELS.includes(raw.transferability)
    ? raw.transferability : "unknown";
  const broken_assumption  = typeof raw.broken_assumption === "string" && raw.broken_assumption.trim()
    ? raw.broken_assumption.trim().slice(0, 200) : null;

  // Rule 1: landmark requires source-supported novelty; uncertain novelty → notable.
  if (level === "landmark" && novelty_confidence === "uncertain") level = "notable";

  // Rule 2: novelty↔level consistency. Level is authoritative.
  if (level === "landmark") {
    if (novelty !== "opens_new_attack_surface" && novelty !== "new_technique") novelty = "new_technique";
  } else if (level === "notable") {
    novelty = "new_technique";
  } else if (novelty === "opens_new_attack_surface") {
    novelty = "incremental_improvement";
  }

  return {
    level,
    novelty,
    novelty_confidence,
    operationalization,
    transferability,
    broken_assumption,
    // Rule 3: surface-opener flag is fully derived — never stored as-is from the LLM.
    opens_new_surface: level === "landmark" && novelty === "opens_new_attack_surface",
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 300) : "",
    ...(opts.scoredAt ? { scored_at: opts.scoredAt } : {}),
    model_version: "significance-v3",
  };
}

/**
 * Assess one research source's significance.
 * @param {object} source
 * @param {object} opts
 * @param {Function} opts.llmFn      async (sys, usr, {schema,json}) => object|string
 * @param {string}  [opts.scoredAt]  ISO timestamp (Date.now is avoided upstream)
 * @returns {Promise<object|null>}   significance record, or null if ineligible
 */
export async function assessSignificance(source, opts = {}) {
  if (!isSignificanceEligible(source)) return null;
  if (typeof opts.llmFn !== "function") {
    throw new Error("assessSignificance requires opts.llmFn (routedLLM in production, a fake in tests)");
  }
  const sys = getSystem();
  const usr = buildSignificanceUserPrompt(source);
  const out = await opts.llmFn(sys, usr, { schema: SIGNIFICANCE_SCHEMA, json: true });
  const raw = typeof out === "string" ? JSON.parse(out) : out;
  return validateSignificance(raw || {}, { scoredAt: opts.scoredAt });
}

/**
 * Comparator: importance tier first (deterministic, primary), then significance
 * (advisory, secondary), then date. Higher = ranked earlier. Pass the same
 * importance-rank function the dashboard already uses.
 *
 * @param {Function} importanceRankOf  (source) => number  (e.g. TIER rank)
 */
export function makeRankedComparator(importanceRankOf) {
  return (a, b) => {
    const ia = importanceRankOf(a), ib = importanceRankOf(b);
    if (ib !== ia) return ib - ia;
    const sa = significanceRank(a), sb = significanceRank(b);
    if (sb !== sa) return sb - sa;
    return String(b.date_published || "").localeCompare(String(a.date_published || ""));
  };
}
