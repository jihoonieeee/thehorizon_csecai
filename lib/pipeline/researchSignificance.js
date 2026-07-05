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

export const SIGNIFICANCE_SCHEMA = {
  type: "object",
  properties: {
    level:            { type: "string", enum: SIGNIFICANCE_LEVELS },
    novelty:          { type: "string", enum: NOVELTY_KINDS },
    opens_new_surface:{ type: "boolean" },
    transferability:  { type: "string", enum: ["high", "medium", "low", "unknown"] },
    reason:           { type: "string" },
  },
  required: ["level", "novelty", "reason"],
};

export function buildSignificanceSystemPrompt() {
  return `You rank the SIGNIFICANCE of an AI-security research paper for a threat-intelligence audience. This is NOT a quality/peer-review score — it is "how much should analysts care".

Return JSON:
  level — one of:
    landmark    — reframes the field / opens a NEW attack surface or threat class; changes how defenders think
    notable     — a real, useful new technique or result within a known surface; worth a slide
    routine     — solid but expected; incremental on well-trodden ground
    incremental — minor variation, narrow, or a reproduction with small deltas
  novelty — one of: opens_new_attack_surface | new_technique | incremental_improvement | survey_or_reproduction
  opens_new_surface — true ONLY if it makes a previously-safe component into an attack surface (e.g. "the guardrail itself is the target")
  transferability — high | medium | low | unknown: does the finding transfer to real deployed systems?
  reason — one sentence, concrete (name the surface/technique and why it matters)

Judgement anchors:
  • Turning a DEFENSE into an attack surface (guardrails, safety filters, detectors) → usually landmark, opens_new_attack_surface.
  • First real-world/zero-click/at-scale demonstration of a known-in-theory attack → notable/landmark.
  • Yet-another jailbreak variant, a survey, a benchmark, or +X% on an existing attack → routine/incremental.
Be discriminating: most papers are routine. Reserve "landmark" for genuine surface-openers.`;
}

export function buildSignificanceUserPrompt(source) {
  const body = (source.short_summary || source.summary || source.full_text || "").slice(0, 4000);
  return `TITLE: ${source.title || "(untitled)"}
PUBLISHER: ${source.publisher || "unknown"}
TAGS: ${(source.tags || []).join(", ") || "—"}

SUMMARY / ABSTRACT:
${body}

Rank its significance per the schema.`;
}

/**
 * Coerce raw LLM output to the controlled vocabulary. Out-of-vocab → the most
 * conservative value so a bad response can never inflate a paper to "landmark".
 */
export function validateSignificance(raw = {}, opts = {}) {
  const level   = SIGNIFICANCE_LEVELS.includes(raw.level) ? raw.level : "routine";
  const novelty = NOVELTY_KINDS.includes(raw.novelty) ? raw.novelty : "incremental_improvement";
  const transferability = ["high", "medium", "low", "unknown"].includes(raw.transferability) ? raw.transferability : "unknown";
  return {
    level,
    novelty,
    opens_new_surface: raw.opens_new_surface === true || novelty === "opens_new_attack_surface",
    transferability,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 300) : "",
    ...(opts.scoredAt ? { scored_at: opts.scoredAt } : {}),
    model_version: "significance-v1",
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
  const sys = buildSignificanceSystemPrompt();
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
