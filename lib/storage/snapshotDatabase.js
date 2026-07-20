import { supabase } from "./supabaseClient.js";
import { uploadArchiveJson } from "./blobArchiveStore.js";

export const TRUST_VERSION = "trust-v2.0";

// ── Graceful column fallback ──────────────────────────────────────────────────
// Each flag is set to false after the first Postgres "column does not exist"
// error (42703) for that column set, so the daily cron keeps running even if
// DB migrations haven't been applied yet.

let ingestionV2ColumnsAvailable = true;
let ingestionV3ColumnsAvailable = true;   // 000_schema.sql section 2 columns
let validationColumnsAvailable = true;    // 000_schema.sql section 3 columns
let sourceSnapshotsTableAvailable = true; // source_snapshots table

// Columns added in 000_schema.sql section 1
const INGESTION_V2_COLUMNS = new Set([
  "date_published_actual", "date_discovered", "date_confidence",
  "structural_validity_score", "publisher_trust_score",
  "url_safety_status", "final_url", "url_reachable",
  "eligible_for_weekly_report", "eligible_for_monthly_report",
  "eligible_for_quarterly_report", "eligible_for_archive",
  "eligible_for_trend_analysis", "eligible_for_reference_context", "needs_review",
  "report_period_week", "report_period_month", "report_period_quarter",
  "event_cluster_id", "cluster_key", "is_primary_source",
  "is_follow_on_source", "adds_new_information", "related_sources",
]);

// Columns added in 000_schema.sql section 2
const INGESTION_V3_COLUMNS = new Set([
  "original_url", "canonical_url", "raw_text", "clean_text",
  "extracted_code_blocks", "extracted_iocs",
  "cleaning_version", "trust_version",
  "is_curated", "curated_metadata",
]);

// Columns added in 000_schema.sql section 12b
const SOURCE_CONTEXT_COLUMNS = new Set([
  "publisher_class", "evidence_role", "independence_level",
  "verification_status", "evidence_strength_hint", "reliability_notes",
]);

let sourceContextColumnsAvailable = true;

// Columns added in 000_schema.sql section 3
const VALIDATION_COLUMNS = new Set([
  "validation_summary", "validation_status", "validation_version",
  "ai_threat_focus", "candidate_domain",
  "validation_relevance_method", "validation_qa_status",
  // Content-quality gate + pre-gate signal strength (000_schema.sql §"content quality")
  "content_quality", "content_quality_reason", "ai_signal_strength",
]);

function stripCols(row, cols) {
  const r = { ...row };
  for (const col of cols) delete r[col];
  return r;
}

function toV1Row(row) {
  const v1 = stripCols(row, VALIDATION_COLUMNS);
  for (const col of INGESTION_V2_COLUMNS) delete v1[col];
  for (const col of INGESTION_V3_COLUMNS) delete v1[col];
  for (const col of SOURCE_CONTEXT_COLUMNS) delete v1[col];
  return v1;
}

function toV2Row(row) {
  const v2 = stripCols(row, VALIDATION_COLUMNS);
  for (const col of INGESTION_V3_COLUMNS) delete v2[col];
  for (const col of SOURCE_CONTEXT_COLUMNS) delete v2[col];
  return v2;
}

function toV3Row(row) {
  const v3 = { ...row };
  for (const col of SOURCE_CONTEXT_COLUMNS) delete v3[col];
  return v3;
}

async function upsertSourceRows(rows) {
  // Strip source-context columns if the migration hasn't been applied yet.
  const withContext = sourceContextColumnsAvailable
    ? rows
    : rows.map((r) => stripCols(r, SOURCE_CONTEXT_COLUMNS));

  // Validation columns are independent — strip if missing and retry.
  const base = validationColumnsAvailable
    ? withContext
    : withContext.map((r) => stripCols(r, VALIDATION_COLUMNS));

  // Try v3 + context (all new columns)
  if (ingestionV3ColumnsAvailable && ingestionV2ColumnsAvailable) {
    const { error } = await supabase.from("sources").upsert(base, {
      onConflict: "id",
      ignoreDuplicates: true,
    });
    if (!error) return;
    if (error.code === "42703") {
      if (sourceContextColumnsAvailable) {
        sourceContextColumnsAvailable = false;
        console.warn("Source-context-v1 DB columns not present — run docs/migrations/000_schema.sql");
        return upsertSourceRows(rows);
      }
      if (validationColumnsAvailable) {
        validationColumnsAvailable = false;
        console.warn("Validation-v1 DB columns not present — run docs/migrations/000_schema.sql");
        return upsertSourceRows(rows);
      }
      ingestionV3ColumnsAvailable = false;
      console.warn("Archiving-v2 DB columns not present — run docs/migrations/000_schema.sql");
    } else {
      throw error;
    }
  }

  // Try v2 (section 1 columns only)
  if (ingestionV2ColumnsAvailable) {
    const { error } = await supabase.from("sources").upsert(rows.map(toV2Row), {
      onConflict: "id",
      ignoreDuplicates: true,
    });
    if (!error) return;
    if (error.code === "42703") {
      ingestionV2ColumnsAvailable = false;
      console.warn("Ingestion-v2 DB columns not present — run docs/migrations/000_schema.sql");
    } else {
      throw error;
    }
  }

  // Fallback: v1 schema only
  const { error } = await supabase.from("sources").upsert(rows.map(toV1Row), {
    onConflict: "id",
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

// ── source_snapshots: point-in-time content capture ───────────────────────────

async function insertSourceSnapshots(snapshotRows) {
  if (!sourceSnapshotsTableAvailable) return;

  const { error } = await supabase.from("source_snapshots").upsert(snapshotRows, {
    onConflict: "source_id,content_hash",  // unique constraint — no duplicate captures
    ignoreDuplicates: true,
  });

  if (error) {
    if (error.code === "42P01") {  // relation does not exist
      sourceSnapshotsTableAvailable = false;
      console.warn("source_snapshots table not present — run docs/migrations/000_schema.sql");
    } else if (error.code !== "42703") {
      throw error;
    }
  }
}

function getSnapshotDateKey(reportingWindow = {}) {
  const end =
    reportingWindow.end_sgt ||
    reportingWindow.end_local ||
    reportingWindow.end_utc;

  if (!end) {
    return new Date().toISOString().slice(0, 10);
  }

  return end.slice(0, 10);
}

function getStartLocal(reportingWindow = {}) {
  return (
    reportingWindow.start_sgt ||
    reportingWindow.start_local ||
    reportingWindow.start_utc ||
    null
  );
}

function getEndLocal(reportingWindow = {}) {
  return (
    reportingWindow.end_sgt ||
    reportingWindow.end_local ||
    reportingWindow.end_utc ||
    null
  );
}

export async function saveSnapshotToDatabase(snapshot, opts = {}) {
  // opts.snapshotIdSuffix keeps a secondary same-day ingest (e.g. the operational
  // discovery run) from overwriting the primary daily snapshot row/blob. Sources
  // still upsert into the shared sources table either way.
  const dateKey = getSnapshotDateKey(snapshot.reporting_window);
  const snapshotId = opts.snapshotIdSuffix
    ? `snapshot-${dateKey}-${opts.snapshotIdSuffix}`
    : `snapshot-${dateKey}`;

  // The Blob archive + snapshot row are AUXILIARY (a point-in-time JSON copy for
  // audit). The SOURCE upsert below is the payload. Neither must be allowed to
  // block source persistence — a bad/expired BLOB_READ_WRITE_TOKEN in CI was
  // throwing here and silently discarding every discovered source (66 accepted →
  // 0 persisted). Both are now best-effort: on failure we log and keep going so
  // the sources still land in the DB.
  let blob = { url: null };
  try {
    blob = await uploadArchiveJson(`snapshots/${snapshotId}.json`, snapshot);
  } catch (err) {
    console.warn(`  [snapshot] Blob archive skipped (${String(err.message).slice(0, 80)}) — persisting sources anyway`);
  }

  const snapshotRow = {
    snapshot_id: snapshotId,
    period: snapshot.period,
    generated_at: snapshot.generated_at,

    start_utc: snapshot.reporting_window.start_utc,
    end_utc: snapshot.reporting_window.end_utc,

    start_local: getStartLocal(snapshot.reporting_window),
    end_local: getEndLocal(snapshot.reporting_window),

    count: snapshot.count,
    discarded_count: snapshot.discarded_count || 0,
    rejected_count: snapshot.rejected_count || 0,

    blob_path: blob.url,
  };

  const { error: snapshotError } = await supabase
    .from("snapshots")
    .upsert(snapshotRow, { onConflict: "snapshot_id" });

  if (snapshotError) {
    // Non-fatal: the snapshot audit row failed, but the sources still must persist.
    console.warn(`  [snapshot] snapshots row upsert failed (${String(snapshotError.message).slice(0, 80)}) — persisting sources anyway`);
  }

  // Ingestion owns: identity, content, and provenance fields only.
  // Classification-owned fields (main_category, tag_version, ai_specificity_score, etc.)
  // are intentionally absent — they must never be overwritten by re-ingestion.
  // ignoreDuplicates: true ensures existing sources are left fully intact so that
  // a backfill over already-classified sources does not wipe their classification.
  const sourceRows = snapshot.sources.map((source) => ({
    id: source.id,
    snapshot_id: snapshotId,

    title: source.title,
    // validateAndTypeSource sets final_url directly on the source object —
    // never under source.validity or source.validation.
    url:           source.final_url   || source.url,
    original_url:  source.original_url  || source.url,
    canonical_url: source.canonical_url || source.url,
    final_url:     source.final_url   || source.url,
    display_url:   source.display_url || source.final_url || source.url,
    publisher: source.publisher,
    author: source.author || "",

    date_published: source.date_published,
    date_published_actual: source.date_published_actual !== undefined
      ? source.date_published_actual
      : source.date_published,
    date_discovered: source.date_discovered || null,
    date_confidence: source.date_confidence || "exact",
    source_type: source.source_type,

    trust_tier:
      source.trust_tier ||
      source.collection_metadata?.trust_tier ||
      "unknown",

    // Structural validity from the ingest gate (source.validity). Previously
    // hardcoded to unknown/0 — populate so the persisted row reflects the gate.
    credibility_label:        source.validity?.credibility_label || "unknown",
    validity_score:           source.validity?.structural_validity_score ?? 0,
    structural_validity_score: source.validity?.structural_validity_score ?? 0,
    publisher_trust_score:    source.validity?.publisher_trust_score ?? 0,

    url_safety_status: source.url_safety_status || "unknown",
    url_reachable:     source.url_reachable ?? null,

    tags: source.tags || [],
    full_text: source.full_text || "",
    summary: source.summary || "",

    // ── Layer 3 validation outputs ────────────────────────────────────────────
    // source_type above is already the validation layer's LLM-chosen type.
    validation_summary:          source.validation_summary || null,
    validation_status:           source.validation_status || null,
    // layer3_status mirrors validation_status — both set by applyFinalGate.
    layer3_status:               source.layer3_status || source.validation_status || null,
    downstream_route:            source.downstream_route || null,
    validation_version:          source.validation_version || null,
    ai_threat_focus:             source.ai_threat_focus || null,
    candidate_domain:            source.candidate_domain || null,
    validation_relevance_method: source.validation_relevance_method || null,
    validation_qa_status:        source.validation_qa_status || null,
    // Content-quality gate + pre-gate signal strength.
    content_quality:             source.content_quality || null,
    content_quality_reason:      source.content_quality_reason || null,
    ai_signal_strength:          source.ai_signal_strength || null,
    // L3 LLM relevance + gate fields (migration 021 columns).
    validation_reasoning:          source.validation_reasoning          || null,
    source_type_confidence:        source.source_type_confidence        || null,
    source_type_reason:            source.source_type_reason            || null,
    final_validity_reason:         source.final_validity_reason         || null,
    ai_materiality:                source.ai_materiality                || null,
    evidence_origin:               source.evidence_origin               || null,
    publisher_role:                source.publisher_role                || null,
    secondary_domain:              source.secondary_domain              || null,
    affected_ai_layer:             source.affected_ai_layer             || null,
    boundary_rationale:            source.boundary_rationale            || null,
    reading_value:                 source.reading_value                 || null,
    distribution_recommendation:   source.distribution_recommendation   || null,
    recommendation_reason:         source.recommendation_reason         || null,
    research_gate_verdict:         source.research_gate_verdict         || null,
    research_gate_read_value:      source.research_gate_read_value      || null,
    research_gate_reject_reason:   source.research_gate_reject_reason   || null,
    research_gate_contribution_type: source.research_gate_contribution_type || null,
    research_gate_maturity:        source.research_gate_maturity        || null,

    // Raw and cleaned text (v3 columns)
    raw_text:   source.raw_text   || "",
    clean_text: source.clean_text || source.full_text || "",

    extracted_code_blocks: source.extracted_code_blocks || [],
    extracted_iocs:        source.extracted_iocs        || {},

    cleaning_version: source.cleaning_version || null,
    trust_version:    TRUST_VERSION,

    is_curated:        source.is_curated        ?? false,
    curated_metadata:  source.curated_metadata  || null,

    content_hash: source.content_hash || null,
    clean_text_hash: source.clean_text_hash || null,

    // Eligibility flags
    eligible_for_weekly_report:     source.eligible_for_weekly_report     ?? true,
    eligible_for_monthly_report:    source.eligible_for_monthly_report    ?? true,
    eligible_for_quarterly_report:  source.eligible_for_quarterly_report  ?? true,
    eligible_for_archive:           source.eligible_for_archive           ?? true,
    eligible_for_trend_analysis:    source.eligible_for_trend_analysis    ?? true,
    eligible_for_reference_context: source.eligible_for_reference_context ?? false,
    // Non-exact date_confidence always triggers review regardless of path — catches
    // curated imports, sitemap connectors, and discovery routes that bypass collectRawSources.
    needs_review: source.needs_review || (source.date_confidence && source.date_confidence !== "exact") || false,
    report_period_week:    source.report_period_week    ?? null,
    report_period_month:   source.report_period_month   ?? null,
    report_period_quarter: source.report_period_quarter ?? null,

    // Event clustering (populated by a future clustering step; null until then)
    event_cluster_id:    source.event_cluster_id    || null,
    cluster_key:         source.cluster_key         || null,
    is_primary_source:   source.is_primary_source   ?? null,
    is_follow_on_source: source.is_follow_on_source ?? null,
    adds_new_information: source.adds_new_information ?? null,
    related_sources:     source.related_sources     || null,

    // L4 routing field (migration 021 column).
    source_family: source.source_family || null,

    blob_path: blob.url,
  }));

  if (sourceRows.length > 0) {
    await upsertSourceRows(sourceRows);
  }

  // Write point-in-time content snapshots so re-ingestion never silently
  // overwrites previously captured content. Unique on (source_id, content_hash).
  const snapshotRecords = snapshot.sources
    .filter((s) => s.content_hash)
    .map((source) => ({
      source_id:     source.id,
      snapshot_id:   snapshotId,
      captured_at:   snapshot.generated_at || new Date().toISOString(),
      content_hash:  source.content_hash,
      clean_text_hash: source.clean_text_hash || null,
      raw_text:      source.raw_text   || "",
      clean_text:    source.clean_text || source.full_text || "",
      raw_html:      source.raw_html   || "",
      cleaning_version: source.cleaning_version || null,
      extracted_code_blocks: source.extracted_code_blocks || [],
      extracted_iocs:        source.extracted_iocs        || {},
    }));

  if (snapshotRecords.length > 0) {
    await insertSourceSnapshots(snapshotRecords);
  }

  return {
    snapshot_id: snapshotId,
    blob_url: blob.url,
  };
}

export async function listSnapshots({ start, end } = {}) {
  let query = supabase
    .from("snapshots")
    .select("*")
    .order("end_utc", { ascending: false });

  if (start) {
    query = query.gte(
      "end_utc",
      `${start}T00:00:00.000Z`
    );
  }

  if (end) {
    query = query.lte(
      "start_utc",
      `${end}T23:59:59.999Z`
    );
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data || [];
}

export async function getSnapshotById(snapshotId) {
  const { data: snapshot, error: snapshotError } =
    await supabase
      .from("snapshots")
      .select("*")
      .eq("snapshot_id", snapshotId)
      .single();

  if (snapshotError) {
    return null;
  }

  const sources = await listSourcesBySnapshot(snapshotId);

  return {
    ...snapshot,
    sources,
  };
}

export async function listSourcesBySnapshot(snapshotId) {
  const { data, error } = await supabase
    .from("sources")
    .select("*")
    .eq("snapshot_id", snapshotId)
    .order("date_published", {
      ascending: false,
    });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function listSources({
  start,
  end,
  publisher,
  source_type,
  trust_tier,
  tag,
  limit = 1000,
} = {}) {
  let query = supabase
    .from("sources")
    .select("*")
    .order("date_published", {
      ascending: false,
    })
    .limit(limit);

  if (process.env.TEST_SET_MODE === "true") {
    query = query.eq("in_test_set", true);
  }

  if (start) {
    query = query.gte("date_published", start);
  }

  if (end) {
    // lte so sources published ON the end date are included (not lt which excludes them)
    query = query.lte("date_published", end);
  }

  if (publisher) {
    query = query.ilike(
      "publisher",
      `%${publisher}%`
    );
  }

  if (source_type) {
    query = query.eq(
      "source_type",
      source_type
    );
  }

  if (trust_tier) {
    query = query.eq("trust_tier", trust_tier);
  }

  if (tag) {
    query = query.contains("tags", [tag]);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data || [];
}
