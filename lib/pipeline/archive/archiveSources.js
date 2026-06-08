/**
 * Layer 3 — Archive Sources
 *
 * Persists validated sources (Layer 2 output) to:
 *   1. Supabase `sources` table — metadata, content, validity, eligibility flags
 *   2. Supabase `source_snapshots` table — point-in-time content capture
 *      (unique on source_id + content_hash; changed content creates a new row)
 *   3. Vercel Blob — immutable run-level JSON archive for auditability
 *
 * Upsert behaviour:
 *   sources: `ignoreDuplicates: true` — existing rows are left intact.
 *   A source's classification, intelligence, and LLM fields (set by Layers 5–9)
 *   are never overwritten by a re-archive run.
 *
 *   source_snapshots: unique on (source_id, content_hash). A source whose
 *   content changes on re-ingestion gets a new snapshot row alongside the old one.
 */

import crypto from "crypto";
import { supabase } from "../../storage/supabaseClient.js";
import { uploadArchiveJson } from "../../storage/blobArchiveStore.js";
import { buildSourceRow, buildSnapshotRecord, ARCHIVE_VERSION } from "./buildSourceRow.js";

const BATCH_SIZE = 200;

function makeRunId() {
  return `archive-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function makeDateKey() {
  return new Date().toISOString().slice(0, 10);
}

async function upsertSources(rows) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("sources")
      .upsert(batch, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw error;
  }
}

async function upsertSourceSnapshots(records) {
  if (records.length === 0) return;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("source_snapshots")
      .upsert(batch, {
        onConflict: "source_id,content_hash",
        ignoreDuplicates: true,
      });
    if (error) {
      if (error.code === "42P01") {
        console.warn("source_snapshots table missing — run docs/migrations/000_schema.sql");
        return;
      }
      throw error;
    }
  }
}

/**
 * Archive a batch of validated sources.
 *
 * @param {object[]} sources
 *   Validated sources from Layer 2 — each must have a `.validation` field.
 * @param {object}   options
 * @param {object}   [options.reportingWindow]  Window metadata to embed in the blob
 * @param {string}   [options.runId]            Custom run identifier
 * @returns {Promise<ArchiveResult>}
 */
export async function archiveSources(sources, options = {}) {
  if (sources.length === 0) {
    return { archived_sources: [], archived_count: 0, run_blob_url: null, run_id: null };
  }

  const runId     = options.runId     || makeRunId();
  const dateKey   = makeDateKey();
  const snapshotId = `snapshot-${dateKey}`;
  const capturedAt = new Date().toISOString();

  // ── 1. Build DB rows ────────────────────────────────────────────────────────
  const sourceRows    = sources.map((s) => buildSourceRow(s, snapshotId));
  const snapshotRecords = sources
    .filter((s) => s.content_hash)
    .map((s) => buildSnapshotRecord(s, snapshotId, capturedAt));

  // ── 2. Persist to Supabase ──────────────────────────────────────────────────
  await upsertSources(sourceRows);
  await upsertSourceSnapshots(snapshotRecords);

  // ── 3. Write immutable run blob to Vercel Blob ──────────────────────────────
  let blobResult = null;
  try {
    const payload = {
      archive_version:   ARCHIVE_VERSION,
      run_id:            runId,
      snapshot_id:       snapshotId,
      generated_at:      capturedAt,
      reporting_window:  options.reportingWindow || null,
      source_count:      sources.length,
      sources: sources.map((s) => ({
        source_id:   s.id,
        url:         s.url,
        title:       s.title,
        publisher:   s.publisher,
        date_published: s.date_published,
        content_hash:   s.content_hash,
        validation:     s.validation || {},
      })),
    };

    blobResult = await uploadArchiveJson(
      `archives/${dateKey}/${runId}.json`,
      payload,
      { overwrite: false }
    );
  } catch (err) {
    console.warn("Layer 3: Vercel Blob archive skipped —", err.message);
  }

  // ── 4. Build pipeline output (pipeline.md schema per source) ────────────────
  const archived_sources = sources.map((s) => ({
    archived_source_id: s.id,
    snapshot_paths: {
      html: null,
      text: null,
      pdf:  null,
    },
    content_hash: s.content_hash || null,
  }));

  return {
    archived_sources,
    archived_count:  sources.length,
    snapshot_id:     snapshotId,
    run_id:          runId,
    run_blob_url:    blobResult?.url || null,
  };
}
