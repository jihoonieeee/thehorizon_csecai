/**
 * Layer 5a.4 — Evidence Item Normalization
 *
 * Normalizes, validates, and cleans evidence_items_raw[] produced by Layer 5a.3.
 * Fully deterministic — no LLM calls.
 *
 * Input:  source with evidence_items_raw[] and extraction_profile
 * Output: source with evidence_items[] (normalized, filtered, capped)
 */

import {
  ALL_EVIDENCE_TYPES,
  EVIDENCE_TYPE_TO_CLASS,
  EVIDENCE_TYPE_TO_ABSTRACTION,
} from "./evidenceExtractionProfiles.js";
export { convertLegacyEvidenceCardToItems } from "./extractEvidenceItems.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALL_EVIDENCE_TYPES_SET = new Set(ALL_EVIDENCE_TYPES);

const VALID_BEST_USED_FOR = new Set([
  "case_study",
  "trend_support",
  "outlook_support",
  "recommendation_support",
  "chart_annotation",
]);

// Regex to extract numbers embedded in fact text
const NUMBER_PATTERN = /\b\d+(?:[.,]\d+)*\s*(?:%|percent|x|\$[\w.]+|[Mm]illion|[Bb]illion|[Kk])\b|\$[\d.,]+(?:[KMBkmb]?)\b|\b\d{1,3}(?:,\d{3})+\b/g;

// Generic opening phrases that indicate low-value items
const GENERIC_PREFIXES = [
  "ai is ",
  "the ai ",
  "ai systems may ",
  "it is possible ",
  "researchers have ",
  "this paper ",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isGenericFact(fact) {
  const lower = fact.toLowerCase().trimStart();
  return GENERIC_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// ── Atomicity check ───────────────────────────────────────────────────────────
// An atomic claim is one sentence, one assertion. Detect compound/summary facts.

function countSentences(text) {
  const m = (text || "").match(/[.!?](?:\s|$)/g);
  return m ? m.length : (text ? 1 : 0);
}

function isAtomicFact(fact) {
  // More than ~28 words → likely a summary, not an atomic claim.
  const words = fact.trim().split(/\s+/).length;
  if (words > 28) return false;
  // More than one sentence-ending punctuation (excluding a trailing one) → compound.
  if (countSentences(fact.replace(/[.!?]+\s*$/, "")) >= 1 && countSentences(fact) > 1) return false;
  // Multiple independent clauses joined by "and" → compound.
  const andClauses = (fact.match(/\b and \b/gi) || []).length;
  if (andClauses >= 2) return false;
  // Semicolon separating independent clauses → compound (e.g. "X happened; 87% of Y resulted").
  // Match: 3+ lowercase chars (end of first clause) followed by "; " and any non-space char.
  if (/[a-z]{3,}\s*;\s*\S/.test(fact)) return false;
  // Colon introducing a second independent clause (both sides verb-bearing) → compound.
  // Allow "CVE-2025-1234: buffer overflow in X" style labels (colon right after a name).
  const colonParts = fact.split(/\s*:\s*/);
  if (colonParts.length > 1) {
    const afterColon = colonParts.slice(1).join(": ").trim();
    const hasVerb = /\b(is|are|was|were|has|have|had|can|will|did|does|allows?|enables?|causes?|leaks?|exposes?|exploits?|bypasses?|injects?|executes?|deploys?)\b/i.test(afterColon);
    if (hasVerb && afterColon.split(/\s+/).length > 5) return false;
  }
  return true;
}

// ── Quote grounding verification ──────────────────────────────────────────────
// Verify that source_quote is actually traceable to the source text. LLMs may
// lightly reformat a quote, so we accept either an exact normalised substring
// match OR ≥75% content-word overlap (order-agnostic).

function normForMatch(s) {
  return (s || "").toLowerCase().replace(/[‘’“”]/g, "'").replace(/\s+/g, " ").trim();
}

function verifyQuoteGrounding(quote, sourceText) {
  const q = normForMatch(quote);
  const src = normForMatch(sourceText);
  if (!q || q.length < 8) return { verified: false, method: "empty" };
  if (!src) return { verified: false, method: "no_source" };

  // 1) Exact normalised substring
  if (src.includes(q)) return { verified: true, method: "exact" };

  // 2) Content-word overlap (words with length > 3, order-agnostic)
  const qWords = [...new Set(q.split(" ").filter((w) => w.length > 3))];
  if (qWords.length === 0) return { verified: false, method: "no_content_words" };
  const present = qWords.filter((w) => src.includes(w)).length;
  const ratio = present / qWords.length;
  if (ratio >= 0.75) return { verified: true, method: `overlap_${Math.round(ratio * 100)}` };

  return { verified: false, method: `overlap_${Math.round(ratio * 100)}` };
}

function extractNumbersFromText(fact) {
  const matches = fact.match(NUMBER_PATTERN);
  return matches ? [...new Set(matches)] : [];
}

function ensureEvidenceId(item, sourceId, index) {
  if (typeof item.evidence_id === "string" && item.evidence_id.length > 0) {
    return item.evidence_id;
  }
  return `ev_${sourceId}_${index + 1}`;
}

function attachSourceMetadata(item, source) {
  return {
    ...item,
    source_id:    item.source_id    || source.id    || "",
    source_type:  item.source_type  || source.source_type || "unknown",
    source_title: item.source_title || source.title  || "",
    publisher:    item.publisher    || source.publisher || "",
    url:          item.url          || source.url    || "",
    date:         item.date         || source.date_published || null,
  };
}

// ── Single item normalizer ────────────────────────────────────────────────────

function normalizeItem(rawItem, source, finalIndex) {
  if (typeof rawItem !== "object" || rawItem === null) return null;

  // Trim text fields
  const fact           = typeof rawItem.fact === "string"           ? rawItem.fact.trim().slice(0, 500) : "";
  const display_label  = typeof rawItem.display_label === "string"  ? rawItem.display_label.trim().slice(0, 100) : "";
  const supporting_text= typeof rawItem.supporting_text === "string"? rawItem.supporting_text.trim().slice(0, 300) : "";

  // Reject empty or too-short facts
  if (fact.length < 10) return null;

  // Reject generic facts
  if (isGenericFact(fact)) return null;

  // Validate evidence_type
  const evidence_type = rawItem.evidence_type;
  if (!ALL_EVIDENCE_TYPES_SET.has(evidence_type)) return null;

  // Validate best_used_for
  const ensureArray = (v) => Array.isArray(v) ? v : [];
  const best_used_for = ensureArray(rawItem.best_used_for)
    .filter((v) => VALID_BEST_USED_FOR.has(v));

  // Extract numbers from fact if numbers[] is empty
  let numbers = ensureArray(rawItem.numbers).filter((n) => typeof n === "string");
  if (numbers.length === 0) {
    numbers = extractNumbersFromText(fact);
  }

  // Verbatim grounding span — verify it traces to the source body.
  const source_quote = typeof rawItem.source_quote === "string"
    ? rawItem.source_quote.trim().slice(0, 300)
    : supporting_text;
  const sourceText = source.clean_text || source.full_text || "";
  const grounding  = verifyQuoteGrounding(source_quote, sourceText);

  // Atomicity flag (used by QA to downgrade compound/summary facts).
  const is_atomic = isAtomicFact(fact);

  // Normalize metric field
  const rawMetric = rawItem.metric;
  let metric = null;
  if (rawMetric && typeof rawMetric === "object" && rawMetric.value !== undefined) {
    metric = {
      name:    typeof rawMetric.name    === "string" ? rawMetric.name.trim().slice(0, 80)  : "",
      value:   rawMetric.value,
      unit:    typeof rawMetric.unit    === "string" ? rawMetric.unit.trim().slice(0, 30)  : "",
      context: typeof rawMetric.context === "string" ? rawMetric.context.trim().slice(0, 200) : "",
    };
  }

  // Normalize date fields
  const event_date = typeof rawItem.event_date === "string" ? rawItem.event_date
    : typeof rawItem.date === "string" ? rawItem.date : null;

  const rawDateRange = rawItem.date_range;
  const date_range = (rawDateRange && typeof rawDateRange === "object" &&
                      rawDateRange.start && rawDateRange.end)
    ? { start: rawDateRange.start, end: rawDateRange.end }
    : null;

  const sourceId = source.id || "";
  const item     = {
    evidence_id:         ensureEvidenceId(rawItem, sourceId, finalIndex),
    source_id:           rawItem.source_id    || sourceId,
    evidence_type,
    evidence_class:      EVIDENCE_TYPE_TO_CLASS[evidence_type]       || "technical",
    abstraction_level:   EVIDENCE_TYPE_TO_ABSTRACTION[evidence_type] || "derived_observation",
    fact,
    display_label:       display_label || fact.slice(0, 60),
    source_quote,
    supporting_text:     supporting_text || source_quote,
    type_justification:  typeof rawItem.type_justification === "string"
      ? rawItem.type_justification.trim().slice(0, 300) : "",
    quote_verified:      grounding.verified,
    quote_match:         grounding.method,
    is_atomic,
    entities:            ensureArray(rawItem.entities).filter((e) => typeof e === "string"),
    numbers,
    metric,
    event_date,
    date_range,
    category_hint:       typeof rawItem.category_hint === "string" ? rawItem.category_hint : (source.main_category || ""),
    source_type:         rawItem.source_type  || source.source_type || "unknown",
    source_title:        rawItem.source_title || source.title  || "",
    publisher:           rawItem.publisher    || source.publisher || "",
    url:                 rawItem.url          || source.url    || "",
    evidence_confidence: ["high","medium","low"].includes(rawItem.evidence_confidence)
      ? rawItem.evidence_confidence : "medium",
    best_used_for:       best_used_for.length > 0 ? best_used_for : ["trend_support"],
    extraction_method:   rawItem.extraction_method || "llm",
  };

  return attachSourceMetadata(item, source);
}

// ── Single source normalizer ──────────────────────────────────────────────────

/**
 * Normalize evidence_items_raw[] for a single source into evidence_items[].
 *
 * @param {object} source - Source with evidence_items_raw[] and extraction_profile.
 * @returns {object} source with evidence_items[] field added
 */
export function normalizeSourceEvidenceItems(source) {
  const rawItems  = Array.isArray(source.evidence_items_raw) ? source.evidence_items_raw : [];
  const profile   = source.extraction_profile || {};
  const evidenceUse = source.evidence_eligibility?.evidence_use;

  // Enforce profile's allowed_evidence_types
  const allowedTypes = Array.isArray(profile.allowed_evidence_types) && profile.allowed_evidence_types.length > 0
    ? new Set(profile.allowed_evidence_types)
    : ALL_EVIDENCE_TYPES_SET;

  // Normalize each item, filtering by allowed types
  let normalized = rawItems
    .map((raw, i) => normalizeItem(raw, source, i))
    .filter(Boolean)
    .filter((item) => allowedTypes.has(item.evidence_type));

  // Cap at 2 for context_only
  if (evidenceUse === "context_only") {
    normalized = normalized.slice(0, 2);
  } else {
    // Enforce extraction_profile max_items
    const maxItems = typeof profile.max_items === "number" ? profile.max_items : normalized.length;
    normalized = normalized.slice(0, maxItems);
  }

  // Re-assign stable evidence_ids based on final position
  const sourceId = source.id || "";
  normalized = normalized.map((item, i) => ({
    ...item,
    evidence_id: `ev_${sourceId}_${i + 1}`,
  }));

  return { ...source, evidence_items: normalized };
}

/**
 * Normalize evidence items for all sources.
 *
 * @param {object[]} sources
 * @returns {object[]} sources with evidence_items[] field added
 */
export function normalizeAllEvidenceItems(sources) {
  return sources.map(normalizeSourceEvidenceItems);
}
