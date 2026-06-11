/**
 * Taxonomy persistence — writes the normalized taxonomy tables created by
 * docs/migrations/000_schema.sql (section 8):
 *   taxonomy_references   — framework reference catalogue (seeded from registry)
 *   rawfacts              — atomic claims with primary/secondary taxonomy
 *   analytics_metrics     — taxonomy-aware aggregates per run
 *   ai_enabled_mappings   — paired operational technique + AI modifier
 *
 * ── GRACEFUL DEGRADATION ──────────────────────────────────────────────────────
 * Mirrors sourceAnalysisStore.js: if a table is absent (42P01 / PGRST205) the
 * writer no-ops with a single warning, so the pipeline runs whether or not the
 * migration has been applied.
 */

import { createHash } from "crypto";
import { supabase } from "./supabaseClient.js";
import { allReferenceRecords, TAXONOMY_VERSION } from "../config/taxonomyRegistry.js";

const knownMissingTables = new Set();
// table → Set<column> proven missing this session (dropped pre-emptively on retry).
const knownMissingColumns = new Map();

function isMissingTableError(error) {
  return error?.code === "42P01" || error?.code === "PGRST205" ||
    /relation .* does not exist|could not find the table/i.test(error?.message || "");
}

export function isMissingColumnError(error) {
  return error?.code === "42703" || error?.code === "PGRST204" ||
    /column .* does not exist|could not find the .* column/i.test(error?.message || "");
}

// Extract the offending column name from a Postgres/PostgREST missing-column error.
export function missingColumnFrom(error) {
  const m = (error?.message || "").match(/column "?([a-z0-9_]+)"?|'([a-z0-9_]+)' column/i);
  return m ? (m[1] || m[2]) : null;
}

export function dropColumns(rows, cols) {
  if (!cols.size) return rows;
  return rows.map((row) => {
    const copy = { ...row };
    for (const c of cols) delete copy[c];
    return copy;
  });
}

function refId(framework, item, url) {
  return "ref_" + createHash("sha256").update(`${framework}|${item}|${url}`).digest("hex").slice(0, 16);
}

// Generic batched insert/upsert that tolerates a missing table.
async function writeRows(table, rows, { upsert = false, onConflict } = {}) {
  if (knownMissingTables.has(table)) return { written: 0, skipped: rows.length };
  if (!rows.length) return { written: 0, skipped: 0 };

  let written = 0;
  const BATCH = 200;
  const missingCols = knownMissingColumns.get(table) || new Set();
  for (let i = 0; i < rows.length; i += BATCH) {
    let batch = dropColumns(rows.slice(i, i + BATCH), missingCols);
    // Retry on a missing-COLUMN error: strip the offending column and try again, so a
    // partially-migrated table (e.g. rawfacts without the newer quality columns) still
    // persists every column it DOES have instead of dropping the whole batch.
    let attempts = 0;
    for (;;) {
      const q = upsert
        ? supabase.from(table).upsert(batch, { onConflict })
        : supabase.from(table).insert(batch);
      const { error } = await q;
      if (!error) { written += batch.length; break; }
      if (isMissingTableError(error)) {
        knownMissingTables.add(table);
        console.warn(`taxonomyStore: table '${table}' missing — apply docs/migrations/000_schema.sql (section 8) to persist it`);
        return { written, skipped: rows.length - written };
      }
      if (isMissingColumnError(error) && attempts < 25) {
        const col = missingColumnFrom(error);
        if (col) {
          missingCols.add(col);
          knownMissingColumns.set(table, missingCols);
          batch = dropColumns(batch, new Set([col]));
          attempts++;
          continue;
        }
      }
      console.warn(`taxonomyStore: write to '${table}' failed: ${error.message}`);
      return { written, skipped: rows.length - written };
    }
  }
  return { written, skipped: 0 };
}

/** Seed/refresh the framework reference catalogue from the registry. */
export async function seedTaxonomyReferences() {
  const rows = allReferenceRecords().map((r) => ({
    reference_id:   refId(r.framework, r.framework_item, r.url),
    framework:      r.framework,
    framework_item: r.framework_item,
    url:            r.url,
    description:    r.description,
  }));
  return writeRows("taxonomy_references", rows, { upsert: true, onConflict: "reference_id" });
}

/**
 * Persist rawfacts for a run. Each rawfact must carry rawfact_id + source_id.
 * @param {object[]} rawfacts
 * @param {string}   [snapshotId]
 */
export async function persistRawfacts(rawfacts = [], snapshotId = null) {
  const rows = rawfacts
    .filter((r) => r && r.rawfact_id && r.source_id)
    .map((r) => ({
      rawfact_id:           r.rawfact_id,
      source_id:            r.source_id,
      claim:                r.claim ?? null,
      supporting_quote:     r.supporting_quote ?? null,
      evidence_location:    r.evidence_location ?? null,
      primary_domain:       r.primary_domain ?? null,
      // v9 fields
      primary_tags:         r.primary_tags ?? r.primary_threat_tags ?? null,
      primary_threat_tags:  r.primary_threat_tags ?? r.primary_tags ?? null,  // back-compat
      sub_techniques:       r.sub_techniques ?? null,
      ai_enabled:           r.ai_enabled ?? false,
      ai_enabled_roles:     r.ai_enabled_roles ?? null,
      ai_capabilities:      r.ai_capabilities ?? null,
      automation_level:     r.automation_level ?? null,
      autonomy_level:       r.autonomy_level ?? null,
      taxonomy_version:     r.taxonomy_version ?? TAXONOMY_VERSION,
      secondary_dimensions: r.secondary_dimensions ?? null,
      taxonomy_confidence:  r.taxonomy_confidence ?? null,
      validation_status:    r.validation_status ?? null,
      caveat_if_any:        r.caveat_if_any ?? null,
      // Evidence-quality axis (000_schema.sql section 8). writeRows tolerates a
      // missing column (PostgREST schema-cache error) by dropping the batch, so
      // unmigrated DBs simply skip these without failing the run.
      evidence_type:        r.evidence_type ?? null,
      evidence_strength:    r.evidence_strength ?? null,
      admissibility:        r.admissibility ?? null,
      permitted_uses:       r.permitted_uses ?? null,
      limitations:          r.limitations ?? null,
      observed_use:         r.observed_use ?? null,
      materiality:          r.materiality ?? null,
      uniqueness:           r.uniqueness ?? null,
      quote_entailment:     r.quote_entailment ?? null,
      claim_preservation:   r.claim_preservation ?? null,
      method_quality:       r.method_quality ?? null,
      statistical_use:      r.statistical_use ?? null,
      origin_role:          r.origin_role ?? null,
      independence_level:   r.independence_level ?? null,
      primary_origin_url:   r.primary_origin_url ?? null,
      source_quality_status:r.source_quality_status ?? null,
      snapshot_id:          snapshotId,
    }));
  return writeRows("rawfacts", rows, { upsert: true, onConflict: "rawfact_id" });
}

/**
 * Persist taxonomy-aware analytics metrics for a run.
 * @param {object[]} metrics  - each {metric_name, domain, primary_threat_tag, parent_tag, subdomain, value, source_ids, evidence_ids, calculation_method, confidence, caveat_if_any}
 * @param {string}   [snapshotId]
 */
export async function persistAnalyticsMetrics(metrics = [], snapshotId = null) {
  const rows = metrics.filter(Boolean).map((m, i) => ({
    metric_id:          m.metric_id || `${snapshotId || "run"}_${m.metric_name || "metric"}_${m.primary_threat_tag || m.domain || i}`,
    metric_name:        m.metric_name ?? null,
    domain:             m.domain ?? null,
    primary_threat_tag: m.primary_threat_tag ?? null,
    parent_tag:         m.parent_tag ?? null,
    subdomain:          m.subdomain ?? null,
    sub_technique:      m.sub_technique ?? null,
    ai_enabled_role:    m.ai_enabled_role ?? null,
    taxonomy_version:   m.taxonomy_version ?? TAXONOMY_VERSION,
    value:              typeof m.value === "number" ? m.value : null,
    source_ids:         m.source_ids ?? null,
    evidence_ids:       m.evidence_ids ?? null,
    calculation_method: m.calculation_method ?? null,
    confidence:         m.confidence ?? null,
    caveat_if_any:      m.caveat_if_any ?? null,
    snapshot_id:        snapshotId,
  }));
  return writeRows("analytics_metrics", rows, { upsert: true, onConflict: "metric_id" });
}

/**
 * Persist AI-enabled paired mappings for a run.
 * @param {object[]} mappings - each {primary_threat_tag, operational_attack_mapping, ai_capability_modifier, supporting_evidence_ids, confidence, source_id}
 * @param {string}   [snapshotId]
 */
export async function persistAiEnabledMappings(mappings = [], snapshotId = null) {
  const rows = mappings.filter((m) => m && m.primary_threat_tag).map((m) => ({
    primary_threat_tag:         m.primary_threat_tag,
    operational_attack_mapping: m.operational_attack_mapping ?? null,
    ai_capability_modifier:     m.ai_capability_modifier ?? null,
    supporting_evidence_ids:    m.supporting_evidence_ids ?? null,
    confidence:                 m.confidence ?? null,
    source_id:                  m.source_id ?? null,
    snapshot_id:                snapshotId,
  }));
  return writeRows("ai_enabled_mappings", rows);
}

/**
 * Persist visual evidence. Handles two schemas:
 *
 * 1. Old schema (text evidence items flagged is_visual / with chart_data):
 *    { evidence_id, is_visual|chart_data, title, publisher, url, image_url, ... }
 *
 * 2. New schema (external_visual_evidence objects from the Layer 5C web-evidence adapter):
 *    { visual_evidence_id, visual_type, source_url, visual_url, what_the_visual_shows, ... }
 *
 * Both are normalised to the visual_evidence table shape.
 *
 * @param {object[]} items      - Mixed array of old + new visual evidence
 * @param {string}   [snapshotId]
 */
export async function persistVisualEvidence(items = [], snapshotId = null) {
  const rows = [];
  for (const e of items) {
    if (!e) continue;

    if (e.visual_evidence_id) {
      // New schema — external visual evidence object
      rows.push({
        evidence_id:         e.visual_evidence_id,
        category:            e.category ?? null,
        title:               e.title ?? null,
        publisher:           e.publisher ?? null,
        url:                 e.source_url ?? null,
        image_url:           e.visual_url ?? null,
        evidence_type:       e.visual_type ?? "figure",
        metric_name:         e.what_the_visual_shows?.slice(0, 120) ?? null,
        metric_value:        null,
        is_visual:           true,
        chart_data:          e.extractable_data?.has_numeric_data ? e.extractable_data : null,
        evidence_confidence: e.evidence_confidence ?? null,
        needs_manual_review: !!e.needs_manual_review,
        snapshot_id:         snapshotId,
      });
    } else if (e.evidence_id && (e.is_visual || e.chart_data)) {
      // Old schema — text evidence item with visual flag
      rows.push({
        evidence_id:         e.evidence_id,
        category:            e.category ?? null,
        title:               e.title ?? null,
        publisher:           e.publisher ?? null,
        url:                 e.url ?? null,
        image_url:           e.image_url ?? null,
        evidence_type:       e.evidence_type ?? null,
        metric_name:         e.metric_name ?? null,
        metric_value:        e.metric_value != null ? String(e.metric_value) : null,
        is_visual:           !!e.is_visual,
        chart_data:          e.chart_data ?? null,
        evidence_confidence: e.evidence_confidence ?? null,
        needs_manual_review: !!e.needs_manual_review,
        snapshot_id:         snapshotId,
      });
    }
  }
  if (rows.length === 0) return { written: 0, skipped: 0 };
  return writeRows("visual_evidence", rows, { upsert: true, onConflict: "evidence_id" });
}

/**
 * Convenience: persist a whole run's taxonomy artefacts.
 */
export async function persistTaxonomyArtefacts({ rawfacts, metrics, aiEnabledMappings, visualEvidence, snapshotId } = {}) {
  const [refs, rf, mt, ai, vis] = await Promise.all([
    seedTaxonomyReferences(),
    persistRawfacts(rawfacts || [], snapshotId),
    persistAnalyticsMetrics(metrics || [], snapshotId),
    persistAiEnabledMappings(aiEnabledMappings || [], snapshotId),
    persistVisualEvidence(visualEvidence || [], snapshotId),
  ]);
  return { references: refs, rawfacts: rf, metrics: mt, ai_enabled_mappings: ai, visual_evidence: vis };
}
