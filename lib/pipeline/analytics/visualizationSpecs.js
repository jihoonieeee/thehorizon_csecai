/**
 * Layer 5b.8 — Visualization Spec Generation
 *
 * Fully deterministic — no LLM calls. Converts Layer 5b.5 aggregates into
 * chart-ready visualization spec objects consumed by the slides layer.
 *
 * ── GENERATED SPECS ──────────────────────────────────────────────────────────
 * Each spec has: { visualization_id, chart_type, title, data, ... }
 *
 *   category_distribution              — bar_chart  (sources per category)
 *   source_type_distribution           — bar_chart  (source type breakdown)
 *   attack_vector_frequency            — bar_chart  (top attack vectors by weighted count)
 *   attack_surface_heatmap             — heatmap    (attack surfaces)
 *   maturity_distribution              — stacked_bar (threat maturity by category)
 *   operational_status_by_category     — stacked_bar (operational status by category)
 *   monthly_category_timeline          — stacked_bar (monthly volume by category)
 *   signal_cluster_heatmap             — heatmap    (signal clusters × categories)
 *   recurring_theme_heatmap            — heatmap    (recurring themes × categories)
 *   timeline_events                    — timeline   (top 20 priority events)
 *   category_maturity_matrix           — matrix     (category × maturity)
 *   source_type_by_category            — stacked_bar (evidence composition by category)
 *   signal_cluster_radar               — radar_chart (signal cluster intensity)
 *   ai_layer_frequency                 — bar_chart  (AI layer attack distribution)
 *   adversary_adoption_distribution    — bar_chart  (adversary adoption stages)
 *   capability_stage_distribution      — bar_chart  (capability pipeline stages)
 *   governance_function_frequency      — bar_chart  (governance functions)
 *   defensive_control_frequency        — bar_chart  (defensive controls)
 *   mitigation_gap_signals             — bar_chart  (unmitigated attack vectors)
 *   derived_metrics_overview           — gauge_array (9 derived index values)
 *
 * Specs that reference empty data are omitted from the output.
 * All visualization_ids are stable — they are cited by planSlides.js to assign
 * visualizations to specific slides.
 */

import { getTag } from "../../config/taxonomyRegistry.js";

// Title-case a snake_case key: "prompt_injection" → "Prompt Injection"
function humanLabel(key) {
  if (key == null) return "";
  const s = String(key);
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const ATTACK_TECHNIQUE_LABELS = {
  T1566:     "T1566: Phishing",
  T1589:     "T1589: Gather Victim Identity",
  T1588_006: "T1588.006: Vulnerabilities",
  T1587_001: "T1587.001: Malware Development",
  T1587_004: "T1587.004: Exploit Development",
  T1027:     "T1027: Obfuscation",
  T1059:     "T1059: Command & Scripting",
  T1595:     "T1595: Active Scanning",
  T1588_007: "T1588.007: AI Capability",
};
function techniqueLabel(key) {
  return ATTACK_TECHNIQUE_LABELS[key] || ATTACK_TECHNIQUE_LABELS[String(key).replace(/\./g, "_")] || key;
}

// Humanise a taxonomy tag using its registry display_name, else the slug.
function tagLabel(tag) {
  return getTag(tag)?.display_name || humanLabel(tag);
}

const CATEGORY_LABELS = {
  traditional_ai_threats: "Traditional AI Threats",
  llm_threats:            "LLM Threats",
  agentic_ai_threats:     "Agentic AI Threats",
  ai_enabled_threats:     "AI-Enabled Threats",
  unclear_or_adjacent:    "Unclear / Adjacent",
};

const SOURCE_TYPE_LABELS = {
  vulnerability:                    "Vulnerability",
  incident:                         "Incident",
  threat_intelligence:              "Threat Intelligence",
  research_finding:                 "Research Finding",
  exploit_disclosure:               "Exploit Disclosure",
  defensive_capability:             "Defensive Capability",
  benchmark_evaluation:             "Benchmark / Evaluation",
  capability_demonstration:         "Capability Demonstration",
  adversary_adoption_signal:        "Adversary Adoption",
  infrastructure_dependency_signal: "Infrastructure Dependency",
  trust_boundary_shift:             "Trust Boundary Shift",
  societal_harm_signal:             "Societal Harm",
  governance_signal:                "Governance / Policy",
  ecosystem_signal:                 "Ecosystem / Market",
  strategic_signal:                 "Strategic Signal",
  unknown:                          "Unknown",
};

const MATURITY_LABELS = {
  research:    "Research",
  emerging:    "Emerging",
  growing:     "Growing",
  operational: "Operational",
  mainstream:  "Mainstream",
  unknown:     "Unknown",
};

const OPERATIONAL_STATUS_LABELS = {
  theoretical:              "Theoretical",
  research_only:            "Research Only",
  proof_of_concept:         "Proof of Concept",
  limited_operational_use:  "Limited Operational",
  active_operational_use:   "Active Operational",
  mainstream_operational_use:"Mainstream",
  unknown:                  "Unknown",
};

const MATURITY_ORDER = ["research","emerging","growing","operational","mainstream","unknown"];
const OPERATIONAL_ORDER = [
  "theoretical","research_only","proof_of_concept",
  "limited_operational_use","active_operational_use","mainstream_operational_use","unknown",
];
const OFFENSIVE_CATEGORIES = [
  "traditional_ai_threats","llm_threats","agentic_ai_threats","ai_enabled_threats",
];

function labeledCounts(counts, labelMap) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: labelMap[key] || key, count }));
}

function sortedEntries(obj, maxN = 15) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxN);
}

function buildStackedBarData(monthly, keyLabelMap) {
  const months = Object.keys(monthly).sort();
  const allKeys = new Set();
  for (const m of months) {
    for (const k of Object.keys(monthly[m] || {})) allKeys.add(k);
  }

  const series = {};
  for (const key of allKeys) {
    const label = keyLabelMap[key] || key;
    series[key] = { key, label, values: months.map((m) => (monthly[m] || {})[key] || 0) };
  }

  return { months, series };
}

// ── Integer rounding + thin-data guards ──────────────────────────────────────
// Charts must display INTEGER source counts, never the 2-decimal weighted
// aggregation values (e.g. "1.5") used internally for ranking. A chart with
// fewer than two meaningful (non-zero) data points — or a timeline with only a
// single populated bucket — is marked insufficient_data so the renderer shows a
// neutral note instead of a misleading single-bar / single-point chart.

const MIN_MEANINGFUL_POINTS = 2;
// Below this total sample size a corpus-count chart (e.g. a "Top Attack Vectors"
// bar showing 1 and 2) is too thin to headline as a statistic. It still renders,
// but is flagged low_n so the slide renderer prefers a validated web figure and
// the chart is honestly labelled as a small corpus sample.
const LOW_N_TOTAL = 6;

function roundCount(v) {
  return typeof v === "number" ? Math.round(v) : v;
}

function nonZeroCount(values) {
  return values.filter((v) => (v || 0) > 0).length;
}

function sumValues(values) {
  return values.reduce((a, b) => a + (Math.abs(b) || 0), 0);
}

// Round all numeric counts to integers in place and decide whether the spec has
// enough meaningful data to be worth rendering. Returns the same spec, flagged
// with { insufficient_data, data_note } when it falls below the threshold.
function finalizeSpec(spec) {
  const cd = spec.chart_data;
  if (!cd) return spec;

  let meaningful = null;     // count of non-zero data points (null = not a counted shape)
  let singleBucket = false;  // timeline/stacked-bar collapsed to one populated bucket
  let total = null;          // sum of all counts (the sample size behind the chart)

  if (Array.isArray(cd.items)) {
    for (const it of cd.items) {
      if (it.count != null)     it.count     = roundCount(it.count);
      if (it.value != null)     it.value     = roundCount(it.value);
      if (it.intensity != null) it.intensity = roundCount(it.intensity);
    }
    const vals = cd.items.map((i) => i.count ?? i.value ?? 0);
    meaningful = nonZeroCount(vals);
    total = sumValues(vals);
  } else if (Array.isArray(cd.stacks) && Array.isArray(cd.categories)) {
    for (const s of cd.stacks) s.values = (s.values || []).map(roundCount);
    const totals = cd.categories.map((_, i) =>
      cd.stacks.reduce((sum, s) => sum + (s.values?.[i] || 0), 0)
    );
    meaningful = nonZeroCount(totals);
    total = sumValues(totals);
  } else if (Array.isArray(cd.months) && cd.series) {
    const series = Array.isArray(cd.series) ? cd.series : Object.values(cd.series);
    for (const s of series) s.values = (s.values || []).map(roundCount);
    const monthTotals = cd.months.map((_, i) =>
      series.reduce((sum, s) => sum + (s.values?.[i] || 0), 0)
    );
    const populated = nonZeroCount(monthTotals);
    meaningful = populated;
    total = sumValues(monthTotals);
    singleBucket = populated <= 1;
  } else if (Array.isArray(cd.rows)) {
    for (const r of cd.rows) r.values = (r.values || []).map(roundCount);
    const rowTotals = cd.rows.map((r) => (r.values || []).reduce((a, b) => a + (b || 0), 0));
    meaningful = nonZeroCount(rowTotals);
    total = sumValues(rowTotals);
  } else if (Array.isArray(cd.axes) && Array.isArray(cd.values)) {
    cd.values = cd.values.map(roundCount);
    meaningful = nonZeroCount(cd.values);
    total = sumValues(cd.values);
  } else if (Array.isArray(cd.events)) {
    meaningful = cd.events.length;
  } else if (Array.isArray(cd.gauges)) {
    meaningful = cd.gauges.length;
  }

  if (meaningful !== null && (meaningful < MIN_MEANINGFUL_POINTS || singleBucket)) {
    return {
      ...spec,
      insufficient_data: true,
      data_note: singleBucket
        ? "Insufficient time-series data for this period"
        : "Insufficient data for this period",
    };
  }

  // Renders fine, but the sample is too small to present as a hard statistic.
  // Flag it so the slide renderer prefers a validated web figure, and label the
  // chart honestly as a corpus sample.
  if (total !== null && total > 0 && total < LOW_N_TOTAL) {
    return {
      ...spec,
      low_n: true,
      sample_size: total,
      data_note: `Corpus sample, N=${total} — indicative distribution, not a population statistic`,
    };
  }
  return spec;
}

/**
 * Generate visualization specs from aggregates and derived metrics (Layer 5b.8).
 *
 * @param {object}   aggregates     - output of aggregateAnalytics()
 * @param {object[]} sources        - full source list (unused, kept for signature compat)
 * @param {object}   derived_metrics - output of computeDerivedMetrics() (optional)
 * @returns {object[]} array of visualization spec objects
 */
export function generateVisualizationSpecs(aggregates, sources = [], derived_metrics = null) {
  const specs = [];
  const ag = aggregates;

  // ── 1. Category Distribution — bar chart ─────────────────────────────────────
  specs.push({
    visualization_id:   "category_distribution",
    visualization_type: "bar_chart",
    title:              "Threat Category Distribution",
    chart_data: {
      items: labeledCounts(ag.category_counts, CATEGORY_LABELS),
    },
    slide_use:          "threat_landscape_overview",
    data_source:        "category_counts",
    interpretation_hint:"Relative volume of sources across the four main AI threat categories.",
  });

  // ── 2. Source Type Distribution — bar chart ──────────────────────────────────
  specs.push({
    visualization_id:   "source_type_distribution",
    visualization_type: "bar_chart",
    title:              "Source Type Distribution",
    chart_data: {
      items: labeledCounts(ag.source_type_counts, SOURCE_TYPE_LABELS),
    },
    slide_use:          "executive_overview",
    data_source:        "source_type_counts",
    interpretation_hint:"Intelligence source types collected — indicates evidence quality and coverage.",
  });

  // ── 3. Attack Vector Frequency — bar chart ───────────────────────────────────
  const topVectors = sortedEntries(ag.attack_vector_frequency, 15);
  specs.push({
    visualization_id:   "attack_vector_frequency",
    visualization_type: "bar_chart",
    title:              "Top Attack Vectors",
    chart_data: {
      items: topVectors.map(([key, count]) => ({
        key,
        label: humanLabel(key),
        count,
      })),
    },
    slide_use:          "category_insight",
    data_source:        "attack_vector_frequency",
    interpretation_hint:"Most frequently observed attack techniques across all sources.",
  });

  // ── 4. Attack Surface Frequency — heatmap ───────────────────────────────────
  const topSurfaces = sortedEntries(ag.attack_surface_frequency, 15);
  specs.push({
    visualization_id:   "attack_surface_heatmap",
    visualization_type: "heatmap",
    title:              "Attack Surface Coverage",
    chart_data: {
      items: topSurfaces.map(([surface, count]) => ({
        key:   surface,
        label: humanLabel(surface),
        count,
        intensity: count,
      })),
    },
    slide_use:          "cross_category_convergence",
    data_source:        "attack_surface_frequency",
    interpretation_hint:"AI/cyber attack surfaces most frequently exposed across threat intelligence sources.",
  });

  // ── 5. Maturity Distribution — stacked bar by category ───────────────────────
  const maturityByCat = {};
  for (const cat of OFFENSIVE_CATEGORIES) {
    maturityByCat[cat] = ag.category_breakdowns[cat]?.maturity_distribution || {};
  }
  specs.push({
    visualization_id:   "maturity_distribution",
    visualization_type: "stacked_bar",
    title:              "Threat Maturity by Category",
    chart_data: {
      categories: OFFENSIVE_CATEGORIES.map((c) => CATEGORY_LABELS[c] || c),
      stacks: MATURITY_ORDER.map((m) => ({
        key:    m,
        label:  MATURITY_LABELS[m],
        values: OFFENSIVE_CATEGORIES.map((c) => maturityByCat[c]?.[m] || 0),
      })),
    },
    slide_use:          "threat_landscape_overview",
    data_source:        "category_breakdowns.maturity_distribution",
    interpretation_hint:"Research-to-operational maturity split per category — indicates operationalization pace.",
  });

  // ── 6. Operational Status by Category — stacked bar ─────────────────────────
  const opStatusByCat = {};
  for (const cat of OFFENSIVE_CATEGORIES) {
    opStatusByCat[cat] = ag.category_breakdowns?.[cat]?.operational_status_distribution || {};
  }
  specs.push({
    visualization_id:   "operational_status_by_category",
    visualization_type: "stacked_bar",
    title:              "Operational Status by Category",
    chart_data: {
      categories: OFFENSIVE_CATEGORIES.map((c) => CATEGORY_LABELS[c] || c),
      stacks: OPERATIONAL_ORDER.map((o) => ({
        key:    o,
        label:  OPERATIONAL_STATUS_LABELS[o],
        values: OFFENSIVE_CATEGORIES.map((c) => opStatusByCat[c]?.[o] || 0),
      })),
    },
    slide_use:          "threat_landscape_overview",
    data_source:        "analytics_operational_status (per category)",
    interpretation_hint:"Theoretical/research/PoC/operational split per category — shows real-world threat activation.",
  });

  // ── 7. Monthly Category Timeline — stacked bar ───────────────────────────────
  const monthlyCatData = buildStackedBarData(ag.monthly_category_counts, CATEGORY_LABELS);
  specs.push({
    visualization_id:   "monthly_category_timeline",
    visualization_type: "stacked_bar",
    title:              "Monthly Source Activity by Category",
    chart_data:         monthlyCatData,
    slide_use:          "executive_overview",
    data_source:        "monthly_category_counts",
    interpretation_hint:"12-month activity timeline by threat category — shows trend direction and peaks.",
  });

  // ── 8. Signal Cluster Heatmap — categories × clusters ───────────────────────
  const topClusters = Object.keys(ag.signal_cluster_counts)
    .sort((a, b) => ag.signal_cluster_counts[b] - ag.signal_cluster_counts[a])
    .slice(0, 12);

  const clusterByCat = {};
  for (const cat of OFFENSIVE_CATEGORIES) {
    clusterByCat[cat] = ag.category_breakdowns?.[cat]?.signal_cluster_counts || {};
  }

  specs.push({
    visualization_id:   "signal_cluster_heatmap",
    visualization_type: "heatmap",
    title:              "Signal Clusters × Threat Categories",
    chart_data: {
      columns:     OFFENSIVE_CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABELS[c] || c })),
      rows:        topClusters.map((cl) => ({
        key:     cl,
        label:   humanLabel(cl),
        values:  OFFENSIVE_CATEGORIES.map((c) => clusterByCat[c]?.[cl] || 0),
      })),
    },
    slide_use:          "cross_category_convergence",
    data_source:        "signal_cluster_counts (by category)",
    interpretation_hint:"Cross-category signal cluster intensity — reveals which threat signals dominate which categories.",
  });

  // ── 9. Recurring Theme Heatmap — categories × themes ────────────────────────
  const topThemes = Object.keys(ag.recurring_theme_counts)
    .sort((a, b) => ag.recurring_theme_counts[b] - ag.recurring_theme_counts[a])
    .slice(0, 10);

  const themeByCat = {};
  for (const cat of OFFENSIVE_CATEGORIES) {
    themeByCat[cat] = ag.category_breakdowns?.[cat]?.recurring_theme_counts || {};
  }

  specs.push({
    visualization_id:   "recurring_theme_heatmap",
    visualization_type: "heatmap",
    title:              "Recurring Themes × Threat Categories",
    chart_data: {
      columns:  OFFENSIVE_CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABELS[c] || c })),
      rows:     topThemes.map((th) => ({
        key:    th,
        label:  humanLabel(th),
        values: OFFENSIVE_CATEGORIES.map((c) => themeByCat[c]?.[th] || 0),
      })),
    },
    slide_use:          "outlook_support",
    data_source:        "recurring_theme_counts (by category)",
    interpretation_hint:"Strategic recurring themes per category — supports early signals and 6-month outlook framing.",
  });

  // ── 10. Timeline Events — top 20 high-priority events ───────────────────────
  const priorityOrder = { must_read: 0, high: 1, medium: 2, low: 3, archive_only: 4 };
  const topEvents = [...(ag.timeline_events || [])]
    .sort((a, b) => {
      const pDiff = (priorityOrder[a.rawfact_priority] ?? 5) - (priorityOrder[b.rawfact_priority] ?? 5);
      if (pDiff !== 0) return pDiff;
      return b.date?.localeCompare(a.date || "") || 0;
    })
    .slice(0, 20);

  specs.push({
    visualization_id:   "timeline_events",
    visualization_type: "timeline",
    title:              "Key Events Timeline",
    chart_data: {
      events: topEvents.map((e) => ({
        date:              e.date,
        source_id:         e.source_id,
        title:             e.title,
        publisher:         e.publisher,
        category_label:    CATEGORY_LABELS[e.category] || e.category,
        source_type_label: SOURCE_TYPE_LABELS[e.source_type] || e.source_type,
        rawfact_priority:  e.rawfact_priority,
        top_attack_vector: e.top_attack_vector,
        source_summary:    e.source_summary?.slice(0, 150),
        url:               e.url,
      })),
      date_range: ag.date_range,
    },
    slide_use:          "executive_overview",
    data_source:        "timeline_events",
    interpretation_hint:"Chronological key intelligence events ranked by priority — top 20 shown.",
  });

  // ── 11. Category Maturity Matrix — category × maturity ───────────────────────
  specs.push({
    visualization_id:   "category_maturity_matrix",
    visualization_type: "matrix",
    title:              "Category × Maturity Matrix",
    chart_data: {
      columns: MATURITY_ORDER.map((m) => ({ key: m, label: MATURITY_LABELS[m] })),
      rows:    OFFENSIVE_CATEGORIES.map((cat) => ({
        key:    cat,
        label:  CATEGORY_LABELS[cat] || cat,
        values: MATURITY_ORDER.map(
          (m) => ag.category_breakdowns[cat]?.maturity_distribution?.[m] || 0
        ),
      })),
    },
    slide_use:          "threat_landscape_overview",
    data_source:        "category_breakdowns.maturity_distribution",
    interpretation_hint:"Cross-tab of threat category vs maturity — shows which threats are moving from research to operational.",
  });

  // ── 12. Source Type by Category — stacked bar ────────────────────────────────
  const topTypes = Object.keys(ag.source_type_counts)
    .sort((a, b) => ag.source_type_counts[b] - ag.source_type_counts[a])
    .slice(0, 8);

  const typeByCat = {};
  for (const cat of OFFENSIVE_CATEGORIES) {
    typeByCat[cat] = ag.category_breakdowns[cat]?.source_type_counts || {};
  }

  specs.push({
    visualization_id:   "source_type_by_category",
    visualization_type: "stacked_bar",
    title:              "Evidence Composition by Category",
    chart_data: {
      categories: OFFENSIVE_CATEGORIES.map((c) => CATEGORY_LABELS[c] || c),
      stacks:     topTypes.map((t) => ({
        key:    t,
        label:  SOURCE_TYPE_LABELS[t] || t,
        values: OFFENSIVE_CATEGORIES.map((c) => typeByCat[c]?.[t] || 0),
      })),
    },
    slide_use:          "category_insight",
    data_source:        "category_breakdowns.source_type_counts",
    interpretation_hint:"Evidence type composition per threat category — shows where evidence quality concentrates.",
  });

  // ── 13. Signal Cluster Radar — all categories combined ──────────────────────
  const clusterKeys   = Object.keys(ag.signal_cluster_counts)
    .sort((a, b) => ag.signal_cluster_counts[b] - ag.signal_cluster_counts[a])
    .slice(0, 10);
  const clusterValues = clusterKeys.map((k) => ag.signal_cluster_counts[k] || 0);

  specs.push({
    visualization_id:   "signal_cluster_radar",
    visualization_type: "radar_chart",
    title:              "Signal Cluster Intensity",
    chart_data: {
      axes:   clusterKeys.map((k) => ({ key: k, label: humanLabel(k) })),
      values: clusterValues,
    },
    slide_use:          "cross_category_convergence",
    data_source:        "signal_cluster_counts",
    interpretation_hint:"Radar view of dominant threat signal clusters across all sources in this period.",
  });

  // ── 14. AI Layer Frequency — bar chart ──────────────────────────────────────
  specs.push({
    visualization_id:   "ai_layer_frequency",
    visualization_type: "bar_chart",
    title:              "AI Layer Attack Distribution",
    chart_data: {
      items: sortedEntries(ag.ai_layer_frequency, 12).map(([key, count]) => ({
        key,
        label: humanLabel(key),
        count,
      })),
    },
    slide_use:          "threat_landscape_overview",
    data_source:        "ai_layer_frequency",
    interpretation_hint:"Which AI system layers are most frequently targeted or exploited.",
  });

  // ── 15. Adversary Adoption Stage Distribution — bar chart ────────────────────
  const adoptionDist = aggregates?.adversary_adoption_analytics?.adoption_stage_distribution || {};
  if (Object.keys(adoptionDist).length > 0) {
    const ADOPTION_LABELS = {
      none:              "None / No Evidence",
      experimenting:     "Experimenting",
      operationalizing:  "Operationalising",
      widespread:        "Widespread",
    };
    specs.push({
      visualization_id:   "adversary_adoption_distribution",
      visualization_type: "bar_chart",
      title:              "Adversary Adoption Stage",
      chart_data: {
        items: Object.entries(adoptionDist)
          .sort((a, b) => b[1] - a[1])
          .map(([key, count]) => ({ key, label: ADOPTION_LABELS[key] || key, count })),
      },
      slide_use:          "category_insight",
      data_source:        "adversary_adoption_analytics.adoption_stage_distribution",
      interpretation_hint:"How far adversaries have progressed in adopting AI capabilities operationally.",
    });
  }

  // ── 16. Capability Stage Distribution — bar chart ────────────────────────────
  const capDist = aggregates?.capability_analytics?.capability_stage_distribution || {};
  if (Object.keys(capDist).length > 0) {
    const CAP_LABELS = {
      theoretical:        "Theoretical",
      lab_demonstrated:   "Lab Demonstrated",
      poc_available:      "PoC Available",
      in_wild:            "In the Wild",
      deployed:           "Deployed",
      unknown:            "Unknown",
    };
    specs.push({
      visualization_id:   "capability_stage_distribution",
      visualization_type: "bar_chart",
      title:              "Research Capability Pipeline",
      chart_data: {
        items: Object.entries(capDist)
          .sort((a, b) => b[1] - a[1])
          .map(([key, count]) => ({ key, label: CAP_LABELS[key] || key, count })),
      },
      slide_use:          "cross_category_convergence",
      data_source:        "capability_analytics.capability_stage_distribution",
      interpretation_hint:"Where research capabilities sit in the pipeline from theoretical to deployed threat.",
    });
  }

  // ── 17. Governance Function Frequency — bar chart ────────────────────────────
  const govFnFreq = aggregates?.governance_analytics?.governance_function_frequency || {};
  if (Object.keys(govFnFreq).length > 0) {
    specs.push({
      visualization_id:   "governance_function_frequency",
      visualization_type: "bar_chart",
      title:              "Governance Function Focus",
      chart_data: {
        items: sortedEntries(govFnFreq, 10).map(([key, count]) => ({
          key, label: humanLabel(key), count,
        })),
      },
      slide_use:          "outlook_support",
      data_source:        "governance_analytics.governance_function_frequency",
      interpretation_hint:"Which governance and regulatory functions are most active this period.",
    });
  }

  // ── 18. Defensive Control Frequency — bar chart ──────────────────────────────
  const defCtrlFreq = aggregates?.defensive_analytics?.defensive_control_frequency || {};
  if (Object.keys(defCtrlFreq).length > 0) {
    specs.push({
      visualization_id:   "defensive_control_frequency",
      visualization_type: "bar_chart",
      title:              "Defensive Controls in Focus",
      chart_data: {
        items: sortedEntries(defCtrlFreq, 10).map(([key, count]) => ({
          key, label: humanLabel(key), count,
        })),
      },
      slide_use:          "category_insight",
      data_source:        "defensive_analytics.defensive_control_frequency",
      interpretation_hint:"Defensive control types most frequently cited in this period's intelligence.",
    });
  }

  // ── 19. Mitigation Gap Signals — bar chart ───────────────────────────────────
  const gaps = aggregates?.defensive_analytics?.mitigation_gap_signals || [];
  if (gaps.length > 0) {
    specs.push({
      visualization_id:   "mitigation_gap_signals",
      visualization_type: "bar_chart",
      title:              "Unmitigated Attack Vectors",
      chart_data: {
        items: gaps.map((g) => ({
          key:   g.attack_vector,
          label: humanLabel(g.attack_vector),
          count: g.source_count,
        })),
      },
      slide_use:          "outlook_support",
      data_source:        "defensive_analytics.mitigation_gap_signals",
      interpretation_hint:"Attack vectors with high threat source counts but no defensive capability sources.",
    });
  }

  // ── 20. Derived Metrics Overview — gauge array ───────────────────────────────
  if (derived_metrics && Object.keys(derived_metrics).length > 0) {
    const METRIC_LABELS = {
      operationalisation_index:          "Operationalisation",
      adversary_adoption_index:           "Adversary Adoption",
      agentic_risk_index:                 "Agentic Risk",
      ai_enabled_threat_index:            "AI-Enabled Threat",
      governance_pressure_index:          "Governance Pressure",
      defensive_maturity_index:           "Defensive Maturity",
      ecosystem_dependency_index:         "Ecosystem Dependency",
      trust_boundary_shift_index:         "Trust Boundary Shift",
      research_to_threat_pipeline_index:  "Research→Threat Pipeline",
    };
    specs.push({
      visualization_id:   "derived_metrics_overview",
      visualization_type: "gauge_array",
      title:              "Composite Risk Indexes",
      chart_data: {
        gauges: Object.entries(derived_metrics).map(([key, m]) => ({
          key,
          label:       METRIC_LABELS[key] || key,
          value:       m.value,
          level:       m.label,
          explanation: m.explanation,
        })),
      },
      slide_use:          "executive_overview",
      data_source:        "derived_metrics",
      interpretation_hint:"Nine composite risk indexes (0–100) summarising the period's threat landscape.",
    });
  }

  // ── Validated AI Threat Taxonomy charts ─────────────────────────────────────
  const tagItems = (counts, max = 15) =>
    sortedEntries(counts, max).map(([key, count]) => ({ key, label: tagLabel(key), count }));

  specs.push({
    visualization_id:   "domain_distribution",
    visualization_type: "bar_chart",
    title:              "Threats by Domain",
    chart_data:         { items: labeledCounts(ag.domain_distribution, CATEGORY_LABELS) },
    slide_use:          "four_domain_overview",
    data_source:        "domain_distribution",
    interpretation_hint:"Distribution of validated primary threats across the four taxonomy domains.",
  });

  specs.push({
    visualization_id:   "primary_threat_tag_distribution",
    visualization_type: "bar_chart",
    title:              "Top Primary Threat Tags",
    chart_data:         { items: tagItems(ag.primary_threat_tag_frequency) },
    slide_use:          "threat_tag_distribution",
    data_source:        "primary_threat_tag_frequency",
    interpretation_hint:"Most frequent validated primary threat techniques (secondary dimensions excluded).",
  });

  specs.push({
    visualization_id:   "agentic_subdomain_distribution",
    visualization_type: "bar_chart",
    title:              "Agentic Threats by Subdomain",
    chart_data: {
      items: sortedEntries(ag.agentic_subdomain_frequency, 12)
        .map(([key, count]) => ({ key, label: humanLabel(key), count })),
    },
    slide_use:          "agentic_subdomain_heatmap",
    data_source:        "agentic_subdomain_frequency",
    interpretation_hint:"Where agentic threats concentrate: memory, tools/MCP, permissions, execution, workflow, multi-agent, identity.",
  });

  specs.push({
    visualization_id:   "ai_enabled_mapping_distribution",
    visualization_type: "bar_chart",
    title:              "AI-Enabled Threats by ATT&CK Technique",
    chart_data: {
      items: sortedEntries(ag.ai_enabled_mapping_frequency, 12)
        .map(([key, count]) => ({ key, label: techniqueLabel(key), count })),
    },
    slide_use:          "ai_enabled_attack_mapping",
    data_source:        "ai_enabled_mapping_frequency",
    interpretation_hint:"AI-enabled threats mapped to their paired operational ATT&CK techniques.",
  });

  specs.push({
    visualization_id:   "prompt_injection_subtype_distribution",
    visualization_type: "bar_chart",
    title:              "Prompt Injection Subtypes",
    chart_data:         { items: tagItems(ag.prompt_injection_subtype_frequency, 8) },
    slide_use:          "prompt_injection_subtype",
    data_source:        "prompt_injection_subtype_frequency",
    interpretation_hint:"Breakdown of prompt-injection children: direct, indirect, multimodal, RAG.",
  });

  if (ag.taxonomy_validation_counts) {
    specs.push({
      visualization_id:   "evidence_validation_distribution",
      visualization_type: "bar_chart",
      title:              "Evidence Coverage: Validated vs Weak",
      chart_data: {
        items: sortedEntries(ag.taxonomy_validation_counts, 6)
          .map(([key, count]) => ({ key, label: humanLabel(key), count })),
      },
      slide_use:          "evidence_coverage",
      data_source:        "taxonomy_validation_counts",
      interpretation_hint:"How much of the corpus is backed by validated evidence vs weak or unreviewed.",
    });
  }

  // ── Trend Delta spec ─────────────────────────────────────────────────────────
  if (ag.trend_deltas && ag.trend_deltas.category_deltas) {
    const { category_deltas, period } = ag.trend_deltas;
    const deltaItems = Object.entries(category_deltas)
      .filter(([cat]) => OFFENSIVE_CATEGORIES.includes(cat))
      .sort((a, b) => b[1] - a[1])
      .map(([cat, delta]) => ({
        key:   cat,
        label: CATEGORY_LABELS[cat] || humanLabel(cat),
        count: delta,
      }));
    if (deltaItems.length > 0) {
      specs.push({
        visualization_id:    "category_trend_delta",
        visualization_type:  "bar_chart",
        title:               `Category Trend: ${period?.from || "prev"} → ${period?.to || "current"}`,
        chart_data:          { items: deltaItems },
        slide_use:           "executive_overview",
        data_source:         "trend_deltas.category_deltas",
        interpretation_hint: "Month-over-month change in source volume per threat category. Positive = growing, negative = declining.",
      });
    }
  }

  // ── Critical Trend Overview spec — gauge_array of high/very_high metrics ─────
  if (derived_metrics && Object.keys(derived_metrics).length > 0) {
    const METRIC_SHORT = {
      operationalisation_index:          "Operationalisation",
      adversary_adoption_index:          "Adversary Adoption",
      agentic_risk_index:                "Agentic Risk",
      ai_enabled_threat_index:           "AI-Enabled Threat",
      governance_pressure_index:         "Governance Pressure",
      defensive_maturity_index:          "Defensive Maturity",
      ecosystem_dependency_index:        "Ecosystem Dependency",
      trust_boundary_shift_index:        "Trust Boundary Shift",
      research_to_threat_pipeline_index: "Research→Threat Pipeline",
    };
    const highMetrics = Object.entries(derived_metrics)
      .filter(([, m]) => m.label === "very_high" || m.label === "high")
      .sort((a, b) => b[1].value - a[1].value)
      .map(([k, m]) => ({ key: k, label: METRIC_SHORT[k] || humanLabel(k.replace(/_index$/, "")), value: m.value, level: m.label, explanation: m.explanation }));
    if (highMetrics.length > 0) {
      specs.push({
        visualization_id:    "critical_trend_overview",
        visualization_type:  "gauge_array",
        title:               "Critical Trend Indicators",
        chart_data:          { gauges: highMetrics },
        slide_use:           "executive_overview",
        data_source:         "derived_metrics (high/very_high only)",
        interpretation_hint: "Composite risk indexes at high or very-high level — the most pressing threat signals this period.",
      });
    }
  }

  // Round weighted counts to integers and flag thin-data charts (see finalizeSpec).
  return specs.map(finalizeSpec);
}

/**
 * Convert external evidence items (from evidenceSearchLayer) into visualization specs.
 * Each item with a metric_value becomes a stat_callout spec; image_url items become
 * image_embed specs. All get source:"external_web" so planSlides picks them up.
 */
export function generateExternalEvidenceSpecs(externalEvidence = []) {
  const specs = [];
  for (const ev of externalEvidence) {
    if (!ev || ev.needs_manual_review) continue;
    const id = `ext_${ev.evidence_id || ev.category || Math.random().toString(36).slice(2, 8)}`;
    if (ev.metric_value != null && ev.metric_name) {
      specs.push({
        visualization_id:    id,
        visualization_type:  "stat_callout",
        source:              "external_web",
        category:            ev.category || null,
        title:               ev.title || ev.metric_name,
        context:             ev.summary || "",
        relevance:           `${ev.metric_name}: ${ev.metric_value}`,
        chart_data: {
          items: [{
            key:   ev.evidence_id,
            label: `${ev.metric_name}: ${String(ev.metric_value).slice(0, 100)}`,
            count: typeof ev.metric_value === "number" ? ev.metric_value : 1,
          }],
        },
        references: [{ url: ev.url, publisher: ev.publisher, title: ev.title, needs_manual_review: ev.needs_manual_review }],
        slide_use:           "stat_callout",
        data_source:         ev.url || "external",
        interpretation_hint: ev.summary || "",
      });
    }
    if (ev.image_url) {
      specs.push({
        visualization_id:    `${id}_img`,
        visualization_type:  "image_embed",
        source:              "external_web",
        category:            ev.category || null,
        title:               ev.title || "",
        context:             ev.summary || "",
        image_url:           ev.image_url,
        chart_data:          null,
        references: [{ url: ev.url, publisher: ev.publisher, title: ev.title, needs_manual_review: ev.needs_manual_review }],
        slide_use:           "visual_annotation",
        data_source:         ev.image_url,
        interpretation_hint: ev.summary || "",
      });
    }
  }
  return specs;
}
