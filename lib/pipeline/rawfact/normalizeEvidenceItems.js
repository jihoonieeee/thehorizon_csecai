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

// buildClaimPermissions is applied by the triage step (after fact_qa is attached),
// so we just import it here for use in the final pass.
// (We do NOT call it in normalizeItem — that runs before fact_qa exists.)

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

// ── Concreteness anchors ──────────────────────────────────────────────────────
// Concreteness anchors — named entities, dates, methods, metrics, reproducible references.
// These are the signals that make a claim verifiable and trustworthy.
// Dramatic language (unprecedented, explosive, critical) is explicitly ignored here.

const ANCHOR_PATTERNS = {
  cve_reference:        /CVE-\d{4}-\d{4,7}/i,
  named_ai_model:       /\b(GPT-4|GPT-3\.5|GPT-?4o|Claude[\s-]?\d?|Llama[\s-]?\d|Gemini[\s-]?\d?|Mistral|DeepSeek|PaLM|Bard|Copilot|LLaMA|Falcon|Vicuna|Alpaca|ChatGPT)\b/i,
  named_authority:      /\b(Anthropic|OpenAI|Google|Microsoft|Meta AI|DeepMind|CISA|NIST|FBI|DHS|NCSC|NSA|Europol|ENISA|MITRE|NVD|arXiv)\b/,
  specific_named_actor: /\b(APT\d+|Lazarus\s+Group|Sandworm|Fancy\s+Bear|Cozy\s+Bear|Salt\s+Typhoon|Volt\s+Typhoon|FIN\d+|UNC\d+)\b/i,
  measured_metric:      /\b\d+(?:\.\d+)?%|\b\d[\d,]*\s*(?:samples?|cases?|attacks?|victims?|organizations?|incidents?|CVEs?|vulnerabilities?)\b/i,
  specific_date:        /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}\b|\bQ[1-4]\s+20\d{2}\b|\b20\d{2}-\d{2}-\d{2}\b/i,
  named_technique:      /\b(prompt injection|jailbreak|PAIR|GCG|AutoDAN|RAG poison(?:ing)?|model extract(?:ion)?|data poison(?:ing)?|backdoor attack|evasion attack|adversarial example|MCP(?:\s+attack)?|tool(?:-call)? hijack(?:ing)?|indirect injection|multi-?hop)\b/i,
  reproducible_ref:     /\b(?:arXiv|doi\.org|CVE-|CWE-|NVD|GHSA|Table \d|Figure \d|Algorithm \d|Appendix [A-Z]|Listing \d|PoC|proof.of.concept|source code|github\.com\/[a-z0-9_-]+\/[a-z0-9_-]+)\b/i,
  attack_success_rate:  /\b(?:ASR|attack success rate|success rate|bypass rate|pass rate|failure rate)\b.*\d+(?:\.\d+)?%|\d+(?:\.\d+)?%.*\b(?:ASR|attack success|bypass)\b/i,
};

const HYPE_PATTERN = /\b(unprecedented|explosive(?:ly)?|skyrocket(?:ing|ed)?|critical risk|game.?changer|revolutionary|game.?changing|surge[sd]?|surging|massive spike|alarming(?:ly)?|at an all.?time high|exponential(?:ly)?|accelerating rapidly|dominating)\b/i;

/**
 * Deterministically score evidence concreteness from fact text and source quote.
 * No LLM — pure regex on named anchor types.
 *
 * @param {string} fact
 * @param {string} sourceQuote
 * @param {string[]} entities
 * @param {string[]} numbers
 * @returns {{ anchors: string[], concreteness_level: "high"|"moderate"|"low", hype_flag: boolean }}
 */
export function computeConcretenessAnchors(fact = "", sourceQuote = "", entities = [], numbers = []) {
  const text = `${fact} ${sourceQuote}`;
  const anchors = [];

  for (const [key, pattern] of Object.entries(ANCHOR_PATTERNS)) {
    if (pattern.test(text)) anchors.push(key);
  }

  // Also count if entities array has specific named entities
  if ((entities || []).some((e) => /CVE-|GPT-|Claude|Llama|CISA|NIST/i.test(e))) {
    if (!anchors.includes("named_ai_model") && !anchors.includes("named_authority") && !anchors.includes("cve_reference")) {
      anchors.push("named_entity_in_entities_array");
    }
  }

  const hype_flag = HYPE_PATTERN.test(text) && anchors.length < 2;

  const concreteness_level =
    anchors.length >= 3 ? "high" :
    anchors.length >= 1 ? "moderate" :
    "low";

  return { anchors, concreteness_level, hype_flag };
}

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

// ── Number grounding ──────────────────────────────────────────────────────────
// When a fact contains specific numbers AND a source_quote is available, check
// that each number appears in the source text. Flags items where numbers in the
// extracted fact cannot be traced back to the source — a strong signal of LLM
// number fabrication or hallucinated precision.

function checkNumberGrounding(fact, sourceQuote, sourceText) {
  const numbers = extractNumbersFromText(fact);
  if (numbers.length === 0) return { grounded: true, ungrounded: [] };

  const haystack = normForMatch((sourceQuote || "") + " " + (sourceText || "").slice(0, 2000));
  const ungrounded = [];

  for (const num of numbers) {
    // Normalise the number for comparison (remove commas, lowercase units)
    const n = num.toLowerCase().replace(/,/g, "");
    // Year-like numbers (4 digits starting 19xx/20xx) are not statistics
    if (/^(19|20)\d{2}$/.test(n)) continue;
    // Single-digit counts (1–9) are not meaningful statistics
    if (/^[1-9]$/.test(n)) continue;

    // Accept only verbatim match (after normalisation).
    // ±5% tolerance was REMOVED (2026-06-17): it masked hallucination. A claimed
    // "57%" when the source says "55%" is a discrepancy, not rounding. The LLM
    // that extracted the fact should have written the exact figure from the source.
    // Tolerance hides this kind of drift and creates false grounding confidence.
    const nNorm = n.replace(/[+%$]/g, "").replace(/[kmb]$/i, "");
    if (haystack.includes(n) || (nNorm.length > 1 && haystack.includes(nNorm))) continue;

    ungrounded.push(num);
  }

  return { grounded: ungrounded.length === 0, ungrounded };
}

function ensureEvidenceId(item, sourceId, index) {
  if (typeof item.evidence_id === "string" && item.evidence_id.length > 0) {
    return item.evidence_id;
  }
  return `ev_${sourceId}_${index + 1}`;
}

function computeProvenanceStatus(item, source) {
  const url   = item.url || source.url || "";
  const pub   = item.publisher || source.publisher || "";
  const evId  = item.evidence_id || "";
  const quote = item.source_quote || item.supporting_text || "";

  if (!url || !pub || !evId || !quote || quote.length < 10) {
    return "incomplete";
  }

  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    return "incomplete";
  }

  // Basic fabricated URL check
  const FABRICATED_DOMAINS = /^(example\.com|source\.org|report\.com|study\.net|security-research\.com|ai-threats\.org)$/i;
  try {
    const domain = new URL(url).hostname.replace(/^www\./, "");
    if (FABRICATED_DOMAINS.test(domain)) return "unverifiable";
  } catch {
    return "incomplete";
  }

  return "complete";
}

function attachSourceMetadata(item, source) {
  const provenanceStatus = computeProvenanceStatus(item, source);
  const url              = item.url || source.url || "";
  const pub              = item.publisher || source.publisher || "";

  return {
    ...item,
    source_id:    item.source_id    || source.id    || "",
    source_type:  item.source_type  || source.source_type || "unknown",
    source_title: item.source_title || source.title  || "",
    publisher:    pub,
    url,
    date:         item.date         || source.date_published || null,
    // Independence/provenance (from L3 originTracking) — carried so corroboration
    // counting can group by the ORIGINATING report and exclude circular reporting,
    // rather than naively counting distinct re-publishers as independent sources.
    origin_role:        item.origin_role        || source.origin_role        || null,
    independence_level: item.independence_level || source.independence_level || null,
    primary_origin_url: item.primary_origin_url || source.primary_origin_url || null,
    // Phase 3B: structured provenance block
    provenance: {
      evidence_id:        item.evidence_id || "",
      source_id:          item.source_id || source.id || "",
      source_branch:      item.source_branch || "L5A",
      source_type:        item.source_type || source.source_type || "unknown",
      publisher:          pub,
      source_title:       item.source_title || source.title || "",
      source_url:         url,
      publication_date:   item.date || source.date_published || null,
      extracted_quote:    item.source_quote || item.supporting_text || "",
      retrieval_timestamp: source.retrieved_at || source.ingested_at || null,
      provenance_status:  provenanceStatus,
    },
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

  // Number grounding — verify that numbers in the fact text appear in the source.
  // Only run when we have a non-trivial source text to check against.
  const numGrounding = sourceText.length > 50
    ? checkNumberGrounding(fact, source_quote, sourceText)
    : { grounded: true, ungrounded: [] };

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
  // Concreteness anchors — deterministic, no LLM.
  const entityArr = ensureArray(rawItem.entities).filter((e) => typeof e === "string");
  const concretenessResult = computeConcretenessAnchors(fact, source_quote, entityArr, numbers);

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
    number_grounding_pass: numGrounding.grounded,
    ungrounded_numbers:  numGrounding.ungrounded.length > 0 ? numGrounding.ungrounded : undefined,
    qa_issues:           numGrounding.ungrounded.length > 0
      ? [`number_not_in_source: ${numGrounding.ungrounded.join(", ")}`]
      : [],
    // Preserve the L5A quote-entailment / claim-preservation verdict (set by
    // applyQuoteVerification in extractEvidenceItems). normalizeItem rebuilds the
    // item field-by-field, so this MUST be copied forward explicitly or the
    // entailment gate is silently lost before triage (see evidenceTriage floor).
    quote_verification:  (rawItem.quote_verification && typeof rawItem.quote_verification === "object")
                           ? rawItem.quote_verification : null,
    // Methodological-quality verdict (set by assessMethodQuality in extraction).
    // Carried forward so the statistics/chart gates can honour it — without this
    // copy, an anecdotal/unmethodical number would chart as fact.
    method_quality:      typeof rawItem.method_quality === "string" ? rawItem.method_quality : null,
    statistical_use:     typeof rawItem.statistical_use === "string" ? rawItem.statistical_use : null,
    method_reason:       typeof rawItem.method_reason === "string" ? rawItem.method_reason : "",
    is_atomic,
    entities:            entityArr,
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
    // Concreteness: deterministic anchor classification
    concreteness_anchors: concretenessResult.anchors,
    concreteness_level:   concretenessResult.concreteness_level,
    hype_flag:            concretenessResult.hype_flag,

    // ── Analytical hooks (from LLM extraction, added in extractEvidenceItems.js) ──
    // Preserved as-is: these are raw reasoning material for L6 — not claims.
    analytical_hook:       typeof rawItem.analytical_hook === "string"
      ? rawItem.analytical_hook.trim().slice(0, 200) : null,
    novelty_signal:        typeof rawItem.novelty_signal === "string"
      ? rawItem.novelty_signal.trim().slice(0, 200) : null,
    why_this_may_matter:   typeof rawItem.why_this_may_matter === "string"
      ? rawItem.why_this_may_matter.trim().slice(0, 200) : null,
    what_changed:          typeof rawItem.what_changed === "string"
      ? rawItem.what_changed.trim().slice(0, 200) : null,
    assumption_challenged: typeof rawItem.assumption_challenged === "string"
      ? rawItem.assumption_challenged.trim().slice(0, 200) : null,

    // Structured analytical_hooks object (for EvidencePacket schema compliance)
    analytical_hooks: {
      why_this_may_matter:      typeof rawItem.why_this_may_matter === "string" ? rawItem.why_this_may_matter.trim().slice(0, 200) : null,
      what_changed:             typeof rawItem.what_changed === "string" ? rawItem.what_changed.trim().slice(0, 200) : null,
      novelty_signal:           typeof rawItem.novelty_signal === "string" ? rawItem.novelty_signal.trim().slice(0, 200) : null,
      capability_delta:         null,  // set by judgeEvidenceItems if detected
      assumption_challenged:    typeof rawItem.assumption_challenged === "string" ? rawItem.assumption_challenged.trim().slice(0, 200) : null,
      implication_candidates:   [],
      contradiction_candidates: [],
      uncertainty_notes:        [],
      affected_entities:        Array.isArray(rawItem.entities) ? rawItem.entities.slice(0, 6) : [],
      dependency_or_attack_surface: null,
    },

    // claim_permissions: populated by applyFactQaAndClaimPermissions (runs after triage)
    claim_permissions: null,
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

/**
 * Apply claim_permissions to evidence items after fact QA has run.
 *
 * Call this after applyEvidenceFactQa() — claim_permissions depend on fact_qa
 * results (blocked_uses[], support_level, quote_entailment, required_caveats[]).
 *
 * @param {object[]} sources - Sources with evidence_items[] that have fact_qa attached
 * @returns {object[]} Sources with claim_permissions attached to each evidence item
 */
export async function applyClaimPermissionsToItems(sources) {
  // Lazy import to avoid circular dependency at module load time
  const { buildClaimPermissions } = await import("./buildClaimPermissions.js");
  const { classifySourceIntent }  = await import("./sourceIntent.js");

  return sources.map((source) => {
    const sourceIntent  = classifySourceIntent(source);
    const sourceType    = source.source_type || "unknown";
    const items = (source.evidence_items || []).map((item) => {
      const factQa    = item.fact_qa || null;
      const claimPerm = buildClaimPermissions(item, sourceType, factQa, sourceIntent);
      return { ...item, claim_permissions: claimPerm };
    });
    return { ...source, source_intent: sourceIntent, evidence_items: items };
  });
}
