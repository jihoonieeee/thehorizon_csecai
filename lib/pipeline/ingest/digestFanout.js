/**
 * digestFanout.js — split multi-topic reports into per-item child sources.
 *
 * The classifier assigns exactly ONE mechanism → ONE category → ONE summary per
 * source (understandSource.normalise). That is correct for a source that reports
 * a SINGLE thing, but wrong for a DIGEST: a weekly threat-intel bulletin, a
 * "N incidents this month" roundup, or a newsletter routinely covers several
 * distinct threats spanning several categories. Single-classification collapses
 * such a source to its one "dominant" item and silently drops the rest — e.g. a
 * Check Point weekly whose Gemini-phishing-as-a-service item (ai_enabled) is lost
 * because the whole report was tagged LLM01/LLM02 for a Claude Code injection.
 *
 * This module fans a digest out into CHILD sub-sources, one per extracted item,
 * each classified independently through the SAME deterministic mapToTaxonomy path
 * (via normalise). Children carry parent_source_id back to the digest for
 * provenance; the parent stays as a container flagged is_digest.
 *
 * Flow:
 *   detectDigest(source)        — cheap heuristic gate (no LLM)
 *   extractDigestItems(source)  — ONE LLM call → array of item mechanism-records
 *   buildChildSources(parent, items) — deterministic: normalise() each item
 *   fanOutDigest(source, opts)  — the three composed
 *
 * Injectable llmFn keeps extraction unit-testable without a network call.
 */

import { normalise }                 from "../understand/understandSource.js";
import { computeImportance }          from "../scoring/importance.js";
import {
  SECURITY_PROPERTIES, EXPLOIT_MECHANISMS, CONSEQUENCES, AFFECTED_LAYERS,
  EVIDENCE_ROLES, buildMechanismPromptBlock,
} from "../understand/mechanism.js";

// ── Detection ────────────────────────────────────────────────────────────────

// Title/section markers that reliably indicate a multi-topic roundup. Kept
// conservative — a false negative just means the source classifies as today
// (one category); a false positive would spend one wasted LLM call.
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
].join("|"), "i");

/**
 * Decide whether a source is a multi-topic digest worth fanning out.
 * @returns {{ is_digest: boolean, reason: string|null }}
 */
export function detectDigest(source = {}) {
  // Explicit flag wins (set by an analyst, an earlier pass, or an LLM hint).
  if (source?.intelligence?.is_digest === true || source?.is_digest === true) {
    return { is_digest: true, reason: "explicit_flag" };
  }
  const title = String(source.title || "");
  if (DIGEST_TITLE_RE.test(title)) {
    return { is_digest: true, reason: "title_pattern" };
  }
  return { is_digest: false, reason: null };
}

// ── Extraction (LLM) ─────────────────────────────────────────────────────────

export const DIGEST_ITEM_SCHEMA = {
  type: "object",
  properties: {
    is_digest: { type: "boolean" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item_title:   { type: "string" },
          item_summary: { type: "string" },
          primary_security_property: { type: "string", enum: SECURITY_PROPERTIES },
          primary_exploit_mechanism: { type: "string", enum: EXPLOIT_MECHANISMS },
          primary_consequence:       { type: "string", enum: CONSEQUENCES },
          affected_layer:            { type: "string", enum: AFFECTED_LAYERS },
          mechanism_evidence_role:   { type: "string", enum: EVIDENCE_ROLES },
          target_is_llm:             { type: "boolean" },
          ai_enabled_overlay:        { type: "boolean" },
          is_defensive:              { type: "boolean" },
          key_entities:              { type: "array", items: { type: "string" } },
        },
        required: ["item_title", "item_summary", "primary_exploit_mechanism", "primary_consequence"],
      },
    },
  },
  required: ["is_digest", "items"],
};

export function buildDigestSystemPrompt() {
  return `You are decomposing a MULTI-TOPIC cybersecurity report into its distinct items.

The report (a weekly bulletin / roundup / newsletter) covers SEVERAL unrelated threats. Split it into one entry per DISTINCT threat, incident, vulnerability, or campaign. Keep ONLY items that concern AI/ML security (attacks on or using AI systems); DROP purely non-AI items (generic breaches, non-AI CVEs, business news).

For EACH kept item, emit the mechanism fields below so it can be classified independently — exactly as if it were its own source.

${buildMechanismPromptBlock()}

Also give item_title (short, specific) and item_summary (2-3 sentences, self-contained). If the source is NOT actually a multi-topic digest (it really reports one thing), return is_digest=false and an empty items array.`;
}

function buildDigestUserPrompt(source) {
  const body = (source.full_text || source.clean_text || source.summary || "").slice(0, 12000);
  return `TITLE: ${source.title || "(untitled)"}
PUBLISHER: ${source.publisher || "unknown"}
URL: ${source.url || ""}

REPORT TEXT:
${body}

Return JSON per the schema: is_digest, items[] (one per distinct AI-security item).`;
}

/**
 * Extract the distinct items from a digest via one LLM call.
 * @param {object} source
 * @param {object} [opts]
 * @param {Function} [opts.llmFn]  async (sys, usr, {schema,json}) => object|string
 * @returns {Promise<{is_digest:boolean, items:object[]}>}
 */
export async function extractDigestItems(source, opts = {}) {
  const llmFn = opts.llmFn;
  if (typeof llmFn !== "function") {
    throw new Error("extractDigestItems requires opts.llmFn (inject callLLM in production, a fake in tests)");
  }
  const sys = buildDigestSystemPrompt();
  const usr = buildDigestUserPrompt(source);
  const rawOut = await llmFn(sys, usr, { schema: DIGEST_ITEM_SCHEMA, json: true });
  const parsed = typeof rawOut === "string" ? JSON.parse(rawOut) : rawOut;
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  return { is_digest: parsed?.is_digest === true && items.length > 0, items };
}

// ── Child-source construction (deterministic) ─────────────────────────────────

/**
 * Turn extracted items into fully-classified child source rows. Each item is run
 * through the SAME normalise() path as a live source, so its category/tags are
 * assigned by the identical deterministic mapToTaxonomy table.
 *
 * @param {object} parent  — the digest source row
 * @param {object[]} items — extractDigestItems().items
 * @param {object} [opts]
 * @param {string} [opts.scoredAt]  — ISO timestamp for importance.scored_at (pass one; Date.now is avoided upstream)
 * @returns {object[]} child rows ready to upsert
 */
export function buildChildSources(parent, items, opts = {}) {
  const scoredAt = opts.scoredAt || null;
  return (items || []).map((it, i) => {
    const childId = `${parent.id}-i${i + 1}`;
    const raw = {
      relevant: true,
      scope: "offensive_finding",
      primary_security_property: it.primary_security_property,
      primary_exploit_mechanism: it.primary_exploit_mechanism,
      primary_consequence:       it.primary_consequence,
      affected_layer:            it.affected_layer,
      mechanism_evidence_role:   it.mechanism_evidence_role,
      target_is_llm:             it.target_is_llm === true,
      ai_enabled_overlay:        it.ai_enabled_overlay === true,
      is_defensive:              it.is_defensive === true,
      source_type:               parent.source_type || "threat_intelligence",
      trust_tier:                parent.trust_tier || "unknown",
      short_summary:             it.item_summary || "",
      key_entities:              Array.isArray(it.key_entities) ? it.key_entities : [],
    };
    const childStub = {
      id: childId,
      title: it.item_title,
      url: parent.url,
      publisher: parent.publisher,
      date_published: parent.date_published,
      full_text: it.item_summary || "",
    };
    const norm = normalise(raw, childStub);
    const importance = { ...computeImportance(norm), ...(scoredAt ? { scored_at: scoredAt } : {}) };

    return {
      id: childId,
      parent_source_id: parent.id,
      title: it.item_title,
      url: parent.url,
      publisher: parent.publisher,
      date_published: parent.date_published,
      main_category: norm.category,
      tags: norm.primary_tags || [],
      source_type: norm.source_type,
      trust_tier: norm.trust_tier,
      short_summary: norm.short_summary || it.item_summary || null,
      summary: it.item_summary || null,
      full_text: it.item_summary || null,
      validation_status: norm.keep ? (norm.disposition === "adjacent" ? "review" : "pass") : "reject",
      layer3_status:     norm.keep ? (norm.disposition === "adjacent" ? "review" : "pass") : "reject",
      relevance_tier:    norm.disposition === "offensive" ? "core" : norm.disposition === "adjacent" ? "adjacent" : "off_topic",
      intelligence: {
        is_defensive: norm.is_defensive || false,
        defended_category: norm.defended_category || null,
        mechanism_classification: norm.mechanism_classification || null,
        importance,
        derived_from_digest: parent.id,
      },
      // not persisted; handy for tests/callers
      _norm: norm,
    };
  });
}

// ── Composed entry point ──────────────────────────────────────────────────────

/**
 * Detect + extract + build children for one source.
 * @returns {Promise<{is_digest:boolean, reason:string|null, children:object[], parent_patch:object|null}>}
 */
export async function fanOutDigest(source, opts = {}) {
  const det = detectDigest(source);
  if (!det.is_digest) return { is_digest: false, reason: null, children: [], parent_patch: null };

  const { is_digest, items } = await extractDigestItems(source, opts);
  if (!is_digest) return { is_digest: false, reason: `${det.reason}_but_llm_single`, children: [], parent_patch: null };

  const children = buildChildSources(source, items, opts).filter(c => c.validation_status !== "reject");
  return {
    is_digest: true,
    reason: det.reason,
    children,
    parent_patch: { intelligence: { ...(source.intelligence || {}), is_digest: true, digest_item_count: children.length } },
  };
}
