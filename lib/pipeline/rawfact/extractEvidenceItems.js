/**
 * L5A-rawfacts — Evidence Item Extraction
 *
 * LLM-based extraction of discrete evidence items from eligible sources.
 * Replaces the old evidence_card model with a fine-grained evidence_items array.
 *
 * Input:  sources with evidence_eligibility and extraction_profile fields
 * Output: sources with evidence_items_raw[] field
 *
 * LLM is only triggered for sources whose evidence_use is "primary_evidence" or
 * "supporting_evidence". "context_only" sources use the deterministic fallback
 * (max 2 items). "do_not_extract" and "analytics_only" sources are skipped.
 */

import { callLLM } from "../../llm/callLLM.js";
import { UNIVERSAL_EXTRACTION_RULES } from "./evidenceExtractionProfiles.js";
import { applyQuoteVerification }      from "./quoteVerification.js";
import { assessMethodQuality }         from "./methodQuality.js";

// ── Evidence item schema for structured output ────────────────────────────────
//
// v2.0: Evidence items are now RICH EXCERPTS, not atomic 25-word facts.
// Each item captures everything analytically relevant from the source:
//   - the central claim with full context
//   - all verbatim numbers/metrics (copied exactly from source)
//   - caveats, scope conditions, and limitations the source itself states
//   - what this evidence can and cannot establish
//
// This change was made because the atomic-fact approach:
//   1. Stripped context that the analysis LLM needs to judge quality
//   2. Broke causal chains across multiple items, hiding the argument structure
//   3. Dropped author-stated caveats (scope: lab-only, limited sample size)
//   4. Made the analysis layer synthesize from decontextualized fragments

const EVIDENCE_ITEMS_SCHEMA = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: [
          "evidence_type", "fact", "source_quote",
          "entities", "category_hint", "evidence_confidence",
          "best_used_for",
        ],
        properties: {
          evidence_type:      { type: "string" },
          // fact: the central finding — full context allowed, ≤400 chars.
          // Include the WHAT, any named entities, and any key metric.
          // Do NOT strip context to hit a word limit.
          fact:               { type: "string" },
          display_label:      { type: "string" },
          // source_quote: verbatim span(s) from the source that ground the fact.
          // For rich items this may be 1–3 sentences. Copy EXACTLY. ≤500 chars.
          source_quote:       { type: "string" },
          // caveats: scope limitations, confidence qualifiers, or author-stated
          // restrictions in the source itself (e.g. "lab setting only",
          // "n=12 samples", "not observed in production"). Null if none stated.
          caveats:            { type: ["string", "null"] },
          // what_this_establishes: one sentence on what this evidence proves.
          //   e.g. "Demonstrates capability exists under controlled conditions"
          //   e.g. "Confirms real adversary use in production (observed incident)"
          what_this_establishes: { type: ["string", "null"] },
          // what_this_does_not_establish: one sentence on what it cannot prove.
          //   e.g. "Cannot confirm adversary adoption or production use"
          //   e.g. "Does not show scale or frequency of exploitation"
          what_this_cannot_establish: { type: ["string", "null"] },
          entities:           { type: "array", items: { type: "string" } },
          event_date:         { type: ["string", "null"] },
          date_range: {
            type: ["object", "null"],
            properties: { start: { type: "string" }, end: { type: "string" } },
          },
          metric: {
            type: ["object", "null"],
            properties: {
              name:    { type: "string" },
              value:   { type: ["string", "number"] },
              unit:    { type: "string" },
              context: { type: "string" },
            },
          },
          category_hint:       { type: "string" },
          evidence_confidence: { type: "string", enum: ["high", "medium", "low"] },
          best_used_for: {
            type: "array",
            items: {
              type: "string",
              enum: ["case_study", "trend_support", "outlook_support",
                     "recommendation_support", "chart_annotation"],
            },
          },
          // Analytical hooks — optional reasoning material for L6 synthesis
          analytical_hook:       { type: ["string", "null"] },
          novelty_signal:        { type: ["string", "null"] },
          why_this_may_matter:   { type: ["string", "null"] },
          what_changed:          { type: ["string", "null"] },
          assumption_challenged: { type: ["string", "null"] },
        },
      },
    },
  },
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an intelligence analyst extracting evidence from a cybersecurity source for an AI threat intelligence briefing.

Your job is to produce RICH, CONTEXTUAL evidence items — not minimal atomic fragments. The analysis layer that reads your output needs full context to form strategic judgments. Stripping context to produce shorter items makes the analysis worse.

## WHAT A RICH EVIDENCE ITEM IS

A rich evidence item captures ONE major finding from the source with:
- The full claim including all named entities, metrics, and qualifications
- A verbatim source_quote that grounds it (can be 1–3 sentences)
- The caveats and scope conditions the SOURCE ITSELF states (lab-only, n=12, limited to a single vendor, etc.)
- What this evidence can establish vs. what it cannot

GOOD — rich, contextual, complete:
  fact: "PAIR algorithm achieves 88% attack success rate against GPT-4 in black-box mode with fewer than 20 queries, evaluated across 10 harmful behavior categories."
  source_quote: "PAIR achieves an attack success rate of 88% on GPT-4 using only black-box access, requiring fewer than 20 queries per attack."
  caveats: "Controlled lab evaluation only; not observed in adversarial use in production."
  what_this_establishes: "Demonstrates jailbreak capability exists at high efficiency without model access."
  what_this_cannot_establish: "Cannot confirm adversary adoption or real-world deployment."

BAD — stripped of context:
  fact: "PAIR achieves 88% ASR."  (too short — missing what PAIR is, against what, under what conditions)

BAD — generic, ungrounded:
  fact: "AI is changing the threat landscape."  (no specific anchor — do not extract)

## HOW MANY ITEMS TO EXTRACT

Extract the KEY FINDINGS of the source — not every sentence, not the minimum possible.
- A 1-page advisory: 1–2 items (the core finding and any key IOCs or mitigations)
- A 10-page research paper: 3–5 items (main result + key experimental conditions + limitations)
- A threat intelligence report: 4–6 items (actor profile, campaign details, IOCs, TTPs, impact)
- A CVE advisory: 1–2 items (the vulnerability + exploitation status)
Never exceed max_items.

## GROUNDING — NON-NEGOTIABLE
source_quote MUST be copied VERBATIM from the source text. Do NOT paraphrase.
- If a metric appears in the source, copy it exactly ("88%", not "~90%")
- source_quote may be 1–3 sentences — use as much as needed to ground the fact
- If you cannot find a verbatim span that supports the claim, DO NOT extract that item

## NUMBER ACCURACY
Any number in "fact" MUST appear verbatim in "source_quote".
- If the source says "thousands", write "thousands" — never convert to a specific count.
- If the source says "multiple organizations", write that — do not substitute a count.
- WRONG: fact contains "5,000 repositories" when source says "thousands of repositories"

## CAVEATS AND SCOPE (fill these — they are critical for analysis quality)
caveats: What scope conditions or confidence qualifiers does the SOURCE ITSELF state?
  - "n=12 samples in controlled conditions"
  - "lab evaluation; not observed in adversarial use"
  - "affects only models without RLHF alignment"
  - "campaign attributed to APT29 with medium confidence"
  Leave null ONLY if the source states no qualifications.

what_this_establishes: One sentence — what does this evidence actually prove?
  "Demonstrates capability is technically feasible in controlled conditions."
  "Confirms real-world adversary deployment by a named actor."

what_this_cannot_establish: One sentence — what does this evidence NOT prove?
  "Cannot confirm production adversary use."
  "Does not generalize to models beyond GPT-4 tested."

${UNIVERSAL_EXTRACTION_RULES}

## FIELD LENGTHS
fact:         up to 400 chars — include full context; do not truncate to hit a word limit
source_quote: up to 500 chars — verbatim; can be 1–3 sentences
caveats:      up to 200 chars — author-stated scope/confidence qualifiers
display_label: ≤10 words, display-only, never used as evidence

## FIELDS
evidence_type       One value from allowed_evidence_types in the extraction profile.
fact                The main finding with full context. Named entities, metric verbatim, scope.
display_label       Slide label only, ≤10 words.
source_quote        VERBATIM span(s) from SOURCE TEXT. Up to 500 chars. Copy exactly.
caveats             Author-stated scope conditions or confidence qualifiers. null if none.
what_this_establishes  What this evidence proves. One sentence.
what_this_cannot_establish  What this evidence does NOT prove. One sentence.
entities            Named orgs, CVEs, threat actors, AI models, products.
event_date          YYYY-MM-DD if dated event, else null.
date_range          { start, end } if covers a period, else null.
metric              { name, value, unit, context } if specific quantitative measurement, else null.
category_hint       The main_category this evidence belongs to.
evidence_confidence
  high   — verbatim quote directly and explicitly establishes the fact
  medium — fact is a close reading of the quote; one reasonable inference from it
  low    — fact is inferred; or only a summary was available; or quote is indirect
best_used_for       1–3 of: case_study, trend_support, outlook_support, recommendation_support, chart_annotation
analytical_hook     One sentence: what makes this analytically interesting or unusual? null if not clear.
novelty_signal      What is NEW vs baseline? Specific change if visible. null if not applicable.
why_this_may_matter One hedged sentence on strategic significance. null if not clear.
what_changed        The specific delta — capability, scale, actor, technique. null if not applicable.
assumption_challenged Which prior assumption does this challenge or confirm? null if not applicable.

## RULES
- Return strict JSON only — no markdown, no preamble.
- NEVER invent facts, numbers, or quotes.
- If nothing qualifies, return { "items": [] }.
- Respect max_items — do not exceed it.`;

// ── Chunking for long sources ─────────────────────────────────────────────────
//
// Long sources (>8 000 chars) are split into overlapping chunks before extraction.
// This prevents the LLM from silently missing evidence buried in the middle of a
// long document and avoids asking for "all evidence from this 15k char source"
// in one broad pass — a violation of the one-task-per-call principle.
//
// Each extracted item carries chunk_id + chunk_byte_offset for:
//   - Cross-chunk deduplication (same fact extracted from overlapping region)
//   - Quote offset verification (quote location in source text)
//   - Traceability in the evidence registry
//
// Chunking strategy:
//   CHUNK_SIZE      = 5 000 chars per chunk (≈1 250 tokens; well within Haiku context)
//   CHUNK_OVERLAP   = 1 000 chars overlap (prevents splitting evidence across boundaries)
//   MIN_CHUNK_SIZE  = 500 chars (don't create tiny trailing chunks)
//   LONG_THRESHOLD  = 8 000 chars (shorter sources use the single-pass path)

// Source text window for extraction — raised from 8k to 15k to match the output
// of the section extractor (extractDocumentSections.js). Rich evidence items need
// more context than atomic facts, and most sources now arrive pre-trimmed to 15k.
export const CHUNK_SIZE      = 8000;   // larger chunks → fewer calls for long docs
export const CHUNK_OVERLAP   = 1500;   // slightly more overlap to preserve context
export const MIN_CHUNK_SIZE  = 500;
export const LONG_THRESHOLD  = 12000;  // raised: shorter sources now use single-pass

/**
 * Split source text into overlapping chunks for long-source extraction.
 *
 * @param {string} text  - Full source text
 * @returns {{ text: string, chunk_id: number, byte_offset: number }[]}
 */
export function chunkSourceText(text) {
  if (!text || text.length <= LONG_THRESHOLD) return [];

  const chunks = [];
  let start = 0;
  let chunkId = 0;

  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    const chunkText = text.slice(start, end);

    // Skip trailing chunks that are too small to yield evidence
    if (chunkText.length >= MIN_CHUNK_SIZE) {
      chunks.push({ text: chunkText, chunk_id: chunkId++, byte_offset: start });
    }

    if (end >= text.length) break;
    start = end - CHUNK_OVERLAP;
  }

  return chunks;
}

/**
 * Deduplicate evidence items extracted from multiple chunks.
 *
 * Items from overlapping regions may be extracted twice. Deduplication uses:
 *   1. event_fingerprint (MD5 of normalized fact + normalized quote) when available
 *   2. Normalized fact text similarity as fallback (≥80% word overlap)
 *
 * The item with the best evidence_confidence is kept; others are discarded.
 * Cross-chunk duplicates are identified by normalizing fact text to lowercase +
 * stripping punctuation, then comparing word sets.
 *
 * @param {object[]} items - Evidence items from multiple chunk extractions
 * @returns {object[]} Deduplicated items with _dedup_count field
 */
export function deduplicateChunkItems(items) {
  if (items.length <= 1) return items;

  function normFact(fact) {
    return (fact || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function wordSet(text) {
    return new Set(normFact(text).split(" ").filter((w) => w.length > 3));
  }

  function wordOverlap(a, b) {
    const wa = wordSet(a);
    const wb = wordSet(b);
    if (wa.size === 0 || wb.size === 0) return 0;
    let common = 0;
    for (const w of wa) { if (wb.has(w)) common++; }
    return common / Math.max(wa.size, wb.size);
  }

  const CONF_RANK = { high: 2, medium: 1, low: 0 };

  const kept = [];
  const used = new Set();

  // Sort by confidence (best first) so we keep the highest-quality item
  const sorted = [...items].sort((a, b) =>
    (CONF_RANK[b.evidence_confidence] ?? 0) - (CONF_RANK[a.evidence_confidence] ?? 0)
  );

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;

    const item = sorted[i];
    let dupeCount = 0;

    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      // Same fact from overlapping chunk regions
      if (wordOverlap(item.fact, sorted[j].fact) >= 0.8) {
        used.add(j);
        dupeCount++;
      }
    }

    kept.push({ ...item, _chunk_dedup_count: dupeCount });
    used.add(i);
  }

  return kept;
}

// ── User prompt builder ───────────────────────────────────────────────────────

// Single-pass text window for sources below LONG_THRESHOLD.
const SOURCE_TEXT_WINDOW = LONG_THRESHOLD;

/**
 * Build the extraction user prompt for a single source (or chunk of a source).
 *
 * @param {object} source
 * @param {object} [chunkOpts]              - For chunked long-source extraction
 * @param {string} [chunkOpts.chunkText]    - The chunk text (instead of full source text)
 * @param {number} [chunkOpts.chunkId]      - Chunk index (0-based)
 * @param {number} [chunkOpts.totalChunks]  - Total number of chunks for this source
 * @param {number} [chunkOpts.byteOffset]   - Byte offset of this chunk in the full text
 */
function buildUserPrompt(source, chunkOpts = null) {
  const profile = source.extraction_profile || {};
  const elig    = source.evidence_eligibility || {};
  const u       = source.understanding || {};

  const allowedStr    = (profile.allowed_evidence_types || []).join(", ") || "(any)";
  const prioritizeStr = (profile.prioritize || []).join(", ") || "(none specified)";
  const maxItems      = profile.max_items ?? 3;
  const typeRules     = profile.extraction_rules || "";

  // Use chunk text if provided (long source chunking), else truncate to window
  const text = chunkOpts?.chunkText
    ?? (source.clean_text || source.full_text || "").slice(0, SOURCE_TEXT_WINDOW);
  const summary = u.source_summary || source.summary || "";

  // For chunked extraction, orient the LLM on what part of the source it sees
  const chunkNotice = chunkOpts
    ? `CHUNK ${chunkOpts.chunkId + 1} of ${chunkOpts.totalChunks} (byte offset ${chunkOpts.byteOffset}–${chunkOpts.byteOffset + chunkOpts.chunkText.length})`
    : null;

  return [
    `TITLE: ${source.title || "(no title)"}`,
    `PUBLISHER: ${source.publisher || "unknown"}  DATE: ${source.date_published || "unknown"}`,
    `CATEGORY: ${source.main_category || "unknown"}  SOURCE TYPE: ${source.source_type || "unknown"}`,
    `EVIDENCE USE: ${elig.evidence_use || "unknown"}`,
    chunkNotice ? `NOTE: ${chunkNotice}. Extract only from this chunk. Quotes must be verbatim from THIS text.` : "",
    ``,
    `EXTRACTION PROFILE:`,
    `  allowed_evidence_types: ${allowedStr}`,
    `  prioritize: ${prioritizeStr}`,
    `  max_items: ${maxItems}`,
    typeRules ? `\nSOURCE-TYPE SPECIFIC RULES:\n${typeRules}` : "",
    ``,
    `=== SOURCE TEXT (copy source_quote VERBATIM from this text; include full context in fact) ===`,
    text || "(no source body available — extract conservatively and mark confidence low)",
    ``,
    summary && !chunkOpts ? `--- source summary (context only; DO NOT quote this) ---\n${summary}` : "",
    ``,
    `Extract up to ${maxItems} rich evidence items. Each needs: fact (full context, named entities, verbatim metrics), source_quote (verbatim from text above), caveats (author-stated scope/confidence), what_this_establishes, what_this_cannot_establish, and evidence_type from the allowed list.`,
  ].filter((l) => l !== "").join("\n");
}

// ── Legacy evidence_card conversion ──────────────────────────────────────────

const SOURCE_TYPE_TO_EVIDENCE_TYPE = {
  incident:                  "incident_event",
  vulnerability:             "vulnerability_fact",
  exploit_disclosure:        "exploit_chain",
  threat_intelligence:       "threat_actor_activity",
  adversary_adoption_signal: "adversary_adoption",
  research_finding:          "research_result",
  capability_demonstration:  "capability_delta",
  benchmark_evaluation:      "benchmark_result",
  societal_harm_signal:      "societal_harm",
  governance_signal:         "governance_action",
  defensive_capability:      "defensive_control",
  attack_surface_signal:     "infrastructure_dependency",
};

// Maps evidence_strength_hint (set by L3.4 source context annotation) to the
// evidence_confidence string used on individual items. Falls back to trust_tier
// for sources that predate the annotation layer.
const STRENGTH_HINT_TO_CONFIDENCE = {
  strong:       "high",
  moderate:     "medium",
  weak:         "low",
  context_only: "low",
};
const TRUST_TIER_FALLBACK = {
  primary: "high", curated: "high", high: "high",
  medium: "medium", low: "low", unknown: "low",
};
function itemConfidence(source) {
  return STRENGTH_HINT_TO_CONFIDENCE[source.evidence_strength_hint] ||
         TRUST_TIER_FALLBACK[source.trust_tier] ||
         "low";
}

/**
 * Convert a legacy evidence_card to the new evidence_items[] format.
 *
 * @param {object} source
 * @returns {object[]} evidence items (may be empty)
 */
export function convertLegacyEvidenceCardToItems(source) {
  const card = source.evidence_card;
  if (!card) return [];

  const st              = source.source_type || "unknown";
  const evidence_type   = SOURCE_TYPE_TO_EVIDENCE_TYPE[st] || "research_result";
  const confidence      = itemConfidence(source) || "low";
  const bestUsedFor     = Array.isArray(card.best_used_for) ? card.best_used_for : ["trend_support"];
  // Map legacy best_used_for values that are not in the new enum
  const LEGACY_MAP = {
    visual_annotation: "chart_annotation",
  };
  const mappedBestUsedFor = bestUsedFor
    .map((v) => LEGACY_MAP[v] || v)
    .filter((v) => ["case_study","trend_support","outlook_support","recommendation_support",
                    "stat_callout","timeline","chart_annotation"].includes(v));

  const keyFacts = Array.isArray(card.key_facts) ? card.key_facts.slice(0, 3) : [];

  return keyFacts
    .filter((fact) => typeof fact === "string" && fact.trim().length >= 10)
    .map((fact, i) => ({
      evidence_id:         `ev_${source.id}_${i + 1}`,
      source_id:           source.id,
      evidence_type,
      fact:                fact.trim(),
      display_label:       fact.trim().slice(0, 60),
      supporting_text:     fact.trim().slice(0, 150),
      entities:            [],
      numbers:             Array.isArray(card.numbers_statistics) ? card.numbers_statistics.slice(0, 5) : [],
      date:                null,
      category_hint:       source.main_category || "",
      source_type:         st,
      source_title:        source.title || "",
      publisher:           source.publisher || "",
      url:                 source.url || "",
      evidence_confidence: confidence,
      best_used_for:       mappedBestUsedFor.length > 0 ? mappedBestUsedFor : ["trend_support"],
    }));
}

// ── Deterministic fallback (no LLM) ───────────────────────────────────────────

// Concrete-signal detectors — a fallback "fact" must look like a fact, not prose.
const CONCRETE_SIGNALS = [
  /\bCVE-\d{4}-\d{4,}\b/i,                         // CVE id
  /\d+%|\$[\d.,]+|\b\d{1,3}(?:,\d{3})+\b|\b\d+\s*(million|billion|thousand|k\b)/i, // numbers/money
  /\bAPT\d+\b|\bransomware\b|\bmalware\b|\bbreach\b|\bexploit(?:ed|ation)?\b/i,    // threat nouns
  /\b(vulnerabilit|patch|zero-day|backdoor|injection|jailbreak|deepfake)\w*/i,    // technique nouns
  /\b(launched|released|disclosed|confirmed|exploited|infected|breached|patched|introduced)\b/i, // event verbs
];

// Summary / generic openers that disqualify a sentence as an atomic fact.
const SUMMARY_OPENERS = [
  /^(this|the)\s+(paper|study|report|research|article|post)\b/i,
  /^(researchers?|the authors?|we)\s+(present|propose|show|demonstrate|introduce|describe|argue)/i,
  /^(ai|llms?|artificial intelligence|machine learning)\s+(is|are|can|may|might|has|have|will)\b/i,
  /^in (this|the)\s+(paper|study|report)/i,
];

function splitSentences(text) {
  return (text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isConcreteFactSentence(s) {
  if (s.length < 25 || s.length > 240) return false;
  if (SUMMARY_OPENERS.some((re) => re.test(s))) return false;
  return CONCRETE_SIGNALS.some((re) => re.test(s));
}

/**
 * Build evidence items deterministically when the LLM is unavailable.
 * Prefers concrete fact-bearing SENTENCES from the source body (grounded,
 * verbatim) over high-level summary claims. Falls back to the legacy
 * evidence_card only as a last resort.
 */
function buildFallbackItems(source, maxItems) {
  const st     = source.source_type || "unknown";
  const evType = SOURCE_TYPE_TO_EVIDENCE_TYPE[st] || "research_result";
  const conf   = itemConfidence(source) || "low";
  const text   = source.clean_text || source.full_text || "";

  // 1) Extract concrete, grounded sentences from the source body.
  const candidates = splitSentences(text).filter(isConcreteFactSentence);

  // De-dup near-identical sentences by lowercased prefix.
  const seen = new Set();
  const picked = [];
  for (const s of candidates) {
    const key = s.toLowerCase().slice(0, 50);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(s);
    if (picked.length >= maxItems) break;
  }

  if (picked.length > 0) {
    return picked.map((sentence, i) => ({
      evidence_id:         `ev_${source.id}_${i + 1}`,
      source_id:           source.id,
      evidence_type:       evType,
      fact:                sentence.slice(0, 200),
      display_label:       sentence.slice(0, 60),
      source_quote:        sentence.slice(0, 200),   // verbatim from source body
      supporting_text:     sentence.slice(0, 200),
      entities:            [],
      numbers:             [],
      date:                null,
      category_hint:       source.main_category || "",
      source_type:         st,
      source_title:        source.title || "",
      publisher:           source.publisher || "",
      url:                 source.url || "",
      evidence_confidence: conf === "high" ? "medium" : conf, // deterministic ≠ high
      best_used_for:       ["trend_support"],
      extraction_method:   "deterministic_sentence",
    }));
  }

  // 2) Last resort: legacy evidence_card key_facts (these may be summaries).
  const fromCard = convertLegacyEvidenceCardToItems(source);
  if (fromCard.length > 0) {
    return fromCard.slice(0, maxItems).map((it) => ({
      ...it,
      source_quote:      it.source_quote || it.supporting_text || "",
      extraction_method: "legacy_card",
    }));
  }

  return [];
}

// ── Output validation ─────────────────────────────────────────────────────────

const VALID_BEST_USED_FOR = new Set([
  "case_study","trend_support","outlook_support",
  "recommendation_support","stat_callout","timeline","chart_annotation",
]);
const VALID_CONFIDENCE = new Set(["high","medium","low"]);

function validateItem(raw, source, index) {
  if (typeof raw !== "object" || raw === null) return null;

  const fact = typeof raw.fact === "string" ? raw.fact.trim() : "";
  if (fact.length < 10) return null;

  const ensureArray = (v) => Array.isArray(v) ? v : [];
  const str = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : null;

  const best_used_for = ensureArray(raw.best_used_for)
    .filter((v) => VALID_BEST_USED_FOR.has(v));

  // source_quote: verbatim grounding span — now up to 500 chars (rich excerpts)
  const source_quote = str(raw.source_quote ?? raw.supporting_text, 500) || "";

  return {
    evidence_id:         `ev_${source.id}_${index + 1}`,
    source_id:           source.id,
    evidence_type:       typeof raw.evidence_type === "string" ? raw.evidence_type : "research_result",
    fact:                fact.slice(0, 400),   // richer facts, up to 400 chars
    display_label:       str(raw.display_label, 100) || fact.slice(0, 60),
    source_quote,
    supporting_text:     source_quote,         // backward-compat mirror
    // Rich context fields (v2.0)
    caveats:                   str(raw.caveats, 250),
    what_this_establishes:     str(raw.what_this_establishes, 200),
    what_this_cannot_establish: str(raw.what_this_cannot_establish, 200),
    entities:            ensureArray(raw.entities).filter((e) => typeof e === "string"),
    numbers:             ensureArray(raw.numbers).filter((n) => typeof n === "string"),
    date:                typeof raw.date === "string" ? raw.date : (typeof raw.event_date === "string" ? raw.event_date : null),
    category_hint:       str(raw.category_hint, 60) || (source.main_category || ""),
    source_type:         source.source_type || "unknown",
    source_title:        source.title || "",
    publisher:           source.publisher || "",
    url:                 source.url || "",
    evidence_confidence: VALID_CONFIDENCE.has(raw.evidence_confidence) ? raw.evidence_confidence : "medium",
    best_used_for:       best_used_for.length > 0 ? best_used_for : ["trend_support"],
    extraction_method:   "llm",
    // Analytical hooks — optional reasoning material for L6 synthesis
    analytical_hook:       str(raw.analytical_hook, 250),
    novelty_signal:        str(raw.novelty_signal, 250),
    why_this_may_matter:   str(raw.why_this_may_matter, 250),
    what_changed:          str(raw.what_changed, 250),
    assumption_challenged: str(raw.assumption_challenged, 250),
  };
}

// ── Post-extraction quality passes ───────────────────────────────────────────

/**
 * Run quote verification and method quality on extracted items, then apply
 * the gating rules that determine admissibility.
 *
 * Items with unsupported/changed_meaning quotes → archived (not used downstream).
 * Items with partially_supported/overstated → capped at context_only.
 * Items with quantitative claims → method_quality and statistical_use attached.
 */
async function applyPostExtractionQuality(items, source, opts = {}) {
  if (items.length === 0) return items;

  const sourceText = source.clean_text || source.full_text || "";

  // Step 5b: Quote verification — gate on entailment and claim preservation
  const verified = await applyQuoteVerification(items, sourceText, opts);

  // Step 5c: Method quality — assess quantitative evidence methodology
  const independence = source.independence_level;
  return verified.map((item) => {
    const methodResult = assessMethodQuality(item, sourceText, { independence_level: independence });
    return {
      ...item,
      method_quality:  methodResult.method_quality,
      statistical_use: methodResult.statistical_use,
      method_reason:   methodResult.method_reason,
    };
  });
}

// ── Single chunk extractor ────────────────────────────────────────────────────

/**
 * Run one LLM extraction call on a chunk of source text.
 * Returns validated evidence items with chunk metadata attached.
 */
async function extractFromChunk(source, chunkOpts, maxItems) {
  const userPrompt = buildUserPrompt(source, chunkOpts);

  const raw = await callLLM(SYSTEM_PROMPT, userPrompt, {
    task:     "evidence_extraction",
    schema:   EVIDENCE_ITEMS_SCHEMA,
    logLabel: `L5A-rawfacts-chunk-${chunkOpts.chunkId}`,
  });

  const parsed  = typeof raw === "string" ? JSON.parse(raw) : raw;
  const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];

  return rawItems
    .map((item, i) => {
      const validated = validateItem(item, source, i);
      if (!validated) return null;
      // Attach chunk metadata for deduplication and traceability
      return {
        ...validated,
        chunk_id:          chunkOpts.chunkId,
        chunk_byte_offset: chunkOpts.byteOffset,
        // Rewrite evidence_id to be chunk-scoped (deduplicated later)
        evidence_id:       `ev_${source.id}_c${chunkOpts.chunkId}_${i + 1}`,
      };
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

// ── Single source processor ───────────────────────────────────────────────────

async function processOne(source, hasLlm) {
  const use     = source.evidence_eligibility?.evidence_use;
  const profile = source.extraction_profile || {};

  // Skip entirely
  if (use === "do_not_extract" || use === "analytics_only") {
    return { ...source, evidence_items_raw: [] };
  }

  // context_only: deterministic only, cap at 2. No quote verification needed —
  // deterministic items are sentence-extracted verbatim from the source.
  if (use === "context_only") {
    const items = buildFallbackItems(source, 2);
    return { ...source, evidence_items_raw: items };
  }

  // primary_evidence or supporting_evidence → LLM if available
  const maxItems = profile.max_items ?? 3;

  if (!hasLlm) {
    const items = buildFallbackItems(source, maxItems);
    return { ...source, evidence_items_raw: items };
  }

  const sourceText = source.clean_text || source.full_text || "";

  try {
    // ── Long source: chunk and extract per chunk ──────────────────────────────
    const chunks = chunkSourceText(sourceText);

    if (chunks.length > 0) {
      // Long source (>LONG_THRESHOLD chars) — extract from each chunk separately.
      // Each call is narrow (one chunk, one focused extraction).
      const perChunkMax = Math.max(2, Math.ceil(maxItems / chunks.length) + 1);
      const allChunkItems = [];

      for (const chunk of chunks) {
        try {
          const chunkItems = await extractFromChunk(
            source,
            { chunkText: chunk.text, chunkId: chunk.chunk_id, totalChunks: chunks.length, byteOffset: chunk.byte_offset },
            perChunkMax
          );
          allChunkItems.push(...chunkItems);
        } catch (chunkErr) {
          process.stdout.write(
            `  [Layer 5a.3] Chunk ${chunk.chunk_id} failed for "${(source.title || "").slice(0, 40)}": ${chunkErr.message}\n`
          );
          // Continue with other chunks on single-chunk failure
        }
      }

      if (allChunkItems.length === 0) {
        // All chunks failed — fall back to deterministic
        const items = buildFallbackItems(source, maxItems);
        return { ...source, evidence_items_raw: items };
      }

      // Deduplicate across chunks (overlapping regions produce near-duplicate facts)
      const deduped = deduplicateChunkItems(allChunkItems).slice(0, maxItems);

      // Reassign stable evidence_ids after deduplication
      const sourceId = source.id || "";
      const reIdented = deduped.map((item, i) => ({
        ...item,
        evidence_id: `ev_${sourceId}_${i + 1}`,
      }));

      // Quote verification on merged items
      const items = await applyPostExtractionQuality(reIdented, source);

      process.stdout.write(
        `  [Layer 5a.3] Chunked "${(source.title || "").slice(0, 40)}" → ` +
        `${chunks.length} chunks, ${allChunkItems.length} raw items, ${deduped.length} after dedup\n`
      );

      return { ...source, evidence_items_raw: items };
    }

    // ── Short source: single-pass extraction ─────────────────────────────────
    const raw = await callLLM(SYSTEM_PROMPT, buildUserPrompt(source), {
      task:     "evidence_extraction",
      schema:   EVIDENCE_ITEMS_SCHEMA,
      logLabel: "L5A-rawfacts-evidence-extraction",
    });

    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];

    const validated = rawItems
      .map((item, i) => validateItem(item, source, i))
      .filter(Boolean)
      .slice(0, maxItems);

    // Step 5b+5c: quote verification + method quality on LLM-extracted items
    const items = await applyPostExtractionQuality(validated, source);

    return { ...source, evidence_items_raw: items };
  } catch (err) {
    process.stdout.write(
      `  [Layer 5a.3] LLM failed for "${(source.title || "").slice(0, 60)}": ${err.message} — using fallback\n`
    );
    const items = buildFallbackItems(source, maxItems);
    return { ...source, evidence_items_raw: items };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 5;

/**
 * Extract evidence items for all eligible sources (Layer 5a.3).
 *
 * @param {object[]} sources - Sources with evidence_eligibility and extraction_profile.
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]  - Force deterministic fallback.
 * @param {number}   [opts.concurrency=5]  - Max parallel LLM calls.
 * @returns {Promise<object[]>} Sources with evidence_items_raw[] field added.
 */
export async function extractEvidenceItems(sources, opts = {}) {
  const { skipLlm = false, concurrency = DEFAULT_CONCURRENCY } = opts;

  const hasLlm = !skipLlm && !!(
    process.env.OPENAI_API_KEY    || process.env.OPENAI_API_KEY_2  ||
    process.env.GEMINI_API_KEY    || process.env.GEMINI_API_KEY_2  ||
    process.env.GROQ_API_KEY      ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.OPENROUTER_API_KEY
  );

  const results = new Array(sources.length);
  for (let i = 0; i < sources.length; i += concurrency) {
    const batch       = sources.slice(i, i + concurrency);
    const batchResult = await Promise.all(batch.map((s) => processOne(s, hasLlm)));
    for (let j = 0; j < batch.length; j++) {
      results[i + j] = batchResult[j];
    }
  }

  return results;
}
