/**
 * Run-level Corpus Representativeness Audit (pipeline-logic audit P0-2).
 *
 * `corpusAudit.js` audits ONE category. This audits the WHOLE run: is the corpus
 * a defensible sample to brief an analyst/executive from, or is it so skewed
 * (keyword-shaped, feed-dominated, research-heavy, single-publisher, English-only)
 * that confident analysis over it would mislead?
 *
 * Output drives two things:
 *   1. `corpus_confidence ∈ {sufficient, limited, insufficient}` — caps the
 *      cross-category / executive confidence (a synthesis cannot be more certain
 *      than its sample warrants).
 *   2. `limitations[]` + `scope_note` — rendered on the deck's scope/methodology
 *      slide so the bias is stated, not hidden.
 *
 * Deterministic. No LLM. No arbitrary numeric weights — boolean flags + counts.
 */

const OPERATIONAL_TYPES = new Set([
  "incident", "threat_intelligence", "adversary_adoption_signal", "exploit_disclosure", "vulnerability",
]);
const RESEARCH_TYPES = new Set([
  "research_finding", "benchmark_evaluation", "capability_demonstration",
]);
const CLASSIFIABLE = new Set([
  "traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats",
]);

function isAuthoritative(s) {
  return s.trust_tier === "primary" ||
    s.origin_role === "primary_origin" ||
    s.publisher_class === "primary_authority" ||
    s.publisher_class === "academic";
}
function isVendorInterested(s) {
  return s.independence_level === "vendor_interested" || s.publisher_class === "security_firm";
}
function isNonEnglish(s) {
  return (s.filter_flags || []).includes("possible_non_english") ||
    (s.detected_language && s.detected_language !== "en" && s.detected_language !== "unknown");
}
function monthOf(d) {
  const m = String(d || "").match(/(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

const CAP_BY_CONFIDENCE = { insufficient: "low", limited: "medium", sufficient: null };

/**
 * @param {object[]} sources  - all classified sources entering synthesis
 * @returns {{
 *   corpus_confidence: "sufficient"|"limited"|"insufficient",
 *   confidence_cap: "low"|"medium"|null,
 *   flags: string[],
 *   limitations: string[],
 *   scope_note: string,
 *   counts: object,
 * }}
 */
export function buildRunCorpusAudit(sources = []) {
  const total = sources.length;

  const counts = {
    total,
    authoritative: sources.filter(isAuthoritative).length,
    operational:   sources.filter((s) => OPERATIONAL_TYPES.has(s.source_type)).length,
    research:      sources.filter((s) => RESEARCH_TYPES.has(s.source_type)).length,
    vendor:        sources.filter(isVendorInterested).length,
    non_english:   sources.filter(isNonEnglish).length,
  };

  // Publisher concentration.
  const pubCounts = {};
  for (const s of sources) {
    const p = (s.publisher || "unknown").toLowerCase();
    pubCounts[p] = (pubCounts[p] || 0) + 1;
  }
  const maxPub = total ? Math.max(0, ...Object.values(pubCounts)) : 0;
  const [dominantPub] = total ? (Object.entries(pubCounts).find(([, v]) => v === maxPub) || ["unknown"]) : ["unknown"];

  // Category coverage.
  const catCounts = {};
  for (const s of sources) {
    if (CLASSIFIABLE.has(s.main_category)) catCounts[s.main_category] = (catCounts[s.main_category] || 0) + 1;
  }
  const classifiedTotal = Object.values(catCounts).reduce((a, b) => a + b, 0);
  const maxCat = classifiedTotal ? Math.max(0, ...Object.values(catCounts)) : 0;
  const categoriesCovered = Object.keys(catCounts).length;

  // Time coverage.
  const months = new Set(sources.map((s) => monthOf(s.date_published)).filter(Boolean));

  // ── Flags ──────────────────────────────────────────────────────────────────
  const flags = [];
  const limitations = [];
  const flag = (id, msg) => { flags.push(id); limitations.push(msg); };

  if (total > 0 && counts.authoritative / total < 0.2) {
    flag("low_authoritative_share", `Only ${counts.authoritative}/${total} sources are primary/authoritative — most findings rest on secondary or research reporting.`);
  }
  if (counts.operational === 0 && total > 0) {
    flag("operational_evidence_absent", "No operational sources (incident / threat-intelligence / adversary-adoption) — real-world adoption cannot be asserted at the corpus level.");
  }
  if (total > 0 && counts.vendor / total > 0.4) {
    flag("vendor_dominant", `Vendor-interested sources are ${Math.round(counts.vendor / total * 100)}% of the corpus — commercial framing may skew the picture.`);
  }
  if (total > 0 && counts.research / total > 0.7 && counts.operational === 0) {
    flag("research_dominant", "Corpus is >70% research with no operational corroboration — capability is demonstrated, real-world use is not.");
  }
  if (total >= 4 && maxPub > total * 0.5) {
    flag("single_publisher_dominance", `One publisher (${dominantPub}) accounts for >50% of the corpus — perspective diversity is limited.`);
  }
  if (classifiedTotal > 0 && (maxCat > classifiedTotal * 0.6 || categoriesCovered < 3)) {
    flag("category_coverage_imbalanced", `Category coverage is uneven (${categoriesCovered}/4 categories; largest is ${Math.round(maxCat / classifiedTotal * 100)}% of classified sources) — cross-category magnitude comparisons reflect collection, not threat balance.`);
  }
  if (months.size < 2) {
    flag("time_window_sparse", `Sources span ${months.size} distinct month(s) — trends over time cannot be established.`);
  }
  if (total > 0 && counts.non_english / total > 0.1) {
    flag("non_english_unhandled", `${Math.round(counts.non_english / total * 100)}% of sources are possibly non-English — summaries of those may be lower fidelity.`);
  }
  if (total < 10) {
    flag("small_corpus", `Small corpus (${total} sources) — distributions and trends may not be representative.`);
  }

  // ── Confidence decision ────────────────────────────────────────────────────
  let corpus_confidence;
  if (total < 5 || (flags.includes("operational_evidence_absent") && flags.includes("low_authoritative_share"))) {
    corpus_confidence = "insufficient";
  } else if (flags.length >= 2) {
    corpus_confidence = "limited";
  } else {
    corpus_confidence = "sufficient";
  }

  const scope_note = corpus_confidence === "sufficient"
    ? "Corpus is a reasonable sample for the reporting period; standard caveats apply."
    : `This analysis is drawn from a ${corpus_confidence} corpus. ${limitations.slice(0, 3).join(" ")} ` +
      'All corpus-level statements (prevalence, trends, "biggest story") should be read as scoped to the collected sources, not the real-world landscape.';

  return {
    corpus_confidence,
    confidence_cap: CAP_BY_CONFIDENCE[corpus_confidence],
    flags,
    limitations,
    scope_note,
    counts: { ...counts, distinct_months: months.size, categories_covered: categoriesCovered, dominant_publisher: dominantPub },
  };
}

const CONF_RANK = { low: 0, medium: 1, moderate: 1, high: 2 };

/**
 * Cap a confidence string at the corpus confidence ceiling.
 */
export function capConfidenceByCorpus(confidence, runCorpusAudit) {
  const cap = runCorpusAudit?.confidence_cap;
  if (!cap) return confidence || "low";
  const c = confidence || "low";
  return (CONF_RANK[c] ?? 2) > (CONF_RANK[cap] ?? 0) ? cap : c;
}

/**
 * Apply the corpus-confidence ceiling to a cross-category synthesis result in
 * place of trusting the LLM's self-assessed confidence. Caps every confidence
 * field and prepends a scope caveat to the strategic outlook.
 */
export function applyCorpusCapToCrossCategory(result, runCorpusAudit) {
  if (!result || !runCorpusAudit?.confidence_cap) return result;
  const cap = (c) => capConfidenceByCorpus(c, runCorpusAudit);

  const out = { ...result };
  if (out.executive_summary?.key_judgments) {
    out.executive_summary = {
      ...out.executive_summary,
      key_judgments: out.executive_summary.key_judgments.map((j) => ({ ...j, confidence: cap(j.confidence) })),
    };
  }
  for (const key of ["cross_category_patterns", "overall_biggest_happenings", "overall_early_signals"]) {
    if (Array.isArray(out[key])) out[key] = out[key].map((i) => ({ ...i, confidence: cap(i.confidence) }));
  }
  if (out.strategic_outlook) {
    out.strategic_outlook = {
      ...out.strategic_outlook,
      confidence: cap(out.strategic_outlook.confidence),
      caveat_if_any: [runCorpusAudit.scope_note, out.strategic_outlook.caveat_if_any].filter(Boolean).join(" "),
    };
  }
  out.corpus_confidence = runCorpusAudit.corpus_confidence;
  return out;
}
