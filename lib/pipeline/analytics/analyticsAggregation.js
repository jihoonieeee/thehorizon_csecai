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

// Like countBy but also tracks source_ids behind each key
function countByWithIds(items, keyFn, idFn = (f) => f.source_id) {
  const c = {};
  for (const item of items) {
    const k = keyFn(item);
    if (k == null || k === "") continue;
    if (!c[k]) c[k] = { count: 0, source_ids: [] };
    c[k].count++;
    const id = idFn(item);
    if (id) c[k].source_ids.push(id);
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

// Like countByArray but also tracks source_ids + weighted counts
function countByArrayWithIds(items, arrayFn, weightFn = () => 1, idFn = (f) => f.source_id) {
  const c = {};
  for (const item of items) {
    const w  = weightFn(item) || 1;
    const id = idFn(item);
    for (const v of (arrayFn(item) || [])) {
      if (!v) continue;
      if (!c[v]) c[v] = { count: 0, weighted: 0, source_ids: [] };
      c[v].count++;
      c[v].weighted = Math.round((c[v].weighted + w) * 100) / 100;
      if (id && !c[v].source_ids.includes(id)) c[v].source_ids.push(id);
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
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 100) / 100]));
}

function topN(obj, n = 10) {
  // Handles both plain { key: count } and { key: { count, weighted, source_ids } }
  return Object.entries(obj)
    .map(([key, val]) => ({
      key,
      count:    typeof val === "number" ? val : val.count,
      weighted: typeof val === "number" ? val : (val.weighted ?? val.count),
      source_ids: typeof val === "object" ? (val.source_ids || []) : [],
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

function sortedCounts(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => {
      const va = typeof b[1] === "number" ? b[1] : b[1].count;
      const vb = typeof a[1] === "number" ? a[1] : a[1].count;
      return va - vb;
    })
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

// Count non-zero months for a key across a monthly counts object.
// Returns the count of distinct months where that key appears.
function nonZeroMonthsForKey(monthlyCnt, key) {
  return Object.values(monthlyCnt).filter((m) => (m[key] || 0) > 0).length;
}

// Collect distinct source types contributing to a domain across months
function sourceTypesForDomain(features, domain) {
  return [...new Set(
    features.filter((f) => f.main_category === domain && f.source_type).map((f) => f.source_type)
  )];
}

// Build trend analytics with 3-bucket + 2-source-type enforcement
function buildTrendAnalytics(features, monthlyDomainCounts) {
  const months = Object.keys(monthlyDomainCounts).sort();
  const MIN_BUCKETS = 3;
  const MIN_SOURCE_TYPES = 2;  // trend claim requires ≥2 independent source types

  const monthly_domain_counts      = monthlyDomainCounts;
  const monthly_source_type_counts = monthlyCounts(features, (f) => f.source_type);
  const monthly_threat_tag_counts  = monthlyCounts(features, (f) =>
    (f.primary_threat_tags || []).map((t) => t.tag || t).filter(Boolean)
  );

  // Compute month-over-month deltas for domains
  const trend_deltas = {};
  for (const domain of ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"]) {
    const domainMonths = months.filter((m) => (monthlyDomainCounts[m]?.[domain] || 0) > 0);
    if (domainMonths.length < MIN_BUCKETS) continue;
    const recent = monthlyDomainCounts[months[months.length - 1]]?.[domain] || 0;
    const prior  = monthlyDomainCounts[months[months.length - 2]]?.[domain] || 0;
    trend_deltas[domain] = { recent, prior, delta: recent - prior, trend: recent > prior ? "increasing" : recent < prior ? "decreasing" : "stable" };
  }

  // Per-domain trend sufficiency — strict: ≥3 non-zero months AND ≥2 source types
  const valid_trend_candidates = [];
  const emerging_signals       = [];  // backward compat
  const persistent_signals     = [];  // backward compat
  const recurring_patterns     = [];
  const burst_clusters         = [];
  const insufficient_trend_data = [];

  for (const domain of ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"]) {
    const nonZero       = months.filter((m) => (monthlyDomainCounts[m]?.[domain] || 0) > 0).length;
    const allCounts     = months.map((m) => monthlyDomainCounts[m]?.[domain] || 0);
    const totalCount    = allCounts.reduce((s, v) => s + v, 0);
    const avg           = totalCount / Math.max(months.length, 1);
    const last          = allCounts[allCounts.length - 1] || 0;
    const srcTypes      = sourceTypesForDomain(features, domain);
    const srcTypeCount  = srcTypes.length;

    if (nonZero >= MIN_BUCKETS && srcTypeCount >= MIN_SOURCE_TYPES) {
      const direction = last > avg * 1.2 ? "increasing" : last < avg * 0.8 ? "decreasing" : "stable";
      const candidate = {
        key: domain, type: "domain",
        non_zero_months: nonZero,
        direction,
        source_type_count: srcTypeCount,
        source_types: srcTypes,
        caveat_if_any: null,
      };
      valid_trend_candidates.push(candidate);
      if (direction === "increasing") emerging_signals.push(domain);
      else if (nonZero >= months.length * 0.6) persistent_signals.push(domain);
      if (direction === "stable" && nonZero >= MIN_BUCKETS) recurring_patterns.push({ ...candidate, label: "recurring_pattern" });
    } else if (nonZero >= 1) {
      // Check if it's a burst (spike in 1-2 months, not sustained)
      const maxCount = Math.max(...allCounts);
      const peakIdx  = allCounts.indexOf(maxCount);
      const peakMonth = months[peakIdx] || null;
      if (maxCount > avg * 2 && nonZero < MIN_BUCKETS) {
        burst_clusters.push({
          key: domain,
          type: "domain",
          peak_month: peakMonth,
          peak_count: maxCount,
          avg_count: Math.round(avg * 10) / 10,
          non_zero_months: nonZero,
          source_ids: [],
          caveat_if_any: "Burst pattern, not a trend — needs ≥ 3 non-zero months to qualify as a trend.",
        });
      } else {
        insufficient_trend_data.push({
          key: domain,
          type: "domain",
          non_zero_months: nonZero,
          source_type_count: srcTypeCount,
          reason: nonZero < MIN_BUCKETS
            ? `Only ${nonZero} non-zero month bucket(s); need ≥ ${MIN_BUCKETS} for a trend claim`
            : `Only ${srcTypeCount} independent source type(s); need ≥ ${MIN_SOURCE_TYPES} for a trend claim`,
        });
      }
    }
  }

  const trend_language_note = "All trend references describe corpus-level collection patterns, not real-world prevalence. Use 'within the collected corpus' phrasing, not 'globally increasing'.";

  return {
    monthly_domain_counts,
    monthly_source_type_counts,
    monthly_threat_tag_counts,
    trend_deltas,
    valid_trend_candidates,
    emerging_signals,
    persistent_signals,
    recurring_patterns,
    burst_clusters,
    insufficient_trend_data,
    trend_language_note,
    month_count: months.length,
  };
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

// ── Taxonomy analytics (taxonomy-v9) ──────────────────────────────────────────
// Counts primary tags, sub-techniques, AI-enabled roles, and overlays.
// Secondary dimensions never mix into primary-threat frequency.

function getPrimaryTagsFromFeature(f) {
  // Support both new (primary_tags) and legacy (primary_threat_tags) field names
  const list = Array.isArray(f.primary_tags)
    ? f.primary_tags
    : (Array.isArray(f.primary_threat_tags) ? f.primary_threat_tags : []);
  return list.map((t) => (typeof t === "string" ? t : t?.tag)).filter(Boolean);
}

function getSubTechsFromFeature(f) {
  return (f.sub_techniques || [])
    .map((s) => (typeof s === "string" ? s : s?.id)).filter(Boolean);
}

function buildTaxonomyAnalytics(features) {
  const validated = features.filter((f) => f.taxonomy_validation_status === "validated");

  // AI-enabled overlay analytics
  const aiEnabledSources = features.filter((f) => f.ai_enabled === true);
  const aiEnabledByDomain = countBy(aiEnabledSources, (f) => f.primary_domain);
  const aiEnabledRoleFreq = countByArray(features, (f) =>
    Array.isArray(f.ai_enabled_roles) ? f.ai_enabled_roles : []
  );
  const aiCapabilityFreq = countByArray(features, (f) =>
    Array.isArray(f.ai_capabilities) ? f.ai_capabilities : []
  );

  return {
    domain_distribution:            sortedCounts(countBy(features, (f) => f.primary_domain)),
    primary_tag_frequency:          sortedCounts(countByArray(features, getPrimaryTagsFromFeature)),
    sub_technique_frequency:        sortedCounts(countByArray(features, getSubTechsFromFeature)),
    // AI-enabled overlay analytics
    ai_enabled_source_count:        aiEnabledSources.length,
    ai_enabled_by_domain:           sortedCounts(aiEnabledByDomain),
    ai_enabled_role_frequency:      sortedCounts(aiEnabledRoleFreq),
    ai_capability_frequency:        sortedCounts(aiCapabilityFreq),
    automation_level_distribution:  sortedCounts(countBy(features, (f) => f.automation_level)),
    autonomy_level_distribution:    sortedCounts(countBy(features, (f) => f.autonomy_level)),
    // AI-enabled overlay by primary tag (cross-tab)
    ai_enabled_overlay_by_primary_tag: buildCrossTab(
      features.filter((f) => f.ai_enabled),
      getPrimaryTagsFromFeature,
      (f) => Array.isArray(f.ai_enabled_roles) ? f.ai_enabled_roles : []
    ),
    // Evidence quality
    validation_status_counts:       sortedCounts(countBy(features, (f) => f.taxonomy_validation_status)),
    validated_primary_tag_frequency:sortedCounts(countByArray(validated, getPrimaryTagsFromFeature)),
    evidence_gaps: {
      validated:           features.filter((f) => f.taxonomy_validation_status === "validated").length,
      weak:                features.filter((f) => f.taxonomy_validation_status === "weak").length,
      needs_manual_review: features.filter((f) => f.taxonomy_validation_status === "needs_manual_review").length,
    },
    // Thin coverage flags
    thin_primary_tags: Object.entries(countByArray(features, getPrimaryTagsFromFeature))
      .filter(([, c]) => c < 3).map(([t]) => t),
    // Back-compat fields used by existing slides/synthesis code
    primary_threat_tag_frequency:   sortedCounts(countByArray(features, getPrimaryTagsFromFeature)),
    ai_enabled_mapping_frequency:   sortedCounts(aiEnabledRoleFreq),
    ai_enabled_tag_frequency:       sortedCounts(countByArray(features, (f) =>
      f.primary_domain === "ai_enabled_threats" ? getPrimaryTagsFromFeature(f) : []
    )),
    prompt_injection_subtype_frequency: sortedCounts(countByArray(features, (f) =>
      getSubTechsFromFeature(f).filter((s) =>
        s.includes("prompt_injection") || s.includes("instruction_override") || s.includes("prompt_obfuscation")
      )
    )),
    secondary_dimension_frequency: sortedCounts(countByArray(features, (f) => f.secondary_dimensions || [])),
    parent_tag_frequency:          {},  // no longer used (flattened in v9)
    agentic_subdomain_frequency:   {},  // no longer used (use sub_technique_frequency)
  };
}

// Build a cross-tab: { primaryTag: { roleTag: count } }
function buildCrossTab(items, keysFn, rolesFn) {
  const result = {};
  for (const item of items) {
    for (const key of keysFn(item)) {
      if (!result[key]) result[key] = {};
      for (const role of rolesFn(item)) {
        result[key][role] = (result[key][role] || 0) + 1;
      }
    }
  }
  return result;
}

/**
 * Flatten taxonomy distributions into normalized metric rows for analytics_metrics table.
 */
export function buildTaxonomyMetricRows(aggregates = {}) {
  const rows = [];
  const push = (metric_name, value, extra = {}) =>
    rows.push({ metric_name, value, calculation_method: "count_of_validated_primary_tags", confidence: "high", ...extra });

  for (const [domain, value] of Object.entries(aggregates.domain_distribution || {}))
    push("domain_count", value, { domain });
  for (const [tag, value] of Object.entries(aggregates.primary_tag_frequency || {}))
    push("primary_tag_count", value, { primary_threat_tag: tag, domain: getTag(tag)?.domain || null });
  for (const [sub, value] of Object.entries(aggregates.sub_technique_frequency || {}))
    push("sub_technique_count", value, { primary_threat_tag: sub });
  for (const [role, value] of Object.entries(aggregates.ai_enabled_role_frequency || {}))
    push("ai_enabled_role_count", value, { primary_threat_tag: role, domain: "ai_enabled_threats" });
  for (const [cap, value] of Object.entries(aggregates.ai_capability_frequency || {}))
    push("ai_capability_count", value, { caveat_if_any: "overlay metadata, not primary threat" });

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
        rawfact_strength:  s.rawfact_evidence_summary?.strongest_strength || null,
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

  const excludedCount = allFeatures.filter((f) => f.analytics_use === "exclude").length;

  // Corpus limitations — describe weaknesses in the dataset
  const corpus_limitations = [];
  if (analyticsFeatures.length < 10) {
    corpus_limitations.push(`Small corpus (${analyticsFeatures.length} eligible sources) — distributions may not be representative.`);
  }
  if (allMonths.length < 3) {
    corpus_limitations.push(`Only ${allMonths.length} distinct month(s) — trend analysis is unreliable.`);
  }
  const lowTrustCount = analyticsFeatures.filter((f) => f.trust_tier === "low" || f.trust_tier === "unknown").length;
  if (lowTrustCount > analyticsFeatures.length * 0.4) {
    corpus_limitations.push(`${lowTrustCount} sources (${Math.round(lowTrustCount / analyticsFeatures.length * 100)}%) are low/unknown trust — weighted counts partially compensate.`);
  }
  const unknownTypeCount = analyticsFeatures.filter((f) => f.source_type === "unknown").length;
  if (unknownTypeCount > 0) {
    corpus_limitations.push(`${unknownTypeCount} sources have source_type=unknown — these contribute to counts at reduced weight.`);
  }
  const dominantCategory = Object.entries(countBy(analyticsFeatures, (f) => f.main_category))
    .sort((a, b) => b[1] - a[1])[0];
  if (dominantCategory && dominantCategory[1] / analyticsFeatures.length > 0.6) {
    corpus_limitations.push(`${Math.round(dominantCategory[1] / analyticsFeatures.length * 100)}% of sources are in ${dominantCategory[0]} — cross-domain comparisons may be skewed.`);
  }

  const corpus_overview = {
    total_sources:             sources.length,
    eligible_sources:          analyticsFeatures.length,
    excluded_sources:          excludedCount,
    total_analytics_eligible:  analyticsFeatures.length,  // backward compat alias
    date_range: {
      start:  allMonths.length > 0 ? allMonths[0] + "-01" : null,
      end:    allMonths.length > 0 ? allMonths[allMonths.length - 1] + "-01" : null,
      months: allMonths.length,
    },
    category_counts:    sortedCounts(countBy(analyticsFeatures, (f) => f.main_category)),
    source_type_counts: sortedCounts(countBy(analyticsFeatures, (f) => f.source_type)),
    trust_tier_counts:  sortedCounts(countBy(analyticsFeatures, (f) => f.trust_tier)),
    corpus_limitations,
  };

  // ── Threat pattern analytics ───────────────────────────────────────────────

  // Threat frequency with source_id tracking (Deliverable 3)
  const attack_vector_frequency_with_ids   = countByArrayWithIds(
    analyticsFeatures, (f) => f.attack_vectors, (f) => f.aggregation_weight
  );
  const attack_surface_frequency_with_ids  = countByArrayWithIds(
    analyticsFeatures, (f) => f.attack_surfaces, (f) => f.aggregation_weight
  );
  const domain_frequency_with_ids          = countByWithIds(analyticsFeatures, (f) => f.main_category);

  const threat_pattern_analytics = {
    // With source_id tracking (new)
    attack_vector_frequency_tracked:    attack_vector_frequency_with_ids,
    attack_surface_frequency_tracked:   attack_surface_frequency_with_ids,
    domain_frequency_tracked:           domain_frequency_with_ids,
    // Plain weighted counts (backward compat)
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
    (f) => f.source_type === "attack_surface_signal"
  );
  const ecosystem_analytics = {
    dependency_type_frequency:     sortedCounts(countByArray(ecoFeatures, (f) => f.dependency_types)),
    ecosystem_shift_frequency:     sortedCounts(countByArray(ecoFeatures, (f) => f.signal_clusters)),
    attack_surface_growth_signals: sortedCounts(countByArray(ecoFeatures, (f) => f.attack_surfaces)),
    total_ecosystem_sources:       ecoFeatures.length,
  };

  // ── Adversary adoption analytics ──────────────────────────────────────────
  // Only operational source types can support adversary adoption claims.
  // governance_signal, attack_surface_signal must NOT be used alone.

  const ADOPTION_SOURCE_TYPES = new Set(["adversary_adoption_signal","threat_intelligence","incident","exploit_disclosure"]);
  const advFeatures = analyticsFeatures.filter((f) => ADOPTION_SOURCE_TYPES.has(f.source_type));
  const advFeaturesAll = analyticsFeatures; // for context-only comparison

  const adoptionStageById  = countByWithIds(advFeatures, (f) => f.adversary_adoption_stage);
  const adoptionByVector   = countByArrayWithIds(advFeatures, (f) => f.attack_vectors, (f) => f.aggregation_weight);

  // Identify sources from non-adoption types that mention adversary activity (for caveats)
  const nonAdoptionTypeCount = analyticsFeatures.filter(
    (f) => !ADOPTION_SOURCE_TYPES.has(f.source_type) &&
           f.adversary_adoption_stage && f.adversary_adoption_stage !== "none_observed" && f.adversary_adoption_stage !== "unknown"
  ).length;

  const adoption_caveats = [];
  if (advFeatures.length < 3) {
    adoption_caveats.push(`Only ${advFeatures.length} operational-type sources for adversary adoption — findings may not be representative.`);
  }
  if (nonAdoptionTypeCount > 0) {
    adoption_caveats.push(`${nonAdoptionTypeCount} non-operational source(s) contain adversary adoption signals that are excluded from this analysis.`);
  }

  const adversary_adoption_analytics = {
    adversary_adoption_distribution:     adoptionStageById,
    adversary_adoption_by_domain:        sortedCounts(countBy(advFeatures, (f) => f.main_category)),
    adversary_adoption_by_source_type:   sortedCounts(countBy(advFeatures, (f) => f.source_type)),
    adversary_adoption_evidence:         advFeatures.filter(
      (f) => f.adversary_adoption_stage &&
             !["none_observed","unknown"].includes(f.adversary_adoption_stage)
    ).map((f) => ({
      source_id: f.source_id,
      source_type: f.source_type,
      adoption_stage: f.adversary_adoption_stage,
      domain: f.main_category,
      attack_vectors: (f.attack_vectors || []).slice(0, 3),
    })),
    adoption_caveats,
    // Flat backward compat
    adoption_stage_distribution:         sortedCounts(countBy(advFeatures, (f) => f.adversary_adoption_stage)),
    adversary_adoption_by_attack_vector: sortedCounts(countByArray(advFeatures, (f) => f.attack_vectors)),
    adversary_adoption_by_category:      sortedCounts(countBy(advFeatures, (f) => f.main_category)),
    total_adversary_sources:             advFeatures.length,
  };

  // ── Capability analytics ───────────────────────────────────────────────────

  const CAP_SOURCE_TYPES = new Set(["research_finding","benchmark_evaluation","capability_demonstration","exploit_disclosure","threat_intelligence"]);
  const capFeatures = analyticsFeatures.filter((f) => CAP_SOURCE_TYPES.has(f.source_type));

  // research_to_poc_signals: sources at lab_validated or benchmark_demonstrated
  const researchToPoc = capFeatures.filter(
    (f) => ["lab_validated","benchmark_demonstrated"].includes(f.capability_stage)
  );
  // poc_to_operational_signals: sources at proof_of_concept or tool_available
  const pocToOperational = capFeatures.filter(
    (f) => ["proof_of_concept","tool_available"].includes(f.capability_stage)
  );
  // watchlist: tool_available or operationally_reported with high-threat domain
  const watchlist = capFeatures.filter(
    (f) => ["tool_available","operationally_reported"].includes(f.capability_stage) &&
           ["llm_threats","agentic_ai_threats","ai_enabled_threats"].includes(f.main_category)
  );

  const capability_analytics = {
    capability_stage_distribution:    countByWithIds(capFeatures, (f) => f.capability_stage),
    capability_stage_by_domain:       sortedCounts(countBy(capFeatures, (f) => f.main_category)),
    research_to_poc_signals:          researchToPoc.map((f) => ({
      source_id: f.source_id, domain: f.main_category, stage: f.capability_stage,
      attack_vectors: (f.attack_vectors || []).slice(0, 3),
    })),
    poc_to_operational_signals:       pocToOperational.map((f) => ({
      source_id: f.source_id, domain: f.main_category, stage: f.capability_stage,
      attack_vectors: (f.attack_vectors || []).slice(0, 3),
    })),
    capability_watchlist:             watchlist.map((f) => ({
      source_id: f.source_id, domain: f.main_category, stage: f.capability_stage,
      attack_vectors: (f.attack_vectors || []).slice(0, 3),
    })),
    // Flat backward compat
    capability_by_ai_layer:           sortedCounts(countByArray(capFeatures, (f) => f.ai_layers)),
    capability_by_attack_vector:      sortedCounts(countByArray(capFeatures, (f) => f.attack_vectors)),
    total_capability_sources:         capFeatures.length,
  };

  // ── Trust boundary analytics ──────────────────────────────────────────────

  const tbFeatures = analyticsFeatures.filter((f) => f.source_type === "attack_surface_signal");
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

  // ── Trend analytics (Deliverable 8 — with 3-bucket enforcement) ────────────

  const trend_analytics = buildTrendAnalytics(analyticsFeatures, timeline_analytics.monthly_category_timeline);
  const trend_deltas    = buildTrendDeltas(timeline_analytics.monthly_category_timeline);  // backward compat

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

  // Rawfact strength counts (from rawfact branch — strongest evidence per source)
  const rawfact_strength_counts = sortedCounts(
    countBy(sources.filter((s) => s.rawfact_evidence_summary?.strongest_strength), (s) => s.rawfact_evidence_summary.strongest_strength)
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
    trend_analytics,
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

    // ── Taxonomy flat fields (taxonomy-v9) ──
    domain_distribution:               taxonomy_analytics.domain_distribution,
    primary_tag_frequency:             taxonomy_analytics.primary_tag_frequency,
    sub_technique_frequency:           taxonomy_analytics.sub_technique_frequency,
    ai_enabled_role_frequency:         taxonomy_analytics.ai_enabled_role_frequency,
    ai_capability_frequency:           taxonomy_analytics.ai_capability_frequency,
    ai_enabled_by_domain:              taxonomy_analytics.ai_enabled_by_domain,
    ai_enabled_overlay_by_primary_tag: taxonomy_analytics.ai_enabled_overlay_by_primary_tag,
    automation_level_distribution:     taxonomy_analytics.automation_level_distribution,
    autonomy_level_distribution:       taxonomy_analytics.autonomy_level_distribution,
    thin_primary_tags:                 taxonomy_analytics.thin_primary_tags,
    // Back-compat aliases
    primary_threat_tag_frequency:      taxonomy_analytics.primary_tag_frequency,
    parent_tag_frequency:              taxonomy_analytics.parent_tag_frequency,
    agentic_subdomain_frequency:       taxonomy_analytics.agentic_subdomain_frequency,
    ai_enabled_mapping_frequency:      taxonomy_analytics.ai_enabled_role_frequency,
    prompt_injection_subtype_frequency: taxonomy_analytics.prompt_injection_subtype_frequency,
    secondary_dimension_frequency:     taxonomy_analytics.secondary_dimension_frequency,
    taxonomy_validation_counts:        taxonomy_analytics.validation_status_counts,
    taxonomy_evidence_gaps:            taxonomy_analytics.evidence_gaps,
    agentic_attack_mapping_frequency:  taxonomy_analytics.agentic_subdomain_frequency,
    operational_status_distribution,
    maturity_distribution,
    rawfact_strength_counts,
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
