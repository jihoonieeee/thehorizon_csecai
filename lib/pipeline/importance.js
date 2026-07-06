/**
 * lib/pipeline/importance.js — deterministic source-importance tiering.
 *
 * SINGLE SOURCE OF TRUTH for the importance facets + rules. Imported by BOTH:
 *   - the Layer-4 write-back in understandSource.js (per new source, at ingest), and
 *   - scripts/scoreImportance.js (batch report + full-corpus recompute).
 *
 * DESIGN (see scripts/scoreImportance.js header for the full rationale):
 *   - No numeric scores. No weights. No summation. No magic thresholds.
 *   - Importance is a TIER from an ordered DECISION LIST (first match wins). Every
 *     rule is a plain boolean over categorical facets — read it, know why it fired.
 *   - Rank by SUBSTANCE (what the source witnessed), not by who published it.
 *     Provenance is a CONFIDENCE annotation, never the tier driver.
 *   - Pure function of already-stored classification fields → no LLM, no cost, so it
 *     runs inline on every source. Change the rules → bump RULES_VERSION → re-run the
 *     script; the whole corpus re-tiers. A tier is a recomputable VIEW, never baked in.
 *
 * computeImportance() tolerates BOTH shapes it will be called with:
 *   - a normalise() output object (ingest):  { category, source_type, trust_tier, is_defensive, ... }
 *   - a raw DB row (script):                 { main_category, source_type, trust_tier, tags, intelligence:{...} }
 */

export const RULES_VERSION = "importance-v1-2026-07-05";

// ─── FACET 1: REALITY — what stage of the threat lifecycle did this source witness?
//   realized = adversaries DID this in the real world (incidents / tracked adversary use)
//   proven   = a working exploit/capability was DEMONSTRATED (researcher / vendor PoC)
//   research = a technique was STUDIED in a paper / benchmark
// (De-conflates "attackers did it" from "researchers showed it" — the key audit finding.)
export const REALITY_BY_TYPE = {
  incident:                  "realized",
  threat_intelligence:       "realized",   // vendor documents adversary USE in operations
  adversary_adoption_signal: "realized",
  attack_surface_signal:     "realized",
  societal_harm_signal:      "realized",
  exploit_disclosure:        "proven",     // a PoC / demonstrated exploit
  capability_demonstration:  "proven",     // a demonstrated offensive capability
  research_finding:          "research",
  benchmark_evaluation:      "research",
  governance_signal:         "advisory",
  defensive_capability:      "defense",
  vulnerability:             "disclosure", // a CVE — potential, not yet realized
};
// Closed, standard in-the-wild vocabulary (CISA-KEV semantics). A demonstrated exploit
// or CVE the text says is ACTIVELY EXPLOITED is upgraded to realized. Only phrasings
// that unambiguously assert REAL exploitation are included — hypotheticals ("could be
// exploited", "can be exploited for RCE") are deliberately excluded to avoid inflating
// a disclosure into a realized incident.
const IN_WILD_PHRASE = /\b(exploited in the wild|in-the-wild exploitation|actively exploited|known exploited|under active exploitation|observed exploitation|being exploited|exploited within \d+|exploited by (?:attackers|threat actors|adversaries|apt|hackers)|mass[- ]exploit(?:ed|ation)?|weaponized in attacks|used in (?:active )?attacks)\b/i;

// ── Field readers — tolerant of both the normalise() output and a raw DB row ──
const typeOf  = (s) => s.source_type;
const trustOf = (s) => s.trust_tier;
const catOf   = (s) => s.main_category ?? s.category;
// Precedence, not OR: prefer the most-recent authoritative defensive judgment.
//   1. mechanism_classification.is_defensive — the resort / current classifier's call
//   2. top-level is_defensive               — a fresh normalise() output (ingest path)
//   3. intelligence.is_defensive            — older pipeline row (legacy fallback only)
const isDefensiveOf = (s) => {
  const mc = s.intelligence?.mechanism_classification?.is_defensive;
  if (typeof mc === "boolean") return mc;
  if (typeof s.is_defensive === "boolean") return s.is_defensive;
  return s.intelligence?.is_defensive === true;
};
const textOf = (s) => `${s.title || ""} ${s.short_summary || s.summary || ""}`;

export function realityOf(s) {
  const base = REALITY_BY_TYPE[typeOf(s)] || "other";
  if (IN_WILD_PHRASE.test(textOf(s)) && (base === "proven" || base === "disclosure" || base === "other")) return "realized";
  return base;
}

// ─── FACET 2: POSTURE — offensive threat, defense, or out-of-scope ───
export function postureOf(s) {
  if (catOf(s) === "unclear_or_adjacent") return "adjacent";
  if (isDefensiveOf(s)) return "defensive";
  return "offensive";
}

// ─── FACET 3: PROVENANCE — confidence in the source (annotation, NOT a ranking axis) ───
const PROVENANCE = { primary: "authoritative", high: "established", curated: "established", medium: "general", low: "weak", unknown: "weak" };
export function provenanceOf(s) { return PROVENANCE[trustOf(s)] || "weak"; }

// ─── THE DECISION LIST — substance first; provenance never gates the tier ───
export function tierFromFacets(f) {
  if (f.posture === "offensive" && f.reality === "realized") return "realized"; // adversaries did it
  if (f.posture === "offensive" && f.reality === "proven")   return "proven";   // demonstrated feasible
  if (f.posture === "offensive" && f.reality === "research")  return "research"; // studied in a paper
  if (f.reality === "advisory" && f.provenance === "authoritative") return "reference"; // durable framework
  return "noise";                                                                // defenses / CVEs / adjacent
}

/**
 * Compute the importance record for a source. Pure and deterministic.
 * @returns {{tier,reality,posture,provenance,rules_version}}
 */
export function computeImportance(s) {
  const reality = realityOf(s), posture = postureOf(s), provenance = provenanceOf(s);
  return { tier: tierFromFacets({ reality, posture, provenance }), reality, posture, provenance, rules_version: RULES_VERSION };
}

// ── Evidence-strength ordering, for downstream consumers (claim QA, dashboard) ──
// How "real" a piece of evidence is, from strongest to weakest. Anything that isn't
// a realized/proven/research offensive reality carries no substantive strength (0).
export const REALITY_RANK = { realized: 3, proven: 2, research: 1 };

/**
 * The strongest reality among a set of evidence items (each an object with a
 * source_type, e.g. from extractEvidence). Returns null if none carry strength.
 */
export function strongestReality(evidenceItems = []) {
  let best = null, bestRank = 0;
  for (const ev of evidenceItems) {
    const r = realityOf(ev);
    const rank = REALITY_RANK[r] || 0;
    if (rank > bestRank) { best = r; bestRank = rank; }
  }
  return best;
}

/**
 * The maximum claim CONFIDENCE that a body of evidence can support, by its strongest
 * reality. The epistemic rule made deterministic: only real-world (realized) evidence
 * earns "high"; a demonstrated PoC (proven) earns at most "medium"; lab research or
 * weaker earns at most "low". Mirrors the intent of the Pass-2 LLM rule
 * ("'actively exploited' requires incident/threat-intel, not just research papers")
 * but for free, in a deterministic gate.
 *   realized → "high" · proven → "medium" · research/none → "low"
 */
export function confidenceCeilingForEvidence(evidenceItems = []) {
  switch (strongestReality(evidenceItems)) {
    case "realized": return "high";
    case "proven":   return "medium";
    default:         return "low";
  }
}
