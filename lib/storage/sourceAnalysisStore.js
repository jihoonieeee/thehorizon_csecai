/**
 * Analysis-phase evidence persistence — write the L3 verdict, L5A rawfact
 * evidence, and L5B analytics features back to the Supabase `sources` table.
 *
 * Without this, everything the analysis phase extracts (atomic rawfacts,
 * analytics tags, gate verdict) lives only inside the per-run deck blob and is
 * recomputed — at LLM cost — on every run, with no per-source traceability.
 *
 * Columns written (created by docs/migrations/000_schema.sql (section 5)):
 *   layer3_status, downstream_route          — L3 final gate
 *   rawfact_evidence (jsonb)                 — full evidence_items array
 *   rawfact_summary  (jsonb)                 — compact { priority, score, ... }
 *   rawfact_version                          — L5A version stamp
 *   analytics_features (jsonb)               — L5B feature tags
 *   analytics_version                        — L5B version stamp
 *
 * ── GRACEFUL DEGRADATION ──────────────────────────────────────────────────────
 * Matches the pattern used across the storage layer (decks, source_snapshots,
 * understand_version): if a column is missing (42703), it is stripped and the
 * write retried, so the pipeline runs whether or not the migration is applied.
 * If none of the new columns exist, persistence no-ops with a single warning.
 */

import { supabase } from "./supabaseClient.js";

const BATCH_SIZE = 50;

const OPTIONAL_COLUMNS = new Set([
  "layer3_status", "downstream_route",
  "rawfact_evidence", "rawfact_summary", "rawfact_version",
  "analytics_features", "analytics_version",
]);

const knownMissing = new Set();

// ── Row builder ────────────────────────────────────────────────────────────────

function buildRawfactSummary(source) {
  const items = source.evidence_items || [];
  if (items.length === 0 && !source.rawfact_evidence_summary) return null;

  const byStrength = (s) =>
    items.filter((i) => i.triage_data?.evidence_strength === s).length;

  return {
    strongest_strength: source.rawfact_evidence_summary?.strongest_strength || "archive",
    item_count:  items.length,
    strong:      byStrength("strong"),
    usable:      byStrength("usable"),
    context:     byStrength("context"),
    grounded:    items.filter((i) => i.quote_verified === true).length,
    atomic:      items.filter((i) => i.is_atomic === true).length,
    version:     source.rawfact_version || null,
  };
}

function buildAnalysisRow(source) {
  const row = {
    // L3 gate verdict
    layer3_status:     source.layer3_status    || null,
    downstream_route:  source.downstream_route || null,

    // L5A rawfact evidence
    rawfact_evidence:  Array.isArray(source.evidence_items) && source.evidence_items.length > 0
      ? source.evidence_items : null,
    rawfact_summary:   buildRawfactSummary(source),
    rawfact_version:   source.rawfact_version || null,

    // L5B analytics features
    analytics_features: source.analytics_features || null,
    analytics_version:  source.analytics_version  || null,
  };

  for (const k of Object.keys(row)) {
    if (row[k] === null || row[k] === undefined) delete row[k];
    if (knownMissing.has(k)) delete row[k];
  }
  return row;
}

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
      const missing = [...OPTIONAL_COLUMNS].find((c) => (error.message || "").includes(c));
      if (missing) { knownMissing.add(missing); delete payload[missing]; continue; }
      for (const c of OPTIONAL_COLUMNS) { knownMissing.add(c); delete payload[c]; }
      continue;
    }
    throw error;
  }
  return false;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Persist L3 + L5A + L5B analysis evidence for a batch of sources.
 *
 * @param {object[]} sources - feed_sources from runSynthesisLayer() (carry
 *   evidence_items, rawfact_score_data, analytics_features, layer3_status).
 * @returns {Promise<{ updated: number, skipped: number, persisted_columns: string[] }>}
 */
export async function persistAnalysisEvidence(sources) {
  const withEvidence = (sources || []).filter((s) =>
    s.id && (
      (s.evidence_items && s.evidence_items.length > 0) ||
      s.analytics_features || s.layer3_status
    )
  );

  if (withEvidence.length === 0) {
    return { updated: 0, skipped: (sources || []).length, persisted_columns: [] };
  }

  let updated = 0;
  for (let i = 0; i < withEvidence.length; i += BATCH_SIZE) {
    const batch = withEvidence.slice(i, i + BATCH_SIZE);
    for (const source of batch) {
      const row = buildAnalysisRow(source);
      if (Object.keys(row).length === 0) continue;
      try {
        const wrote = await updateWithColumnFallback(source.id, row);
        if (wrote) updated++;
      } catch (err) {
        console.warn(`sourceAnalysisStore: update failed for ${source.id}: ${err.message}`);
      }
    }
  }

  const persisted = [...OPTIONAL_COLUMNS].filter((c) => !knownMissing.has(c));
  if (knownMissing.size > 0) {
    console.warn(
      `sourceAnalysisStore: missing columns [${[...knownMissing].join(", ")}] — ` +
      `apply docs/migrations/000_schema.sql (section 5) to persist them`
    );
  }

  return { updated, skipped: (sources || []).length - updated, persisted_columns: persisted };
}
