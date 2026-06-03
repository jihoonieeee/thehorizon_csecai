/**
 * Layer 5b.7 — Analytics Evidence Selection
 *
 * Deterministic — no LLM calls. Builds a concise `analytics_evidence[]` that the
 * analysis layer can consume directly, without needing to walk raw aggregate objects.
 *
 * Replaces the old practice of passing the full aggregates dump into buildCategoryDossier.
 * The analysis layer should read analytics_evidence, not iterate over raw aggregates.
 *
 * ── OUTPUT SHAPE ────────────────────────────────────────────────────────────
 * analytics_evidence: [
 *   {
 *     dimension:   string,    — e.g. "attack_vector_frequency"
 *     category:    string,    — e.g. "threat_pattern" | "maturity" | "timeline" | ...
 *     top_entries: [{ key, count, pct? }],
 *     insight:     string,    — one-sentence human-readable summary
 *     data:        object,    — raw data for chart generation (optional)
 *   }
 * ]
 */

const TOP_N = 8;

function humanLabel(key) {
  if (!key) return "";
  return String(key).replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function topEntries(obj, n = TOP_N) {
  const total = Object.values(obj || {}).reduce((a, b) => a + b, 0);
  return Object.entries(obj || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({
      key,
      count,
      pct: total > 0 ? Math.round(count / total * 100) : 0,
    }));
}

function pct(n, total) {
  return total > 0 ? Math.round(n / total * 100) : 0;
}

function topKey(obj) {
  return Object.entries(obj || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// ── Evidence builders ──────────────────────────────────────────────────────────

function corpusEvidence(aggregates) {
  const co = aggregates.corpus_overview || {};
  const total = co.total_analytics_eligible || 0;
  const topCat = topKey(co.category_counts);
  return [
    {
      dimension:   "corpus_size",
      category:    "corpus",
      top_entries: topEntries(co.category_counts),
      insight:     `Corpus has ${total} analytics-eligible sources; dominant category: ${topCat || "unknown"}`,
      data:        { total_sources: co.total_sources, analytics_eligible: total, date_range: co.date_range },
    },
    {
      dimension:   "source_type_distribution",
      category:    "corpus",
      top_entries: topEntries(co.source_type_counts),
      insight:     `Top source type: ${topKey(co.source_type_counts) || "unknown"}`,
      data:        co.source_type_counts,
    },
  ];
}

function threatPatternEvidence(aggregates) {
  const tp = aggregates.threat_pattern_analytics || {};
  const evidences = [];

  if (Object.keys(tp.attack_vector_frequency || {}).length > 0) {
    const top = topEntries(tp.attack_vector_frequency, 5);
    evidences.push({
      dimension:   "attack_vector_frequency",
      category:    "threat_pattern",
      top_entries: top,
      insight:     `Most common attack vector: ${humanLabel(top[0]?.key || "none")} (weighted count: ${top[0]?.count || 0})`,
      data:        tp.attack_vector_frequency,
    });
  }

  if (Object.keys(tp.attack_surface_distribution || {}).length > 0) {
    const top = topEntries(tp.attack_surface_distribution, 5);
    evidences.push({
      dimension:   "attack_surface_distribution",
      category:    "threat_pattern",
      top_entries: top,
      insight:     `Primary attack surface: ${humanLabel(top[0]?.key || "none")}`,
      data:        tp.attack_surface_distribution,
    });
  }

  if (Object.keys(tp.ai_layer_distribution || {}).length > 0) {
    const top = topEntries(tp.ai_layer_distribution, 5);
    evidences.push({
      dimension:   "ai_layer_distribution",
      category:    "threat_pattern",
      top_entries: top,
      insight:     `Most targeted AI layer: ${humanLabel(top[0]?.key || "none")}`,
      data:        tp.ai_layer_distribution,
    });
  }

  if (Object.keys(tp.signal_cluster_counts || {}).length > 0) {
    const top = topEntries(tp.signal_cluster_counts, 5);
    evidences.push({
      dimension:   "signal_cluster_counts",
      category:    "threat_pattern",
      top_entries: top,
      insight:     `Dominant signal cluster: ${humanLabel(top[0]?.key || "none")}`,
      data:        tp.signal_cluster_counts,
    });
  }

  if (Object.keys(tp.impact_type_frequency || {}).length > 0) {
    const top = topEntries(tp.impact_type_frequency, 5);
    evidences.push({
      dimension:   "impact_type_frequency",
      category:    "threat_pattern",
      top_entries: top,
      insight:     `Most common impact: ${humanLabel(top[0]?.key || "none")}`,
      data:        tp.impact_type_frequency,
    });
  }

  return evidences;
}

function maturityEvidence(aggregates) {
  const ma = aggregates.maturity_analytics || {};
  const evidences = [];

  const opTop = topEntries(ma.operational_status_distribution, 5);
  if (opTop.length > 0) {
    evidences.push({
      dimension:   "operational_status_distribution",
      category:    "maturity",
      top_entries: opTop,
      insight:     `Most common operational status: ${humanLabel(opTop[0]?.key || "none")} (${opTop[0]?.pct || 0}%)`,
      data:        ma.operational_status_distribution,
    });
  }

  const matTop = topEntries(ma.threat_maturity_distribution, 5);
  if (matTop.length > 0) {
    evidences.push({
      dimension:   "threat_maturity_distribution",
      category:    "maturity",
      top_entries: matTop,
      insight:     `Dominant threat maturity: ${humanLabel(matTop[0]?.key || "none")} (${matTop[0]?.pct || 0}%)`,
      data:        ma.threat_maturity_distribution,
    });
  }

  return evidences;
}

function timelineEvidence(aggregates) {
  const tl = aggregates.timeline_analytics || {};
  const catTimeline = tl.monthly_category_timeline || {};
  const months = Object.keys(catTimeline).sort();

  if (months.length === 0) return [];

  const lastMonth = months[months.length - 1];
  const lastMonthCats = catTimeline[lastMonth] || {};
  const topCatLastMonth = topKey(lastMonthCats);

  return [
    {
      dimension:   "monthly_category_timeline",
      category:    "timeline",
      top_entries: Object.entries(lastMonthCats).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count })),
      insight:     `In ${lastMonth}, most active category: ${topCatLastMonth || "unknown"}`,
      data:        catTimeline,
    },
  ];
}

function trendEvidence(aggregates) {
  const td = aggregates.trend_deltas;
  if (!td) return [];

  const { growing = [], category_deltas = {}, period } = td;
  const growingNames = growing.map((g) => g.cat).join(", ");

  return [
    {
      dimension:   "trend_deltas",
      category:    "trend",
      top_entries: growing.map((g) => ({ key: g.cat, count: g.delta })),
      insight:     growing.length > 0
        ? `Growing categories (${period.from} → ${period.to}): ${growingNames}`
        : `No clear growth trend in most recent period (${period?.from} → ${period?.to})`,
      data:        { period, category_deltas },
    },
  ];
}

function adversaryEvidence(aggregates) {
  const adv = aggregates.adversary_adoption_analytics || {};
  const stages = adv.adoption_stage_distribution || {};
  const top = topEntries(stages, 4);

  if (top.length === 0) return [];

  const operationalizing = stages.operationalizing || 0;
  const widespread       = stages.widespread       || 0;
  const highAdoption = operationalizing + widespread;
  const total = Object.values(stages).reduce((a, b) => a + b, 0);

  return [
    {
      dimension:   "adversary_adoption_stage_distribution",
      category:    "adversary",
      top_entries: top,
      insight:     `${pct(highAdoption, total)}% of adversary signals at operationalizing/widespread stage`,
      data:        { adoption_stage_distribution: stages, total_adversary_sources: adv.total_adversary_sources },
    },
  ];
}

function capabilityEvidence(aggregates) {
  const cap = aggregates.capability_analytics || {};
  const capDist = cap.capability_stage_distribution || {};
  const top = topEntries(capDist, 5);
  if (top.length === 0) return [];

  const pocPlusInWild = (capDist.poc_available || 0) + (capDist.in_wild || 0);
  const capTotal = Object.values(capDist).reduce((a, b) => a + b, 0);

  return [
    {
      dimension:   "capability_stage_distribution",
      category:    "capability",
      top_entries: top,
      insight:     `${pct(pocPlusInWild, capTotal)}% of research capabilities are at PoC or in-wild stage`,
      data:        { capability_stage_distribution: capDist, total_capability_sources: cap.total_capability_sources },
    },
  ];
}

function governanceEvidence(aggregates) {
  const gov = aggregates.governance_analytics || {};
  const fnFreq = gov.governance_function_frequency || {};
  const top = topEntries(fnFreq, 5);
  if (top.length === 0) return [];

  return [
    {
      dimension:   "governance_function_frequency",
      category:    "governance",
      top_entries: top,
      insight:     `${gov.total_governance_sources || 0} governance sources; top function: ${top[0]?.key || "none"}`,
      data:        { governance_function_frequency: fnFreq, governance_by_sector: gov.governance_by_sector },
    },
  ];
}

function defensiveEvidence(aggregates) {
  const def = aggregates.defensive_analytics || {};
  const ctrlFreq = def.defensive_control_frequency || {};
  const gaps = def.mitigation_gap_signals || [];
  const top = topEntries(ctrlFreq, 5);

  const evidences = [];

  if (top.length > 0) {
    evidences.push({
      dimension:   "defensive_control_frequency",
      category:    "defensive",
      top_entries: top,
      insight:     `${def.total_defensive_sources || 0} defensive sources; top control: ${top[0]?.key || "none"}`,
      data:        ctrlFreq,
    });
  }

  if (gaps.length > 0) {
    evidences.push({
      dimension:   "mitigation_gap_signals",
      category:    "defensive",
      top_entries: gaps.map((g) => ({ key: g.attack_vector, count: g.source_count })),
      insight:     `${gaps.length} attack vector(s) have no defensive source coverage: ${gaps.map((g) => g.attack_vector).join(", ")}`,
      data:        { gaps },
    });
  }

  return evidences;
}

function derivedMetricsEvidence(derived_metrics) {
  if (!derived_metrics) return [];

  const high = Object.entries(derived_metrics)
    .filter(([, m]) => m.label === "high" || m.label === "very_high")
    .map(([name, m]) => ({ key: name, count: m.value }))
    .sort((a, b) => b.count - a.count);

  return [
    {
      dimension:   "derived_metrics_summary",
      category:    "derived",
      top_entries: high,
      insight:     high.length > 0
        ? `High/very-high risk indexes: ${high.map((h) => humanLabel(h.key.replace(/_index$/, ""))).join(", ")}`
        : "No indexes at high or very_high level",
      data:        derived_metrics,
    },
  ];
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build concise analytics evidence for the analysis layer (Layer 5b.7).
 * Deterministic — no LLM calls.
 *
 * @param {object} aggregates     - Output of aggregateAnalytics()
 * @param {object} derived_metrics - Output of computeDerivedMetrics()
 * @returns {object[]} analytics_evidence array
 */
export function selectAnalyticsEvidence(aggregates, derived_metrics) {
  return [
    ...corpusEvidence(aggregates),
    ...threatPatternEvidence(aggregates),
    ...maturityEvidence(aggregates),
    ...timelineEvidence(aggregates),
    ...trendEvidence(aggregates),
    ...adversaryEvidence(aggregates),
    ...capabilityEvidence(aggregates),
    ...governanceEvidence(aggregates),
    ...defensiveEvidence(aggregates),
    ...derivedMetricsEvidence(derived_metrics),
  ];
}
