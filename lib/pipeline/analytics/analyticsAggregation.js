/**
 * Layer 5b.5 — Analytics Aggregation
 *
 * Deterministic — no LLM calls. Aggregates analytics_features (Layer 5b.3/4)
 * into structured groups for downstream analysis and slide generation.
 *
 * ── AGGREGATE GROUPS ────────────────────────────────────────────────────────
 *   corpus_overview           — total counts, date range, category/type/trust breakdowns
 *   threat_pattern_analytics  — attack vectors, surfaces, AI layers, impact types
 *   maturity_analytics        — operational status, threat maturity, cross-category maturity
 *   timeline_analytics        — monthly timelines by category, source type, vector, maturity
 *   source_type_analytics     — source type cross-tabs with category, maturity, vector
 *   category_analytics        — per-category detailed breakdowns
 *   governance_analytics      — governance functions, sector, geography
 *   defensive_analytics       — defensive controls, control vs attack vector, gaps
 *   ecosystem_analytics       — dependency types, ecosystem shifts, attack surface growth
 *   adversary_adoption_analytics — adoption stages, adoption by vector/category
 *   capability_analytics      — capability stages, by AI layer, by vector
 *   trust_boundary_analytics  — shift types, delegation signals, oversight reduction
 *
 * Also exposes backward-compat flat fields for downstream code that used the old
 * aggregateAnalytics() output shape.
 */

import { getTag } from "../../config/taxonomyRegistry.js";

// ── Utility helpers ────────────────────────────────────────────────────────────

function countBy(items, keyFn) {
  const c = {};
  for (const item of items) {
    const k = keyFn(item);
    if (k != null && k !== "") c[k] = (c[k] || 0) + 1;
  }
  return c;
}

function countByArray(items, arrayFn) {
  const c = {};
  for (const item of items) {
    for (const v of (arrayFn(item) || [])) {
      if (v) c[v] = (c[v] || 0) + 1;
    }
  }
  return c;
}

function weightedCountByArray(items, arrayFn, weightFn = () => 1) {
  const c = {};
  for (const item of items) {
    const w = weightFn(item) || 1;
    for (const v of (arrayFn(item) || [])) {
      if (v) c[v] = (c[v] || 0) + w;
    }
  }
  // Round to 2dp for readability
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 100) / 100]));
}

function topN(obj, n = 10) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

function sortedCounts(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => b[1] - a[1])
  );
}

function yearMonth(f) {
  return f?.month_bucket || null;
}

// Build { "YYYY-MM": { key: count } } from features array
function monthlyCounts(features, keyFn) {
  const result = {};
  for (const f of features) {
    const m = yearMonth(f);
    if (!m) continue;
    for (const k of [].concat(keyFn(f) || [])) {
      if (!k) continue;
      if (!result[m]) result[m] = {};
      result[m][k] = (result[m][k] || 0) + 1;
    }
  }
  return result;
}

// ── Category constants ─────────────────────────────────────────────────────────

const OFFENSIVE_CATEGORIES = [
  "traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats",
];

const ALL_CATEGORIES = [
  ...OFFENSIVE_CATEGORIES, "ai_for_security", "unclear_or_adjacent",
];

// ── Per-category breakdown ────────────────────────────────────────────────────

function buildCategoryAnalytics(features) {
  const byCategory = {};

  for (const cat of ALL_CATEGORIES) {
    const catFeatures = features.filter((f) => f.main_category === cat);
    if (catFeatures.length === 0) {
      byCategory[cat] = { count: 0 };
      continue;
    }

    byCategory[cat] = {
      count:                    catFeatures.length,
      source_type_counts:       sortedCounts(countBy(catFeatures, (f) => f.source_type)),
      trust_tier_counts:        sortedCounts(countBy(catFeatures, (f) => f.trust_tier)),
      attack_vector_frequency:  sortedCounts(countByArray(catFeatures, (f) => f.attack_vectors)),
      attack_surface_frequency: sortedCounts(countByArray(catFeatures, (f) => f.attack_surfaces)),
      ai_layer_frequency:       sortedCounts(countByArray(catFeatures, (f) => f.ai_layers)),
      maturity_distribution:    sortedCounts(countBy(catFeatures, (f) => f.threat_maturity)),
      operational_status_distribution: sortedCounts(countBy(catFeatures, (f) => f.operational_status)),
      impact_type_frequency:    sortedCounts(countByArray(catFeatures, (f) => f.impact_types)),
      signal_cluster_counts:    sortedCounts(countByArray(catFeatures, (f) => f.signal_clusters)),
      recurring_theme_counts:   sortedCounts(countByArray(catFeatures, (f) => f.recurring_themes)),
      sector_counts:            sortedCounts(countByArray(catFeatures, (f) => f.sectors)),
      top_vectors:              topN(countByArray(catFeatures, (f) => f.attack_vectors), 5),
      top_signal_clusters:      topN(countByArray(catFeatures, (f) => f.signal_clusters), 5),
      top_recurring_themes:     topN(countByArray(catFeatures, (f) => f.recurring_themes), 5),
    };
  }

  return { per_category: byCategory };
}

// ── Taxonomy analytics (Validated AI Threat Taxonomy) ─────────────────────────
// Computes distributions over domain / primary_threat_tag / parent_tag /
// agentic subdomain / AI-enabled operational mapping / prompt-injection subtype.
// Secondary dimensions are counted SEPARATELY and never mixed into the
// primary-threat frequency.

function buildTaxonomyAnalytics(features) {
  // AI-enabled tags → their operational ATT&CK mapping (from the registry).
  const opMappingOf = (tag) => getTag(tag)?.operational_mapping || null;

  const validated = features.filter((f) => f.taxonomy_validation_status === "validated");

  return {
    domain_distribution:          sortedCounts(countBy(features, (f) => f.primary_domain)),
    primary_threat_tag_frequency: sortedCounts(countByArray(features, (f) => f.primary_threat_tags)),
    parent_tag_frequency:         sortedCounts(countByArray(features, (f) => f.parent_tags)),
    agentic_subdomain_frequency:  sortedCounts(countByArray(features, (f) => f.agentic_subdomains)),
    ai_enabled_mapping_frequency: sortedCounts(
      countByArray(features, (f) => (f.ai_enabled_tags || []).map(opMappingOf).filter(Boolean))
    ),
    ai_enabled_tag_frequency:     sortedCounts(countByArray(features, (f) => f.ai_enabled_tags)),
    prompt_injection_subtype_frequency: sortedCounts(
      countByArray(features, (f) => f.prompt_injection_subtypes)
    ),
    // Secondary dimensions — context only, NOT primary-threat frequency.
    secondary_dimension_frequency: sortedCounts(countByArray(features, (f) => f.secondary_dimensions)),
    // Evidence quality split.
    validation_status_counts:     sortedCounts(countBy(features, (f) => f.taxonomy_validation_status)),
    validated_threat_tag_frequency: sortedCounts(countByArray(validated, (f) => f.primary_threat_tags)),
    evidence_gaps: {
      validated:           features.filter((f) => f.taxonomy_validation_status === "validated").length,
      weak:                features.filter((f) => f.taxonomy_validation_status === "weak").length,
      needs_manual_review: features.filter((f) => f.taxonomy_validation_status === "needs_manual_review").length,
    },
  };
}

/**
 * Flatten taxonomy distributions into normalized metric rows for the
 * analytics_metrics table (taxonomyStore.persistAnalyticsMetrics).
 */
export function buildTaxonomyMetricRows(aggregates = {}) {
  const rows = [];
  const push = (metric_name, value, extra = {}) =>
    rows.push({ metric_name, value, calculation_method: "count_of_validated_primary_tags", confidence: "high", ...extra });

  for (const [domain, value] of Object.entries(aggregates.domain_distribution || {}))
    push("domain_count", value, { domain });
  for (const [tag, value] of Object.entries(aggregates.primary_threat_tag_frequency || {}))
    push("primary_threat_tag_count", value, { primary_threat_tag: tag, domain: getTag(tag)?.domain || null, parent_tag: getTag(tag)?.parent_tag || null, subdomain: getTag(tag)?.subdomain || null });
  for (const [sub, value] of Object.entries(aggregates.agentic_subdomain_frequency || {}))
    push("agentic_subdomain_count", value, { domain: "agentic_ai_threats", subdomain: sub });
  for (const [tag, value] of Object.entries(aggregates.prompt_injection_subtype_frequency || {}))
    push("prompt_injection_subtype_count", value, { primary_threat_tag: tag, parent_tag: "prompt_injection", domain: "llm_threats" });
  for (const [dim, value] of Object.entries(aggregates.secondary_dimension_frequency || {}))
    push("secondary_dimension_count", value, { calculation_method: "count_secondary_dimension_context", caveat_if_any: "secondary dimension — not a primary threat count" });

  return rows;
}

// ── Timeline analytics ─────────────────────────────────────────────────────────

function buildTimelineAnalytics(features) {
  return {
    monthly_source_timeline:       monthlyCounts(features, (f) => [f.main_category]),
    monthly_category_timeline:     monthlyCounts(features, (f) => [f.main_category]),
    monthly_source_type_timeline:  monthlyCounts(features, (f) => [f.source_type]),
    monthly_attack_vector_timeline:monthlyCounts(features, (f) => f.attack_vectors),
    monthly_maturity_timeline:     monthlyCounts(features, (f) => [f.threat_maturity]),
    monthly_signal_cluster_timeline:monthlyCounts(features, (f) => f.signal_clusters),
  };
}

// ── Trend deltas ────────────────────────────────────────────────────────────

function buildTrendDeltas(monthlyCatCounts) {
  const months = Object.keys(monthlyCatCounts).sort();
  if (months.length < 2) return null;

  const last = months[months.length - 1];
  const prev = months[months.length - 2];
  const catLast = monthlyCatCounts[last] || {};
  const catPrev = monthlyCatCounts[prev] || {};

  const allCats = new Set([...Object.keys(catLast), ...Object.keys(catPrev)]);
  const deltas = {};
  for (const cat of allCats) {
    deltas[cat] = (catLast[cat] || 0) - (catPrev[cat] || 0);
  }

  return {
    period: { from: prev, to: last },
    category_deltas: deltas,
    growing: Object.entries(deltas).filter(([,d]) => d > 0)
      .sort((a,b) => b[1]-a[1]).slice(0,3).map(([cat,delta]) => ({ cat, delta })),
  };
}

// ── Source-type cross-tabs ─────────────────────────────────────────────────────

function buildSourceTypeAnalytics(features) {
  const byType = {};
  for (const f of features) {
    const t = f.source_type;
    if (!byType[t]) byType[t] = [];
    byType[t].push(f);
  }

  const source_type_by_category = {};
  const source_type_by_maturity = {};
  const source_type_by_vector   = {};

  for (const [t, typeFeatures] of Object.entries(byType)) {
    source_type_by_category[t] = countBy(typeFeatures, (f) => f.main_category);
    source_type_by_maturity[t] = countBy(typeFeatures, (f) => f.threat_maturity);
    const vectors = countByArray(typeFeatures, (f) => f.attack_vectors);
    source_type_by_vector[t] = topN(vectors, 5).map((e) => e.key);
  }

  return { source_type_by_category, source_type_by_maturity, source_type_by_vector };
}

// ── Timeline events (for slides/appendix) ─────────────────────────────────────

function buildTimelineEvents(sources) {
  return sources
    .filter((s) => s.analytics_features?.date_published)
    .map((s) => {
      const f = s.analytics_features;
      return {
        date:              f.date_published,
        source_id:         s.id,
        title:             s.title,
        url:               s.url,
        publisher:         s.publisher,
        category:          f.main_category,
        source_type:       f.source_type,
        rawfact_priority:  s.rawfact_score_data?.rawfact_priority || null,
        rawfact_score:     s.rawfact_score_data?.rawfact_score ?? null,
        top_attack_vector: (f.attack_vectors || [])[0] || null,
        top_signal_cluster:(f.signal_clusters || [])[0] || null,
        source_summary:    s.understanding?.source_summary || s.summary || "",
        trust_tier:        f.trust_tier,
      };
    })
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

/**
 * Aggregate analytics data from all sources (Layer 5b.5).
 * Deterministic — no LLM calls.
 *
 * @param {object[]} sources - Sources with analytics_features set.
 * @returns {object} aggregates object with structured groups + backward-compat fields.
 */
export function aggregateAnalytics(sources) {
  // Extract features, skipping sources without analytics_features
  const allFeatures = sources
    .map((s) => s.analytics_features)
    .filter(Boolean)
    .filter((f) => f.analytics_use !== "exclude");

  // Sources with full or limited analytics
  const analyticsFeatures = allFeatures.filter(
    (f) => f.analytics_use === "full_analytics" || f.analytics_use === "limited_analytics"
  );

  // ── Corpus overview ────────────────────────────────────────────────────────

  const allMonths = Object.keys(
    monthlyCounts(analyticsFeatures, (f) => [f.main_category])
  ).sort();

  const corpus_overview = {
    total_sources:             sources.length,
    total_analytics_eligible:  analyticsFeatures.length,
    date_range: {
      start:  allMonths.length > 0 ? allMonths[0] + "-01" : null,
      end:    allMonths.length > 0 ? allMonths[allMonths.length - 1] + "-01" : null,
      months: allMonths.length,
    },
    category_counts:    sortedCounts(countBy(analyticsFeatures, (f) => f.main_category)),
    source_type_counts: sortedCounts(countBy(analyticsFeatures, (f) => f.source_type)),
    trust_tier_counts:  sortedCounts(countBy(analyticsFeatures, (f) => f.trust_tier)),
  };

  // ── Threat pattern analytics ───────────────────────────────────────────────

  const threat_pattern_analytics = {
    attack_vector_frequency:  sortedCounts(
      weightedCountByArray(analyticsFeatures, (f) => f.attack_vectors, (f) => f.aggregation_weight)
    ),
    attack_surface_distribution: sortedCounts(
      weightedCountByArray(analyticsFeatures, (f) => f.attack_surfaces, (f) => f.aggregation_weight)
    ),
    ai_layer_distribution:    sortedCounts(
      countByArray(analyticsFeatures, (f) => f.ai_layers)
    ),
    impact_type_frequency:    sortedCounts(
      countByArray(analyticsFeatures, (f) => f.impact_types)
    ),
    impact_scope_distribution:sortedCounts(
      countBy(analyticsFeatures, (f) => f.impact_scope)
    ),
    signal_cluster_counts:    sortedCounts(
      countByArray(analyticsFeatures, (f) => f.signal_clusters)
    ),
    recurring_theme_counts:   sortedCounts(
      countByArray(analyticsFeatures, (f) => f.recurring_themes)
    ),
  };

  // ── Maturity analytics ─────────────────────────────────────────────────────

  const catMaturities = {};
  const catOpStatus   = {};
  for (const cat of OFFENSIVE_CATEGORIES) {
    const catF = analyticsFeatures.filter((f) => f.main_category === cat);
    catMaturities[cat] = countBy(catF, (f) => f.threat_maturity);
    catOpStatus[cat]   = countBy(catF, (f) => f.operational_status);
  }

  const maturity_analytics = {
    operational_status_distribution:sortedCounts(countBy(analyticsFeatures, (f) => f.operational_status)),
    threat_maturity_distribution:   sortedCounts(countBy(analyticsFeatures, (f) => f.threat_maturity)),
    category_by_maturity:    catMaturities,
    category_by_operational_status: catOpStatus,
  };

  // ── Taxonomy analytics (Validated AI Threat Taxonomy) ──────────────────────

  const taxonomy_analytics = buildTaxonomyAnalytics(analyticsFeatures);

  // ── Timeline analytics ─────────────────────────────────────────────────────

  const timeline_analytics = buildTimelineAnalytics(analyticsFeatures);

  // ── Source-type analytics ──────────────────────────────────────────────────

  const source_type_analytics = buildSourceTypeAnalytics(analyticsFeatures);

  // ── Category analytics ─────────────────────────────────────────────────────

  const category_analytics = buildCategoryAnalytics(analyticsFeatures);

  // ── Governance analytics ───────────────────────────────────────────────────

  const govFeatures = analyticsFeatures.filter((f) => f.source_type === "governance_signal");
  const governance_analytics = {
    governance_function_frequency: sortedCounts(countByArray(govFeatures, (f) => f.governance_functions)),
    governance_by_sector:          sortedCounts(countByArray(govFeatures, (f) => f.sectors)),
    governance_by_geography:       sortedCounts(countByArray(govFeatures, (f) => f.geography)),
    total_governance_sources:      govFeatures.length,
  };

  // ── Defensive analytics ────────────────────────────────────────────────────

  const defFeatures = analyticsFeatures.filter((f) => f.source_type === "defensive_capability");
  const defControlFrequency = countByArray(defFeatures, (f) => f.defensive_controls);
  const defControlByVector  = {};
  for (const f of defFeatures) {
    for (const ctrl of (f.defensive_controls || [])) {
      if (!defControlByVector[ctrl]) defControlByVector[ctrl] = {};
      for (const vec of (f.attack_vectors || [])) {
        defControlByVector[ctrl][vec] = (defControlByVector[ctrl][vec] || 0) + 1;
      }
    }
  }

  // Mitigation gap: attack vectors with few defensive sources
  const attackVectorCounts = threat_pattern_analytics.attack_vector_frequency;
  const defensiveVectors   = new Set(defFeatures.flatMap((f) => f.attack_vectors || []));
  const mitigation_gap_signals = Object.entries(attackVectorCounts)
    .filter(([vec]) => !defensiveVectors.has(vec) && vec !== "unknown")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([vec, count]) => ({ attack_vector: vec, source_count: count, defensive_coverage: "none" }));

  const defensive_analytics = {
    defensive_control_frequency:    sortedCounts(defControlFrequency),
    defensive_control_by_attack_vector: defControlByVector,
    mitigation_gap_signals,
    total_defensive_sources: defFeatures.length,
  };

  // ── Ecosystem analytics ───────────────────────────────────────────────────

  const ecoFeatures = analyticsFeatures.filter(
    (f) => f.source_type === "ecosystem_signal" || f.source_type === "infrastructure_dependency_signal"
  );
  const ecosystem_analytics = {
    dependency_type_frequency:     sortedCounts(countByArray(ecoFeatures, (f) => f.dependency_types)),
    ecosystem_shift_frequency:     sortedCounts(countByArray(ecoFeatures, (f) => f.signal_clusters)),
    attack_surface_growth_signals: sortedCounts(countByArray(ecoFeatures, (f) => f.attack_surfaces)),
    total_ecosystem_sources:       ecoFeatures.length,
  };

  // ── Adversary adoption analytics ──────────────────────────────────────────

  const advFeatures = analyticsFeatures.filter(
    (f) => f.source_type === "adversary_adoption_signal" || f.source_type === "threat_intelligence"
  );
  const adversary_adoption_analytics = {
    adoption_stage_distribution:    sortedCounts(countBy(advFeatures, (f) => f.adversary_adoption_stage)),
    adversary_adoption_by_attack_vector: sortedCounts(
      countByArray(advFeatures, (f) => f.attack_vectors)
    ),
    adversary_adoption_by_category: sortedCounts(countBy(advFeatures, (f) => f.main_category)),
    total_adversary_sources:        advFeatures.length,
  };

  // ── Capability analytics ───────────────────────────────────────────────────

  const capFeatures = analyticsFeatures.filter(
    (f) => ["research_finding","benchmark_evaluation","capability_demonstration"].includes(f.source_type)
  );
  const capability_analytics = {
    capability_stage_distribution: sortedCounts(countBy(capFeatures, (f) => f.capability_stage)),
    capability_by_ai_layer:        sortedCounts(countByArray(capFeatures, (f) => f.ai_layers)),
    capability_by_attack_vector:   sortedCounts(countByArray(capFeatures, (f) => f.attack_vectors)),
    total_capability_sources:      capFeatures.length,
  };

  // ── Trust boundary analytics ──────────────────────────────────────────────

  const tbFeatures = analyticsFeatures.filter((f) => f.source_type === "trust_boundary_shift");
  const trust_boundary_analytics = {
    trust_boundary_shift_frequency: sortedCounts(
      countByArray(tbFeatures, (f) => f.trust_boundary_shift_types)
    ),
    authority_delegation_signals:   tbFeatures.filter(
      (f) => f.trust_boundary_shift_types.includes("authority_delegation")
    ).length,
    human_oversight_reduction_signals: tbFeatures.filter(
      (f) => f.trust_boundary_shift_types.includes("human_oversight_reduction")
    ).length,
    total_trust_boundary_sources: tbFeatures.length,
  };

  // ── Trend deltas ───────────────────────────────────────────────────────────

  const trend_deltas = buildTrendDeltas(timeline_analytics.monthly_category_timeline);

  // ── Timeline events (for slides) ──────────────────────────────────────────

  const timeline_events = buildTimelineEvents(sources);

  // ── Backward-compat flat fields ────────────────────────────────────────────
  // Old code reads these directly on the aggregates object. Keep them populated.

  const attack_vector_frequency  = threat_pattern_analytics.attack_vector_frequency;
  const attack_surface_frequency = threat_pattern_analytics.attack_surface_distribution;
  const ai_layer_frequency       = threat_pattern_analytics.ai_layer_distribution;
  const impact_type_frequency    = threat_pattern_analytics.impact_type_frequency;
  const signal_cluster_counts    = threat_pattern_analytics.signal_cluster_counts;
  const recurring_theme_counts   = threat_pattern_analytics.recurring_theme_counts;
  const maturity_distribution    = maturity_analytics.threat_maturity_distribution;
  const operational_status_distribution = maturity_analytics.operational_status_distribution;
  const impact_scope_distribution = threat_pattern_analytics.impact_scope_distribution;
  const category_counts          = corpus_overview.category_counts;
  const source_type_counts       = corpus_overview.source_type_counts;
  const trust_tier_counts        = corpus_overview.trust_tier_counts;
  const monthly_category_counts  = timeline_analytics.monthly_category_timeline;
  const monthly_source_type_counts = timeline_analytics.monthly_source_type_timeline;
  const monthly_attack_vector_counts = timeline_analytics.monthly_attack_vector_timeline;
  const monthly_maturity_counts  = timeline_analytics.monthly_maturity_timeline;
  const monthly_signal_cluster_counts = timeline_analytics.monthly_signal_cluster_timeline;

  // Old category_breakdowns format (renamed from category_analytics.per_category)
  const category_breakdowns = category_analytics.per_category;

  // attack_mapping_frequency now reflects AI-enabled operational ATT&CK mappings
  // (the validated taxonomy replaced the old standalone attack_mappings field).
  const attack_mapping_frequency = taxonomy_analytics.ai_enabled_mapping_frequency;
  // NIST governance was removed from the threat taxonomy; secondary dimensions
  // are the nearest contextual signal and are tracked separately.
  const governance_tag_frequency = taxonomy_analytics.secondary_dimension_frequency;

  // Old rawfact_priority_counts (from rawfact branch)
  const rawfact_priority_counts = sortedCounts(
    countBy(sources.filter((s) => s.rawfact_score_data?.rawfact_priority), (s) => s.rawfact_score_data.rawfact_priority)
  );

  // Top-N convenience lists
  const top = {
    attack_vectors:   topN(attack_vector_frequency, 10),
    attack_surfaces:  topN(attack_surface_frequency, 10),
    signal_clusters:  topN(signal_cluster_counts, 10),
    recurring_themes: topN(recurring_theme_counts, 8),
    sectors:          topN(sortedCounts(countByArray(analyticsFeatures, (f) => f.sectors)), 8),
    technologies:     topN(sortedCounts(countByArray(analyticsFeatures, (f) => f.technologies)), 10),
    ai_layers:        topN(ai_layer_frequency, 8),
  };

  return {
    // ── New structured groups ─────────────────────────────────────────────
    corpus_overview,
    threat_pattern_analytics,
    taxonomy_analytics,
    maturity_analytics,
    timeline_analytics,
    source_type_analytics,
    category_analytics,
    governance_analytics,
    defensive_analytics,
    ecosystem_analytics,
    adversary_adoption_analytics,
    capability_analytics,
    trust_boundary_analytics,
    trend_deltas,

    // ── Backward-compat flat fields ──────────────────────────────────────
    total_sources:               sources.length,
    taxonomy_done:               analyticsFeatures.length,
    date_range:                  corpus_overview.date_range,
    category_counts,
    source_type_counts,
    trust_tier_counts,
    attack_vector_frequency,
    attack_surface_frequency,
    ai_layer_distribution:       ai_layer_frequency,
    ai_layer_frequency,
    impact_type_frequency,
    impact_scope_distribution,
    attack_mapping_frequency,
    governance_tag_frequency,

    // ── Taxonomy flat fields (Validated AI Threat Taxonomy) ──
    domain_distribution:               taxonomy_analytics.domain_distribution,
    primary_threat_tag_frequency:      taxonomy_analytics.primary_threat_tag_frequency,
    parent_tag_frequency:              taxonomy_analytics.parent_tag_frequency,
    agentic_subdomain_frequency:       taxonomy_analytics.agentic_subdomain_frequency,
    ai_enabled_mapping_frequency:      taxonomy_analytics.ai_enabled_mapping_frequency,
    prompt_injection_subtype_frequency: taxonomy_analytics.prompt_injection_subtype_frequency,
    secondary_dimension_frequency:     taxonomy_analytics.secondary_dimension_frequency,
    taxonomy_validation_counts:        taxonomy_analytics.validation_status_counts,
    taxonomy_evidence_gaps:            taxonomy_analytics.evidence_gaps,
    agentic_attack_mapping_frequency: taxonomy_analytics.agentic_subdomain_frequency,
    operational_status_distribution,
    maturity_distribution,
    rawfact_priority_counts,
    sector_distribution: sortedCounts(countByArray(analyticsFeatures, (f) => f.sectors)),
    geography_distribution: sortedCounts(countByArray(analyticsFeatures, (f) => f.geography)),
    technology_frequency: sortedCounts(countByArray(analyticsFeatures, (f) => f.technologies)),
    entity_frequency: sortedCounts(countByArray(sources, (s) => s.understanding?.key_entities || [])),
    signal_cluster_counts,
    recurring_theme_counts,
    monthly_category_counts,
    monthly_source_type_counts,
    monthly_attack_vector_counts,
    monthly_maturity_counts,
    monthly_signal_cluster_counts,
    category_breakdowns,
    timeline_events,
    top,
    publisher_counts: sortedCounts(countBy(sources, (s) => s.publisher || "")),
  };
}
