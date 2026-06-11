/**
 * Agent answer-grounding + overclaim guard (pipeline-logic audit P0-1).
 *
 * Two jobs:
 *  1. Label every chatbot answer with `answer_grounding` so a consumer can tell a
 *     validated claim-chain answer from a raw-corpus or web-search one.
 *  2. Give the raw-corpus routes (general / timeline / attack_vector) the same
 *     observed-use / trend discipline the deck path enforces: if the QUERY asks
 *     for operational/adoption/trend/prevalence claims and the CORPUS lacks the
 *     evidence to support them, inject a refusal directive into the prompt, cap
 *     confidence, and attach a mandatory caveat — instead of letting the model
 *     synthesise an operational claim out of research summaries.
 *
 * Pure functions, no I/O.
 */

// What the user is asking the answer to assert.
const ADOPTION_QUERY   = /\b(in the wild|real[- ]world|operational(?:ly)?|adopt(?:ed|ing|ion)?|deployed by|used by (?:attackers|adversaries|threat actors)|actively exploit)/i;
const TREND_QUERY      = /\b(trend|increasing|growing|rising|surge|surging|on the rise|more common|accelerat|prolifer)/i;
const PREVALENCE_QUERY = /\b(how common|how prevalent|prevalence|how widespread|how often)\b/i;

// Source types whose claims can support real-world (operational) assertions.
const OPERATIONAL_SOURCE_TYPES = new Set([
  "incident", "incident_report", "threat_intelligence", "adversary_adoption_signal",
]);

// Context claims carry `source_type` + `publisher` (see buildContextPack).
function corpusHasOperational(ctx) {
  return (ctx?.claims || []).some((c) => OPERATIONAL_SOURCE_TYPES.has(c.source_type));
}
function corpusIndependentOrigins(ctx) {
  return new Set((ctx?.claims || []).map((c) => c.publisher).filter((p) => p && p !== "unknown")).size;
}

// Stable mapping from a resolved route to its grounding provenance label.
export const GROUNDING_BY_ROUTE = {
  analytical:      "claim_chain",
  evidence_lookup: "evidence_packet",
  distribution:    "deterministic",
  raw_sources:     "raw_corpus",
  timeline:        "raw_corpus",
  attack_vector:   "raw_corpus",
  general:         "raw_corpus",
  web_search:      "web_search",
};

/**
 * Assess whether the query asks for a claim the corpus cannot support.
 *
 * @param {string} query
 * @param {object} ctx     - buildContextPack() output (has claims[] with source_type/publisher)
 * @returns {{ must_guard: boolean, directive: string|null, caveat: string|null, confidence_cap: "low"|"moderate"|null }}
 */
export function assessOverclaim(query, ctx) {
  const q = query || "";
  const wantsAdoption = ADOPTION_QUERY.test(q);
  const wantsTrend    = TREND_QUERY.test(q) || PREVALENCE_QUERY.test(q);
  const hasOperational = corpusHasOperational(ctx);
  const origins        = corpusIndependentOrigins(ctx);

  const directives = [];
  const caveats    = [];
  let confidenceCap = null;

  if (wantsAdoption && !hasOperational) {
    directives.push(
      "The corpus contains NO operational sources (no incident / threat-intelligence / adversary-adoption evidence). " +
      "Do NOT state that adversaries are using, adopting, or operationally deploying any technique. You may only describe " +
      "what research/analysis sources DEMONSTRATE as a capability, and you must label it as research, not real-world use."
    );
    caveats.push("No operational evidence in the corpus — adoption/in-the-wild use is unconfirmed; this reflects research/analysis only.");
    confidenceCap = "low";
  }

  if (wantsTrend && origins < 2) {
    directives.push(
      "The corpus does not contain ≥2 independent sources across time for this query. Do NOT assert a trend, increase, " +
      "growth, or prevalence. Describe only what is present in the corpus, explicitly corpus-scoped."
    );
    caveats.push("Insufficient independent, time-distributed sources to support a trend or prevalence claim.");
    confidenceCap = confidenceCap || "low";
  }

  // Corpus-composition guard: even when the QUERY uses no adoption/trend keywords, a
  // research-only corpus (zero operational sources) must not be narrated as real-world
  // activity. This catches the "more papers ⇒ it's happening" leak that keyword guards
  // miss. Softer than the explicit-adoption guard: caps to moderate, not low.
  const hasAnyClaims = (ctx?.claims || []).length > 0;
  if (!wantsAdoption && hasAnyClaims && !hasOperational) {
    directives.push(
      "The corpus for this query contains NO operational sources (only research/analysis/governance). " +
      "Describe findings as demonstrated CAPABILITY or research signal — not as confirmed real-world incidents or adversary use."
    );
    caveats.push("Corpus is research/analysis-only for this query — findings are capability/ research signals, not confirmed real-world activity.");
    confidenceCap = confidenceCap || "moderate";
  }

  return {
    must_guard:     directives.length > 0,
    directive:      directives.length ? `## GROUNDING CONSTRAINT (non-negotiable)\n${directives.join("\n")}` : null,
    caveat:         caveats.length ? caveats.join(" ") : null,
    confidence_cap: confidenceCap,
  };
}

const CONF_RANK = { low: 0, moderate: 1, high: 2 };

/** Lower `confidence` to `cap` if it currently exceeds it. */
export function applyConfidenceCap(confidence, cap) {
  if (!cap) return confidence;
  return (CONF_RANK[confidence] ?? 2) > (CONF_RANK[cap] ?? 0) ? cap : confidence;
}

/** Merge a guard caveat into an existing caveat (dedupe-safe). */
export function mergeCaveat(existing, added) {
  if (!added) return existing || null;
  if (!existing) return added;
  if (existing.includes(added)) return existing;
  return `${existing} ${added}`;
}
