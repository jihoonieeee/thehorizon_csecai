/**
 * Layer 5C.13 — Persist web evidence + visual evidence (audit store).
 *
 * Writes the tables in docs/migrations/web-evidence-v1.sql. Stores accepted AND
 * rejected/manual-review items + failures + clusters, so nothing is lost.
 * Graceful: missing table (42P01 / PGRST205) → single warning + no-op.
 */

import { supabase } from "../../storage/supabaseClient.js";

const knownMissingTables = new Set();
function isMissingTableError(error) {
  return error?.code === "42P01" || error?.code === "PGRST205" ||
    /relation .* does not exist|could not find the table/i.test(error?.message || "");
}

async function writeRows(table, rows, onConflict) {
  if (knownMissingTables.has(table)) return { written: 0, skipped: rows.length };
  if (!rows.length) return { written: 0, skipped: 0 };
  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) {
      if (isMissingTableError(error)) {
        knownMissingTables.add(table);
        console.warn(`persistWebEvidence: table '${table}' missing — apply docs/migrations/web-evidence-v1.sql`);
        return { written, skipped: rows.length - written };
      }
      console.warn(`persistWebEvidence: write to '${table}' failed: ${error.message}`);
      return { written, skipped: rows.length - written };
    }
    written += batch.length;
  }
  return { written, skipped: 0 };
}

function evidenceRow(e, snapshotId) {
  return {
    web_evidence_id: e.web_evidence_id,
    snapshot_id: snapshotId ?? null,
    category: e.category ?? null,
    discovery_mission: e.discovery_mission ?? null,
    evidence_label: e.evidence_label ?? null,
    evidence_depth: e.evidence_depth ?? null,
    analysis_usefulness: e.analysis_usefulness ?? null,
    why_this_is_useful: e.why_this_is_useful ?? null,
    concrete_claim: e.concrete_claim ?? null,
    operational_details: e.operational_details ?? null,
    walkthrough_status: e.walkthrough_status ?? null,
    source_url: e.source_grounding?.source_url ?? null,
    opened_url_confirmed: e.source_grounding?.opened_url_confirmed ?? null,
    publisher: e.source_grounding?.publisher ?? null,
    title: e.source_grounding?.title ?? null,
    published_date: e.source_grounding?.published_date ?? null,
    verbatim_quotes: e.source_grounding?.verbatim_quotes ?? null,
    taxonomy_context: e.taxonomy_context ?? null,
    source_lineage: e.source_lineage ?? null,
    confidence: e.confidence ?? null,
    validation_status: e.validation_status ?? null,
    validation_violations: e.validation_violations ?? null,
    qa_status: e.qa_status ?? null,
    selection_reason: e.selection_reason ?? null,
    duplicate_cluster_id: e.duplicate_cluster_id ?? null,
    is_cluster_representative: e.is_cluster_representative ?? null,
    duplicate_reason: e.duplicate_reason ?? null,
    manual_review_required: e.manual_review_required ?? null,
    rejection_reason: e.rejection_reason ?? null,
  };
}

function visualRow(v, snapshotId) {
  return {
    visual_evidence_id: v.visual_evidence_id,
    snapshot_id: snapshotId ?? null,
    category: v.category ?? null,
    visual_label: v.visual_label ?? null,
    visual_kind: v.visual_kind ?? null,
    source_url: v.source_url ?? null,
    visual_url: v.visual_url ?? null,
    local_image_path: v.local_image_path ?? null,
    screenshot_path: v.screenshot_path ?? null,
    full_page_screenshot_path: v.full_page_screenshot_path ?? null,
    cropped_visual_path: v.cropped_visual_path ?? null,
    crop_method: v.crop_method ?? null,
    capture_method: v.capture_method ?? null,
    page_number: v.page_number ?? null,
    caption_or_nearby_text: v.caption_or_nearby_text ?? null,
    what_it_shows: v.what_it_shows ?? null,
    why_it_is_relevant: v.why_it_is_relevant ?? null,
    supports_evidence_ids: v.supports_evidence_ids ?? null,
    visual_claim: v.visual_claim ?? null,
    image_hash: v.image_hash ?? null,
    taxonomy_context: v.taxonomy_context ?? null,
    visual_quality: v.visual_quality ?? null,
    usage: v.usage ?? null,
    visual_usefulness: v.visual_usefulness ?? null,
    slide_suitability: v.slide_suitability ?? null,
    table_data: v._table_data ?? null,
    validation_status: v.validation_status ?? null,
    qa_status: v.qa_status ?? null,
    duplicate_cluster_id: v.duplicate_cluster_id ?? null,
    is_cluster_representative: v.is_cluster_representative ?? null,
    duplicate_reason: v.duplicate_reason ?? null,
    manual_review_required: v.manual_review_required ?? null,
    rejection_reason: v.rejection_reason ?? null,
  };
}

export async function persistWebEvidence(branchResult = {}, opts = {}) {
  const snapshotId = opts.snapshotId ?? null;
  const evidence = [...(branchResult.evidence_items || []), ...(branchResult.rejected_items || []), ...(branchResult.manual_review_items || [])]
    .filter((e) => e && e.web_evidence_id);
  const visuals = [...(branchResult.visual_evidence || []), ...(branchResult.rejected_visuals || [])]
    .filter((v) => v && v.visual_evidence_id);
  const failures = (branchResult.failures || []).map((f, i) => ({
    failure_id: `wef_${snapshotId || "run"}_${i}`,
    snapshot_id: snapshotId, provider: f.provider ?? null, query: f.query ?? null,
    failed_url: f.failed_url ?? null, failure_reason: f.failure_reason ?? null,
    retry_attempted: f.retry_attempted ?? null, fallback_used: f.fallback_used ?? null,
  }));

  const [ev, vis, fail] = await Promise.all([
    writeRows("web_evidence_items", evidence.map((e) => evidenceRow(e, snapshotId)), "web_evidence_id"),
    writeRows("web_visual_evidence", visuals.map((v) => visualRow(v, snapshotId)), "visual_evidence_id"),
    writeRows("web_evidence_failures", failures, "failure_id"),
  ]);
  return { evidence: ev, visuals: vis, failures: fail };
}
