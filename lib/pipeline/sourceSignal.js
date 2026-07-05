/**
 * sourceSignal.js — one combined "how much should this source drive analysis" score.
 *
 * The dashboard-insight pipeline previously fed findings round-robin across ALL
 * window sources with no importance weighting, so a noise-tier source diluted the
 * findings pool exactly as much as a realized incident or a landmark paper. This
 * module gives a single deterministic signal score that folds together the three
 * axes we now compute per source:
 *
 *   1. importance.reality  — realized > proven > research > advisory   (what stage)
 *   2. significance.level  — landmark > notable > routine > incremental (how novel; research only)
 *   3. trust_tier          — primary/high > medium > low               (how credible)
 *
 * It is used to (a) prioritise which sources contribute findings and cap noise,
 * (b) rank the attribution candidate pool, and (c) rank top-source selection — so
 * insights are grounded in the strongest signals and landmark research surfaces,
 * without any fuzzy per-source numeric guesswork inside the pipeline.
 *
 * Pure + deterministic + no LLM — fully unit-testable.
 */

import { computeImportance } from "./importance.js";
import { significanceRank }  from "./researchSignificance.js";

// Reality is the dominant axis — an in-the-wild incident outranks any paper.
const REALITY_WEIGHT = { realized: 400, proven: 300, research: 200, advisory: 100, other: 0 };
// Significance lifts a source WITHIN its reality band (research landmark > research routine).
// Capped below one reality band so it never leapfrogs a higher-reality source.
const SIGNIFICANCE_WEIGHT = { 3: 60, 2: 30, 1: 10, 0: 0 };   // landmark|notable|routine|incremental (via significanceRank)
const TRUST_WEIGHT = { primary: 8, high: 6, curated: 6, medium: 4, low: 2, unknown: 0 };

/**
 * Combined signal score for a source row. Higher = should drive analysis more.
 * @param {object} s — a DB source row (with intelligence jsonb) or normalise() output
 */
export function sourceSignalScore(s = {}) {
  const imp = computeImportance(s);
  const reality = REALITY_WEIGHT[imp.reality] ?? 0;
  const sig = SIGNIFICANCE_WEIGHT[significanceRank(s)] ?? 0;
  const trust = TRUST_WEIGHT[s.trust_tier] ?? 0;
  // Defensive sources are context, not offensive signal — halve so a real attack
  // outranks a defense of equal maturity in the findings pool.
  const defensivePenalty = (imp.posture === "defensive") ? 0.5 : 1;
  return Math.round((reality + sig + trust) * defensivePenalty);
}

/**
 * A source is "noise" when it carries the lowest importance tier AND no research
 * significance lifted it (landmark/notable research is never noise). These are the
 * sources that should NOT dilute the findings pool when stronger signal exists.
 * @param {object} s
 */
export function isNoiseSource(s = {}) {
  const tier = computeImportance(s).tier;
  if (tier !== "noise") return false;
  return significanceRank(s) < 2;   // landmark(3)/notable(2) research rescues it
}

/**
 * Comparator (descending signal, newest tiebreak) for sorting source rows.
 */
export function bySignalThenRecency(a, b) {
  const sa = sourceSignalScore(a), sb = sourceSignalScore(b);
  if (sb !== sa) return sb - sa;
  return String(b.date_published || "").localeCompare(String(a.date_published || ""));
}

/**
 * Split sources into signal-bearing and noise, each sorted strongest-first.
 * Callers prioritise `signal` and only dip into `noise` if they still need volume.
 * @returns {{ signal: object[], noise: object[] }}
 */
export function partitionBySignal(sources = []) {
  const signal = [], noise = [];
  for (const s of sources) (isNoiseSource(s) ? noise : signal).push(s);
  signal.sort(bySignalThenRecency);
  noise.sort(bySignalThenRecency);
  return { signal, noise };
}
