/**
 * digestFanout.js — split multi-topic reports into per-item child sources.
 *
 * The classifier assigns exactly ONE category + tag + summary per source
 * (understandSource.normalise). That is correct for a source that reports
 * a SINGLE thing, but wrong for a DIGEST: a weekly threat-intel bulletin, a
 * "N incidents this month" roundup, or a newsletter routinely covers several
 * distinct threats spanning several categories. Single-classification collapses
 * such a source to its one "dominant" item and silently drops the rest — e.g. a
 * Check Point weekly whose Gemini-phishing-as-a-service item (ai_enabled) is lost
 * because the whole report was tagged LLM01/LLM02 for a Claude Code injection.
 *
 * This module fans a digest out into CHILD sub-sources, one per extracted item,
 * each carrying its own LLM-assigned main_category + primary_tag (validated by
 * normalise). Children carry parent_source_id back to the digest for provenance;
 * the parent stays as a container flagged is_digest.
 *
 * Flow:
 *   detectDigest(source)        — cheap heuristic gate (no LLM)
 *   extractDigestItems(source)  — ONE LLM call → array of items w/ taxonomy assigned
 *   buildChildSources(parent, items) — deterministic: normalise() each item
 *   fanOutDigest(source, opts)  — the three composed
 *
 * Injectable llmFn keeps extraction unit-testable without a network call.
 */

import { normalise }                 from "../understand/understandSource.js";
import { detectDigest }             from "./detectDigest.js";
import { DOMAINS, buildTaxonomyPromptBlock } from "../understand/taxonomy.js";
import { loadPrompt, interpolate } from "../../prompts/promptLoader.js";

// ── Detection ────────────────────────────────────────────────────────────────
// detectDigest() is imported from ./detectDigest.js (shared with understandSource.js).
// Re-export it so existing callers that import from digestFanout still work.
export { detectDigest } from "./detectDigest.js";

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
          main_category:      { type: "string", enum: DOMAINS },
          primary_tag:        { type: "string" },
          secondary_tags:     { type: "array", items: { type: "string" } },
          boundary_rationale: { type: "string" },
          ai_enabled_overlay:        { type: "boolean" },
          is_defensive:              { type: "boolean" },
          key_entities:              { type: "array", items: { type: "string" } },
          // Structured finding fields (surfaced per finding; provenance to the parent report)
          named_incidents: { type: "array", items: { type: "string" } },
          named_cves:      { type: "array", items: { type: "string" } },
          named_products:  { type: "array", items: { type: "string" } },
          actor:           { type: "string" },   // threat actor / group, if any
          timeframe:       { type: "string" },   // date or period the finding refers to
          supporting_quote:{ type: "string" },   // verbatim span from the report
          section_ref:     { type: "string" },   // page / section reference
        },
        required: ["item_title", "item_summary", "main_category", "primary_tag"],
      },
    },
  },
  required: ["is_digest", "items"],
};

// System prompt lives in lib/prompts/ingest/digest-decompose.md (edit prose there).
// The taxonomy tag list is injected from config at runtime.
export function buildDigestSystemPrompt() {
  return interpolate(loadPrompt("ingest/digest-decompose").system, {
    taxonomyBlock: buildTaxonomyPromptBlock(),
  });
}

function buildDigestUserPrompt(source, bodyText, chunkInfo) {
  const body = String(bodyText || "");
  const chunkNote = chunkInfo
    ? `\n(This is part ${chunkInfo.i + 1} of ${chunkInfo.n} of a long report — extract the findings in THIS part; other parts are handled separately.)`
    : "";
  return `TITLE: ${source.title || "(untitled)"}
PUBLISHER: ${source.publisher || "unknown"}
URL: ${source.url || ""}${chunkNote}

REPORT TEXT:
${body}

Return JSON per the schema: is_digest, items[] (one per distinct AI-security finding).`;
}

// Split a long report into overlapping windows so the LLM sees the WHOLE document
// (a 40-page report has far more findings than one 12k-char call can surface).
function chunkText(text, size, overlap = 1500) {
  const t = String(text || "");
  if (t.length <= size) return [t];
  const chunks = [];
  for (let start = 0; start < t.length; start += (size - overlap)) {
    chunks.push(t.slice(start, start + size));
    if (start + size >= t.length) break;
  }
  return chunks;
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
  const CHUNK = opts.chunkChars || 40000;   // per-call window; reports > this are chunked

  // Prefer the FULL document text (opts.fullText, fetched uncapped for reports) over
  // the stored, truncated full_text — a 40-page report yields far more findings.
  let text = String(opts.fullText || source.full_text || source.clean_text || source.summary || "");
  if (opts.fetchFullText && typeof opts.fetchFullText === "function" && text.length < 20000 && source.url) {
    try {
      const fetched = await opts.fetchFullText(source.url);
      if (fetched && fetched.length > text.length) text = fetched;
    } catch { /* keep stored text on fetch failure */ }
  }

  const sys = buildDigestSystemPrompt();
  // Cap total chunks (cost control): a huge report is covered by the first N windows
  // rather than an unbounded number of calls. Findings cluster in the body anyway.
  const maxChunks = opts.maxChunks || 6;
  const chunks = chunkText(text, CHUNK).slice(0, maxChunks);

  // Extract per chunk, then merge + dedupe findings by title (chunks overlap).
  const all = [];
  let anyDigest = false;
  for (let i = 0; i < chunks.length; i++) {
    const usr = buildDigestUserPrompt(source, chunks[i], chunks.length > 1 ? { i, n: chunks.length } : null);
    let parsed;
    try {
      const rawOut = await llmFn(sys, usr, { schema: DIGEST_ITEM_SCHEMA, json: true });
      parsed = typeof rawOut === "string" ? JSON.parse(rawOut) : rawOut;
    } catch { continue; }
    if (parsed?.is_digest === true) anyDigest = true;
    for (const it of (Array.isArray(parsed?.items) ? parsed.items : [])) all.push(it);
  }

  const seen = new Set();
  const items = all.filter(it => {
    const key = String(it.item_title || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { is_digest: (anyDigest || items.length > 1) && items.length > 0, items, chunks: chunks.length, text_chars: text.length };
}

// ── Child-source construction (deterministic) ─────────────────────────────────

/**
 * Turn extracted items into fully-classified child source rows. Each item is run
 * through the SAME normalise() path as a live source, which validates the item's
 * LLM-assigned main_category + primary_tag against the taxonomy registry.
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
    // Each digest item is extracted with its taxonomy already assigned by the LLM
    // (main_category + primary_tag); normalise() validates it against the registry.
    const raw = {
      relevant: true,
      scope: "offensive_finding",
      main_category:             it.main_category,
      primary_tag:               it.primary_tag,
      secondary_tags:            Array.isArray(it.secondary_tags) ? it.secondary_tags : [],
      boundary_rationale:        it.boundary_rationale || "",
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

    return {
      id: childId,
      parent_source_id: parent.id,
      title: `${parent.title} [${it.item_title}]`,
      parent_title: parent.title,
      url: parent.url,
      publisher: parent.publisher,
      date_published: parent.date_published,
      // Classification fields are intentionally left null — understandAllSources
      // will classify each child with the full classify.md prompt and taxonomy rules
      // immediately after fanout. Fanout extracts the finding; understand taxonomises it.
      main_category: null,
      tags: [],
      source_type: null,
      trust_tier: parent.trust_tier || "unknown",
      short_summary: null,
      summary: it.item_summary || null,
      // full_text includes the supporting_quote so Layer 5 can verify it verbatim.
      // item_summary alone is too short (< 150 chars) and has no quotable text.
      // The quote verification in extractEvidence checks the first 80 chars against
      // this full_text; having the original span here makes quote_grounded=true possible.
      full_text: [it.item_summary, it.supporting_quote ? `"${it.supporting_quote}"` : null]
        .filter(Boolean).join("\n\n") || null,
      validation_status: null,
      layer3_status: null,
      intelligence: {
        // Provenance — preserved through the understand write-back (see understandAllSources).
        derived_from_digest: parent.id,
        report_finding: {
          parent_report_id: parent.id,
          parent_report_title: parent.title || null,
          finding_title: it.item_title || null,
          named_incidents: Array.isArray(it.named_incidents) ? it.named_incidents.slice(0, 10) : [],
          named_cves:      Array.isArray(it.named_cves) ? it.named_cves.slice(0, 10) : [],
          named_products:  Array.isArray(it.named_products) ? it.named_products.slice(0, 10) : [],
          actor:           it.actor || null,
          timeframe:       it.timeframe || null,
          supporting_quote: it.supporting_quote ? String(it.supporting_quote).slice(0, 400) : null,
          section_ref:     it.section_ref || null,
          reading_value: ["essential", "recommended", "analyst", "background"].includes(it.reading_value) ? it.reading_value : null,
        },
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

  const children = buildChildSources(source, items, opts)
    .filter(c => c.validation_status !== "reject")
    .map(({ _norm, ...row }) => row);  // _norm is in-memory only; strip before any DB upsert
  return {
    is_digest: true,
    reason: det.reason,
    children,
    parent_patch: { intelligence: { ...(source.intelligence || {}), is_digest: true, digest_item_count: children.length } },
  };
}
