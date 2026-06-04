/**
 * Layer 7.1B — Rawfact Evidence Card Extraction
 *
 * LLM-based extraction of structured evidence cards for high-priority sources.
 * Only sources with rawfact_taxonomy.operational_relevance of "very_high" or "high",
 * OR feed_score_data?.feed_priority of "must_read" or "high", receive an LLM call.
 * Lower-priority sources get evidence_card: null.
 *
 * ── LLM CALL ─────────────────────────────────────────────────────────────────
 * Tool:    callLLM()  (lib/llm/callLLM.js) — provider rotation
 * Models:  gpt-4o-mini  (OPENAI_API_KEY primary, OPENAI_API_KEY_2 secondary)
 *          llama-3.3-70b-versatile  (GROQ_API_KEY — JSON mode, no schema)
 *          gemini-2.0-flash / gemini-2.5-flash  (GEMINI_API_KEY / GEMINI_API_KEY_2)
 * Trigger: source operational_relevance="very_high"|"high" OR priority="must_read"|"high"
 *          AND at least one API key present AND skipLlm=false
 * Output:  structured JSON via json_schema response_format (EVIDENCE_SCHEMA)
 * Label:   "L5A-rawfacts-evidence-extraction"
 * Concurrency: 5 parallel calls (default)
 *
 * System prompt: SYSTEM_PROMPT (constant, lines 46–107)
 *   Senior intelligence analyst role. Extracts 8 structured fields from source:
 *   evidence_card_title (≤10 words), short_summary (1–2 sentences),
 *   key_facts (3–5), numbers_statistics, attack_flow (step-by-step if applicable),
 *   impacts, why_it_matters (1 sentence), best_used_for (slide use tags).
 *   Source-type-aware guidance for 10 source types.
 *
 * User prompt: buildUserPrompt(source) — title, publisher, date, url,
 *   category, source_type, rawfact_taxonomy fields (operational_relevance,
 *   novelty, impact_severity, impact_scope, sector), analyst summary,
 *   source text (≤1800 chars).
 *
 * Fallback (no keys, skipLlm=true, or source below priority threshold):
 *   buildFallbackCard() — copies title, source_summary, main_claims,
 *   important_numbers from Layer 5 understanding. Sets best_used_for=["trend_support"].
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 * source.evidence_card = { evidence_card_title, short_summary, key_facts,
 *   numbers_statistics, attack_flow, impacts, why_it_matters, best_used_for,
 *   source_id, citations: [{ url, title, publisher, published_date }] }
 *   OR null for low-priority sources.
 */

import { callLLM } from "../../llm/callLLM.js";

// ── Structured output schema ──────────────────────────────────────────────────

const EVIDENCE_SCHEMA = {
  type: "object",
  required: [
    "evidence_card_title","short_summary","key_facts",
    "numbers_statistics","attack_flow","impacts",
    "why_it_matters","best_used_for",
  ],
  properties: {
    evidence_card_title: { type: "string" },
    short_summary:       { type: "string" },
    key_facts:           { type: "array", items: { type: "string" } },
    numbers_statistics:  { type: "array", items: { type: "string" } },
    attack_flow:         { type: "array", items: { type: "string" } },
    impacts:             { type: "array", items: { type: "string" } },
    why_it_matters:      { type: "string" },
    best_used_for: {
      type: "array",
      items: {
        type: "string",
        enum: ["trend_support","case_study","outlook_support","visual_annotation","stat_callout"],
      },
    },
  },
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior intelligence analyst extracting structured evidence from a cybersecurity source for use in a strategic AI threat briefing deck.

Your output will be placed directly on presentation slides. Precision and brevity are critical — no filler phrases.

RAWFACT TAXONOMY is provided — use it to focus extraction on the most important evidence type for this source's source_type.

## FIELDS

evidence_card_title
  A punchy, slide-ready title (≤10 words). Captures the most newsworthy aspect.
  Good: "GPT-4o Guardrails Bypassed via Base64 Injection"
  Bad: "Researchers demonstrate a new type of attack on AI systems"

short_summary
  1–2 sentences suitable for a slide body. What happened + why it matters. No fluff.

key_facts
  3–5 specific, verifiable facts from the source. Short declarative sentences.
  Only facts the source directly states — no inference.

numbers_statistics
  Quantitative data points with context. Format: "value: context"
  e.g. "87%: attack success rate against GPT-4o guardrails"
  Empty array if none present.

attack_flow
  Step-by-step attack sequence (if source describes one). Start each step with a verb.
  e.g. ["Embed malicious instruction in base64", "LLM decodes and executes payload", "Attacker achieves arbitrary output"]
  Empty array if not an attack/exploit source.

impacts
  1–3 concrete impact statements. What was compromised, damaged, or leaked?
  Empty array if no concrete impact described.

why_it_matters
  1 sentence. The strategic significance for defenders or decision-makers.
  Focus on: what defender action this calls for, or what threat shift it signals.

best_used_for
  1–3 tags indicating best slide use. Choose from:
  - trend_support — illustrates an ongoing trend
  - case_study — a specific real-world example
  - outlook_support — supports a forward-looking claim
  - visual_annotation — good for annotating a chart or timeline
  - stat_callout — a strong statistic worth highlighting

## SOURCE-TYPE GUIDANCE (use rawfact_taxonomy to focus)
- vulnerability/exploit_disclosure: prioritise attack_flow, affected systems, exploit status
- incident: prioritise confirmed impacts, victim details, attacker method
- threat_intelligence: prioritise observed TTPs, threat actor, targeted sectors
- research_finding: prioritise method demonstrated, systems tested, key result
- defensive_capability: prioritise gap addressed, deployment readiness, limitations
- governance_signal: prioritise issuing authority, compliance implications, recommended actions
- benchmark_evaluation: prioritise capability measured, key result, trajectory
- capability_demonstration: prioritise demonstrated capability, affected system, replication difficulty
- adversary_adoption_signal: prioritise who is adopting, evidence quality, affected sectors
- strategic_signal: prioritise strategic theme, systemic risk, horizon relevance

## RULES
- Return strict JSON only — no markdown, no explanation
- Do not invent facts not in the source
- If a field is not applicable, use an empty array or a neutral statement`;

// ── User prompt builder ───────────────────────────────────────────────────────

function buildUserPrompt(source) {
  const rt = source.rawfact_taxonomy || {};
  const u  = source.understanding  || {};

  const sectorStr = Array.isArray(rt.sector) ? rt.sector.join(", ") : "";

  const parts = [
    `TITLE: ${source.title || "(no title)"}`,
    `PUBLISHER: ${source.publisher || "unknown"}  DATE: ${source.date_published || "unknown"}  URL: ${source.url || ""}`,
    `CATEGORY: ${source.main_category || "unknown"}  SOURCE TYPE: ${source.source_type || "unknown"}`,
    `RAWFACT TAXONOMY:`,
    `  operational_relevance: ${rt.operational_relevance || "unknown"}`,
    `  novelty: ${rt.novelty || "unknown"}`,
    `  impact_severity: ${rt.impact_severity || "unknown"}`,
    `  impact_scope: ${rt.impact_scope || "unknown"}`,
    `  sector: ${sectorStr || "(none)"}`,
  ];

  const summary = u.source_summary || source.summary || "";
  if (summary) parts.push(`\nANALYST SUMMARY: ${summary}`);

  const text = (source.clean_text || source.full_text || "").slice(0, 1800);
  if (text) parts.push(`\nSOURCE TEXT:\n${text}`);

  return parts.join("\n");
}

// ── Deterministic fallback ────────────────────────────────────────────────────

function buildFallbackCard(source) {
  const u = source.understanding || {};
  return {
    evidence_card_title:  (source.title || "").slice(0, 80),
    short_summary:        u.source_summary || source.summary || source.title || "",
    key_facts:            (u.main_claims || []).slice(0, 3),
    numbers_statistics:   u.important_numbers || [],
    attack_flow:          [],
    impacts:              [],
    why_it_matters:       "Relevant to the AI threat landscape — see source for details.",
    best_used_for:        ["trend_support"],
  };
}

// ── Output validation ─────────────────────────────────────────────────────────

const BEST_USED_FOR_VALUES = ["trend_support","case_study","outlook_support","visual_annotation","stat_callout"];

function validateCard(raw) {
  const out = typeof raw === "object" && raw !== null ? raw : {};
  const ensureArray = (v) => Array.isArray(v) ? v : [];

  const best_used_for = ensureArray(out.best_used_for)
    .filter((v) => BEST_USED_FOR_VALUES.includes(v))
    .slice(0, 3);

  return {
    evidence_card_title: typeof out.evidence_card_title === "string" ? out.evidence_card_title : "",
    short_summary:       typeof out.short_summary === "string" ? out.short_summary : "",
    key_facts:           ensureArray(out.key_facts).slice(0, 5),
    numbers_statistics:  ensureArray(out.numbers_statistics).slice(0, 5),
    attack_flow:         ensureArray(out.attack_flow).slice(0, 8),
    impacts:             ensureArray(out.impacts).slice(0, 3),
    why_it_matters:      typeof out.why_it_matters === "string" ? out.why_it_matters : "",
    best_used_for:       best_used_for.length > 0 ? best_used_for : ["trend_support"],
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 5;

/**
 * Extract evidence cards for high-priority sources (Layer 7.1B).
 *
 * @param {object[]} sources - Sources with rawfact_taxonomy from Layer 7.1A.
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]   - Force deterministic fallback.
 * @param {number}   [opts.concurrency=5]   - Max parallel LLM calls.
 * @returns {Promise<object[]>} Sources with `evidence_card` field added.
 */
export async function extractRawfacts(sources, opts = {}) {
  const { skipLlm = false, concurrency = DEFAULT_CONCURRENCY } = opts;

  const hasLlm = !skipLlm && !!(
    process.env.OPENAI_API_KEY  || process.env.OPENAI_API_KEY_2  ||
    process.env.GROQ_API_KEY    ||
    process.env.GEMINI_API_KEY  || process.env.GEMINI_API_KEY_2
  );

  function shouldExtract(source) {
    const opRel    = source.rawfact_taxonomy?.operational_relevance;
    const priority = source.feed_score_data?.feed_priority;
    return (
      opRel === "very_high" || opRel === "high" ||
      priority === "must_read" || priority === "high"
    );
  }

  function buildCitation(source) {
    return {
      url:            source.url           || "",
      title:          source.title         || "",
      publisher:      source.publisher     || "",
      published_date: source.date_published || "",
    };
  }

  async function processOne(source) {
    if (!shouldExtract(source)) {
      return { ...source, evidence_card: null };
    }

    let cardFields;

    if (!hasLlm) {
      cardFields = validateCard(buildFallbackCard(source));
    } else {
      try {
        const raw = await callLLM(SYSTEM_PROMPT, buildUserPrompt(source), {
          schema:   EVIDENCE_SCHEMA,
          logLabel: "L5A-rawfacts-evidence-extraction",
        });
        cardFields = validateCard(typeof raw === "string" ? JSON.parse(raw) : raw);
      } catch (err) {
        process.stdout.write(
          `  [Layer 7.1B] Evidence LLM failed for "${(source.title || "").slice(0, 60)}": ${err.message} — using fallback\n`
        );
        cardFields = validateCard(buildFallbackCard(source));
      }
    }

    const evidence_card = {
      ...cardFields,
      source_id: source.id,
      citations: [buildCitation(source)],
    };

    return { ...source, evidence_card };
  }

  const results = new Array(sources.length);
  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processOne));
    for (let j = 0; j < batch.length; j++) {
      results[i + j] = batchResults[j];
    }
  }

  return results;
}
