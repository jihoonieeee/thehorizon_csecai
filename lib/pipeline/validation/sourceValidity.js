/**
 * Validation 3.1 — Source Validity
 *
 * Decides whether a source is usable at all.
 * Hard gates produce immediate rejection with no further processing needed.
 * Soft flags accumulate and inform the final gate (3.5) without blocking alone.
 *
 * Does NOT assess AI relevance, source type, or trust.
 */

import { isSafeUrl } from "./urlSafety.js";

// ── Deny lists ────────────────────────────────────────────────────────────────

const PUBLISHER_DENY_LIST = new Set([
  "feedburner",
  "dlvr.it",
  "paper.li",
  "scoop.it",
]);

const URL_DOMAIN_DENY_LIST = new Set([
  // Add domains that consistently produce noise
]);

function isDeniedPublisher(source) {
  const pub = (source.publisher || "").toLowerCase();
  for (const denied of PUBLISHER_DENY_LIST) {
    if (pub.includes(denied)) return `denied_publisher:${denied}`;
  }
  try {
    const host = new URL(source.url || "").hostname.toLowerCase();
    for (const denied of URL_DOMAIN_DENY_LIST) {
      if (host.includes(denied)) return `denied_domain:${denied}`;
    }
  } catch {
    // invalid URL — caught by URL hard gate separately
  }
  return null;
}

// ── Scoring helpers ───────────────────────────────────────────────────────────

function computeTextQualityScore(source) {
  const textLen = source.full_text?.length ?? 0;
  let score = 0;
  if (textLen >= 500)      score += 60;
  else if (textLen >= 100) score += 35;
  else if (textLen >= 50)  score += 15;
  else                     score += 3;

  if ((source.title?.length ?? 0) >= 20) score += 15;
  if ((source.summary?.length ?? 0) >= 50) score += 10;
  if (source.publisher && source.publisher !== "Unknown") score += 10;
  if (source.date_published) score += 5;

  return Math.min(100, score);
}

function assessPublishDateConfidence(source) {
  const explicit = source.date_confidence || source.collection_metadata?.date_confidence;
  if (explicit) return explicit;
  if (source.date_published) return "exact";
  return "none";
}

// Heuristic: flag text with >30% non-ASCII characters as likely non-English.
function detectLanguage(source) {
  const text = [source.title, source.summary, source.full_text?.slice(0, 500)]
    .filter(Boolean)
    .join(" ");
  if (!text) return "unknown";
  const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
  return nonAscii / text.length > 0.3 ? "non_english" : "en";
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Check whether a source is structurally usable.
 *
 * @param {object} source
 * @returns {{
 *   hard_fail: boolean,
 *   is_valid: boolean,
 *   validity_reason: string,
 *   filter_flags: string[],
 *   text_quality_score: number,
 *   publish_date_confidence: string,
 * }}
 */
export function checkSourceValidity(source) {
  const filter_flags = [];

  // ── Hard gate 1: missing title ────────────────────────────────────────────
  if (!source.title?.trim()) {
    return {
      hard_fail:              true,
      is_valid:               false,
      validity_reason:        "Missing title",
      filter_flags:           ["missing_title"],
      text_quality_score:     0,
      publish_date_confidence: "none",
    };
  }

  // ── Hard gate 2: missing or unsafe URL ───────────────────────────────────
  if (!source.url?.trim()) {
    filter_flags.push("missing_url");
  } else if (!isSafeUrl(source.url)) {
    filter_flags.push("unsafe_url");
  }

  if (filter_flags.includes("missing_url") || filter_flags.includes("unsafe_url")) {
    return {
      hard_fail:              true,
      is_valid:               false,
      validity_reason:        filter_flags[0] === "missing_url" ? "Missing URL" : `Unsafe URL: ${source.url}`,
      filter_flags,
      text_quality_score:     computeTextQualityScore(source),
      publish_date_confidence: assessPublishDateConfidence(source),
    };
  }

  // ── Hard gate 3: denied publisher ────────────────────────────────────────
  const denyReason = isDeniedPublisher(source);
  if (denyReason) {
    filter_flags.push(denyReason);
    return {
      hard_fail:              true,
      is_valid:               false,
      validity_reason:        `Excluded publisher: ${denyReason}`,
      filter_flags,
      text_quality_score:     computeTextQualityScore(source),
      publish_date_confidence: assessPublishDateConfidence(source),
    };
  }

  // ── Soft checks — accumulate flags ────────────────────────────────────────
  if (!source.publisher || source.publisher === "Unknown") {
    filter_flags.push("missing_publisher");
  }

  if (!source.date_published) {
    filter_flags.push("no_publish_date");
  } else {
    const d = new Date(source.date_published);
    if (Number.isNaN(d.getTime())) {
      filter_flags.push("invalid_date_format");
    } else if (d.getFullYear() < 2020) {
      filter_flags.push("date_before_2020");
    }
  }

  const textLen = source.full_text?.length ?? 0;
  if (textLen < 50)       filter_flags.push("short_text");
  else if (textLen < 200) filter_flags.push("minimal_text");

  const titleLower = source.title.toLowerCase();
  if (/^https?:\/\//.test(source.title)) filter_flags.push("title_is_url");
  if (titleLower === "untitled" || titleLower === "no title") filter_flags.push("generic_title");

  if (detectLanguage(source) === "non_english") filter_flags.push("possible_non_english");

  const is_valid = !filter_flags.includes("short_text") && !filter_flags.includes("title_is_url");

  return {
    hard_fail:              false,
    is_valid,
    validity_reason:        filter_flags.length === 0 ? "ok" : filter_flags.join("; "),
    filter_flags,
    text_quality_score:     computeTextQualityScore(source),
    publish_date_confidence: assessPublishDateConfidence(source),
  };
}
