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

// Encode _from_atlas_* boolean flags as a single atlas_origin text value.
function atlasOriginOf(item) {
  if (item._from_atlas_chain)     return "chain";
  if (item._from_chain_analysis)  return "chain_analysis";
  if (item._from_atlas_reference) return "reference";
  if (item._from_atlas_llm)       return "llm";
  return null;
}

function itemToRow(item, contentHash) {
  // Structured walkthrough fields — set by reportAnalysisToEvidence() when a source
  // has intelligence.report_analysis. Must be persisted so the cache path doesn't
  // silently degrade case study selection and dossier rendering on the second run.
  const hasWalkthrough = Array.isArray(item.walkthrough_steps) && item.walkthrough_steps.length > 0;
  const hasInsight     = !!item._report_insight;
  const ext = {};
  if (hasWalkthrough) {
    ext.walkthrough_actor     = item.walkthrough_actor     || null;
    ext.walkthrough_technique = item.walkthrough_technique || null;
    ext.walkthrough_mechanism = item.walkthrough_mechanism || null;
    ext.walkthrough_steps     = item.walkthrough_steps;
    ext.walkthrough_impact    = item.walkthrough_impact    || null;
    ext.from_report_analysis  = true;
  }
  if (hasInsight) {
    ext.report_insight        = true;
    ext.insight_finding       = item.insight_finding       || null;
    ext.insight_significance  = item.insight_significance  || null;
    ext.insight_taxonomy      = item.insight_taxonomy      || null;
    ext.from_report_analysis  = true;
  }
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
    // Temporal provenance triad:
    //   event_date       — when the described event occurred (LLM-extracted from source text)
    //   publication_date — when the source article was published (from source.date_published)
    //   extraction_date  — when Horizon ingested this row (= created_at, DB default)
    event_date:              item.event_date       || null,
    publication_date:        item.publication_date || null,
    time_basis:              item.time_basis        || null,
    within_reporting_window: item.within_reporting_window ?? null,
    // ATLAS provenance — persisted so cache round-trips preserve extraction metadata
    atlas_case_id:       item.atlas_case_id       || null,
    atlas_origin:        atlasOriginOf(item),
    cited_reference_url: item.cited_reference_url || null,
    reference_type:      item.reference_type      || null,
    // Source-aware extraction fields (migration 020)
    claim_epistemic_type: item.claim_epistemic_type || null,
    source_family:        item.source_family        || null,
    claim_origin:         item.claim_origin         || null,
    // Capability announcement
    landscape_change:     item.landscape_change === true ? true : null,
    // Academic paper
    claim_id:          item.claim_id        || null,
    supports_claim:    item.supports_claim  || null,
    paper_section:     item.paper_section   || null,
    relationships:     item.relationships?.length  ? item.relationships  : null,
    research_metadata: item.research_metadata      ? item.research_metadata : null,
    // Threat intel
    campaign_metadata: item.campaign_metadata      ? item.campaign_metadata : null,
    // Structured extension fields (walkthrough + report insight)
    ...ext,
  };
}

// Decode atlas_origin back into the boolean flag expected by downstream consumers.
function restoreAtlasOrigin(item, origin) {
  if (!origin) return;
  if (origin === "chain")          item._from_atlas_chain     = true;
  if (origin === "chain_analysis") item._from_chain_analysis  = true;
  if (origin === "reference")      item._from_atlas_reference = true;
  if (origin === "llm")            item._from_atlas_llm       = true;
}

function rowToItem(row) {
  const item = {
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
    _evidence_version:     row.evidence_version,
    // Temporal provenance triad
    event_date:              row.event_date              || null,
    publication_date:        row.publication_date        || null,
    time_basis:              row.time_basis              || null,
    within_reporting_window: row.within_reporting_window ?? null,
    // ATLAS provenance
    atlas_case_id:       row.atlas_case_id       || null,
    cited_reference_url: row.cited_reference_url || null,
    reference_type:      row.reference_type      || null,
    // Source-aware extraction fields (migration 020)
    claim_epistemic_type: row.claim_epistemic_type || null,
    source_family:        row.source_family        || null,
    claim_origin:         row.claim_origin         || null,
    landscape_change:     row.landscape_change     ?? null,
    claim_id:             row.claim_id             || null,
    supports_claim:       row.supports_claim       || null,
    paper_section:        row.paper_section        || null,
    relationships:        row.relationships        || null,
    research_metadata:    row.research_metadata    || null,
    campaign_metadata:    row.campaign_metadata    || null,
  };

  // Restore _from_atlas_* flags from the atlas_origin column.
  restoreAtlasOrigin(item, row.atlas_origin);

  // Restore structured walkthrough fields when present — these are set by
  // reportAnalysisToEvidence() and are critical for case study selection and
  // dossier rendering. Without them the cache path silently degrades quality.
  if (row.walkthrough_steps?.length) {
    item.walkthrough_actor     = row.walkthrough_actor     || null;
    item.walkthrough_technique = row.walkthrough_technique || null;
    item.walkthrough_mechanism = row.walkthrough_mechanism || null;
    item.walkthrough_steps     = row.walkthrough_steps;
    item.walkthrough_impact    = row.walkthrough_impact    || null;
    item._from_report_analysis = true;
  }
  if (row.report_insight) {
    item._report_insight       = true;
    item.insight_finding       = row.insight_finding       || null;
    item.insight_significance  = row.insight_significance  || null;
    item.insight_taxonomy      = row.insight_taxonomy      || null;
    item._from_report_analysis = true;
  }
  if (row.from_report_analysis && !item._from_report_analysis) {
    item._from_report_analysis = true;
  }

  return item;
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
    // Chunk size 50: the .limit(1000) is the real guard against silent truncation.
    // At ~5-20 items per source, 50 sources can produce up to 1000 rows (ATLAS
    // case studies can have 20+ items each). Keep chunks small so the limit is
    // never approached even in worst-case ATLAS-heavy batches.
    for (let i = 0; i < sourceIds.length; i += 50) {
      const { data, error } = await supabase
        .from(EVIDENCE_TABLE)
        .select("source_id, content_hash")
        .in("source_id", sourceIds.slice(i, i + 50))
        .limit(1000);
      if (data?.length >= 1000) console.warn(`  [evidenceStore] hash chunk hit 1000-row cap — reduce chunk size`);
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
    for (let i = 0; i < sourceIds.length; i += 200) {
      const { data, error } = await supabase
        .from(EVIDENCE_TABLE)
        .select("*")
        .in("source_id", sourceIds.slice(i, i + 200))
        .limit(2000);
      if (error) throw error;
      if (data?.length >= 2000) console.warn(`  [evidenceStore] load chunk hit 2000-row cap for ${sourceIds.slice(i, i + 200).length} sources`);
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
