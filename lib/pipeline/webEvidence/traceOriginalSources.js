/**
 * Layer 5C.5 — Original-source tracing (depth-capped).
 *
 * If a candidate page links to an original report/paper/advisory/dataset/repo/PDF,
 * prefer extracting from the ORIGINAL. The derivative is kept only if it adds
 * unique value (clearer walkthrough, unique visual, extra timeline, corroboration,
 * impact context). Tracing depth is capped by WEB_EVIDENCE_MAX_TRACE_DEPTH.
 *
 * Deterministic link selection; opening reuses openAndCacheWebSource.
 */

import { openAndCacheWebSource } from "./openAndCacheWebSources.js";
import { canonicalUrlKey } from "./webEvidenceSchemas.js";

// Anchor text / URL signals that a link points to an original source.
const ORIGINAL_URL_PATTERNS = [
  /arxiv\.org\/(abs|pdf)\//i, /doi\.org\//i, /\.pdf($|\?)/i,
  /github\.com\//i, /nvd\.nist\.gov\/vuln\//i,
  /(cisa|ncsc|nist|enisa|csa)\.gov/i, /\/(report|whitepaper|advisory|research|paper)s?\//i,
];
const ORIGINAL_ANCHOR_TEXT = /\b(original (report|paper|research)|full report|read the (paper|report)|technical report|whitepaper|advisory|preprint|published (paper|research)|PDF|dataset|proof[- ]of[- ]concept|repository)\b/i;

function isLikelyOriginal(link) {
  return ORIGINAL_URL_PATTERNS.some((p) => p.test(link.href)) || ORIGINAL_ANCHOR_TEXT.test(link.text || "");
}

// Does the derivative add unique value vs the original?
function derivativeAddsValue(derivative, original) {
  const dText = `${derivative.text || ""}`;
  const hasWalkthrough = /step 1|attack chain|walkthrough|exploit chain/i.test(dText);
  const hasNumbers = /\b\d+(?:\.\d+)?%/.test(dText);
  const longer = (dText.length || 0) > (original.text?.length || 0) * 1.2;
  return hasWalkthrough || hasNumbers || longer;
}

/**
 * @param {object} opened  result of openAndCacheWebSource for the candidate
 * @param {object} [opts]  { fetchImpl, config, depth }
 * @returns {Promise<object>} {
 *   primary_opened, original_source_url, original_source_opened,
 *   derivative_source_url, derivative_adds_unique_value, source_lineage }
 */
export async function traceOriginalSource(opened, opts = {}) {
  const maxDepth = opts.config?.max_trace_depth ?? 2;
  const depth = opts.depth ?? 0;

  const result = {
    primary_opened: opened,
    original_source_url: null,
    original_source_opened: false,
    derivative_source_url: null,
    derivative_adds_unique_value: false,
    source_lineage: "original",   // default: this IS the original
  };

  if (depth >= maxDepth || !opened?.links?.length) return result;

  // Find the best original-source link that is not the page itself.
  const selfKey = canonicalUrlKey(opened.canonical_url || opened.source_url);
  const candidate = opened.links.find((l) => isLikelyOriginal(l) && canonicalUrlKey(l.href) !== selfKey);
  if (!candidate) return result;

  let original;
  try {
    original = await openAndCacheWebSource(candidate.href, { ...opts, depth: depth + 1 });
  } catch {
    return result;
  }

  if (!original?.opened_url_confirmed) return result;

  result.original_source_url = original.source_url;
  result.original_source_opened = true;
  result.derivative_source_url = opened.source_url;
  result.derivative_adds_unique_value = derivativeAddsValue(opened, original);
  result.source_lineage = result.derivative_adds_unique_value ? "derivative_with_value" : "derivative_archive_only";
  // Prefer extracting from the original going forward.
  result.primary_opened = original;
  result.original_opened = original;
  return result;
}
