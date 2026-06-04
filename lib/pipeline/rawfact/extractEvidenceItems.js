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

// ── Evidence item schema for structured output ────────────────────────────────

const EVIDENCE_ITEMS_SCHEMA = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: [
          "evidence_type","fact","short_label","source_quote",
          "entities","numbers","date","category_hint",
          "evidence_confidence","best_used_for",
        ],
        properties: {
          evidence_type:       { type: "string" },
          // fact = ONE atomic claim (single subject + single assertion), <= 25 words
          fact:                { type: "string" },
          short_label:         { type: "string" },
          // source_quote = VERBATIM span copied from the source text (the grounding anchor)
          source_quote:        { type: "string" },
          entities:            { type: "array", items: { type: "string" } },
          numbers:             { type: "array", items: { type: "string" } },
          date:                { type: ["string","null"] },
          category_hint:       { type: "string" },
          evidence_confidence: { type: "string", enum: ["high","medium","low"] },
          best_used_for: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "case_study","trend_support","outlook_support",
                "recommendation_support","stat_callout","timeline","chart_annotation",
              ],
            },
          },
        },
      },
    },
  },
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an intelligence analyst extracting ATOMIC, SOURCE-GROUNDED factual claims from a cybersecurity source for an AI threat briefing.

A rawfact is NOT a summary. It is one precise, verifiable claim, copied-down from a specific statement in the source text.

## WHAT AN ATOMIC CLAIM IS
- ONE subject + ONE assertion. A single fact a reader could fact-check against the source.
- If a sentence contains two facts, split it into two items.
- ≤ 25 words. If you cannot say it in 25 words, it is probably a summary — break it up.

GOOD (atomic, grounded):
  fact: "Detectify's MCP Server lets AI agents run continuous AppSec tests autonomously."
  fact: "CVE-2026-34926 in Trend Micro Apex One is being actively exploited in the wild."
  fact: "Megalodon malware infected thousands of GitHub repositories."
BAD (summary / compound — DO NOT do this):
  "This paper proposes a new method for detecting adversarial examples and evaluates it on several datasets, showing improvements." (summary, multiple claims)
  "AI is changing the threat landscape and defenders must adapt." (generic, no specific fact)
  "Detectify launched a product and Conifers launched another and MIT wrote an article." (compound — three claims in one)

## GROUNDING — NON-NEGOTIABLE
Every item MUST include source_quote: a VERBATIM span copied EXACTLY from the SOURCE TEXT below.
- Copy the words as they appear. Do NOT paraphrase, summarise, or fix grammar in source_quote.
- The source_quote must contain the evidence for the fact. If you cannot find a verbatim span that supports the claim, DO NOT extract that item.
- If the source text is empty or you can only see a summary (not the source body), extract fewer items and mark evidence_confidence "low".

## EXTRACT ONLY IF: credible + concrete + consequential.
The fact must answer at least one of:
1. Is this happening in the real world?      2. Is this newly possible?
3. Does it affect many systems/sectors/orgs?  4. Does it change attacker capability?
5. Does it change defender priorities?        6. Does it show adversaries adopting AI?
7. Does it create or expand an attack surface? 8. Does it require mitigation/monitoring/governance/response?

DO NOT extract:
- Generic AI commentary or vague predictions
- Vendor marketing or unsupported superlatives
- Summaries of the source ("this report describes…", "researchers show…")
- Compound claims (split them) or paraphrases of a prior item
- Items whose evidence_type is not in allowed_evidence_types

## FIELDS

evidence_type   One value from allowed_evidence_types in the extraction profile.

fact            ONE atomic claim. ≤25 words. Specific subject + specific assertion. Source must directly state it.

short_label     Slide-ready label, ≤8 words. No hedging.

source_quote    A VERBATIM span from the SOURCE TEXT (≤200 chars) that contains the evidence for this fact. Copy exactly.

entities        Named orgs, people, systems, CVEs, threat actors, products in this fact.

numbers         Quantitative data points WITH context and units, e.g. "87%: attack success rate", "5500: GitHub repos". Only numbers that appear in the source.

date            Event date YYYY-MM-DD if determinable, else null.

category_hint   The main_category this evidence belongs to.

evidence_confidence
  high   — source_quote directly and explicitly states the fact with specifics
  medium — fact is a fair close reading of the quote
  low    — fact is inferred, or you only had a summary to work from

best_used_for   1–3 of: case_study, trend_support, outlook_support, recommendation_support, stat_callout, timeline, chart_annotation

## RULES
- Return strict JSON only — no markdown, no preamble.
- NEVER invent facts, numbers, or quotes not in the source.
- One claim per item. Split compound statements.
- If nothing qualifies, return { "items": [] }.
- Respect max_items — do not exceed it.`;

// ── User prompt builder ───────────────────────────────────────────────────────

// Source text window for extraction. Larger window → evidence is found in the
// body, not just the summary. ~5000 chars ≈ 1250 tokens — cheap-tier safe.
const SOURCE_TEXT_WINDOW = 5000;

function buildUserPrompt(source) {
  const profile = source.extraction_profile || {};
  const elig    = source.evidence_eligibility || {};
  const u       = source.understanding || {};

  const allowedStr    = (profile.allowed_evidence_types || []).join(", ") || "(any)";
  const prioritizeStr = (profile.prioritize || []).join(", ") || "(none specified)";
  const maxItems      = profile.max_items ?? 3;

  const text    = (source.clean_text || source.full_text || "").slice(0, SOURCE_TEXT_WINDOW);
  const summary = u.source_summary || source.summary || "";

  // SOURCE TEXT leads — it is the extraction substrate and the source of source_quote.
  // The analyst summary is provided only as orientation, explicitly NOT to be quoted.
  return [
    `TITLE: ${source.title || "(no title)"}`,
    `PUBLISHER: ${source.publisher || "unknown"}  DATE: ${source.date_published || "unknown"}`,
    `CATEGORY: ${source.main_category || "unknown"}  SOURCE TYPE: ${source.source_type || "unknown"}`,
    `EVIDENCE USE: ${elig.evidence_use || "unknown"}`,
    ``,
    `EXTRACTION PROFILE:`,
    `  allowed_evidence_types: ${allowedStr}`,
    `  prioritize: ${prioritizeStr}`,
    `  max_items: ${maxItems}`,
    ``,
    `=== SOURCE TEXT (extract atomic claims from THIS; copy source_quote verbatim from here) ===`,
    text || "(no source body available — extract conservatively and mark confidence low)",
    ``,
    summary ? `--- analyst orientation only (DO NOT quote this; for context) ---\n${summary}` : "",
    ``,
    `Extract up to ${maxItems} atomic, source-grounded claims. Each needs a verbatim source_quote from the SOURCE TEXT above.`,
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
  ecosystem_signal:          "ecosystem_shift",
  trust_boundary_shift:      "trust_boundary_shift",
  infrastructure_dependency_signal: "infrastructure_dependency",
  strategic_signal:          "strategic_signal",
};

const TRUST_TO_CONFIDENCE = {
  primary: "high",
  curated: "high",
  high:    "high",
  medium:  "medium",
  low:     "low",
  unknown: "low",
};

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
  const confidence      = TRUST_TO_CONFIDENCE[source.trust_tier] || "low";
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
      short_label:         fact.trim().slice(0, 60),
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
  const conf   = TRUST_TO_CONFIDENCE[source.trust_tier] || "low";
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
      short_label:         sentence.slice(0, 60),
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

  const best_used_for = ensureArray(raw.best_used_for)
    .filter((v) => VALID_BEST_USED_FOR.has(v));

  // source_quote is the verbatim grounding span; fall back to legacy supporting_text.
  const source_quote = typeof raw.source_quote === "string"
    ? raw.source_quote.trim().slice(0, 300)
    : (typeof raw.supporting_text === "string" ? raw.supporting_text.trim().slice(0, 300) : "");

  return {
    evidence_id:         `ev_${source.id}_${index + 1}`,
    source_id:           source.id,
    evidence_type:       typeof raw.evidence_type === "string" ? raw.evidence_type : "research_result",
    fact,
    short_label:         typeof raw.short_label === "string" ? raw.short_label.trim().slice(0, 100) : fact.slice(0, 60),
    source_quote,
    supporting_text:     source_quote,   // backward-compat mirror
    entities:            ensureArray(raw.entities).filter((e) => typeof e === "string"),
    numbers:             ensureArray(raw.numbers).filter((n) => typeof n === "string"),
    date:                typeof raw.date === "string" ? raw.date : null,
    category_hint:       typeof raw.category_hint === "string" ? raw.category_hint : (source.main_category || ""),
    source_type:         source.source_type || "unknown",
    source_title:        source.title || "",
    publisher:           source.publisher || "",
    url:                 source.url || "",
    evidence_confidence: VALID_CONFIDENCE.has(raw.evidence_confidence) ? raw.evidence_confidence : "medium",
    best_used_for:       best_used_for.length > 0 ? best_used_for : ["trend_support"],
    extraction_method:   "llm",
  };
}

// ── Single source processor ───────────────────────────────────────────────────

async function processOne(source, hasLlm) {
  const use     = source.evidence_eligibility?.evidence_use;
  const profile = source.extraction_profile || {};

  // Skip entirely
  if (use === "do_not_extract" || use === "analytics_only") {
    return { ...source, evidence_items_raw: [] };
  }

  // context_only: deterministic only, cap at 2
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

  try {
    const raw = await callLLM(SYSTEM_PROMPT, buildUserPrompt(source), {
      task:     "evidence_extraction",
      schema:   EVIDENCE_ITEMS_SCHEMA,
      logLabel: "L5A-rawfacts-evidence-extraction",
    });

    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];

    const items = rawItems
      .map((item, i) => validateItem(item, source, i))
      .filter(Boolean)
      .slice(0, maxItems);

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
