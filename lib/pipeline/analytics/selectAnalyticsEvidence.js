/**
 * Layer 5b.8 — Analytics Evidence Pack Generation
 *
 * Deterministic — no LLM calls. Converts important aggregate metrics into
 * concise analytics_evidence[] items for direct consumption by the analysis layer.
 *
 * ── DESIGN PRINCIPLE ─────────────────────────────────────────────────────────
 * This is measured evidence, not final insight.
 * Findings are phrased as corpus-level observations, not global claims.
 * Every item includes source_ids, confidence, and caveats.
 *
 * ── OUTPUT SHAPE ─────────────────────────────────────────────────────────────
 * analytics_evidence: [
 *   {
 *     analytics_evidence_id: "ae_XXXXXXXX",
 *     evidence_type:  "frequency_distribution" | "timeline" | "maturity_distribution"
 *                   | "adoption_signal" | "coverage_gap" | "derived_index",
 *     finding:        string,    — corpus-level finding (never global claim)
 *     data:           object,    — structured data for chart or analysis
 *     source_ids:     string[],  — sources contributing to this finding
 *     metric_ids:     string[],  — metric keys this derives from
 *     domain:         string|null,
 *     source_types:   string[],  — which source types contribute
 *     confidence:     "high" | "medium" | "low",
 *     caveat_if_any:  string|null,
 *   }
 * ]
 */

import { randomUUID } from "crypto";

const TOP_N = 8;

// Map legacy evidence_type values to spec-aligned metric_type values
const METRIC_TYPE_MAP = {
  frequency_distribution: "frequency_distribution",
  cross_tab_matrix:        "cross_tab_matrix",
  timeline:                "timeline",
  maturity_distribution:   "maturity_distribution",
  adoption_signal:         "adoption_signal",
  coverage_gap:            "coverage_gap",
  derived_index:           "derived_metric",
  derived_metric:          "derived_metric",
  source_coverage:         "source_coverage",
  evidence_confidence:     "evidence_confidence",
  burst_pattern:           "burst_pattern",
  insufficient_trend_data: "insufficient_trend_data",
};

function aeId() {
  return `ae_${randomUUID().slice(0, 8)}`;
}

// Add spec-required fields to any evidence item that doesn't already have them
function finalize(item) {
  return {
    ...item,
    metric_type:                   METRIC_TYPE_MAP[item.evidence_type] || item.metric_type || "frequency_distribution",
    evidence_ids:                  item.evidence_ids || [],
    supports_claim_types:          item.supports_claim_types || [],
    recommended_visualization_ids: item.recommended_visualization_ids || [],
  };
}

function topEntries(obj, n = TOP_N) {
  // Handles both plain { key: count } and { key: { count, weighted, source_ids } }
  const entries = Object.entries(obj || {}).map(([key, val]) => ({
    key,
    count:     typeof val === "number" ? val : (val.count || 0),
    weighted:  typeof val === "number" ? val : (val.weighted || 0),
    source_ids: typeof val === "object" ? (val.source_ids || []) : [],
  }));
  const sorted = entries.sort((a, b) => b.count - a.count).slice(0, n);
  const total  = entries.reduce((s, e) => s + e.count, 0);
  return sorted.map((e) => ({ ...e, pct: total > 0 ? Math.round(e.count / total * 100) : 0 }));
}

function sumObj(obj) {
  return Object.values(obj || {}).reduce((a, b) => {
    const v = typeof b === "number" ? b : (b?.count || 0);
    return a + v;
  }, 0);
}

function topKey(obj) {
  return topEntries(obj, 1)[0]?.key || null;
}

function confidence(sourceCount) {
  if (sourceCount >= 20) return "high";
  if (sourceCount >= 5)  return "medium";
  return "low";
}

function caveat(sourceCount, additionalNote = null) {
  const n = typeof sourceCount === "number" ? sourceCount : sumObj(sourceCount);
  const base = n < 5 ? `Low N (${n} sources) — treat as signal, not statistic`
             : n < 10 ? `Moderate N (${n} sources) — directional only`
             : null;
  if (base && additionalNote) return `${base}. ${additionalNote}`;
  return base || additionalNote || null;
}

// ── Corpus profile evidence ────────────────────────────────────────────────────

function corpusEvidence(aggregates) {
  const items = [];
  const cp = aggregates.corpus_overview || {};
  const total = cp.eligible_sources || cp.total_analytics_eligible || 0;

  items.push({
    analytics_evidence_id: aeId(),
    evidence_type:  "source_coverage",
    finding:        `Within the collected corpus, ${total} sources are analytics-eligible across ${Object.keys(cp.category_counts || {}).length} threat domains.`,
    data:           { source_type_distribution: cp.source_type_counts, domain_distribution: cp.category_counts },
    source_ids:     [],
    metric_ids:     ["corpus_overview.eligible_sources", "corpus_overview.source_type_counts"],
    domain:         null,
    source_types:   Object.keys(cp.source_type_counts || {}),
    confidence:     confidence(total),
    caveat_if_any:  (cp.corpus_limitations || []).join(" ") || caveat(total),
    supports_claim_types:          ["evidence_gap", "confidence_assessment"],
    recommended_visualization_ids: ["source_type_distribution", "category_distribution", "trust_tier_distribution"],
  });

  return items;
}

// ── Threat frequency evidence ──────────────────────────────────────────────────

function threatFrequencyEvidence(aggregates) {
  const items = [];
  const tp = aggregates.threat_pattern_analytics || {};
  const total = sumObj(tp.attack_vector_frequency || {});

  // Attack vector frequency — with source_ids
  const vectorTracked = tp.attack_vector_frequency_tracked || {};
  const topVectors = topEntries(vectorTracked, 8);
  if (topVectors.length > 0) {
    const topVec = topVectors[0];
    items.push({
      analytics_evidence_id: aeId(),
      evidence_type:  "frequency_distribution",
      finding:        `Within the collected corpus, the most frequently observed attack vector is '${topVec.key}' (${topVec.count} sources, ${topVec.pct}% of vector-tagged sources).`,
      data:           { top_attack_vectors: topVectors, total_vector_tagged: total },
      source_ids:     topVectors.flatMap((v) => v.source_ids || []).slice(0, 20),
      metric_ids:     ["threat_pattern_analytics.attack_vector_frequency"],
      domain:         null,
      source_types:   [],
      confidence:     confidence(total),
      caveat_if_any:  caveat(total, "Attack vector frequency reflects extraction from parsed sources, not real-world prevalence."),
      supports_claim_types:          ["frequency_claim", "category_insight", "trend_claim"],
      recommended_visualization_ids: ["attack_vector_frequency", "attack_surface_heatmap"],
    });
  }

  // Primary threat tag frequency (taxonomy-validated)
  const tagFreq = aggregates.taxonomy_analytics?.primary_threat_tag_frequency || {};
  const topTags = topEntries(tagFreq, 8);
  if (topTags.length > 0) {
    items.push({
      analytics_evidence_id: aeId(),
      evidence_type:  "frequency_distribution",
      finding:        `Within the collected corpus, the most frequent validated primary threat tag is '${topTags[0].key}' (${topTags[0].count} sources).`,
      data:           { top_primary_threat_tags: topTags },
      source_ids:     [],
      metric_ids:     ["taxonomy_analytics.primary_threat_tag_frequency"],
      domain:         null,
      source_types:   [],
      confidence:     confidence(sumObj(tagFreq)),
      caveat_if_any:  "Taxonomy tags are validated against the registry; secondary dimensions are tracked separately.",
      supports_claim_types:          ["frequency_claim", "category_insight"],
      recommended_visualization_ids: ["primary_threat_tag_distribution", "taxonomy_heatmap"],
    });
  }

  // Taxonomy cross-tab: category × primary tag
  const taxAn = aggregates.taxonomy_analytics || {};
  if (taxAn.primary_tag_frequency && Object.keys(taxAn.primary_tag_frequency).length > 0) {
    const catByDomain = aggregates.category_analytics?.per_category || {};
    const crossTab = {};
    for (const [cat, catData] of Object.entries(catByDomain)) {
      if (catData.count > 0) crossTab[cat] = catData.count;
    }
    items.push({
      analytics_evidence_id: aeId(),
      evidence_type:  "cross_tab_matrix",
      finding:        `Within the collected corpus, ${Object.keys(taxAn.primary_tag_frequency).length} distinct primary threat tags are distributed across ${Object.keys(crossTab).length} threat domains.`,
      data:           { primary_tag_frequency: taxAn.primary_tag_frequency, domain_distribution: taxAn.domain_distribution, ai_enabled_role_frequency: taxAn.ai_enabled_role_frequency },
      source_ids:     [],
      metric_ids:     ["taxonomy_analytics.primary_tag_frequency", "taxonomy_analytics.domain_distribution"],
      domain:         null,
      source_types:   [],
      confidence:     confidence(sumObj(tagFreq)),
      caveat_if_any:  "Frequency does not equal importance. 5B measures corpus presence, not real-world prevalence.",
      supports_claim_types:          ["frequency_claim", "category_insight", "trend_claim"],
      recommended_visualization_ids: ["taxonomy_heatmap", "primary_threat_tag_distribution", "domain_distribution"],
    });
  }

  return items;
}

// ── Operationalisation evidence ────────────────────────────────────────────────

function operationalisationEvidence(aggregates) {
  const items = [];
  const ma = aggregates.maturity_analytics || {};
  const opDist = ma.operational_status_distribution || {};
  const total  = sumObj(opDist);
  if (total === 0) return items;

  const active  = (opDist.active_operational_use || 0) + (opDist.mainstream_operational_use || 0);
  const limited = opDist.limited_operational_use || 0;
  const poc     = opDist.proof_of_concept || 0;

  items.push({
    analytics_evidence_id: aeId(),
    evidence_type:  "maturity_distribution",
    finding:        `Within the collected corpus, ${active} sources show active/mainstream operational use, ${limited} limited operational use, and ${poc} proof-of-concept stage.`,
    data:           { operational_status_distribution: opDist, total },
    source_ids:     [],
    metric_ids:     ["maturity_analytics.operational_status_distribution"],
    domain:         null,
    source_types:   ["incident","exploit_disclosure","vulnerability","threat_intelligence","adversary_adoption_signal"],
    confidence:     confidence(total),
    caveat_if_any:  caveat(total, "Only operational source types (incident, exploit, vuln, TI) meaningfully contribute to operational claims."),
    supports_claim_types:          ["capability_shift_claim", "adoption_claim", "outlook"],
    recommended_visualization_ids: ["operational_status_by_category", "maturity_distribution", "capability_pipeline_funnel"],
  });

  // Per-domain operationalisation
  for (const [domain, catMat] of Object.entries(ma.category_by_operational_status || {})) {
    const catTotal = sumObj(catMat);
    if (catTotal < 3) continue;
    const catActive = (catMat.active_operational_use || 0) + (catMat.mainstream_operational_use || 0);
    if (catActive > 0) {
      items.push({
        analytics_evidence_id: aeId(),
        evidence_type:  "maturity_distribution",
        finding:        `Within the corpus, for ${domain}: ${catActive} of ${catTotal} sources show active operational status.`,
        data:           { domain, operational_status_distribution: catMat, total: catTotal },
        source_ids:     [],
        metric_ids:     [`maturity_analytics.category_by_operational_status.${domain}`],
        domain,
        source_types:   [],
        confidence:     confidence(catTotal),
        caveat_if_any:  caveat(catTotal),
        supports_claim_types:          ["capability_shift_claim", "adoption_claim"],
        recommended_visualization_ids: ["operational_status_by_category", "category_maturity_matrix"],
      });
    }
  }

  return items;
}

// ── Adversary adoption evidence ────────────────────────────────────────────────

function adversaryAdoptionEvidence(aggregates) {
  const items = [];
  const adv = aggregates.adversary_adoption_analytics || {};
  const stageDist = adv.adoption_stage_distribution || {};
  const total = adv.total_adversary_sources || 0;
  if (total === 0) return items;

  const activeStages = ["limited_operational_use","active_operational_use","widespread_use"];
  const activeCount = activeStages.reduce((s, k) => s + (stageDist[k] || 0), 0);

  items.push({
    analytics_evidence_id: aeId(),
    evidence_type:  "adoption_signal",
    finding:        `Within the collected corpus, among ${total} adversary-type sources (TI, incident, adoption signal, exploit), ${activeCount} show limited-or-greater adversary adoption of AI capabilities.`,
    data:           { adversary_adoption_distribution: stageDist, total_adversary_sources: total },
    source_ids:     (adv.adversary_adoption_evidence || []).map((e) => e.source_id).slice(0, 20),
    metric_ids:     ["adversary_adoption_analytics.adoption_stage_distribution"],
    domain:         null,
    source_types:   ["adversary_adoption_signal","threat_intelligence","incident","exploit_disclosure"],
    confidence:     confidence(total),
    caveat_if_any:  (adv.adoption_caveats || []).join(" ") ||
                    caveat(total, "Governance, ecosystem, and strategic signals are excluded from adversary adoption claims."),
    supports_claim_types:          ["adoption_claim", "capability_shift_claim", "outlook"],
    recommended_visualization_ids: ["adversary_adoption_distribution", "adoption_stage_distribution"],
  });

  return items;
}

// ── Capability pipeline evidence ───────────────────────────────────────────────

function capabilityPipelineEvidence(aggregates) {
  const items = [];
  const cap = aggregates.capability_analytics || {};
  const total = cap.total_capability_sources || 0;
  if (total === 0) return items;

  const rtp = (cap.research_to_poc_signals || []).length;
  const p2o = (cap.poc_to_operational_signals || []).length;
  const watchlist = (cap.capability_watchlist || []).length;

  items.push({
    analytics_evidence_id: aeId(),
    evidence_type:  "maturity_distribution",
    finding:        `Within the collected corpus, ${rtp} research/benchmark sources show research-to-PoC progression, ${p2o} show PoC-to-operational signals, and ${watchlist} are on the capability watchlist.`,
    data:           {
      capability_stage_distribution: cap.capability_stage_distribution,
      research_to_poc_count:    rtp,
      poc_to_operational_count: p2o,
      watchlist_count:          watchlist,
    },
    source_ids:     [
      ...(cap.research_to_poc_signals    || []).map((s) => s.source_id),
      ...(cap.poc_to_operational_signals || []).map((s) => s.source_id),
    ].slice(0, 20),
    metric_ids:     ["capability_analytics.capability_stage_distribution"],
    domain:         null,
    source_types:   ["research_finding","benchmark_evaluation","capability_demonstration","exploit_disclosure"],
    confidence:     confidence(total),
    caveat_if_any:  caveat(total),
    supports_claim_types:          ["capability_shift_claim", "outlook", "trend_claim"],
    recommended_visualization_ids: ["capability_stage_distribution", "capability_pipeline_funnel"],
  });

  return items;
}

// ── Coverage gap evidence ──────────────────────────────────────────────────────

function coverageGapEvidence(aggregates) {
  const items = [];
  const def = aggregates.defensive_analytics || {};
  const gaps = def.mitigation_gap_signals || [];

  if (gaps.length > 0) {
    items.push({
      analytics_evidence_id: aeId(),
      evidence_type:  "coverage_gap",
      finding:        `Within the collected corpus, ${gaps.length} frequently observed attack vector(s) have no corresponding defensive-capability source.`,
      data:           { mitigation_gaps: gaps },
      source_ids:     [],
      metric_ids:     ["defensive_analytics.mitigation_gap_signals"],
      domain:         null,
      source_types:   ["defensive_capability"],
      confidence:     "medium",
      caveat_if_any:  "Gap reflects corpus collection — not absence of real-world defensive capability.",
      supports_claim_types:          ["evidence_gap", "recommendation"],
      recommended_visualization_ids: ["mitigation_gap_signals", "evidence_gap_matrix"],
    });
  }

  // Thin coverage from coverage matrix
  const matrix = aggregates.source_type_coverage_matrix || {};
  for (const flag of (matrix.thin_coverage_flags || [])) {
    items.push({
      analytics_evidence_id: aeId(),
      evidence_type:  "evidence_confidence",
      finding:        `Within the collected corpus, for ${flag.domain}: ${flag.reason}`,
      data:           flag,
      source_ids:     [],
      metric_ids:     ["source_type_coverage_matrix.thin_coverage_flags"],
      domain:         flag.domain || null,
      source_types:   [],
      confidence:     "medium",
      caveat_if_any:  "Thin operational coverage reduces confidence in operational claims for this domain.",
      supports_claim_types:          ["evidence_gap", "confidence_assessment"],
      recommended_visualization_ids: ["evidence_strength_by_category", "evidence_gap_matrix"],
    });
  }

  return items;
}

// ── Timeline evidence ─────────────────────────────────────────────────────────

function timelineEvidence(aggregates) {
  const items = [];
  const trend = aggregates.trend_analytics || {};
  const monthly = trend.monthly_domain_counts || {};
  const months = Object.keys(monthly).sort();

  if (months.length === 0) return items;

  // Only emit timeline finding if we have enough months
  if (months.length >= 3) {
    const domainSeries = {};
    for (const [month, counts] of Object.entries(monthly)) {
      for (const [domain, count] of Object.entries(counts)) {
        if (!domainSeries[domain]) domainSeries[domain] = [];
        domainSeries[domain].push({ month, count });
      }
    }

    const topMonth = months[months.length - 1];
    const topMonthCounts = monthly[topMonth] || {};
    const topDomain = Object.entries(topMonthCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    items.push({
      analytics_evidence_id: aeId(),
      evidence_type:  "timeline",
      finding:        `Within the collected corpus, ${months.length} months of source coverage are available. ${topDomain ? `The domain with the highest corpus coverage in the most recent month is '${topDomain}'.` : ""}`,
      data:           { monthly_domain_counts: monthly, months_available: months.length, domain_series: domainSeries },
      source_ids:     [],
      metric_ids:     ["trend_analytics.monthly_domain_counts"],
      domain:         null,
      source_types:   [],
      confidence:     months.length >= 6 ? "high" : "medium",
      caveat_if_any:  trend.trend_language_note || "Use 'within the collected corpus' phrasing, not global prevalence language.",
      supports_claim_types:          ["trend_claim", "early_signal", "outlook"],
      recommended_visualization_ids: ["monthly_category_timeline", "corpus_timeline"],
    });
  }

  // Burst cluster evidence
  for (const bc of (trend.burst_clusters || [])) {
    items.push({
      analytics_evidence_id: aeId(),
      evidence_type:  "burst_pattern",
      finding:        `Within the collected corpus, '${bc.key}' shows a burst pattern in ${bc.peak_month}: ${bc.peak_count} sources vs. average of ${bc.avg_count}. Not enough sustained months for a trend claim.`,
      data:           bc,
      source_ids:     bc.source_ids || [],
      metric_ids:     ["trend_analytics.burst_clusters"],
      domain:         bc.type === "domain" ? bc.key : null,
      source_types:   [],
      confidence:     "low",
      caveat_if_any:  "A burst pattern is not a trend. Requires ≥ 3 non-zero separated months and ≥ 2 independent source types for a trend claim.",
      supports_claim_types:          ["early_signal"],
      recommended_visualization_ids: ["monthly_category_timeline"],
    });
  }

  // Insufficient trend data flags
  for (const flag of (trend.insufficient_trend_data || [])) {
    items.push({
      analytics_evidence_id: aeId(),
      evidence_type:  "insufficient_trend_data",
      finding:        `Within the collected corpus, insufficient data for a trend claim on '${flag.key}': ${flag.reason}`,
      data:           flag,
      source_ids:     [],
      metric_ids:     ["trend_analytics.insufficient_trend_data"],
      domain:         flag.type === "domain" ? flag.key : null,
      source_types:   [],
      confidence:     "low",
      caveat_if_any:  "Need ≥ 3 non-zero monthly buckets and ≥ 2 independent source types for a trend direction claim.",
      supports_claim_types:          [],
      recommended_visualization_ids: [],
    });
  }

  return items;
}

// ── Derived index evidence ────────────────────────────────────────────────────

function derivedIndexEvidence(derived_metrics) {
  const items = [];
  for (const [key, metric] of Object.entries(derived_metrics || {})) {
    // Skip backward-compat aliases (old names that duplicate new ones)
    if (["agentic_risk_index","ai_enabled_threat_index","defensive_maturity_index","ecosystem_dependency_index"].includes(key)) continue;
    if (!metric?.index_id) continue;
    if (metric.label === "very_high" || metric.label === "high") {
      items.push({
        analytics_evidence_id: aeId(),
        evidence_type:  "derived_metric",
        finding:        `Within the collected corpus, ${metric.index_id}: score ${metric.score}/100 (${metric.label}) — ${metric.explanation || metric.formula || ""}`,
        data:           {
          index_id:    metric.index_id,
          score:       metric.score,
          label:       metric.label,
          inputs:      metric.inputs,
          formula:     metric.formula,
          source_count: metric.source_count,
          confidence:  metric.confidence,
        },
        source_ids:     [],
        metric_ids:     [metric.index_id],
        domain:         null,
        source_types:   [],
        confidence:     metric.confidence || "medium",
        caveat_if_any:  metric.caveat_if_any || null,
        supports_claim_types:          ["trend_claim", "category_insight", "executive_judgment"],
        recommended_visualization_ids: ["derived_metrics_overview", "critical_trend_overview"],
      });
    }
  }
  return items;
}

// ── Governance, defensive, infrastructure evidence ────────────────────────────

function structuralSignalEvidence(aggregates) {
  const items = [];

  // Governance
  const gov = aggregates.governance_analytics || {};
  const govTotal = gov.total_governance_sources || 0;
  if (govTotal > 0) {
    const topFn = Object.entries(gov.governance_function_frequency || {}).sort((a,b) => b[1]-a[1])[0];
    items.push({
      analytics_evidence_id: aeId(),
      evidence_type:  "frequency_distribution",
      finding:        `Within the collected corpus, ${govTotal} governance signal sources were collected${topFn ? `; most common governance function: '${topFn[0]}'` : ""}.`,
      data:           gov,
      source_ids:     [],
      metric_ids:     ["governance_analytics"],
      domain:         null,
      source_types:   ["governance_signal"],
      confidence:     confidence(govTotal),
      caveat_if_any:  "Governance signals describe regulatory/policy activity, not adversary behaviour.",
      supports_claim_types:          ["recommendation", "outlook"],
      recommended_visualization_ids: ["governance_function_frequency"],
    });
  }

  // Defensive
  const def = aggregates.defensive_analytics || {};
  const defTotal = def.total_defensive_sources || 0;
  if (defTotal > 0) {
    items.push({
      analytics_evidence_id: aeId(),
      evidence_type:  "frequency_distribution",
      finding:        `Within the collected corpus, ${defTotal} defensive capability sources were collected.`,
      data:           { defensive_control_frequency: def.defensive_control_frequency, total: defTotal },
      source_ids:     [],
      metric_ids:     ["defensive_analytics"],
      domain:         null,
      source_types:   ["defensive_capability"],
      confidence:     confidence(defTotal),
      caveat_if_any:  caveat(defTotal),
      supports_claim_types:          ["recommendation", "evidence_gap"],
      recommended_visualization_ids: ["defensive_control_frequency"],
    });
  }

  // Infrastructure / trust boundary
  const eco = aggregates.ecosystem_analytics || {};
  const ecoTotal = eco.total_ecosystem_sources || 0;
  const tb  = aggregates.trust_boundary_analytics || {};
  const tbTotal  = tb.total_trust_boundary_sources || 0;

  if (ecoTotal + tbTotal > 0) {
    items.push({
      analytics_evidence_id: aeId(),
      evidence_type:  "frequency_distribution",
      finding:        `Within the collected corpus, ${ecoTotal} infrastructure/ecosystem dependency sources and ${tbTotal} trust boundary shift sources were collected.`,
      data:           {
        dependency_type_frequency:       eco.dependency_type_frequency,
        trust_boundary_shift_frequency:  tb.trust_boundary_shift_frequency,
      },
      source_ids:     [],
      metric_ids:     ["ecosystem_analytics","trust_boundary_analytics"],
      domain:         null,
      source_types:   ["attack_surface_signal"],
      confidence:     confidence(ecoTotal + tbTotal),
      caveat_if_any:  caveat(ecoTotal + tbTotal, "Infrastructure and trust boundary signals provide structural context, not direct operational evidence."),
      supports_claim_types:          ["recommendation", "outlook", "exposure_shift"],
      recommended_visualization_ids: ["trust_boundary_frequency", "dependency_exposure_matrix"],
    });
  }

  return items;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the analytics evidence pack from aggregates and derived metrics.
 *
 * @param {object} aggregates      - Output of aggregateAnalytics()
 * @param {object} derived_metrics - Output of computeDerivedMetrics()
 * @returns {object[]}             - analytics_evidence[] items
 */
export function selectAnalyticsEvidence(aggregates, derived_metrics) {
  const raw = [
    ...corpusEvidence(aggregates),
    ...threatFrequencyEvidence(aggregates),
    ...operationalisationEvidence(aggregates),
    ...adversaryAdoptionEvidence(aggregates),
    ...capabilityPipelineEvidence(aggregates),
    ...structuralSignalEvidence(aggregates),
    ...coverageGapEvidence(aggregates),
    ...timelineEvidence(aggregates),
    ...derivedIndexEvidence(derived_metrics),
  ];
  // Ensure all items have the full required schema fields
  return raw.map(finalize);
}
