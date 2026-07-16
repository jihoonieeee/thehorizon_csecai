/**
 * sourceSignal.js — combined "how much should this source drive analysis" score.
 *
 * Three orthogonal axes, no overlaps:
 *   reading_value   — audience fit: essential > recommended > analyst > background
 *                     (set by Layer 3 LLM; answers "should leadership / team read this?")
 *   maturity_level  — threat lifecycle: operational > observed > disclosed > demonstrated > research
 *                     (set by Layer 4 LLM; answers "how real is the threat technique?")
 *   significance    — research novelty: landmark > notable > routine > incremental
 *                     (set by scoring layer, research sources only)
 *
 * reading_value is the primary ranking axis for editorial selection (dashboard, digest,
 * agent suggested readings). maturity_level ranks within a reading_value band.
 * significance rescues landmark research from lower reading_value assignments.
 *
 * Pure + deterministic + no LLM.
 */

import { maturityOf }       from "./maturityLevel.js";
import { significanceRank } from "./researchSignificance.js";

// ── Weights ───────────────────────────────────────────────────────────────────

const READING_WEIGHT = {
  essential:   400,
  recommended: 300,
  analyst:     200,
  background:  100,
};

// Maturity lifts within a reading_value band without crossing into a higher band.
const MATURITY_WEIGHT = {
  operational:  60,
  observed:     50,
  disclosed:    30,
  demonstrated: 20,
  research:     10,
};

// Significance rescues landmark/notable research. Capped below one reading_value band.
const SIGNIFICANCE_WEIGHT = { 3: 50, 2: 25, 1: 5, 0: 0 }; // landmark|notable|routine|incremental

const TRUST_WEIGHT = { primary: 8, high: 6, medium: 4, low: 2, unknown: 0 };

// ── Reading value reader ──────────────────────────────────────────────────────

const READING_VALUES = new Set(["essential", "recommended", "analyst", "background"]);

export function readingValueOf(s = {}) {
  // Prefer top-level column (set at Layer 3 ingest); fall back to intelligence jsonb
  // (for sources processed before this field existed).
  const v = s.reading_value ?? s.intelligence?.reading_value ?? null;
  return READING_VALUES.has(v) ? v : null;
}

export const READING_RANK = { essential: 3, recommended: 2, analyst: 1, background: 0 };

// ── Combined signal score ─────────────────────────────────────────────────────

/**
 * Combined signal score for a source row. Higher = should drive analysis more.
 * @param {object} s — a DB source row (with intelligence jsonb) or normalise() output
 */
export function sourceSignalScore(s = {}) {
  const rv      = readingValueOf(s) ?? "background";
  const reading  = READING_WEIGHT[rv]          ?? 0;
  const maturity = MATURITY_WEIGHT[maturityOf(s)] ?? 0;
  const sig      = SIGNIFICANCE_WEIGHT[significanceRank(s)] ?? 0;
  const trust    = TRUST_WEIGHT[s.trust_tier]  ?? 0;

  // Defensive sources are context, not offensive signal — halve so a real attack
  // outranks a defense of equal reading_value in the findings pool.
  const isDefensive = s.intelligence?.mechanism_classification?.is_defensive
    ?? s.intelligence?.is_defensive
    ?? s.is_defensive
    ?? false;
  const penalty = isDefensive ? 0.5 : 1;

  return Math.round((reading + maturity + sig + trust) * penalty);
}

/**
 * True when a source carries no signal worth including in active analysis.
 * background reading_value + no landmark/notable significance = noise.
 */
export function isNoiseSource(s = {}) {
  const rv = readingValueOf(s);
  if (rv && rv !== "background") return false;  // analyst/recommended/essential always signal
  return significanceRank(s) < 2;               // landmark(3)/notable(2) research rescues it
}

/**
 * Comparator (descending signal, newest tiebreak).
 */
export function bySignalThenRecency(a, b) {
  const sa = sourceSignalScore(a), sb = sourceSignalScore(b);
  if (sb !== sa) return sb - sa;
  return String(b.date_published || "").localeCompare(String(a.date_published || ""));
}

/**
 * Split sources into signal-bearing and noise, each sorted strongest-first.
 */
export function partitionBySignal(sources = []) {
  const signal = [], noise = [];
  for (const s of sources) (isNoiseSource(s) ? noise : signal).push(s);
  signal.sort(bySignalThenRecency);
  noise.sort(bySignalThenRecency);
  return { signal, noise };
}

/**
 * Comparator combining reading_value (primary) then significance (secondary) then date.
 * Used by dashboard sort where reading_value is the editorial ranking axis.
 */
export function makeRankedComparator() {
  return (a, b) => {
    const ra = READING_RANK[readingValueOf(a) ?? "background"] ?? 0;
    const rb = READING_RANK[readingValueOf(b) ?? "background"] ?? 0;
    if (rb !== ra) return rb - ra;
    const sa = significanceRank(a), sb = significanceRank(b);
    if (sb !== sa) return sb - sa;
    return String(b.date_published || "").localeCompare(String(a.date_published || ""));
  };
}
