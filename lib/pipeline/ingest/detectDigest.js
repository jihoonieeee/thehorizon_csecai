/**
 * detectDigest — cheap heuristic to decide whether a source is a multi-topic
 * digest/report before spending an LLM call on it.
 *
 * Extracted from digestFanout.js so it can be imported by understandSource.js
 * without creating a circular dependency (digestFanout imports normalise from
 * understandSource; understandSource imports detectDigest from here).
 */

const DIGEST_TITLE_RE = new RegExp([
  "threat intelligence report",
  "weekly (?:threat|security|intelligence|cyber)",
  "threatsday",
  "\\bbulletin\\b",
  "round[- ]?up",
  "\\bdigest\\b",
  "newsletter",
  "this week in",
  "week in review",
  "in review",
  "\\b\\d+\\s+(?:\\w+\\s+){0,3}(?:incidents|attacks|threats|stories|breaches|cves)\\b",
  "biggest (?:attacks|threats|breaches)",
  "threat landscape",
  "landscape report",
  "\\btracker\\b",
  "(?:annual|quarterly|monthly)\\b",
  "\\bQ[1-4]\\b\\s*20\\d\\d|20\\d\\d\\s*\\bQ[1-4]\\b",
  "incident response report",
  "global threat report",
  "digital defen[cs]e report",
  "\\bforecast\\b",
  "year in review",
  "state of (?:ai |llm |agentic )?(?:security|threats?|malware|ransomware|phishing|cyber(?:security)?)",
  "\\bDBIR\\b",
  "m-trends",
  "exploit round-?up",
  "system card",
  "safety report",
  "responsible scaling",
  "frontier (?:safety|model|risk)",
  "preparedness framework",
  "threat assessment",
  "annual (?:cyber|threat)",
].join("|"), "i");

const REPORT_URL_RE = /\/(?:threat-landscape|global-threat-report|incident-response-report|annual-report|digital-defense|threat-tracker|exploit-round-?up)\b/i;

// Single-article URL patterns that structuralReportSignal false-positives on.
// A long detailed press release or blog post is NOT a multi-topic digest.
const NOT_DIGEST_URL_RE = /\/(?:press-release|press|newsroom|blog|news|article)\/[^/]+\/?$/i;

function structuralReportSignal(source = {}) {
  const text = String(source.full_text || source.clean_text || "");
  if (text.length < 6000) return false;
  const headings = (text.match(/\n#{1,3}\s|\n[A-Z][^\n]{6,60}\n(?:[-=]{3,}|\s*\n)/g) || []).length;
  const cves     = new Set(text.match(/CVE-\d{4}-\d{3,}/gi) || []).size;
  const sections = (text.match(/\b(?:section|part|chapter|finding|incident|campaign)\s+\d+/gi) || []).length;
  return headings >= 5 || cves >= 3 || sections >= 3;
}

/**
 * Decide whether a source is a multi-topic report/digest worth fanning out.
 * @param {object} source
 * @returns {{ is_digest: boolean, reason: string|null }}
 */
export function detectDigest(source = {}) {
  if (source?.intelligence?.is_digest === true || source?.is_digest === true) {
    return { is_digest: true, reason: "explicit_flag" };
  }
  if (DIGEST_TITLE_RE.test(String(source.title || ""))) {
    return { is_digest: true, reason: "title_pattern" };
  }
  if (REPORT_URL_RE.test(String(source.url || ""))) {
    return { is_digest: true, reason: "url_pattern" };
  }
  // Structural signal fires on any long document with headings/CVEs — guard against
  // false-positives on detailed single-article press releases and blog posts.
  if (structuralReportSignal(source) && !NOT_DIGEST_URL_RE.test(String(source.url || ""))) {
    return { is_digest: true, reason: "structural_signal" };
  }
  return { is_digest: false, reason: null };
}
