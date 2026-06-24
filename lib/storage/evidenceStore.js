/**
 * evidenceStore.js — persistence for per-source extracted evidence (Layer 5).
 *
 * Evidence is cached in the `evidence` table (migration 011) keyed by source_id
 * and a content hash of the source's full_text. This lets the ingestion loop
 * extract evidence once per source and lets deck runs reuse it instead of
 * re-extracting every time.
 *
 * All functions degrade gracefully if the table is missing (pre-migration):
 * reads return empty, writes log a warning and no-op, so the pipeline still runs
 * (falling back to in-memory extraction).
 */

import { createHash } from "crypto";

export const EVIDENCE_TABLE = "evidence";

/** Stable content hash of a source's text — changes only when full_text changes. */
export function contentHashOf(text) {
  return createHash("sha256").update(String(text || "")).digest("hex").slice(0, 32);
}

// ── shape mapping ──────────────────────────────────────────────────────────────

function itemToRow(item, contentHash) {
  return {
    id:               `${item.source_id}__${item.evidence_id}`,
    source_id:        item.source_id,
    evidence_id:      item.evidence_id,
    content_hash:     contentHash,
    source_url:       item.source_url || null,
    source_title:     item.source_title || null,
    publisher:        item.publisher || null,
    source_type:      item.source_type || null,
    trust_tier:       item.trust_tier || null,
    category:         item.category || null,
    fact:             item.fact || null,
    quote:            item.quote || null,
    quote_grounded:   !!item.quote_grounded,
    evidence_type:    item.evidence_type || null,
    specificity:      item.specificity || null,
    numbers:          item.numbers || [],
    technique_tags:   item.technique_tags || [],
    entities:         item.entities || [],
    evidence_version: item._evidence_version || null,
  };
}

function rowToItem(row) {
  return {
    evidence_id:    row.evidence_id,
    source_id:      row.source_id,
    source_title:   row.source_title,
    source_url:     row.source_url,
    publisher:      row.publisher || "",
    source_type:    row.source_type,
    trust_tier:     row.trust_tier,
    category:       row.category,
    fact:           row.fact,
    quote:          row.quote,
    quote_grounded: row.quote_grounded,
    evidence_type:  row.evidence_type,
    specificity:    row.specificity,
    numbers:        row.numbers || [],
    technique_tags: row.technique_tags || [],
    entities:       row.entities || [],
    _evidence_version: row.evidence_version,
  };
}

// ── reads ───────────────────────────────────────────────────────────────────────

/**
 * Map of source_id → content_hash for sources that already have cached evidence.
 * Used to decide which sources need (re)extraction.
 */
export async function getEvidenceHashes(supabase, sourceIds) {
  const out = new Map();
  if (!supabase || !sourceIds?.length) return out;
  try {
    for (let i = 0; i < sourceIds.length; i += 300) {
      const { data, error } = await supabase
        .from(EVIDENCE_TABLE)
        .select("source_id, content_hash")
        .in("source_id", sourceIds.slice(i, i + 300));
      if (error) throw error;
      for (const r of (data || [])) out.set(r.source_id, r.content_hash);
    }
  } catch (err) {
    console.warn(`  [evidenceStore] hash read skipped: ${err.message}`);
  }
  return out;
}

/** Load all cached evidence items for the given source ids (evidence-item shape). */
export async function loadEvidence(supabase, sourceIds) {
  const items = [];
  if (!supabase || !sourceIds?.length) return items;
  try {
    for (let i = 0; i < sourceIds.length; i += 300) {
      const { data, error } = await supabase
        .from(EVIDENCE_TABLE)
        .select("*")
        .in("source_id", sourceIds.slice(i, i + 300));
      if (error) throw error;
      for (const r of (data || [])) {
        if (r.evidence_id === MARKER_ID) continue;   // "extracted, found nothing" sentinel
        items.push(rowToItem(r));
      }
    }
  } catch (err) {
    console.warn(`  [evidenceStore] load skipped: ${err.message}`);
  }
  return items;
}

// Sentinel evidence_id recorded when a source was extracted but yielded no items,
// so it isn't re-extracted on every cycle (its content_hash is still registered).
const MARKER_ID = "__none__";

// ── writes ──────────────────────────────────────────────────────────────────────

/**
 * Replace the cached evidence for one source: delete its existing rows and
 * insert the freshly-extracted items (tagged with contentHash). Passing an empty
 * items array records "extracted, found nothing" (clears stale rows) — but we
 * still stamp the hash via a marker is not needed; callers treat missing as stale.
 * @returns {Promise<boolean>} true if persisted.
 */
export async function saveSourceEvidence(supabase, sourceId, contentHash, items) {
  if (!supabase || !sourceId) return false;
  try {
    const del = await supabase.from(EVIDENCE_TABLE).delete().eq("source_id", sourceId);
    if (del.error) throw del.error;
    const rows = (items || []).map(it => itemToRow(it, contentHash));
    // Record a sentinel row when nothing was extracted, so the source's hash is
    // registered and it isn't re-extracted every cycle.
    if (!rows.length) {
      rows.push(itemToRow({ source_id: sourceId, evidence_id: MARKER_ID }, contentHash));
    }
    const ins = await supabase.from(EVIDENCE_TABLE).upsert(rows, { onConflict: "id" });
    if (ins.error) throw ins.error;
    return true;
  } catch (err) {
    console.warn(`  [evidenceStore] save skipped for ${sourceId}: ${err.message}`);
    return false;
  }
}
