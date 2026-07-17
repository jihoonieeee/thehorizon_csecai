/**
 * extractRoundupEvidence()
 *
 * Specialist extractor for multi-story digest articles.
 *
 * Two-pass approach:
 *   1. LLM segmentation pass: identify distinct stories in the digest.
 *   2. Standard extraction on each segment (reuses SYSTEM_PROMPT from extractEvidence).
 *
 * This prevents ten incidents from collapsing into a single generic summary,
 * and ensures each incident gets its own quote-grounded evidence items.
 *
 * Cap: 12 total items per roundup to prevent one digest from dominating synthesis.
 */

import { routedLLM }             from "../../llm/llmRouter.js";
import { callLLM }               from "../../llm/callLLM.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";
import { EVIDENCE_VERSION }      from "./extractEvidence.js";
import { isValidTag, isValidSubTech } from "../understand/taxonomy.js";

const _segmentPrompt = loadPrompt("extraction/extract-evidence-roundup");
const SEG_SYS        = _segmentPrompt.system;
const SEG_USR_TPL    = _segmentPrompt.user;

// Reuse the generic system prompt for per-segment extraction.
const STD_SYS = loadPrompt("extraction/extract-evidence-news").system;

const ROUNDUP_ITEM_CAP = 12;
const EVIDENCE_TYPES   = ["incident","capability_demonstration","research_finding","vulnerability",
                          "threat_actor_activity","statistical_measurement","expert_assessment","policy_or_standard"];
const VALID_EPISTEMIC  = ["observed_fact","author_analysis","forecast","inference","marketing_claim"];

function citationTitle(source) {
  return source.intelligence?.report_finding?.parent_report_title || source.title;
}

function verifyQuote(quote, text) {
  if (!quote || quote.length < 15) return false;
  const needle = quote.slice(0, 80).toLowerCase().replace(/\s+/g, " ").trim();
  return text.toLowerCase().includes(needle);
}

function verifyNumberInSource(value, sourceText) {
  const digits = (String(value || "").match(/\d[\d,.]*/) || [])[0];
  if (!digits) return true;
  const core = digits.replace(/[.,]+$/, "");
  const hay  = String(sourceText || "");
  return hay.includes(core) || hay.includes(core.replace(/,/g, ""));
}

function normaliseSegmentItems(raw, source, segment, startIdx) {
  const items = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.evidence_items) ? raw.evidence_items : []);
  // Always verify quotes against the full source text — it is the authoritative ground truth.
  // The segment text may be condensed by the segmentation LLM, causing verbatim quotes
  // from the original to fail verification and be incorrectly marked quote_grounded=false.
  const sourceText = source.full_text || segment.story_text || "";

  return items
    .filter(ei => ei?.fact && ei.fact.length > 10)
    .map((ei, i) => {
      const quote = String(ei.quote || "").slice(0, 300);
      const modelGrounded = Boolean(ei.quote_grounded);
      const verified = modelGrounded ? verifyQuote(quote, sourceText) : false;

      return {
        evidence_id:    `ev-${source.id.slice(0, 8)}-${startIdx + i + 1}`,
        source_id:      source.id,
        source_title:   citationTitle(source),
        source_url:     source.url,
        publisher:      source.publisher || "",
        source_type:    source.source_type,
        trust_tier:     source.trust_tier,
        category:       source.category || source.main_category,
        source_family:  "roundup_digest",
        fact:           String(ei.fact || "").slice(0, 500),
        quote,
        quote_grounded:  verified,
        evidence_type:   EVIDENCE_TYPES.includes(ei.evidence_type) ? ei.evidence_type : "expert_assessment",
        specificity:     ["high","medium","low"].includes(ei.specificity) ? ei.specificity : "low",
        numbers:         (ei.numbers || []).filter(n => n?.value && n?.context).slice(0, 4)
                           .map(n => ({ ...n, grounded: verifyNumberInSource(n.value, sourceText) })),
        technique_tags:  (ei.technique_tags || []).filter(t => isValidTag(t) || isValidSubTech(t)),
        // Tag the parent digest + story title in entities for traceability.
        entities:        [
          ...(ei.entities || []).slice(0, 8),
          segment.story_title ? `[story: ${segment.story_title.slice(0, 60)}]` : null,
        ].filter(Boolean),
        event_date:      segment.story_date || ei.event_date || null,
        time_basis:      segment.story_date ? "event_date"
                           : (["event_date","publication_date","unknown"].includes(ei.time_basis)
                               ? ei.time_basis : "unknown"),
        within_reporting_window: ei.within_reporting_window ?? null,
        claim_epistemic_type: VALID_EPISTEMIC.includes(ei.claim_epistemic_type)
          ? ei.claim_epistemic_type : "observed_fact",
        claim_origin: "secondary_report",
        _evidence_version: EVIDENCE_VERSION,
        _from_roundup_segment: true,
      };
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {object} source - Post-understand source object (source_family=roundup_digest)
 * @param {object} [opts]
 * @returns {Promise<object[]>} Evidence items (capped at ROUNDUP_ITEM_CAP)
 */
export async function extractRoundupEvidence(source, opts = {}) {
  if (opts.skipLlm) return [];

  const text = (source.full_text || source.clean_text || "").slice(0, 12000);

  // ── Pass 1: Segmentation ──────────────────────────────────────────────────
  const segUsr = interpolate(SEG_USR_TPL, {
    title:            source.title || "",
    publisher:        source.publisher || "",
    publication_date: source.date_published || "unknown",
    text,
  });

  let segments = [];
  try {
    let raw;
    try {
      const { result } = await routedLLM(SEG_SYS, segUsr, {
        task: "evidence_extraction",
        requires_json: true,
      });
      raw = typeof result === "string" ? JSON.parse(result) : result;
    } catch {
      const t = await callLLM(SEG_SYS, segUsr, { json: true });
      raw = typeof t === "string" ? JSON.parse(t) : t;
    }
    segments = Array.isArray(raw?.segments) ? raw.segments.slice(0, 15) : [];
  } catch {
    // Segmentation failed — fall back to treating the full text as one segment.
    segments = [{ story_title: source.title, story_date: null, story_text: text.slice(0, 4000) }];
  }

  if (segments.length === 0) return [];

  // ── Pass 2: Per-segment extraction ───────────────────────────────────────
  const windowHint = opts.windowStart && opts.windowEnd
    ? `\nREPORTING WINDOW: ${opts.windowStart} to ${opts.windowEnd}` : "";

  const allItems = [];
  for (const seg of segments) {
    if (allItems.length >= ROUNDUP_ITEM_CAP) break;

    const segText = String(seg.story_text || "").slice(0, 3000);
    if (segText.length < 50) continue;

    const segTags = (source.primary_tags || source.tags || []).join(", ");
    const segUsr2 = `Extract evidence items from this story excerpt:

STORY: ${seg.story_title || "(untitled)"}
DATE: ${seg.story_date || "unknown"}
PARENT SOURCE: ${source.title} (${source.publisher || ""})
SOURCE_TYPE: ${source.source_type}
CATEGORY: ${source.category || source.main_category}
TAGS: ${segTags}${windowHint}

TEXT:
${segText}

Extract 1-3 discrete evidence items. Each item must have a real quote from the text above.`;

    try {
      let raw;
      try {
        const { result } = await routedLLM(STD_SYS, segUsr2, {
          task: "evidence_extraction",
          requires_json: true,
        });
        raw = typeof result === "string" ? JSON.parse(result) : result;
      } catch {
        const t = await callLLM(STD_SYS, segUsr2, { json: true });
        raw = typeof t === "string" ? JSON.parse(t) : t;
      }
      const items = normaliseSegmentItems(raw, source, seg, allItems.length);
      allItems.push(...items);
    } catch {
      // Skip this segment on LLM failure.
    }
  }

  return allItems.slice(0, ROUNDUP_ITEM_CAP);
}
