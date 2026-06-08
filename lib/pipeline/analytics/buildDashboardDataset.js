/**
 * Layer 5B — Dashboard Dataset Builder
 *
 * Converts 5B analytics outputs into a structured dashboard_dataset object
 * with 6 dashboard views. Every chart segment is traceable to source_ids
 * and analytics_evidence_ids.
 *
 * Deterministic — no LLM calls.
 *
 * ── DASHBOARD VIEWS ──────────────────────────────────────────────────────────
 *   1. overview              — corpus summary cards
 *   2. threat_landscape      — taxonomy heatmap, tag explorer, filters
 *   3. operational_maturity  — capability funnel, adoption stages, maturity
 *   4. attack_surface        — affected layers, tools, trust boundaries
 *   5. trends                — monthly activity, trend candidates, bursts
 *   6. evidence_explorer     — filterable source/evidence list
 */

// ── Helpers ────────────────────────────────────────────────────────────────────

function sortedEntries(obj, n = 20) {
  if (!obj) return [];
  return Object.entries(obj)
    .sort((a, b) => {
      const va = typeof b[1] === "number" ? b[1] : (b[1]?.count || 0);
      const vb = typeof a[1] === "number" ? a[1] : (a[1]?.count || 0);
      return va - vb;
    })
    .slice(0, n);
}

function safeCount(v) {
  return typeof v === "number" ? v : (v?.count || 0);
}

function extractSourceIds(tracked, keys = null) {
  const ids = [];
  for (const [k, v] of Object.entries(tracked || {})) {
    if (keys && !keys.includes(k)) continue;
    if (v?.source_ids) ids.push(...v.source_ids);
  }
  return [...new Set(ids)].slice(0, 50);
}

// ── View builders ──────────────────────────────────────────────────────────────

function buildOverview(aggregates, analyticsEvidence) {
  const cp = aggregates.corpus_overview || {};
  const dm = aggregates;

  // Top validated analytics findings for the overview panel
  const topFindings = analyticsEvidence
    .filter((e) => e.confidence === "high" || e.confidence === "medium")
    .slice(0, 5)
    .map((e) => ({
      analytics_evidence_id: e.analytics_evidence_id,
      finding:               e.finding,
      metric_type:           e.metric_type || e.evidence_type,
      confidence:            e.confidence,
      caveat_if_any:         e.caveat_if_any,
    }));

  return {
    view: "overview",
    cards: {
      total_sources:       cp.total_sources || 0,
      eligible_sources:    cp.eligible_sources || cp.total_analytics_eligible || 0,
      excluded_sources:    cp.excluded_sources || 0,
      date_range:          cp.date_range || {},
      months_covered:      cp.date_range?.months || 0,
      category_breakdown:  cp.category_counts || {},
      source_type_breakdown: cp.source_type_counts || {},
      trust_tier_breakdown:  cp.trust_tier_counts || {},
      corpus_limitations:  cp.corpus_limitations || [],
    },
    evidence_confidence_summary: {
      high:   analyticsEvidence.filter((e) => e.confidence === "high").length,
      medium: analyticsEvidence.filter((e) => e.confidence === "medium").length,
      low:    analyticsEvidence.filter((e) => e.confidence === "low").length,
    },
    top_validated_findings: topFindings,
    visualization_ids: ["category_distribution","source_type_distribution","trust_tier_distribution","corpus_timeline"],
  };
}

function buildThreatLandscape(aggregates) {
  const ta = aggregates.taxonomy_analytics || {};
  const tp = aggregates.threat_pattern_analytics || {};

  // Primary tag frequency as heatmap rows, traceable to source_ids
  const tagRows = sortedEntries(ta.primary_tag_frequency, 20).map(([tag, count]) => ({
    tag,
    count: safeCount(count),
  }));

  // Category × primary tag cross-tab
  const catByTag = {};
  for (const cat of ["traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats"]) {
    const catData = aggregates.category_analytics?.per_category?.[cat] || {};
    catByTag[cat] = { count: catData.count || 0, top_vectors: catData.top_vectors || [] };
  }

  // AI-enabled role frequency
  const aiRoles = sortedEntries(ta.ai_enabled_role_frequency, 10).map(([role, count]) => ({
    role,
    count: safeCount(count),
  }));

  return {
    view: "threat_landscape",
    taxonomy_heatmap: {
      primary_tag_rows: tagRows,
      sub_technique_frequency: ta.sub_technique_frequency || {},
      ai_enabled_by_domain: ta.ai_enabled_by_domain || {},
      automation_level_distribution: ta.automation_level_distribution || {},
      autonomy_level_distribution: ta.autonomy_level_distribution || {},
      taxonomy_coverage_gaps: ta.thin_primary_tags || [],
    },
    ai_enabled_overlay: {
      ai_enabled_role_frequency: aiRoles,
      ai_capability_frequency: sortedEntries(ta.ai_capability_frequency, 10).map(([c, n]) => ({ capability: c, count: safeCount(n) })),
    },
    attack_frequency: {
      top_attack_vectors:  sortedEntries(tp.attack_vector_frequency || {}, 15).map(([k, n]) => ({ key: k, count: safeCount(n) })),
      top_attack_surfaces: sortedEntries(tp.attack_surface_distribution || {}, 15).map(([k, n]) => ({ key: k, count: safeCount(n) })),
      top_ai_layers:       sortedEntries(tp.ai_layer_distribution || {}, 10).map(([k, n]) => ({ key: k, count: safeCount(n) })),
    },
    category_summaries:      catByTag,
    filters: {
      available_categories:    Object.keys(aggregates.corpus_overview?.category_counts || {}),
      available_source_types:  Object.keys(aggregates.corpus_overview?.source_type_counts || {}),
      available_trust_tiers:   Object.keys(aggregates.corpus_overview?.trust_tier_counts || {}),
    },
    visualization_ids: ["primary_threat_tag_distribution","taxonomy_heatmap","domain_distribution","ai_enabled_mapping_distribution","attack_vector_frequency","attack_surface_heatmap"],
  };
}

function buildOperationalMaturity(aggregates) {
  const ma  = aggregates.maturity_analytics || {};
  const adv = aggregates.adversary_adoption_analytics || {};
  const cap = aggregates.capability_analytics || {};

  // Capability funnel — ordered by pipeline stage
  const capDist = cap.capability_stage_distribution || {};
  const FUNNEL_ORDER = ["concept","lab_validated","benchmark_demonstrated","proof_of_concept","tool_available","operationally_reported","unknown"];
  const funnel = FUNNEL_ORDER
    .map((s) => ({ stage: s, count: safeCount(capDist[s] || 0), source_ids: capDist[s]?.source_ids || [] }))
    .filter((f) => f.count > 0);

  // Adoption stage distribution — from adversary-type sources only
  const adoptionDist = adv.adversary_adoption_distribution || {};
  const adoptionRows = Object.entries(adoptionDist)
    .map(([stage, val]) => ({ stage, count: safeCount(val), source_ids: val?.source_ids || [] }))
    .sort((a, b) => b.count - a.count);

  // Watchlist items
  const watchlist = (cap.capability_watchlist || []).map((w) => ({
    source_id:     w.source_id,
    domain:        w.domain,
    stage:         w.stage,
    attack_vectors: w.attack_vectors,
  }));

  return {
    view: "operational_maturity",
    capability_funnel: {
      stages:         funnel,
      total_sources:  cap.total_capability_sources || 0,
      watchlist_count:(cap.capability_watchlist || []).length,
    },
    adoption_stages: {
      distribution:         adoptionRows,
      total_adversary_sources: adv.total_adversary_sources || 0,
      active_adoption_count:   adoptionRows.filter((r) => ["limited_operational_use","active_operational_use","widespread_use"].includes(r.stage)).reduce((s, r) => s + r.count, 0),
      caveats:              adv.adoption_caveats || [],
    },
    maturity_by_category: ma.category_by_maturity || {},
    operational_by_category: ma.category_by_operational_status || {},
    capability_watchlist: watchlist,
    research_to_poc_signals: (cap.research_to_poc_signals || []).slice(0, 20),
    poc_to_operational_signals: (cap.poc_to_operational_signals || []).slice(0, 20),
    visualization_ids: ["maturity_distribution","operational_status_by_category","capability_pipeline_funnel","adoption_stage_distribution","adversary_adoption_distribution","category_maturity_matrix"],
  };
}

function buildAttackSurface(aggregates) {
  const tp  = aggregates.threat_pattern_analytics || {};
  const eco = aggregates.ecosystem_analytics || {};
  const tb  = aggregates.trust_boundary_analytics || {};

  return {
    view: "attack_surface",
    ai_layer_frequency:        sortedEntries(tp.ai_layer_distribution || {}, 12).map(([k, n]) => ({ layer: k, count: safeCount(n) })),
    attack_surface_frequency:  sortedEntries(tp.attack_surface_distribution || {}, 15).map(([k, n]) => ({ surface: k, count: safeCount(n) })),
    dependency_exposure: {
      dependency_type_frequency: sortedEntries(eco.dependency_type_frequency || {}, 10).map(([k, n]) => ({ type: k, count: safeCount(n) })),
      total_ecosystem_sources:   eco.total_ecosystem_sources || 0,
    },
    trust_boundary: {
      shift_frequency:              sortedEntries(tb.trust_boundary_shift_frequency || {}, 10).map(([k, n]) => ({ shift_type: k, count: safeCount(n) })),
      authority_delegation_signals: tb.authority_delegation_signals || 0,
      oversight_reduction_signals:  tb.human_oversight_reduction_signals || 0,
      total_sources:                tb.total_trust_boundary_sources || 0,
    },
    impact_type_frequency: sortedEntries(tp.impact_type_frequency || {}, 10).map(([k, n]) => ({ type: k, count: safeCount(n) })),
    visualization_ids: ["ai_layer_frequency","attack_surface_heatmap","trust_boundary_frequency","dependency_exposure_matrix"],
  };
}

function buildTrends(aggregates) {
  const trend = aggregates.trend_analytics || {};

  return {
    view: "trends",
    monthly_activity: {
      monthly_domain_counts:      trend.monthly_domain_counts || {},
      monthly_source_type_counts: trend.monthly_source_type_counts || {},
      monthly_threat_tag_counts:  trend.monthly_threat_tag_counts || {},
      month_count:                trend.month_count || 0,
    },
    valid_trend_candidates: (trend.valid_trend_candidates || []).map((tc) => ({
      ...tc,
      corpus_scoped_label: `Within the collected corpus, '${tc.key}' shows a ${tc.direction} pattern across ${tc.non_zero_months} months (${tc.source_type_count} source types).`,
    })),
    recurring_patterns: (trend.recurring_patterns || []).map((rp) => ({
      ...rp,
      corpus_scoped_label: `Within the collected corpus, '${rp.key}' shows a recurring but stable pattern.`,
    })),
    burst_clusters: (trend.burst_clusters || []).map((bc) => ({
      ...bc,
      corpus_scoped_label: `Within the collected corpus, '${bc.key}' shows a burst pattern in ${bc.peak_month} (not a trend).`,
    })),
    insufficient_trend_data: trend.insufficient_trend_data || [],
    trend_language_note: trend.trend_language_note || "",
    visualization_ids: ["monthly_category_timeline","corpus_timeline","category_trend_delta"],
  };
}

function buildEvidenceExplorer(aggregates, analyticsEvidence, analyticsSources) {
  // Build per-source evidence index for drilldown
  const sourceIndex = {};
  for (const src of (analyticsSources || [])) {
    const f = src.analytics_features || {};
    sourceIndex[src.id] = {
      source_id:   src.id,
      title:       src.title,
      url:         src.url,
      publisher:   src.publisher,
      date:        src.date_published || f.date_published,
      category:    f.main_category || src.main_category,
      source_type: f.source_type || src.source_type,
      trust_tier:  f.trust_tier || src.trust_tier,
      analytics_eligibility: src.analytics_eligibility?.analytics_use || "unknown",
      rawfact_strength: src.rawfact_evidence_summary?.strongest_strength || null,
    };
  }

  // Filter specs: evidence coverage flags
  const gapItems = analyticsEvidence.filter((e) =>
    ["coverage_gap","evidence_confidence","insufficient_trend_data"].includes(e.metric_type || e.evidence_type)
  );

  return {
    view: "evidence_explorer",
    source_index:          sourceIndex,
    analytics_evidence_index: Object.fromEntries(
      analyticsEvidence.map((e) => [e.analytics_evidence_id, {
        analytics_evidence_id:  e.analytics_evidence_id,
        finding:                e.finding,
        metric_type:            e.metric_type || e.evidence_type,
        confidence:             e.confidence,
        domain:                 e.domain,
        source_ids:             e.source_ids,
        supports_claim_types:   e.supports_claim_types,
        recommended_visualization_ids: e.recommended_visualization_ids,
        caveat_if_any:          e.caveat_if_any,
      }])
    ),
    coverage_gaps:         gapItems,
    filters: {
      available_categories:   [...new Set(Object.values(sourceIndex).map((s) => s.category).filter(Boolean))],
      available_source_types: [...new Set(Object.values(sourceIndex).map((s) => s.source_type).filter(Boolean))],
      available_trust_tiers:  [...new Set(Object.values(sourceIndex).map((s) => s.trust_tier).filter(Boolean))],
      available_publishers:   [...new Set(Object.values(sourceIndex).map((s) => s.publisher).filter(Boolean))].slice(0, 50),
    },
    visualization_ids: ["evidence_strength_by_category","evidence_gap_matrix","source_type_by_category","external_evidence_coverage"],
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

function buildExternalEvidenceExplorer(externalEvidence = [], externalVisuals = [], unsupportedQueries = [], sourceQualityReport = null, websearchValidationReport = null) {
  const byQuality  = { authoritative: [], reputable: [], mixed: [], weak: [] };
  const byCategory = {};
  const byEvidenceType = {};

  for (const e of externalEvidence) {
    (byQuality[e.source_quality] ||= []).push(e.external_evidence_id || e.evidence_id);
    (byCategory[e.category || "unknown"] ||= []).push(e.external_evidence_id || e.evidence_id);
    (byEvidenceType[e.evidence_type] ||= []).push(e.external_evidence_id || e.evidence_id);
  }

  return {
    view: "external_evidence_explorer",
    total_external_evidence: externalEvidence.length,
    total_external_visuals:  externalVisuals.length,
    total_unsupported:       unsupportedQueries.length,
    // Evidence panel
    evidence_panel: {
      authoritative: externalEvidence.filter((e) => e.source_quality === "authoritative"),
      reputable:     externalEvidence.filter((e) => e.source_quality === "reputable"),
      statistics:    externalEvidence.filter((e) => ["authoritative_statistic","benchmark_result"].includes(e.evidence_type)),
      visuals:       externalVisuals.filter((v) => v.slide_usable && !v.needs_manual_review),
      unsupported:   unsupportedQueries,
    },
    // Source quality panel
    source_quality_panel: sourceQualityReport || { by_quality: byQuality },
    // Evidence gap panel
    evidence_gap_panel: {
      unsupported_queries:  unsupportedQueries,
      stale_sources:        externalEvidence.filter((e) => e.freshness_status === "stale"),
      weak_sources:         externalEvidence.filter((e) => e.source_quality === "weak"),
      manual_review_needed: externalEvidence.filter((e) => e.needs_manual_review),
      no_quote:             externalEvidence.filter((e) => (e.limitations || []).includes("no_quote_available")),
    },
    // Claim support drilldown structure
    claim_support_structure: {
      evidence_by_category:    byCategory,
      evidence_by_type:        byEvidenceType,
      claim_usable:            externalEvidence.filter((e) => !e.needs_manual_review && e.source_quality !== "weak" && e.confidence !== "low"),
    },
    // Filters for dashboard UI
    filters: {
      available_categories:   [...new Set(externalEvidence.map((e) => e.category).filter(Boolean))],
      available_evidence_types:[...new Set(externalEvidence.map((e) => e.evidence_type).filter(Boolean))],
      available_source_quality:["authoritative","reputable","mixed","weak"],
      available_freshness:    ["current","recent","stale","unknown"],
      available_publishers:   [...new Set(externalEvidence.map((e) => e.publisher).filter(Boolean))].slice(0, 30),
      available_permitted_uses:[...new Set(externalEvidence.flatMap((e) => e.permitted_uses || []))],
    },
    websearch_validation: websearchValidationReport || null,
    visualization_ids: ["external_evidence_coverage"],
  };
}

/**
 * Build the dashboard_dataset from 5B analytics outputs.
 * Optionally includes 5C external evidence explorer view.
 *
 * @param {object}   aggregates        - output of aggregateAnalytics()
 * @param {object[]} analyticsEvidence - output of selectAnalyticsEvidence()
 * @param {object[]} analyticsSources  - sources with analytics_features set
 * @param {object}   [opts]
 * @param {object[]} [opts.externalEvidence]          - adapted 5C external evidence
 * @param {object[]} [opts.externalVisuals]           - adapted 5C visual evidence
 * @param {object[]} [opts.unsupportedQueries]        - structured unsupported queries
 * @param {object}   [opts.sourceQualityReport]       - from packageWebEvidenceForDossiers
 * @param {object}   [opts.websearchValidationReport] - from webEvidenceToExternalEvidence
 * @returns {object} dashboard_dataset with 6-7 views
 */
export function buildDashboardDataset(aggregates, analyticsEvidence, analyticsSources, opts = {}) {
  const {
    externalEvidence = [], externalVisuals = [], unsupportedQueries = [],
    sourceQualityReport = null, websearchValidationReport = null,
  } = opts;

  const views = {
    overview:             buildOverview(aggregates, analyticsEvidence),
    threat_landscape:     buildThreatLandscape(aggregates),
    operational_maturity: buildOperationalMaturity(aggregates),
    attack_surface:       buildAttackSurface(aggregates),
    trends:               buildTrends(aggregates),
    evidence_explorer:    buildEvidenceExplorer(aggregates, analyticsEvidence, analyticsSources),
  };

  // Add 5C external evidence explorer if any external evidence is available
  if (externalEvidence.length > 0 || unsupportedQueries.length > 0) {
    views.external_evidence_explorer = buildExternalEvidenceExplorer(
      externalEvidence, externalVisuals, unsupportedQueries, sourceQualityReport, websearchValidationReport
    );
  }

  return {
    generated_at: new Date().toISOString(),
    corpus_summary: {
      total_sources:    aggregates.corpus_overview?.total_sources    || 0,
      eligible_sources: aggregates.corpus_overview?.eligible_sources || aggregates.corpus_overview?.total_analytics_eligible || 0,
      date_range:       aggregates.corpus_overview?.date_range       || {},
      external_evidence_count: externalEvidence.length,
    },
    views,
  };
}
