/**
 * Layer 8A — Category Evidence Dossier Builder
 *
 * Fully deterministic — no LLM calls. Assembles a compact, structured evidence
 * dossier per threat category. This dossier is the sole input to the Layer 8B
 * category analysis LLM call — the LLM never sees raw source objects directly.
 *
 * ── RAWFACT EVIDENCE SELECTION ───────────────────────────────────────────────
 * Max MAX_RAWFACT_EVIDENCE = 12 items per category, selected in this order:
 *   1. Priority: must_read → high → medium → low → archive_only
 *   2. Within same priority: cluster representatives first (is_representative=true)
 *   3. Within same priority+rep: descending rawfact_score
 *
 * Each rawfact evidence item carries:
 *   evidence_id (format: "raw_<source_id>"), title, publisher, published_date,
 *   source_type, rawfact_score, rawfact_priority, key_facts[], numbers_statistics[],
 *   attack_flow[], why_it_matters, top_evidence_items[], evidence_item_count,
 *   analytics_attack_vectors[], analytics_signal_clusters[],
 *   cluster_id, cluster_size, is_cluster_representative
 *
 * ── EVIDENCE PACK (new) ───────────────────────────────────────────────────────
 * When evidence_packs[] is provided (rawfact-v2.0+), each dossier also carries
 * evidence_pack — the assembled per-category pack from assembleEvidencePacks().
 * This gives the LLM access to pre-grouped critical/high/statistics/case_studies etc.
 *
 * ── ANALYTICS EVIDENCE ───────────────────────────────────────────────────────
 * Up to 4 analytics items per category (attack vectors, maturity, signal clusters,
 * operational status). Each carries an analytics_id (format: "agg_<category>_<metric>")
 * that can be cited by the LLM in supporting_evidence_ids.
 *
 * ── ACTIVE CATEGORIES ────────────────────────────────────────────────────────
 * Only categories with source_count > 0 are returned. Categories with no sources
 * are skipped entirely — analyzeCategory() is not called for empty dossiers.
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 * buildAllDossiers() → dossier[] where each dossier:
 *   { category, source_count, rawfact_evidence[], analytics_evidence[], evidence_pack }
 */

import { strengthRank, compareEvidenceByStrength } from "../evidenceTriage/evidenceTriageVocab.js";

const MAX_RAWFACT_EVIDENCE = 12;

const ANALYSIS_CATEGORIES = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

// ── Evidence item builders ─────────────────────────────────────────────────────

function buildRawfactEvidenceItem(source) {
  const rf = source.rawfact_evidence_summary || {};
  const ec = source.evidence_card || {};
  const at = source.analytics_taxonomy || {};
  const cl = source.rawfact_cluster || {};

  // Prefer evidence_items (rawfact-v2.0) over legacy evidence_card
  const evidenceItems = source.evidence_items || [];
  const topItems = [...evidenceItems]
    .sort(compareEvidenceByStrength)
    .slice(0, 5);

  const keyFacts = topItems.length > 0
    ? topItems.map((i) => i.fact)
    : (ec.key_facts || source.understanding?.main_claims || []);

  const numbersStatistics = topItems.length > 0
    ? [...new Set(topItems.flatMap((i) => i.numbers || []))]
    : (ec.numbers_statistics || source.understanding?.important_numbers || []);

  const bestUsedFor = topItems.length > 0
    ? [...new Set(topItems.flatMap((i) => i.best_used_for || []))]
    : (ec.best_used_for || []);

  return {
    evidence_id:               `raw_${source.id}`,
    source_id:                 source.id,
    title:                     source.title || "",
    url:                       source.url || "",
    publisher:                 source.publisher || "",
    published_date:            (source.date_published || "").slice(0, 10),
    source_type:               source.source_type || "unknown",
    rawfact_strength:          rf.strongest_strength ?? "archive",
    cluster_id:                cl.cluster_id || null,
    is_cluster_representative: cl.is_representative ?? true,
    cluster_size:              cl.cluster_size || 1,
    // Evidence facts — prefer item-level data over legacy evidence_card
    evidence_card_title:       ec.evidence_card_title || null,
    short_summary:             ec.short_summary || source.understanding?.source_summary || source.summary || null,
    key_facts:                 keyFacts,
    numbers_statistics:        numbersStatistics,
    attack_flow:               ec.attack_flow || [],
    impacts:                   ec.impacts || [],
    why_it_matters:            ec.why_it_matters || null,
    best_used_for:             bestUsedFor,
    // Structured evidence items (rawfact-v2.0+); empty array for older sources
    evidence_item_count:       evidenceItems.length,
    top_evidence_items:        topItems.map((i) => ({
      evidence_id:        i.evidence_id,
      evidence_type:      i.evidence_type,
      fact:               i.fact,
      source_quote:       i.source_quote || i.supporting_text || "",
      display_label:      i.display_label,
      evidence_strength:  i.triage_data?.evidence_strength ?? "archive",
      permitted_uses:     i.triage_data?.permitted_uses ?? [],
      limitations:        i.triage_data?.limitations ?? [],
      entities:           i.entities || [],
      numbers:            i.numbers || [],
      best_used_for:      i.best_used_for || [],
    })),
    // Analytics fields — prefer new analytics_features, fall back to analytics_taxonomy
    analytics_attack_vectors:     source.analytics_features?.attack_vectors     || at.analytics_attack_vectors     || [],
    analytics_maturity:           source.analytics_features?.threat_maturity    || at.analytics_maturity            || "unknown",
    analytics_signal_clusters:    source.analytics_features?.signal_clusters    || at.analytics_signal_clusters    || [],
    analytics_operational_status: source.analytics_features?.operational_status || at.analytics_operational_status || "unknown",
  };
}

function buildAnalyticsEvidence(category, sources, aggregates) {
  const allSourceIds = sources.map((s) => s.id);
  const items = [];

  function getField(s, featureField, taxonomyField) {
    return s.analytics_features?.[featureField] ?? s.analytics_taxonomy?.[taxonomyField];
  }

  // Attack vector frequency — prefer analytics_features
  const vectorCounts = {};
  for (const s of sources) {
    const vectors = getField(s, "attack_vectors", "analytics_attack_vectors") || [];
    for (const v of vectors) {
      if (v) vectorCounts[v] = (vectorCounts[v] || 0) + 1;
    }
  }
  if (Object.keys(vectorCounts).length > 0) {
    items.push({
      analytics_id:       `agg_${category}_attack_vectors`,
      metric_name:        "attack_vector_frequency",
      value:              vectorCounts,
      data_source:        "analytics_aggregation_5b.5",
      source_ids:         allSourceIds,
      aggregation_method: "count_by_field",
    });
  }

  // Maturity distribution
  const maturityCounts = {};
  for (const s of sources) {
    const m = getField(s, "threat_maturity", "analytics_maturity") || "unknown";
    maturityCounts[m] = (maturityCounts[m] || 0) + 1;
  }
  if (Object.keys(maturityCounts).length > 0) {
    items.push({
      analytics_id:       `agg_${category}_maturity`,
      metric_name:        "maturity_distribution",
      value:              maturityCounts,
      data_source:        "analytics_aggregation_5b.5",
      source_ids:         allSourceIds,
      aggregation_method: "count_by_field",
    });
  }

  // Signal cluster counts
  const clusterCounts = {};
  for (const s of sources) {
    const clusters = getField(s, "signal_clusters", "analytics_signal_clusters") || [];
    for (const c of clusters) {
      if (c) clusterCounts[c] = (clusterCounts[c] || 0) + 1;
    }
  }
  if (Object.keys(clusterCounts).length > 0) {
    items.push({
      analytics_id:       `agg_${category}_signal_clusters`,
      metric_name:        "signal_cluster_counts",
      value:              clusterCounts,
      data_source:        "analytics_aggregation_5b.5",
      source_ids:         allSourceIds,
      aggregation_method: "count_by_field",
    });
  }

  // Operational status distribution
  const opStatusCounts = {};
  for (const s of sources) {
    const op = getField(s, "operational_status", "analytics_operational_status") || "unknown";
    opStatusCounts[op] = (opStatusCounts[op] || 0) + 1;
  }
  if (Object.keys(opStatusCounts).length > 0) {
    items.push({
      analytics_id:       `agg_${category}_operational_status`,
      metric_name:        "operational_status_distribution",
      value:              opStatusCounts,
      data_source:        "analytics_aggregation_5b.5",
      source_ids:         allSourceIds,
      aggregation_method: "count_by_field",
    });
  }

  return items;
}

// ── Source selector ────────────────────────────────────────────────────────────

function selectTopSources(sources) {
  return [...sources].sort((a, b) => {
    // Order by the source's strongest evidence strength (categorical rank, no score).
    const sa = strengthRank(a.rawfact_evidence_summary?.strongest_strength);
    const sb = strengthRank(b.rawfact_evidence_summary?.strongest_strength);
    if (sa !== sb) return sb - sa;

    // Within same strength: cluster representatives first.
    const repA = a.rawfact_cluster?.is_representative ?? true;
    const repB = b.rawfact_cluster?.is_representative ?? true;
    if (repA !== repB) return repB ? 1 : -1;

    // Then more evidence items first (richer source).
    return (b.evidence_items?.length || 0) - (a.evidence_items?.length || 0);
  }).slice(0, MAX_RAWFACT_EVIDENCE);
}

// ── Public API ────────────────────────────────────────────────────────────────

// ── External evidence helpers ─────────────────────────────────────────────────

function buildExternalEvidenceSection(category, externalByCategory = {}) {
  const catData = externalByCategory[category] || {};
  const items   = catData.external_evidence       || [];
  const visuals = catData.external_visual_evidence || [];
  const queries = catData.unsupported_queries      || [];

  // Separate statistics from findings
  const external_statistics = items.filter((e) =>
    ["authoritative_statistic","benchmark_result"].includes(e.evidence_type)
  );
  const external_visuals_usable = visuals.filter(
    (v) => v.slide_usable && !v.needs_manual_review
  );

  // External caveats: stale, vendor_self_reported, no_quote, weak
  const external_caveats = [];
  for (const e of items) {
    for (const lim of (e.limitations || [])) {
      if (!external_caveats.includes(lim)) external_caveats.push(lim);
    }
    if (e.evidence_type === "conflicting_evidence") {
      external_caveats.push(`conflicting_evidence: ${e.finding.slice(0, 80)}`);
    }
  }

  // Source quality summary for this category
  const sqCounts = { authoritative: 0, reputable: 0, mixed: 0, weak: 0 };
  for (const e of items) sqCounts[e.source_quality] = (sqCounts[e.source_quality] || 0) + 1;

  return {
    external_evidence:     items,
    external_statistics,
    external_visuals:      external_visuals_usable,
    unsupported_queries:   queries,
    external_caveats:      [...new Set(external_caveats)],
    source_quality_summary: sqCounts,
    has_claim_usable_evidence: items.some(
      (e) => !e.needs_manual_review && e.source_quality !== "weak" && e.confidence !== "low"
    ),
  };
}

/**
 * Build a compact evidence dossier for a single category.
 *
 * @param {string}   category         - One of the 4 threat category strings.
 * @param {object[]} sources          - All sources for this category.
 * @param {object}   aggregates       - Output of aggregateAnalytics().
 * @param {object}   [evidencePack]   - Optional rawfact evidence pack.
 * @param {object}   [externalByCategory] - 5C external evidence by category (from webEvidenceToExternalEvidence).
 * @returns {object} Category dossier.
 */
export function buildCategoryDossier(category, sources, aggregates, evidencePack = null, externalByCategory = {}) {
  const topSources = selectTopSources(sources);
  const extSection = buildExternalEvidenceSection(category, externalByCategory);

  return {
    category,
    source_count:        sources.length,
    rawfact_evidence:    topSources.map(buildRawfactEvidenceItem),
    analytics_evidence:  buildAnalyticsEvidence(category, sources, aggregates),
    evidence_pack:       evidencePack || null,
    // 5C external evidence (spec-aligned)
    external_evidence:     extSection.external_evidence,
    external_statistics:   extSection.external_statistics,
    external_visuals:      extSection.external_visuals,
    unsupported_queries:   extSection.unsupported_queries,
    external_caveats:      extSection.external_caveats,
    source_quality_summary: extSection.source_quality_summary,
    has_external_claim_support: extSection.has_claim_usable_evidence,
    // Layer identification for LLM prompt context
    evidence_layer_note: "rawfact_evidence=5A in-corpus; analytics_evidence=5B corpus metrics; external_evidence=5C open-web (cite layer in every claim).",
  };
}

/**
 * Build dossiers for all 4 active threat categories.
 *
 * @param {object[]} sources              - All enriched sources.
 * @param {object}   aggregates           - Output of aggregateAnalytics().
 * @param {object[]} [evidencePacks]      - Optional evidence packs from rawfact branch.
 * @param {object[]} [analyticsEvidence]  - Pre-computed analytics evidence from Layer 5b.7.
 * @param {object}   [externalEvidenceByCategory] - 5C evidence by category.
 * @returns {object[]} Array of category dossiers (only non-empty categories included).
 */
export function buildAllDossiers(sources, aggregates, evidencePacks = [], analyticsEvidence = [], externalEvidenceByCategory = {}) {
  const byCat = {};
  for (const source of sources) {
    const cat = source.main_category || "unclear_or_adjacent";
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(source);
  }

  // Filter pre-computed analytics evidence to category-relevant items
  const catRelevantEvidence = (cat) =>
    analyticsEvidence.filter((e) =>
      !e.domain ||
      e.domain === cat ||
      !e.domain
    ).slice(0, 5);

  return ANALYSIS_CATEGORIES
    .filter((cat) => (byCat[cat] || []).length > 0)
    .map((cat) => {
      const pack    = evidencePacks.find((p) => p.category === cat) || null;
      const dossier = buildCategoryDossier(cat, byCat[cat], aggregates, pack, externalEvidenceByCategory);

      // Inject pre-computed analytics evidence items from Layer 5b.7 (if provided)
      if (analyticsEvidence.length > 0) {
        dossier.global_analytics_evidence = catRelevantEvidence(cat);
      }

      return dossier;
    });
}
