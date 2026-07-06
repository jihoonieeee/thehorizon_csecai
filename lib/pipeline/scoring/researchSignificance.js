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
  return `You rank the SIGNIFICANCE of an AI-security research source for a threat-intelligence audience. This is NOT a quality/peer-review score — it is "how much should analysts care, and how novel is this to the field".

Return JSON: level, novelty, opens_new_surface, transferability, reason.

━━ level — pick ONE ━━
  landmark    — changes how defenders think. Reserve for ANY of:
                (a) the FIRST work to establish a new attack surface / threat class
                    (a previously-trusted component becomes a target), OR a novel FRAMING
                    of a failure mode as an attack vector (e.g. "LLM hallucination → a
                    registrable supply-chain domain"), OR
                (b) a genuinely NEW capability that was not previously feasible
                    (e.g. FIRST autonomous exploit generation at scale, first end-to-end
                    real-world/zero-click demonstration of a theorized attack), OR
                (c) the FIRST large-scale / systematic demonstration that turns a loosely-
                    noted risk into a measured, corpus-wide threat (a first rigorous
                    benchmark across many real targets counts — do NOT demote it just
                    because a blog once mentioned the idea).
  notable     — a real, useful new technique, result, or defense WITHIN an already-known
                surface; worth a slide. This includes strong new attacks/defenses that
                USE a known surface but do not open it.
  routine     — solid but expected; incremental on well-trodden ground; guidance/SoK for a
                known class; OR secondary coverage (see the news rule below).
  incremental — minor variation, narrow scope, or a reproduction with small deltas.

━━ THE KEY DISTINCTION — first-establishment vs later work on a KNOWN surface ━━
The SAME surface can yield a landmark and many notables. Judge NOVELTY TO THE FIELD:
  • MCP tool-metadata poisoning: the FIRST paper/benchmark that establishes tool
    descriptions are an attack surface → landmark. A LATER technique on that now-known
    surface (a new evasion, a multi-tool variant, a vendor advisory repeating it) → notable,
    even if its own summary says it "turns metadata into an attack surface". Once the
    surface is public knowledge, subsequent work is notable at most.
  • Set opens_new_surface=true ONLY for case (a) — a component becoming a target for the
    FIRST time. Do NOT set it for later work that merely operates on an already-known surface.

━━ NEW-CAPABILITY anchor (don't under-rate these) ━━
A first demonstration that AI can now DO something offensive/defensive at scale that was
previously infeasible is landmark even if the target class is old. Example: an agent that
autonomously discovers AND exploits real production vulnerabilities at scale with measured
impact → landmark (new operational capability), not merely "notable".

━━ SECONDARY / NEWS COVERAGE rule (fixes duplicate news writeups) ━━
Significance attaches to the ORIGINATING research, not to the Nth writeup. If this source is
a news article or vendor blog REPORTING a technique first disclosed elsewhere (rather than
the primary research/disclosure itself), cap it at routine — regardless of how striking the
underlying technique is. The primary paper carries the significance; the coverage does not.

━━ CALIBRATION ━━
Be discriminating: most sources are notable or routine. Landmark should be RARE — well under
1 in 10, but do NOT let the news/known-surface rules erase genuine first-establishment PRIMARY
research (cases a–c above); those rules demote ECHOES and VARIANTS, not the originating work.

novelty MUST be consistent with level (this is a hard requirement, not a preference):
  landmark    → opens_new_attack_surface (surface-opener, case a) OR new_technique (new
                capability, case b/c). NEVER incremental_improvement or survey_or_reproduction.
  notable     → new_technique.
  routine     → incremental_improvement OR survey_or_reproduction.
  incremental → incremental_improvement.
opens_new_surface=true ONLY for a case-(a) surface-opener — not for new-capability landmarks.

reason — ONE concrete sentence: name the surface/capability, and say whether it FIRST-
establishes it (landmark) or operates within a known one (notable/routine).`;
}

export function buildSignificanceUserPrompt(source) {
  const body = (source.short_summary || source.summary || source.full_text || "").slice(0, 4000);
  return `TITLE: ${source.title || "(untitled)"}
PUBLISHER: ${source.publisher || "unknown"}   (a news outlet / vendor blog here usually means SECONDARY coverage — apply the news rule; a research venue like arXiv is usually primary)
TAGS: ${(source.tags || []).join(", ") || "—"}

SUMMARY / ABSTRACT:
${body}

Rank its significance per the schema. Decide first: is this the ORIGINATING research, or coverage of something disclosed elsewhere? Then: does it FIRST-establish a surface/capability (landmark) or operate within a known one (notable/routine)?`;
}

/**
 * Coerce raw LLM output to the controlled vocabulary. Out-of-vocab → the most
 * conservative value so a bad response can never inflate a paper to "landmark".
 */
export function validateSignificance(raw = {}, opts = {}) {
  const level   = SIGNIFICANCE_LEVELS.includes(raw.level) ? raw.level : "routine";
  let   novelty = NOVELTY_KINDS.includes(raw.novelty) ? raw.novelty : "incremental_improvement";
  const transferability = ["high", "medium", "low", "unknown"].includes(raw.transferability) ? raw.transferability : "unknown";

  // Enforce novelty↔level consistency so a self-contradictory record (e.g.
  // landmark + incremental_improvement, which then derives opens_new_surface=false)
  // can never be stored, even when the LLM slips. The LEVEL is authoritative — it
  // carries the ranking weight — so novelty is coerced to match it, never the reverse.
  if (level === "landmark") {
    // landmark must be a surface-opener OR a new capability; keep the LLM's choice
    // between those two, but never let it be incremental/survey.
    if (novelty !== "opens_new_attack_surface" && novelty !== "new_technique") novelty = "new_technique";
  } else if (level === "notable") {
    novelty = "new_technique";
  } else if (novelty === "opens_new_attack_surface") {
    // routine/incremental can never be a surface-opener.
    novelty = "incremental_improvement";
  }

  return {
    level,
    novelty,
    // Surface-opener flag ⟺ novelty is opens_new_attack_surface, which (after the
    // coercion above) can only occur on a case-(a) landmark. New-capability landmarks
    // are new_technique and are NOT surface-openers; nothing below landmark qualifies.
    opens_new_surface: novelty === "opens_new_attack_surface",
    transferability,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 300) : "",
    ...(opts.scoredAt ? { scored_at: opts.scoredAt } : {}),
    model_version: "significance-v2",
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
