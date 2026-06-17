/**
 * Methodological Quality Assessment
 *
 * Deterministic checks on evidence items that carry quantitative claims.
 * No LLM calls.
 *
 * method_quality values:
 *   clear_method    — study population, dataset, evaluation methodology are stated
 *   partial_method  — some methodology context, but incomplete
 *   unclear_method  — claim stated but no methodology visible
 *   anecdotal       — single data point, no dataset/sample context
 *   not_applicable  — evidence type doesn't carry quantitative method requirements
 *
 * statistical_use values:
 *   chart_allowed          — number can appear in a chart or slide callout
 *   text_only_with_caveat  — can be mentioned in text but not visualized
 *   context_only           — background context only, do not present as fact
 *   not_allowed            — do not use this statistic
 */

// Evidence types that require methodology assessment before charting
const METHOD_REQUIRED_TYPES = new Set([
  "benchmark_result",
  "research_result",
  "capability_delta",
  "benchmark_evaluation",  // from rawfact taxonomy
]);

// Methodology presence signals in text
const METHODOLOGY_SIGNALS = [
  /\bn\s*=\s*\d+/i,                          // "n=100", "n = 50"
  /sample\s+size\s+of\s+\d+/i,               // "sample size of 500"
  /dataset\s+of\s+\d+/i,                     // "dataset of 10,000"
  /across\s+\d+/i,                           // "across 50 models"
  /study\s+of\s+\d+/i,                       // "study of 200 samples"
  /evaluated\s+on\s+\d+/i,                   // "evaluated on 5 benchmarks"
  /tested\s+against\s+\d+/i,                 // "tested against 100 prompts"
  /\d+\s+participants/i,                     // "500 participants"
  /\d+\s+(?:samples|examples|instances|cases)/i, // "1000 samples"
  /benchmark(?:ed|ing)?\s+on/i,              // "benchmarked on..."
  /evaluation\s+(?:set|dataset|corpus)/i,    // "evaluation dataset"
  /\d+\s+hour[s]?\s+of/i,                   // "200 hours of audio"
  /measured\s+across/i,                      // "measured across..."
  /(?:train|test(?:ing)?)\s+set\s+of\s+\d+/i, // "test set of 1000"
];

// Signals indicating methodology is absent despite a claim
const UNCLEAR_SIGNALS = [
  /\bwe\s+found\b/i,           // "We found X%"
  /\bour\s+(?:analysis|research|study|data)\s+(?:shows|found|reveals|indicates)\b/i,
  /\baccording\s+to\s+our\b/i,  // "according to our data"
  /\binternal\s+(?:data|analysis|research)\b/i,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasMethodologySignal(sourceText) {
  return METHODOLOGY_SIGNALS.some((pattern) => pattern.test(sourceText));
}

function hasUnclearSignal(sourceText) {
  return UNCLEAR_SIGNALS.some((pattern) => pattern.test(sourceText));
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Assess the methodological quality of an evidence item.
 *
 * @param {object} evidenceItem   - The extracted evidence item (may have metric, evidence_type fields)
 * @param {string} sourceText     - The full source text for methodology signal detection
 * @param {object} [opts]
 * @param {string} [opts.independence_level]  - From originTracking: "vendor_interested" etc.
 * @returns {{
 *   method_quality: "clear_method"|"partial_method"|"unclear_method"|"anecdotal"|"not_applicable",
 *   statistical_use: "chart_allowed"|"text_only_with_caveat"|"context_only"|"not_allowed",
 *   method_reason: string,
 * }}
 */
export function assessMethodQuality(evidenceItem, sourceText, opts = {}) {
  const { independence_level } = opts;

  const evidenceType = evidenceItem.evidence_type ||
    evidenceItem.rawfact_type || evidenceItem.source_type || "";

  const hasMetricValue = !!(
    evidenceItem.metric?.value !== undefined ||
    evidenceItem.numbers_statistics?.length > 0 ||
    evidenceItem.number_value !== undefined ||
    /\d+(?:\.\d+)?%/.test(evidenceItem.key_fact || evidenceItem.fact || "")
  );

  const isVendorInterested = independence_level === "vendor_interested" ||
    evidenceItem.independence_level === "vendor_interested";

  // ── Not applicable: non-quantitative evidence types ───────────────────────
  if (!METHOD_REQUIRED_TYPES.has(evidenceType) || !hasMetricValue) {
    return {
      method_quality: "not_applicable",
      statistical_use: isVendorInterested ? "text_only_with_caveat" : "chart_allowed",
      method_reason: "Evidence type does not require methodology assessment",
    };
  }

  // ── Methodology detection ─────────────────────────────────────────────────
  const text = sourceText || "";

  const hasMethodology    = hasMethodologySignal(text);
  const hasUnclearContext = hasUnclearSignal(text);

  let method_quality;
  let method_reason;

  if (hasMethodology && !hasUnclearContext) {
    method_quality = "clear_method";
    method_reason  = "Source contains methodology context (sample size, dataset, evaluation parameters)";
  } else if (hasMethodology && hasUnclearContext) {
    method_quality = "partial_method";
    method_reason  = "Some methodology context present but clarity is limited";
  } else if (hasUnclearContext) {
    method_quality = "unclear_method";
    method_reason  = "Claim stated (\"we found\", \"our analysis\") without sample or dataset context";
  } else if (isVendorInterested) {
    // Single data point from vendor source with no broader context
    method_quality = "anecdotal";
    method_reason  = "Single data point from vendor source; no external dataset or comparison context";
  } else {
    method_quality = "unclear_method";
    method_reason  = "No methodology context detected for quantitative claim";
  }

  // ── Derive statistical_use ────────────────────────────────────────────────
  let statistical_use;

  switch (method_quality) {
    case "clear_method":
      statistical_use = isVendorInterested ? "text_only_with_caveat" : "chart_allowed";
      break;
    case "partial_method":
      statistical_use = "text_only_with_caveat";
      break;
    case "anecdotal":
    case "unclear_method":
      statistical_use = "context_only";
      break;
    default:
      statistical_use = "context_only";
  }

  // Vendor-interested is always at least text_only_with_caveat
  if (isVendorInterested && statistical_use === "chart_allowed") {
    statistical_use = "text_only_with_caveat";
  }

  return { method_quality, statistical_use, method_reason };
}
