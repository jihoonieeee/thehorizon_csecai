/**
 * Quote Location Verification — MECHANICAL ONLY
 *
 * Checks whether an extracted quote actually appears in the source text.
 * This is a MECHANICAL check — it answers "is the quote present?" not
 * "does the quote support the fact?" (that semantic judgment belongs to the LLM).
 *
 * ── DESIGN PRINCIPLE ──────────────────────────────────────────────────────────
 * This module was refactored to remove semantic entailment logic that used:
 *   - Key noun phrase overlap thresholds (0.6 / 0.3) to decide "supported/unsupported"
 *   - Absolute/hedged language regex to decide "overstated"
 *   - Token count ratios to decide "narrowed"
 *
 * These were semantic judgments masquerading as mechanical checks. Threshold-based
 * phrase overlap cannot reliably assess whether a fact is semantically supported by
 * a quote — that requires reading comprehension, which is an LLM task.
 *
 * The SEMANTIC fields (quote_support, support_level) are now produced by
 * judgeEvidenceItems.js (the LLM judgment call) as:
 *   triage_judgment.quote_support: "directly_supports" | "partially_supports" |
 *                                  "does_not_support" | "overstates_scope"
 *   triage_judgment.support_level: "direct_fact" | "reported_fact" | etc.
 *
 * This module now only answers: "Is this quote actually in the source text?"
 *
 * ── WHAT IS KEPT ─────────────────────────────────────────────────────────────
 *   quote_exists (bool) — is the quote locatable in the source text?
 *                         Determined by ≥75% token overlap between quote and source.
 *                         75% allows for minor LLM reformatting (quotes vs apostrophes,
 *                         whitespace normalization) without being fooled by unrelated text.
 *   quote_location       — "exact" | "approximate" | "not_found"
 *   overlap_pct          — raw token overlap for audit trail
 *
 * ── WHAT WAS REMOVED ─────────────────────────────────────────────────────────
 *   claim_preservation   — removed (was "preserved" | "narrowed" | "overstated" | "changed_meaning")
 *   quote_entailment     — removed (was "supported" | "partially_supported" | "unsupported")
 *   entailment_reason    — removed
 *
 * These fields are no longer set on items by this module. The evidenceTriage.js
 * now reads triage_judgment.quote_support instead of quote_verification.quote_entailment
 * for semantic gating decisions.
 */

// ── Token helpers ─────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","as","is","was","are","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","shall",
  "not","no","nor","so","yet","both","either","neither","whether","that","this",
  "these","those","it","its","he","she","they","we","you","i","me","him","her",
  "them","us","my","your","his","our","their","its","which","who","what","how",
  "when","where","why","all","any","each","every","few","more","most","other",
  "some","such","than","then","there","can","also","just","than","about","into",
]);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[''""]/g, "'")   // normalise quote chars
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function tokenOverlap(aTokens, bTokens) {
  if (aTokens.length === 0) return 0;
  const bSet = new Set(bTokens);
  const matched = aTokens.filter((t) => bSet.has(t)).length;
  return matched / aTokens.length;
}

// ── Mechanical quote location check ──────────────────────────────────────────

/**
 * Check whether a quote is locatable in the source text.
 * This is a MECHANICAL location check — not a semantic entailment check.
 *
 * Returns:
 *   quote_exists    — boolean: is the quote present (≥75% token overlap)?
 *   quote_location  — "exact" | "approximate" | "not_found"
 *   overlap_pct     — raw overlap percentage (for audit trail)
 *
 * Does NOT assess: whether the quote supports the fact, whether the fact
 * overstates the quote, or any other semantic property. Those judgments
 * belong to judgeEvidenceItems.js (the LLM).
 *
 * @param {string} quote       - The verbatim quote from extraction
 * @param {string} sourceText  - Full source text
 * @returns {{ quote_exists, quote_location, overlap_pct }}
 */
export function locateQuote(quote, sourceText) {
  if (!quote || quote.trim().length < 8) {
    return { quote_exists: false, quote_location: "not_found", overlap_pct: 0 };
  }
  if (!sourceText || sourceText.length < 10) {
    return { quote_exists: false, quote_location: "not_found", overlap_pct: 0 };
  }

  // Exact substring match (fastest path)
  const normQuote  = quote.toLowerCase().replace(/[''""]/g, "'").replace(/\s+/g, " ").trim();
  const normSource = sourceText.toLowerCase().replace(/[''""]/g, "'").replace(/\s+/g, " ");

  if (normSource.includes(normQuote)) {
    return { quote_exists: true, quote_location: "exact", overlap_pct: 100 };
  }

  // Approximate match: ≥75% token overlap (handles minor LLM formatting differences)
  const quoteTokens  = tokenize(quote);
  const sourceTokens = tokenize(sourceText);

  if (quoteTokens.length === 0) {
    return { quote_exists: false, quote_location: "not_found", overlap_pct: 0 };
  }

  const overlap = tokenOverlap(quoteTokens, sourceTokens);
  const pct = Math.round(overlap * 100);

  if (overlap >= 0.75) {
    return { quote_exists: true, quote_location: "approximate", overlap_pct: pct };
  }

  return { quote_exists: false, quote_location: "not_found", overlap_pct: pct };
}

/**
 * Apply mechanical quote location check to all extracted evidence items.
 *
 * Attaches quote_verification to each item:
 *   { quote_exists, quote_location, overlap_pct }
 *
 * NO semantic fields are set here. Do not gate admissibility on quote_entailment
 * here — that decision is made downstream using triage_judgment.quote_support.
 *
 * @param {object[]} items       - Evidence items with { fact, source_quote } fields
 * @param {string}   sourceText  - Full source text
 * @param {object}   [opts]      - Unused (kept for API compatibility)
 * @returns {Promise<object[]>}  Items with quote_verification attached
 */
export async function applyQuoteVerification(items, sourceText, opts = {}) {
  return items.map((item) => {
    const quote = item.source_quote || item.quote || "";
    const { quote_exists, quote_location, overlap_pct } = locateQuote(quote, sourceText);

    return {
      ...item,
      quote_verification: {
        quote_exists,
        quote_location,
        overlap_pct,
        // Semantic entailment fields are NOT set here.
        // They are set by judgeEvidenceItems.js as triage_judgment.quote_support.
        // Downstream code (evidenceTriage.js) reads triage_judgment.quote_support, not
        // quote_verification.quote_entailment, for semantic gating.
      },
    };
  });
}

// ── Legacy compatibility shim ─────────────────────────────────────────────────
// verifyQuoteEntailment was the original export. It is kept as a thin wrapper
// for any callers that haven't migrated yet, but it no longer does semantic
// entailment checking — it only returns the mechanical location result.

export async function verifyQuoteEntailment(fact, quote, sourceText, opts = {}) {
  const { quote_exists, quote_location, overlap_pct } = locateQuote(quote, sourceText);
  return {
    quote_exists,
    quote_location,
    overlap_pct,
    // Return minimal fields that old callers may check — but no semantic values
    quote_entailment:   quote_exists ? "supported" : "unsupported",
    claim_preservation: "preserved",
    entailment_reason:  `mechanical_location_only: ${quote_location} (${overlap_pct}%) — semantic judgment in triage_judgment.quote_support`,
  };
}
