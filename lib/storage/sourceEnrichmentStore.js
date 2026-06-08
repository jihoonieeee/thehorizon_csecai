/**
 * Source enrichment persistence — write Layer 4 (understanding) + Layer 6
 * (category classification) results back to the Supabase `sources` table.
 *
 * Layer 4 (understand) sets: source_type, intelligence (taxonomy payload),
 *   taxonomy version stamp, claim_extraction_status.
 * Layer 6 (classify) sets: main_category, category_confidence, category_reason.
 *
 * Uses UPDATE (not upsert) so enrichment refreshes existing rows without
 * touching ingestion-owned identity/content fields.
 *
 * ── RESILIENCE ────────────────────────────────────────────────────────────────
 * The DB schema has drifted across pipeline versions. Some columns this code
 * would like to write may not exist yet (migration not applied). Rather than
 * disabling ALL enrichment on the first missing-column error (the old behaviour,
 * which silently dropped intelligence + main_category), we now strip the
 * offending columns and retry, so every column that DOES exist still gets saved.
 *
 * Historical bug: this module used to write `understand_version`, a column that
 * was never created (000_schema.sql (section 4) unapplied). The first UPDATE failed
 * with 42703 and set a module flag that stopped all subsequent writes — so no
 * intelligence or main_category was ever persisted in the analysis phase. The
 * version stamp now targets `claim_extraction_version`, which exists, and the
 * per-column fallback prevents one missing column from blocking the rest.
 */

import { supabase } from "./supabaseClient.js";
import { TAXONOMY_VERSION } from "../pipeline/understand/understandSources.js";

const BATCH_SIZE = 50;

// Columns known to vary by migration state. If the DB rejects one of these we
// drop it and retry rather than abandoning the whole write.
const OPTIONAL_COLUMNS = new Set([
  "claim_extraction_version",
  "category_confidence",
  "category_reason",
  "relevance_tier",
  "ai_specificity_score",
]);

// Columns proven missing this session — skipped pre-emptively on later rows.
const knownMissing = new Set();

/**
 * Build the enrichment UPDATE payload from a processed source.
 * Only includes fields the analysis phase actually (re)computes.
 */
function buildEnrichmentRow(source) {
  // "success" must mean the LLM ACTUALLY ran — not that a deterministic fallback
  // stamped taxonomy_version. The fallback in understandSource.js sets
  // taxonomy_version=TAXONOMY_VERSION even with llm_used:false; treating that as
  // success poisons the backlog (the row is then skipped on every real re-run).
  // Gate on understanding.llm_used so fallback rows stay claim_extraction_status=null
  // and get re-enriched once real quota is available.
  const llmRan   = source.understanding?.llm_used === true;
  const taxoDone = llmRan && (source.taxonomy_version === TAXONOMY_VERSION ||
                              source.understand_version === TAXONOMY_VERSION);

  const row = {
    // Layer 4 — understanding
    source_type:             source.source_type   || null,
    intelligence:            source.understanding || null,
    claim_extraction_status: taxoDone ? "success" : null,
    claim_extraction_version: llmRan ? (source.taxonomy_version || source.understand_version || null) : null,

    // Layer 6 — classification
    main_category:           source.main_category || null,
    category_confidence:     source.category_confidence || null,
    category_reason:         source.category_reason || null,

    // Layer 3 signals carried on the source (refresh fresh values when present)
    relevance_tier:          source.relevance_tier || null,
    ai_specificity_score:    typeof source.ai_specificity_score === "number"
      ? source.ai_specificity_score : null,
  };

  // Drop nulls so we never overwrite a populated column with null.
  for (const k of Object.keys(row)) {
    if (row[k] === null || row[k] === undefined) delete row[k];
    if (knownMissing.has(k)) delete row[k];
  }
  return row;
}

/**
 * UPDATE one source, stripping columns the DB reports as missing (42703) and
 * retrying, so partial schemas still persist everything they can.
 *
 * @returns {Promise<boolean>} true if any column was written
 */
// Missing-column errors differ by backend:
//   42703    — Postgres "column does not exist"
//   PGRST204 — PostgREST "could not find the 'X' column ... in the schema cache"
function isMissingColumnError(error) {
  return error.code === "42703" || error.code === "PGRST204";
}

async function updateWithColumnFallback(id, row) {
  let payload = { ...row };

  for (let attempt = 0; attempt < 8; attempt++) {
    if (Object.keys(payload).length === 0) return false;

    const { error } = await supabase.from("sources").update(payload).eq("id", id);
    if (!error) return true;

    if (isMissingColumnError(error)) {
      // Identify the missing column from the error message and drop it.
      const missing = [...OPTIONAL_COLUMNS].find((c) =>
        (error.message || "").includes(c)
      );
      if (missing) {
        knownMissing.add(missing);
        delete payload[missing];
        continue;
      }
      // Unknown missing column — drop all optional columns and retry once.
      for (const c of OPTIONAL_COLUMNS) { knownMissing.add(c); delete payload[c]; }
      continue;
    }
    throw error;
  }
  return false;
}

/**
 * Persist Layer 4 + 6 enrichment results for a batch of sources.
 *
 * Writes any source that has been enriched (taxonomy stamp present) or
 * classified (main_category present) and has a valid id.
 *
 * @param {object[]} sources - Output of understandSources() → classifySources().
 * @returns {Promise<{ updated: number, skipped: number }>}
 */
export async function persistUnderstandResults(sources) {
  const enriched = sources.filter((s) =>
    s.id && (
      s.taxonomy_version === TAXONOMY_VERSION ||
      s.understand_version === TAXONOMY_VERSION ||
      s.main_category
    )
  );

  if (enriched.length === 0) {
    return { updated: 0, skipped: sources.length };
  }

  let updated = 0;

  for (let i = 0; i < enriched.length; i += BATCH_SIZE) {
    const batch = enriched.slice(i, i + BATCH_SIZE);
    for (const source of batch) {
      const row = buildEnrichmentRow(source);
      if (Object.keys(row).length === 0) continue;
      const wrote = await updateWithColumnFallback(source.id, row);
      if (wrote) updated++;
    }
  }

  if (knownMissing.size > 0) {
    console.warn(
      `sourceEnrichmentStore: skipped missing columns [${[...knownMissing].join(", ")}] — ` +
      `apply docs/migrations/000_schema.sql to enable them`
    );
  }

  return { updated, skipped: sources.length - updated };
}
