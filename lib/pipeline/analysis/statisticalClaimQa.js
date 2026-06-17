/**
 * Statistical Claim QA
 *
 * Checks whether explicit numbers and implied quantitative language in claims
 * are grounded in the supporting evidence. Fully deterministic — no LLM.
 *
 * Two checks:
 *   1. number_not_in_evidence  — explicit numbers/percentages in the claim text
 *      that do not appear in any supporting evidence item's fact or source_quote
 *   2. implied_quantitative_not_supported — implied quantitative language
 *      (surging, widespread, majority, etc.) without a supporting number in evidence
 */

// ── Implied quantitative patterns ─────────────────────────────────────────────

export const IMPLIED_QUANTITATIVE_PATTERNS = [
  /\bsurging?\b/gi,
  /\bspiki?(?:ng|es?)?\b/gi,
  /\brapidly (?:growing|increasing|expanding|accelerating)\b/gi,
  /\b(?:most|majority|many|significant|substantial|large)\s+(?:of|number|portion|share)\b/gi,
  /\b(?:widespread|ubiquitous|pervasive|dominant|leading)\b/gi,
  /\b(?:doubled|tripled|quadrupled)\b/gi,
  /\b(?:highest|lowest|most common|most frequent|fastest)\b/gi,
  /\b(?:increased?|decreased?|grown?)\s+significantly\b/gi,
];

// Neutral replacements for implied quantitative terms
const NEUTRAL_REPLACEMENTS = new Map([
  ["surge",       "increase"],
  ["surges",      "increases"],
  ["surging",     "increasing"],
  ["spiking",     "increasing"],
  ["spike",       "increase"],
  ["spikes",      "increases"],
  ["rapidly",     "notably"],
  ["widespread",  "observed across sources"],
  ["ubiquitous",  "frequently observed"],
  ["pervasive",   "observed across sources"],
  ["dominant",    "frequently seen"],
  ["leading",     "prominent"],
  ["majority",    "several"],
  ["most",        "many"],
  ["doubled",     "increased"],
  ["tripled",     "increased significantly"],
  ["quadrupled",  "increased substantially"],
  ["highest",     "frequently observed"],
  ["lowest",      "infrequently observed"],
  ["most common", "frequently observed"],
  ["most frequent","frequently observed"],
  ["fastest",     "among the faster"],
  ["increased significantly", "increased"],
  ["decreased significantly", "decreased"],
  ["grown significantly",     "grown"],
]);

// ── Number extraction ─────────────────────────────────────────────────────────

const STAT_PATTERN = /(\$[\d,]+(?:\.\d+)?[MBk]?(?:\s*(?:million|billion))?|\d[\d,]*(?:\.\d+)?%|\d[\d,]*(?:\+|×|x)\s*(?:times?|fold)|\b\d{1,3}(?:,\d{3})+\b|\b\d{2,}(?:\.\d+)?(?:\s+(?:vulnerabilities?|incidents?|cases?|attacks?|organizations?|victims?|reports?|breaches?|days?|months?)))/gi;

// Numbers that are not meaningful statistics (years, single digits)
function isNonStatistic(numStr) {
  const clean = numStr.replace(/[,$%\s]/g, "");
  if (/^(19|20)\d{2}$/.test(clean)) return true; // year
  if (/^[1-9]$/.test(clean)) return true;          // single digit
  return false;
}

function extractNumbers(text) {
  const matches = text.match(STAT_PATTERN) || [];
  return matches.filter((m) => !isNonStatistic(m));
}

// ── Evidence text collector ───────────────────────────────────────────────────

function collectEvidenceText(evidencePackets) {
  const parts = [];
  for (const ep of (evidencePackets || [])) {
    if (ep.fact)         parts.push(ep.fact);
    if (ep.source_quote) parts.push(ep.source_quote);
    if (ep.supporting_text) parts.push(ep.supporting_text);
    if (Array.isArray(ep.numbers)) parts.push(ep.numbers.join(" "));
    if (ep.metric?.value != null) parts.push(String(ep.metric.value));
    // 5B analytics evidence
    if (ep.finding)      parts.push(String(ep.finding));
    if (ep.value_summary)parts.push(String(ep.value_summary));
    // 5C external evidence
    if (ep.claim)        parts.push(ep.claim);
    if (ep.metric_value != null) parts.push(String(ep.metric_value));
  }
  return parts.join(" ").toLowerCase();
}

function numberAppearsInEvidence(numStr, evidenceText) {
  const norm = numStr.toLowerCase().replace(/[$,]/g, "").trim();
  if (evidenceText.includes(norm)) return true;

  // Tolerance: ±5% rounding for percentages and plain numbers
  const raw = parseFloat(norm.replace(/[^0-9.]/g, ""));
  if (!isNaN(raw) && raw < 10000) {
    const tol = Math.ceil(raw * 0.05) + 1;
    for (let d = -tol; d <= tol; d++) {
      if (evidenceText.includes(String(Math.round(raw + d)))) return true;
    }
  }
  return false;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Check statistical claims in an array of claim texts against supporting evidence.
 *
 * @param {object[]} claims         - Claim objects (must have claim_text or text field)
 * @param {object[]} evidencePackets - All evidence packets for this category
 * @returns {{ flagged: object[], clean: object[] }}
 */
export function checkStatisticalClaims(claims, evidencePackets) {
  const evidenceText = collectEvidenceText(evidencePackets);
  const flagged = [];
  const clean = [];

  for (const claim of (claims || [])) {
    const text = claim.claim_text || claim.text || claim.insight || "";
    const flags = [];

    // Check 1: explicit numbers
    const numbers = extractNumbers(text);
    for (const num of numbers) {
      if (!numberAppearsInEvidence(num, evidenceText)) {
        flags.push({
          stat_flag: "number_not_in_evidence",
          flagged_value: num,
          note: `"${num}" not found in supporting evidence`,
        });
      }
    }

    // Check 2: implied quantitative language
    for (const pattern of IMPLIED_QUANTITATIVE_PATTERNS) {
      const matches = text.match(pattern);
      if (!matches) continue;
      // Check if evidence contains any supporting number or explicit quantity
      const hasNumber = numbers.some((n) => numberAppearsInEvidence(n, evidenceText));
      const hasTimeComparison = /\b(?:year[- ]over[- ]year|month[- ]over[- ]month|compared to|relative to|vs\.?|increased from|grew from)\b/i.test(evidenceText);
      const hasExplicitQuote = /[""]/.test(evidenceText) && matches.some((m) => evidenceText.includes(m.toLowerCase()));

      if (!hasNumber && !hasTimeComparison && !hasExplicitQuote) {
        for (const match of matches) {
          flags.push({
            stat_flag: "implied_quantitative_not_supported",
            flagged_value: match,
            note: `Implied quantitative term "${match}" not backed by numeric evidence`,
          });
        }
      }
    }

    if (flags.length > 0) {
      flagged.push({ ...claim, stat_qa_flags: flags });
    } else {
      clean.push(claim);
    }
  }

  return { flagged, clean };
}

/**
 * Scrub implied quantitative language from a text string.
 * Returns the scrubbed text and a list of replacements made.
 *
 * @param {string}   text
 * @param {string}   evidenceText - evidence to check against
 * @returns {{ text: string, replacements: Array<{original, replacement}> }}
 */
export function scrubImpliedQuantitatives(text, evidenceText) {
  if (!text || typeof text !== "string") return { text, replacements: [] };

  const replacements = [];
  let result = text;

  for (const pattern of IMPLIED_QUANTITATIVE_PATTERNS) {
    const resetPattern = new RegExp(pattern.source, pattern.flags);
    result = result.replace(resetPattern, (match) => {
      // If evidence text contains a relevant number, leave it alone
      const hasNumber = (result.match(STAT_PATTERN) || []).some(
        (n) => !isNonStatistic(n) && numberAppearsInEvidence(n, evidenceText)
      );
      if (hasNumber) return match;

      // Find neutral replacement
      const lower = match.toLowerCase();
      for (const [term, replacement] of NEUTRAL_REPLACEMENTS.entries()) {
        if (lower === term || lower.startsWith(term)) {
          replacements.push({ original: match, replacement });
          return replacement;
        }
      }
      return match; // no replacement found
    });
  }

  return { text: result, replacements };
}
