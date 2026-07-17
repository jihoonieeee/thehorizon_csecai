/**
 * Web Discovery persistence — writes the web_discovery_candidates audit table
 * created by docs/migrations/000_schema.sql (section 9).
 *
 * Stores EVERY candidate (accepted or rejected) so rejected candidates are
 * retained for audit and never lost. Accepted
 * candidates additionally become rows in `sources` via the normal archive path.
 *
 * Graceful degradation: if the table is absent (42P01 / PGRST205) the writer
 * no-ops with a single warning, exactly like taxonomyStore/sourceAnalysisStore.
 */

import { supabase } from "./supabaseClient.js";

const knownMissingTables = new Set();

function isMissingTableError(error) {
  return error?.code === "42P01" || error?.code === "PGRST205" ||
    /relation .* does not exist|could not find the table/i.test(error?.message || "");
}

async function writeRows(table, rows, { onConflict } = {}) {
  if (knownMissingTables.has(table)) return { written: 0, skipped: rows.length };
  if (!rows.length) return { written: 0, skipped: 0 };

  let written = 0;
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) {
      if (isMissingTableError(error)) {
        knownMissingTables.add(table);
        console.warn(`discoveryStore: table '${table}' missing — apply docs/migrations/000_schema.sql to persist it`);
        return { written, skipped: rows.length - written };
      }
      console.warn(`discoveryStore: write to '${table}' failed: ${error.message}`);
      return { written, skipped: rows.length - written };
    }
    written += batch.length;
  }
  return { written, skipped: 0 };
}

function toRow(c, { snapshotId, runId } = {}) {
  return {
    candidate_id:               c.candidate_id,
    snapshot_id:                snapshotId ?? null,
    run_id:                     runId ?? null,
    source_id:                  c.source_id ?? null,
    source_origin:              c.source_origin ?? "web_discovery",
    discovery_mission:          c.discovery_mission ?? null,
    search_query:               c.search_query ?? null,
    search_query_family:        c.search_query_family ?? null,
    provider:                   c.provider ?? null,
    fetch_pending:              c.fetch_pending ?? null,
    opened_url:                 c.opened_url ?? null,
    opened_url_confirmed:       c.opened_url_confirmed ?? null,
    source_class:               c.source_class ?? null,
    title:                      c.title ?? null,
    publisher:                  c.publisher ?? null,
    published_date:             c.published_date ?? null,
    event_date:                 c.event_date ?? null,
    last_updated:               c.last_updated ?? null,
    candidate_claim:            c.candidate_claim ?? null,
    verbatim_quote:             c.verbatim_quote ?? null,
    quote_status:               c.quote_status ?? null,
    quote_verified:             c.quote_verified ?? null,
    quote_claim_match_status:   c.quote_claim_match_status ?? null,
    source_type_hint:           c.source_type_hint ?? null,
    trust_tier_hint:            c.trust_tier_hint ?? null,
    source_quality:             c.source_quality ?? null,
    freshness_status:           c.freshness_status ?? null,
    freshness_interpretation:   c.freshness_interpretation ?? null,
    ai_threat_specificity:      c.ai_threat_specificity ?? null,
    ai_threat_anchors:          c.ai_threat_anchors ?? null,
    novelty_assessment:         c.novelty_assessment ?? null,
    operationalization_stage:   c.operationalization_stage ?? null,
    early_signal_value:         c.early_signal_value ?? null,
    early_signal_type:          c.early_signal_type ?? null,
    early_signal_reason:        c.early_signal_reason ?? null,
    early_signal_qa_status:     c.early_signal_qa_status ?? null,
    corroboration_status:       c.corroboration_status ?? null,
    source_independence_status: c.source_independence_status ?? null,
    hallucination_risk:         c.hallucination_risk ?? null,
    duplicate_cluster_id:       c.duplicate_cluster_id ?? null,
    is_cluster_representative:  c.is_cluster_representative ?? null,
    duplicate_reason:           c.duplicate_reason ?? null,
    original_source_url:        c.original_source_url ?? null,
    route:                      c.route ?? null,
    route_reason:               c.route_reason ?? null,
    rejection_reason:           c.rejection_reason ?? null,
    taxonomy_hint:              c.taxonomy_hint ?? null,
    web_discovery_metadata:     c.web_discovery_metadata ?? null,
  };
}

/**
 * Persist all discovery candidates (accepted + audit) to the audit table.
 * @param {object[]} candidates  full candidate objects from runWebDiscovery
 * @param {object}   [opts] { snapshotId, runId }
 */
export async function persistDiscoveryCandidates(candidates = [], opts = {}) {
  const rows = candidates.filter((c) => c && c.candidate_id).map((c) => toRow(c, opts));
  return writeRows("web_discovery_candidates", rows, { onConflict: "candidate_id" });
}

/**
 * Convenience: persist the full runWebDiscovery result (accepted + audit).
 */
export async function persistDiscoveryResult(discoveryResult = {}, opts = {}) {
  const all = [...(discoveryResult.accepted || []), ...(discoveryResult.audit || [])];
  return persistDiscoveryCandidates(all, opts);
}
