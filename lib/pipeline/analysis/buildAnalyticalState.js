/**
 * L6A — Analytical State Construction
 *
 * Deterministic stage that runs after fused dossier construction and BEFORE
 * category LLM analysis calls. Builds structured analytical state from all
 * prior layer outputs so the LLM evaluates pre-structured candidates instead
 * of discovering patterns from loose evidence bags.
 *
 * ── ROLE ──────────────────────────────────────────────────────────────────────
 * Code constructs analytical relationships.
 * LLM explains, prioritises, and writes evidence-backed judgments.
 *
 * ── OUTPUTS ───────────────────────────────────────────────────────────────────
 * {
 *   analytical_state_version: "v1",
 *   category_states: [],          — per-category structured state
 *   cross_category_state: {},     — shared patterns and convergence clusters
 *   hypothesis_candidates: [],    — all candidates (category + cross-category)
 *   evidence_gaps: [],            — things missing from corpus
 *   contradictions: [],           — conflicting signals
 *   qa_notes: []                  — structural validation results
 * }
 *
 * ── CONFIDENCE CEILINGS ───────────────────────────────────────────────────────
 * high   — ≥ 3 operational source types + validated taxonomy + quantitative anchor
 * medium — ≥ 2 supporting evidence items (mixed source types acceptable)
 * low    — single source or single evidence stream
 * none   — gap only; do not make a positive claim
 */

import { randomUUID } from "crypto";

// ── ID generators ─────────────────────────────────────────────────────────────

function patId(category, n) {
  return `pat_${category.replace(/_/g, "")}_${String(n).padStart(3, "0")}`;
}
function opId(category, n) {
  return `op_${category.replace(/_/g, "")}_${String(n).padStart(3, "0")}`;
}
function trendId(category, n) {
  return `tr_${category.replace(/_/g, "")}_${String(n).padStart(3, "0")}`;
}
function advId(category, n) {
  return `adv_${category.replace(/_/g, "")}_${String(n).padStart(3, "0")}`;
}
function capId(category, n) {
  return `cap_${category.replace(/_/g, "")}_${String(n).padStart(3, "0")}`;
}
function hypId(scope, n) {
  return `hyp_${scope.replace(/_/g, "")}_${String(n).padStart(3, "0")}`;
}
function ccpId(n) {
  return `ccp_${String(n).padStart(3, "0")}`;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sumObj(obj) {
  return Object.values(obj || {}).reduce((a, b) => {
    const v = typeof b === "number" ? b : (b?.count || 0);
    return a + v;
  }, 0);
}

function countFromTracked(tracked, key) {
  const v = tracked?.[key];
  if (!v) return 0;
  return typeof v === "number" ? v : (v.count || 0);
}

function sourceIdsFromTracked(tracked, key, max = 10) {
  const v = tracked?.[key];
  if (!v || typeof v === "number") return [];
  return (v.source_ids || []).slice(0, max);
}

function confidenceFromN(n, sourceTypeDiversity = 1) {
  if (n >= 5 && sourceTypeDiversity >= 2) return "high";
  if (n >= 2) return "medium";
  if (n >= 1) return "low";
  return "none";
}

const OPERATIONAL_SOURCE_TYPES = new Set([
  "incident", "exploit_disclosure", "vulnerability", "threat_intelligence",
  "adversary_adoption_signal",
]);

const FOUR_DOMAINS = [
  "traditional_ai_threats", "llm_threats",
  "agentic_ai_threats",    "ai_enabled_threats",
];

// ── Stage 1: Dominant threat patterns ─────────────────────────────────────────
// Patterns are derived from rawfact evidence items + attack vector frequency.

function buildDominantPatterns(category, dossier, aggregates) {
  const patterns = [];
  const rf = dossier?.rawfact || {};
  const allItems = [
    ...(rf.strong_evidence || []),
    ...(rf.usable_evidence || []).slice(0, 8),
  ];

  if (allItems.length === 0) return patterns;

  // Group by evidence_type to find dominant patterns
  const byType = {};
  for (const item of allItems) {
    const et = item.evidence_type || "unknown";
    if (!byType[et]) byType[et] = { count: 0, items: [], sourceTypes: new Set() };
    byType[et].count++;
    byType[et].items.push(item);
    if (item.source_type) byType[et].sourceTypes.add(item.source_type);
  }

  // Also use attack_vector_frequency_tracked if available (has source_ids)
  const vecTracked = aggregates?.threat_pattern_analytics?.attack_vector_frequency_tracked || {};
  const topVectors = Object.entries(vecTracked)
    .map(([v, d]) => ({ v, count: typeof d === "number" ? d : (d.count || 0), source_ids: typeof d === "object" ? (d.source_ids || []) : [] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Build pattern from top attack vectors with enough support
  let n = 0;
  for (const { v, count, source_ids } of topVectors) {
    if (count < 2) break;

    // Get rawfact evidence IDs from dossier items that mention this vector
    const matchingItems = allItems.filter((item) =>
      (item.evidence_type || "").includes(v.replace(/_/g, "_")) ||
      (item.fact || "").toLowerCase().includes(v.replace(/_/g, " "))
    );

    const supportingEvidenceIds = [
      ...matchingItems.map((i) => i.evidence_id).filter(Boolean).slice(0, 5),
    ];
    const supportingMetricIds = [`agg_attack_vector_frequency`];

    const sourceTypeMix = {};
    for (const item of matchingItems) {
      if (item.source_type) sourceTypeMix[item.source_type] = (sourceTypeMix[item.source_type] || 0) + 1;
    }

    const uniqueTypes = Object.keys(sourceTypeMix).length;

    patterns.push({
      pattern_id:                    patId(category, ++n),
      pattern_name:                  v,
      primary_threat_tags:           [v],
      subdomains:                    [],
      source_count:                  count,
      weighted_count:                typeof vecTracked[v] === "object" ? (vecTracked[v].weighted || count) : count,
      supporting_evidence_ids:       supportingEvidenceIds,
      supporting_metric_ids:         supportingMetricIds,
      supporting_external_evidence_ids: [],
      source_type_mix:               sourceTypeMix,
      confidence:                    confidenceFromN(count, uniqueTypes),
      caveat_if_any:                 count < 3 ? `Only ${count} source(s) — pattern may not be representative` : null,
    });
  }

  // Also add a pattern for the dominant evidence_type if it has ≥ 3 items
  for (const [et, d] of Object.entries(byType).sort((a, b) => b[1].count - a[1].count)) {
    if (d.count < 3 || patterns.find((p) => p.pattern_name === et)) continue;
    patterns.push({
      pattern_id:              patId(category, ++n),
      pattern_name:            et,
      primary_threat_tags:     [et],
      subdomains:              [],
      source_count:            d.count,
      weighted_count:          d.count,
      supporting_evidence_ids: d.items.map((i) => i.evidence_id).filter(Boolean).slice(0, 6),
      supporting_metric_ids:   [],
      supporting_external_evidence_ids: [],
      source_type_mix:         Object.fromEntries([...d.sourceTypes].map((t) => [t, d.items.filter((i) => i.source_type === t).length])),
      confidence:              confidenceFromN(d.count, d.sourceTypes.size),
      caveat_if_any:           null,
    });
  }

  return patterns.slice(0, 6);
}

// ── Stage 2: Operationalisation signals ───────────────────────────────────────

function buildOperationalisationSignals(category, dossier, aggregates) {
  const signals = [];
  const catOpDist = aggregates?.maturity_analytics?.category_by_operational_status?.[category] || {};

  const ACTIVE_STATUSES = [
    "active_operational_use", "mainstream_operational_use",
    "limited_operational_use", "proof_of_concept",
  ];

  let n = 0;
  for (const status of ACTIVE_STATUSES) {
    const count = catOpDist[status] || 0;
    if (count === 0) continue;

    // Find rawfact evidence items from this category dossier that match this status
    const rf = dossier?.rawfact || {};
    const relevantItems = [
      ...(rf.strong_evidence || []),
      ...(rf.usable_evidence || []),
    ].filter((item) => OPERATIONAL_SOURCE_TYPES.has(item.source_type));

    const evIds = relevantItems.map((i) => i.evidence_id).filter(Boolean).slice(0, 4);
    const sourcetypes = [...new Set(relevantItems.map((i) => i.source_type).filter(Boolean))];

    // Only emit if operational-type sources back this up
    if (status !== "proof_of_concept" && !relevantItems.some((i) => OPERATIONAL_SOURCE_TYPES.has(i.source_type))) {
      continue;
    }

    signals.push({
      signal_id:               opId(category, ++n),
      status,
      threat_tags:             [],
      source_types:            sourcetypes,
      supporting_evidence_ids: evIds,
      supporting_metric_ids:   [`agg_operational_status_distribution`],
      confidence:              confidenceFromN(count, sourcetypes.length),
      caveat_if_any:           sourcetypes.length < 2
        ? "Single source type — operational claim needs corroboration from other source types"
        : null,
    });
  }

  return signals;
}

// ── Stage 3: Adversary adoption signals ───────────────────────────────────────
// ONLY from operational source types: incident, exploit_disclosure, TI, adversary_adoption_signal

function buildAdversaryAdoptionSignals(category, aggregates) {
  const signals = [];
  const advEvidence = (aggregates?.adversary_adoption_analytics?.adversary_adoption_evidence || [])
    .filter((e) => e.domain === category);

  if (advEvidence.length === 0) return signals;

  const byStage = {};
  for (const e of advEvidence) {
    const stage = e.adoption_stage || "unknown";
    if (!byStage[stage]) byStage[stage] = [];
    byStage[stage].push(e);
  }

  let n = 0;
  for (const [stage, items] of Object.entries(byStage).sort((a, b) => b[1].length - a[1].length)) {
    if (stage === "none_observed" || stage === "unknown") continue;

    signals.push({
      signal_id:               advId(category, ++n),
      adoption_stage:          stage,
      source_types:            [...new Set(items.map((i) => i.source_type))],
      attack_vectors:          [...new Set(items.flatMap((i) => i.attack_vectors || []))].slice(0, 4),
      source_count:            items.length,
      supporting_source_ids:   items.map((i) => i.source_id).filter(Boolean).slice(0, 5),
      supporting_metric_ids:   ["agg_adversary_adoption_distribution"],
      confidence:              confidenceFromN(items.length, new Set(items.map((i) => i.source_type)).size),
      caveat_if_any:           items.length < 3
        ? `Only ${items.length} source(s) — adoption signal is preliminary`
        : null,
    });
  }

  return signals;
}

// ── Stage 4: Capability progression signals ────────────────────────────────────

function buildCapabilityProgressionSignals(category, aggregates) {
  const signals = [];

  const r2p = (aggregates?.capability_analytics?.research_to_poc_signals || [])
    .filter((s) => s.domain === category);
  const p2o = (aggregates?.capability_analytics?.poc_to_operational_signals || [])
    .filter((s) => s.domain === category);
  const watch = (aggregates?.capability_analytics?.capability_watchlist || [])
    .filter((s) => s.domain === category);

  let n = 0;

  if (r2p.length > 0) {
    signals.push({
      signal_id:         capId(category, ++n),
      progression_type:  "research_to_poc",
      source_count:      r2p.length,
      source_ids:        r2p.map((s) => s.source_id).filter(Boolean).slice(0, 5),
      attack_vectors:    [...new Set(r2p.flatMap((s) => s.attack_vectors || []))].slice(0, 4),
      supporting_metric_ids: ["agg_capability_stage_distribution"],
      confidence:        confidenceFromN(r2p.length),
      caveat_if_any:     null,
    });
  }
  if (p2o.length > 0) {
    signals.push({
      signal_id:         capId(category, ++n),
      progression_type:  "poc_to_operational",
      source_count:      p2o.length,
      source_ids:        p2o.map((s) => s.source_id).filter(Boolean).slice(0, 5),
      attack_vectors:    [...new Set(p2o.flatMap((s) => s.attack_vectors || []))].slice(0, 4),
      supporting_metric_ids: ["agg_capability_stage_distribution"],
      confidence:        confidenceFromN(p2o.length),
      caveat_if_any:     null,
    });
  }
  if (watch.length > 0) {
    signals.push({
      signal_id:         capId(category, ++n),
      progression_type:  "capability_watchlist",
      source_count:      watch.length,
      source_ids:        watch.map((s) => s.source_id).filter(Boolean).slice(0, 5),
      attack_vectors:    [...new Set(watch.flatMap((s) => s.attack_vectors || []))].slice(0, 4),
      supporting_metric_ids: ["agg_capability_stage_distribution"],
      confidence:        confidenceFromN(watch.length),
      caveat_if_any:     "Watchlist items need further confirmation before claiming operational use",
    });
  }

  return signals;
}

// ── Stage 5: Trend signals (3-bucket minimum) ─────────────────────────────────

function buildTrendSignals(category, aggregates) {
  const signals = [];
  const trend = aggregates?.trend_analytics || {};

  // Check if this domain has insufficient trend data
  const insufficientFlag = (trend.insufficient_trend_data || [])
    .find((f) => f.key === category && f.type === "domain");

  const monthly = trend.monthly_domain_counts || {};
  const months = Object.keys(monthly).sort();
  const nonZero = months.filter((m) => (monthly[m]?.[category] || 0) > 0).length;

  if (insufficientFlag || nonZero < 3) {
    signals.push({
      trend_id:               trendId(category, 1),
      metric_id:              "agg_monthly_domain_counts",
      trend_subject:          category,
      direction:              "insufficient_data",
      time_buckets:           months.length,
      non_zero_buckets:       nonZero,
      supporting_metric_ids:  ["agg_monthly_domain_counts"],
      confidence:             "none",
      caveat_if_any:          `Only ${nonZero} non-zero month(s) available; need ≥ 3 for a trend claim. Do not claim trend direction.`,
    });
    return signals;
  }

  // We have enough buckets — compute direction
  const delta = trend.trend_deltas?.[category];
  let direction = "stable";
  if (delta) {
    direction = delta.trend || (delta.delta > 0 ? "increasing" : delta.delta < 0 ? "decreasing" : "stable");
  }

  signals.push({
    trend_id:              trendId(category, 1),
    metric_id:             "agg_monthly_domain_counts",
    trend_subject:         category,
    direction,
    time_buckets:          months.length,
    non_zero_buckets:      nonZero,
    supporting_metric_ids: ["agg_monthly_domain_counts", "agg_trend_deltas"],
    confidence:            nonZero >= 6 ? "high" : "medium",
    caveat_if_any:         `Corpus trend only — describes collected source volume, not real-world prevalence. Use "within the collected corpus" phrasing.`,
  });

  return signals;
}

// ── Stage 6: Evidence strength ─────────────────────────────────────────────────

function buildEvidenceStrength(dossier, externalEvidence, visualEvidence) {
  const rf = dossier?.rawfact || {};
  const strongCount = (rf.strong_evidence || []).length;
  const usableCount = (rf.usable_evidence || []).length;
  const totalRawfact  = strongCount + usableCount + (rf.case_study_candidates || []).length +
                        (rf.statistics || []).length;

  const sourceCount   = dossier?.source_count || 0;

  const allItems = [...(rf.strong_evidence || []), ...(rf.usable_evidence || [])];
  const sourceTypeSet = new Set(allItems.map((i) => i.source_type).filter(Boolean));
  const sourceTypeDiversity = sourceTypeSet.size;

  const hasOperationalType = [...sourceTypeSet].some((t) => OPERATIONAL_SOURCE_TYPES.has(t));
  const hasPrimarySource   = allItems.some((i) => ["primary","curated"].includes(i.trust_tier));
  const totalPrimary       = allItems.filter((i) => ["primary","curated","high"].includes(i.trust_tier)).length;
  const primaryRatio       = totalRawfact > 0 ? Math.round(totalPrimary / totalRawfact * 100) / 100 : 0;

  const catExternal = (externalEvidence || []).filter(
    (e) => e.category === dossier?.category && e.evidence_confidence !== "low" && !e.needs_manual_review
  );
  const catVisual = (visualEvidence || []).filter(
    (v) => v.category === dossier?.category && !v.needs_manual_review
  );

  let confidence_ceiling;
  if (strongCount >= 2 && sourceTypeDiversity >= 3 && catExternal.length > 0) {
    confidence_ceiling = "high";
  } else if (strongCount + usableCount >= 3 && sourceTypeDiversity >= 2) {
    confidence_ceiling = "high";
  } else if (strongCount + usableCount >= 2 || catExternal.length > 0) {
    confidence_ceiling = "medium";
  } else if (totalRawfact >= 1) {
    confidence_ceiling = "low";
  } else {
    confidence_ceiling = "none";
  }

  return {
    validated_evidence_count:  totalRawfact,
    source_count:              sourceCount,
    source_type_diversity:     sourceTypeDiversity,
    has_operational_sources:   hasOperationalType,
    primary_source_ratio:      primaryRatio,
    has_external_support:      catExternal.length > 0,
    has_quantitative_support:  (rf.statistics || []).length > 0 || catExternal.some((e) => e.metric_value != null),
    has_visual_support:        catVisual.length > 0,
    confidence_ceiling,
  };
}

// ── Stage 7: Hypothesis candidate generation ─────────────────────────────────

function buildCategoryHypothesisCandidates(category, categoryState, dossier) {
  const candidates = [];
  const ceiling = categoryState.evidence_strength?.confidence_ceiling || "low";
  let n = 0;

  // Hypothesis from each dominant pattern
  for (const pat of (categoryState.dominant_threat_patterns || []).slice(0, 4)) {
    if (pat.source_count < 2) continue;

    const judgmentType = pat.source_type_mix &&
      Object.keys(pat.source_type_mix).some((t) => OPERATIONAL_SOURCE_TYPES.has(t))
      ? "operationalisation" : "trend";

    const conf = pat.confidence === "high" && ceiling === "high" ? "high"
               : pat.confidence === "none"                       ? "none"
               : pat.confidence === "high"                       ? "medium"
               : pat.confidence;

    candidates.push({
      hypothesis_id:           hypId(category, ++n),
      category,
      judgment_type:           judgmentType,
      candidate_claim:         `${pat.pattern_name} is a notable pattern in the ${category.replace(/_/g, " ")} corpus (${pat.source_count} sources, weighted ${Math.round(pat.weighted_count || pat.source_count)})`,
      basis: {
        dominant_pattern_ids:            [pat.pattern_id],
        operationalisation_signal_ids:   [],
        trend_ids:                       [],
        metric_ids:                      pat.supporting_metric_ids,
        rawfact_evidence_ids:            pat.supporting_evidence_ids.slice(0, 4),
        external_evidence_ids:           pat.supporting_external_evidence_ids,
        visual_evidence_ids:             [],
      },
      supporting_evidence_ids:  pat.supporting_evidence_ids.slice(0, 4),
      counter_evidence_ids:     [],
      confidence_ceiling:       conf,
      recommended_output_type:  conf === "none" ? "evidence_gap"
                               : conf === "low"  ? "caveat"
                               : "insight",
      caveat_if_any:            pat.caveat_if_any,
    });
  }

  // Hypothesis from operationalisation signals
  for (const sig of (categoryState.operationalisation_signals || []).slice(0, 2)) {
    const conf = sig.confidence === "high" && ceiling === "high" ? "high"
               : sig.confidence === "none"                       ? "none"
               : sig.confidence;

    const isHighOp = ["active_operational_use","mainstream_operational_use"].includes(sig.status);
    candidates.push({
      hypothesis_id:  hypId(category, ++n),
      category,
      judgment_type:  "operationalisation",
      candidate_claim: `${category.replace(/_/g, " ")} shows evidence of ${sig.status.replace(/_/g, " ")} based on ${sig.source_types.join(", ")} sources`,
      basis: {
        dominant_pattern_ids:          [],
        operationalisation_signal_ids: [sig.signal_id],
        trend_ids:                     [],
        metric_ids:                    sig.supporting_metric_ids,
        rawfact_evidence_ids:          sig.supporting_evidence_ids.slice(0, 4),
        external_evidence_ids:         [],
        visual_evidence_ids:           [],
      },
      supporting_evidence_ids: sig.supporting_evidence_ids.slice(0, 4),
      counter_evidence_ids:    [],
      confidence_ceiling:      conf,
      recommended_output_type: isHighOp && conf !== "none" ? "insight" : "caveat",
      caveat_if_any:           sig.caveat_if_any,
    });
  }

  // Hypothesis from trend signals
  for (const tr of (categoryState.trend_signals || []).slice(0, 1)) {
    if (tr.direction === "insufficient_data") {
      candidates.push({
        hypothesis_id:  hypId(category, ++n),
        category,
        judgment_type:  "evidence_gap",
        candidate_claim: `Insufficient trend data for ${category.replace(/_/g, " ")} — only ${tr.non_zero_buckets} non-zero month(s) available`,
        basis: {
          dominant_pattern_ids: [], operationalisation_signal_ids: [], trend_ids: [tr.trend_id],
          metric_ids: tr.supporting_metric_ids, rawfact_evidence_ids: [], external_evidence_ids: [], visual_evidence_ids: [],
        },
        supporting_evidence_ids: [],
        counter_evidence_ids:    [],
        confidence_ceiling:      "none",
        recommended_output_type: "evidence_gap",
        caveat_if_any:           tr.caveat_if_any,
      });
    } else {
      const dirLabel = tr.direction === "increasing" ? "growing" : tr.direction === "decreasing" ? "declining" : "stable";
      candidates.push({
        hypothesis_id:  hypId(category, ++n),
        category,
        judgment_type:  "trend",
        candidate_claim: `Within the collected corpus, ${category.replace(/_/g, " ")} source volume shows a ${dirLabel} direction (${tr.non_zero_buckets} non-zero months across ${tr.time_buckets} total months)`,
        basis: {
          dominant_pattern_ids: [], operationalisation_signal_ids: [], trend_ids: [tr.trend_id],
          metric_ids: tr.supporting_metric_ids, rawfact_evidence_ids: [], external_evidence_ids: [], visual_evidence_ids: [],
        },
        supporting_evidence_ids: [],
        counter_evidence_ids:    [],
        confidence_ceiling:      tr.confidence,
        recommended_output_type: tr.confidence === "high" ? "insight" : "caveat",
        caveat_if_any:           tr.caveat_if_any,
      });
    }
  }

  // Hypothesis from adversary adoption
  for (const adv of (categoryState.adversary_adoption_signals || []).slice(0, 1)) {
    const conf = adv.confidence;
    candidates.push({
      hypothesis_id:  hypId(category, ++n),
      category,
      judgment_type:  "adoption",
      candidate_claim: `Adversary adoption evidence for ${category.replace(/_/g, " ")}: ${adv.adoption_stage.replace(/_/g, " ")} stage (${adv.source_count} operational-type sources)`,
      basis: {
        dominant_pattern_ids: [], operationalisation_signal_ids: [],
        trend_ids: [], metric_ids: adv.supporting_metric_ids,
        rawfact_evidence_ids: adv.supporting_source_ids.slice(0, 4),
        external_evidence_ids: [], visual_evidence_ids: [],
      },
      supporting_evidence_ids: adv.supporting_source_ids.slice(0, 4),
      counter_evidence_ids:    [],
      confidence_ceiling:      conf,
      recommended_output_type: conf === "high" ? "insight" : conf === "medium" ? "insight" : "early_signal",
      caveat_if_any:           adv.caveat_if_any,
    });
  }

  // Hypothesis from capability progression
  for (const cap of (categoryState.capability_progression_signals || []).slice(0, 1)) {
    if (cap.progression_type === "capability_watchlist") {
      candidates.push({
        hypothesis_id:  hypId(category, ++n),
        category,
        judgment_type:  "capability_progression",
        candidate_claim: `${cap.source_count} source(s) in ${category.replace(/_/g, " ")} are on the capability watchlist (tool_available or operationally_reported stage)`,
        basis: {
          dominant_pattern_ids: [], operationalisation_signal_ids: [], trend_ids: [],
          metric_ids: cap.supporting_metric_ids,
          rawfact_evidence_ids: cap.source_ids.slice(0, 4),
          external_evidence_ids: [], visual_evidence_ids: [],
        },
        supporting_evidence_ids: cap.source_ids.slice(0, 4),
        counter_evidence_ids:    [],
        confidence_ceiling:      cap.confidence,
        recommended_output_type: "early_signal",
        caveat_if_any:           cap.caveat_if_any || "Watchlist items need additional confirmation",
      });
    }
  }

  // Coverage gap hypothesis
  for (const gap of (categoryState.coverage_gaps || []).slice(0, 2)) {
    candidates.push({
      hypothesis_id:  hypId(category, ++n),
      category,
      judgment_type:  "evidence_gap",
      candidate_claim: gap,
      basis: {
        dominant_pattern_ids: [], operationalisation_signal_ids: [], trend_ids: [],
        metric_ids: [], rawfact_evidence_ids: [], external_evidence_ids: [], visual_evidence_ids: [],
      },
      supporting_evidence_ids: [],
      counter_evidence_ids:    [],
      confidence_ceiling:      "none",
      recommended_output_type: "evidence_gap",
      caveat_if_any:           null,
    });
  }

  return candidates;
}

// ── Cross-category state ───────────────────────────────────────────────────────

// Pre-defined convergence cluster seeds — from the spec
const CONVERGENCE_SEEDS = [
  {
    name:    "Prompt injection + tool misuse + agent orchestration",
    tags:    ["prompt_injection", "tool_hijacking", "mcp_abuse", "agent_permission_abuse"],
    domains: ["llm_threats", "agentic_ai_threats"],
  },
  {
    name:    "AI-assisted phishing + deepfake + synthetic identity",
    tags:    ["ai_assisted_phishing", "deepfake_impersonation", "synthetic_identity_abuse", "voice_cloning"],
    domains: ["ai_enabled_threats"],
  },
  {
    name:    "Model supply chain + LLM supply chain + tool supply chain",
    tags:    ["ai_supply_chain_compromise", "model_backdoor", "model_poisoning", "data_poisoning"],
    domains: ["traditional_ai_threats", "llm_threats", "agentic_ai_threats"],
  },
  {
    name:    "Adversarial ML + LLM evasion + adversarial examples",
    tags:    ["adversarial_evasion", "jailbreak", "model_extraction", "model_inversion"],
    domains: ["traditional_ai_threats", "llm_threats"],
  },
  {
    name:    "Governance pressure + infrastructure dependency + trust boundary shift",
    tags:    [],
    domains: ["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats"],
    structural: true,
  },
];

function buildCrossAnalyticalState(categoryStates, aggregates) {
  const cross_category_patterns = [];
  let n = 0;

  // For each convergence seed, check if ≥2 categories have supporting evidence
  for (const seed of CONVERGENCE_SEEDS) {
    const supportingByCategory = {};

    for (const cs of categoryStates) {
      if (!seed.domains.some((d) => cs.category === d) && seed.domains.length > 0) continue;

      // Find patterns or signals that overlap with seed tags
      const patternMatch = (cs.dominant_threat_patterns || []).filter((p) =>
        seed.tags.some((t) => p.pattern_name === t || p.primary_threat_tags.includes(t))
      );

      if (patternMatch.length > 0 || seed.structural) {
        supportingByCategory[cs.category] = {
          patterns:       patternMatch.map((p) => p.pattern_id),
          evidence_ids:   patternMatch.flatMap((p) => p.supporting_evidence_ids).slice(0, 4),
          source_count:   patternMatch.reduce((s, p) => s + p.source_count, 0),
        };
      }
    }

    const categoriesWithSupport = Object.keys(supportingByCategory);
    // Always require evidence from ≥ 2 categories — even structural seeds
    if (categoriesWithSupport.length < 2) continue;

    const totalSources = Object.values(supportingByCategory)
      .reduce((s, d) => s + (d.source_count || 0), 0);

    cross_category_patterns.push({
      pattern_id:    ccpId(++n),
      pattern_name:  seed.name,
      categories:    categoriesWithSupport,
      shared_threat_tags: seed.tags,
      supporting_evidence_ids_by_category: Object.fromEntries(
        Object.entries(supportingByCategory).map(([cat, d]) => [cat, d.evidence_ids])
      ),
      supporting_metric_ids: ["agg_attack_vector_frequency"],
      confidence:    categoriesWithSupport.length >= 3 && totalSources >= 4 ? "high"
                   : categoriesWithSupport.length >= 2 && totalSources >= 2 ? "medium"
                   : "low",
      why_it_matters_candidate: seed.structural
        ? `Structural convergence across ${categoriesWithSupport.join(", ")} — multiple signal types appearing together`
        : `Shared technique cluster '${seed.name}' appears across ${categoriesWithSupport.length} threat domains`,
      caveat_if_any: categoriesWithSupport.length < 2
        ? "Cross-category claim needs evidence from at least 2 categories"
        : null,
    });
  }

  // Shared attack surfaces across categories
  const vecTracked = aggregates?.threat_pattern_analytics?.attack_vector_frequency_tracked || {};
  const topShared = Object.entries(vecTracked)
    .map(([v, d]) => ({ v, count: typeof d === "number" ? d : (d.count || 0) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Shared operationalisation signals
  const sharedOpSignals = categoryStates
    .flatMap((cs) => (cs.operationalisation_signals || []).map((s) => ({ ...s, category: cs.category })))
    .filter((s) => ["active_operational_use","mainstream_operational_use"].includes(s.status));

  // Contradictions: categories with conflicting trend signals
  const contradictions = [];
  const increasing = categoryStates.filter((cs) =>
    cs.trend_signals?.some((t) => t.direction === "increasing")
  ).map((cs) => cs.category);
  const decreasing = categoryStates.filter((cs) =>
    cs.trend_signals?.some((t) => t.direction === "decreasing")
  ).map((cs) => cs.category);

  // No contradictions from trend alone — different categories can have different trends legitimately

  // Global evidence gaps
  const global_evidence_gaps = categoryStates
    .filter((cs) => cs.evidence_strength?.confidence_ceiling === "none" ||
                    cs.evidence_strength?.confidence_ceiling === "low")
    .map((cs) => `${cs.category}: ${cs.evidence_strength?.confidence_ceiling === "none" ? "no usable evidence" : "low evidence — claims must be caveated"}`);

  return {
    cross_category_patterns,
    shared_attack_surfaces:         topShared.map((t) => t.v),
    shared_source_type_signals:     [], // populated from coverage matrix if needed
    shared_operationalisation_signals: sharedOpSignals,
    convergence_clusters:           cross_category_patterns.filter((p) => p.confidence !== "low"),
    contradictions,
    global_evidence_gaps,
  };
}

function buildCrossHypothesisCandidates(crossState, categoryStates) {
  const candidates = [];
  let n = 0;

  for (const pat of (crossState.cross_category_patterns || []).slice(0, 4)) {
    if (pat.categories.length < 2) continue;

    const allEvidenceIds = Object.values(pat.supporting_evidence_ids_by_category)
      .flat().slice(0, 6);

    candidates.push({
      hypothesis_id:  hypId("cross_category", ++n),
      category:       "cross_category",
      judgment_type:  "convergence",
      candidate_claim: pat.why_it_matters_candidate,
      basis: {
        dominant_pattern_ids:          [],
        operationalisation_signal_ids: [],
        trend_ids:                     [],
        metric_ids:                    pat.supporting_metric_ids,
        rawfact_evidence_ids:          allEvidenceIds,
        external_evidence_ids:         [],
        visual_evidence_ids:           [],
      },
      supporting_evidence_ids:         allEvidenceIds,
      counter_evidence_ids:            [],
      confidence_ceiling:              pat.confidence,
      recommended_output_type:         pat.confidence === "high" ? "insight" : "early_signal",
      caveat_if_any:                   pat.caveat_if_any,
    });
  }

  // Shared operationalisation across categories
  const sharedOp = crossState.shared_operationalisation_signals || [];
  if (sharedOp.length >= 2) {
    const cats = [...new Set(sharedOp.map((s) => s.category))];
    if (cats.length >= 2) {
      candidates.push({
        hypothesis_id:  hypId("cross_category", ++n),
        category:       "cross_category",
        judgment_type:  "operationalisation",
        candidate_claim: `Operationalisation signals appear across ${cats.join(" and ")} — multiple categories show active/limited operational use`,
        basis: {
          dominant_pattern_ids: [], operationalisation_signal_ids: sharedOp.map((s) => s.signal_id),
          trend_ids: [], metric_ids: ["agg_operational_status_distribution"],
          rawfact_evidence_ids: sharedOp.flatMap((s) => s.supporting_evidence_ids || []).slice(0, 6),
          external_evidence_ids: [], visual_evidence_ids: [],
        },
        supporting_evidence_ids: sharedOp.flatMap((s) => s.supporting_evidence_ids || []).slice(0, 6),
        counter_evidence_ids:    [],
        confidence_ceiling:      "medium",
        recommended_output_type: "insight",
        caveat_if_any:           "Operationalisation claim spans multiple categories — verify each category's evidence separately",
      });
    }
  }

  // Evidence gap at cross-category level
  if ((crossState.global_evidence_gaps || []).length > 0) {
    candidates.push({
      hypothesis_id:  hypId("cross_category", ++n),
      category:       "cross_category",
      judgment_type:  "evidence_gap",
      candidate_claim: `Thin evidence in: ${crossState.global_evidence_gaps.join("; ")}`,
      basis: {
        dominant_pattern_ids: [], operationalisation_signal_ids: [], trend_ids: [],
        metric_ids: [], rawfact_evidence_ids: [], external_evidence_ids: [], visual_evidence_ids: [],
      },
      supporting_evidence_ids: [],
      counter_evidence_ids:    [],
      confidence_ceiling:      "none",
      recommended_output_type: "evidence_gap",
      caveat_if_any:           null,
    });
  }

  return candidates;
}

// ── QA ────────────────────────────────────────────────────────────────────────

function qaAnalyticalState(analyticalState) {
  const notes = [];

  // Every pattern should have evidence or metric IDs
  for (const cs of (analyticalState.category_states || [])) {
    for (const pat of (cs.dominant_threat_patterns || [])) {
      if (!pat.supporting_evidence_ids?.length && !pat.supporting_metric_ids?.length) {
        notes.push({ severity: "warning", check: "pattern_missing_basis", detail: `${cs.category}: pattern ${pat.pattern_id} has no supporting IDs` });
      }
    }
    // Trend claims need ≥ 3 buckets
    for (const tr of (cs.trend_signals || [])) {
      if (tr.direction !== "insufficient_data" && tr.non_zero_buckets < 3) {
        notes.push({ severity: "error", check: "trend_insufficient_buckets", detail: `${cs.category}: trend claim with only ${tr.non_zero_buckets} non-zero buckets` });
      }
    }
    // Hypothesis confidence must not exceed ceiling
    for (const h of (cs.candidate_judgments || [])) {
      if (h.confidence_ceiling === "none" && h.recommended_output_type === "insight") {
        notes.push({ severity: "error", check: "hypothesis_exceeds_ceiling", detail: `${h.hypothesis_id}: insight recommended but confidence_ceiling is none` });
      }
    }
  }

  // Cross-category patterns need ≥ 2 categories
  for (const pat of (analyticalState.cross_category_state?.cross_category_patterns || [])) {
    if (pat.categories.length < 2) {
      notes.push({ severity: "error", check: "cross_category_single_category", detail: `${pat.pattern_id}: cross-category claim has only 1 category` });
    }
  }

  return notes;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the analytical state from all prior layer outputs.
 *
 * @param {object[]} dossiers         - Fused dossiers from buildFusedDossiers
 * @param {object}   analyticsResult  - Full analytics branch result
 * @param {object[]} externalEvidence - From Layer 5e
 * @param {object[]} visualEvidence   - From Layer 5e visual
 * @returns {object}
 */
export function buildAnalyticalState(dossiers, analyticsResult, externalEvidence = [], visualEvidence = []) {
  const aggregates     = analyticsResult?.aggregates     || {};
  const derivedMetrics = analyticsResult?.derived_metrics || {};

  const category_states = [];
  const all_hypothesis_candidates = [];

  for (const dossier of dossiers) {
    const category = dossier.category;

    // Build each component of the category state
    const dominant_threat_patterns     = buildDominantPatterns(category, dossier, aggregates);
    const operationalisation_signals   = buildOperationalisationSignals(category, dossier, aggregates);
    const adversary_adoption_signals   = buildAdversaryAdoptionSignals(category, aggregates);
    const capability_progression_signals = buildCapabilityProgressionSignals(category, aggregates);
    const trend_signals                = buildTrendSignals(category, aggregates);
    const evidence_strength            = buildEvidenceStrength(dossier, externalEvidence, visualEvidence);

    // Coverage gaps from dossier fusion summary + analytics
    const coverage_gaps = [
      ...(dossier.fusion_summary?.evidence_gaps || []),
      ...(aggregates.source_type_coverage_matrix?.thin_coverage_flags || [])
        .filter((f) => f.domain === category)
        .map((f) => f.reason),
    ].slice(0, 5);

    const categoryState = {
      category,
      dominant_threat_patterns,
      operationalisation_signals,
      adversary_adoption_signals,
      capability_progression_signals,
      trend_signals,
      evidence_strength,
      coverage_gaps,
      candidate_judgments: [], // filled below
    };

    // Build hypothesis candidates now that state is assembled
    const candidates = buildCategoryHypothesisCandidates(category, categoryState, dossier);
    categoryState.candidate_judgments = candidates;
    all_hypothesis_candidates.push(...candidates);

    category_states.push(categoryState);
  }

  // Cross-category state
  const cross_category_state = buildCrossAnalyticalState(category_states, aggregates);
  const cross_hypothesis = buildCrossHypothesisCandidates(cross_category_state, category_states);
  all_hypothesis_candidates.push(...cross_hypothesis);

  // Evidence gaps
  const evidence_gaps = [
    ...category_states.flatMap((cs) => cs.coverage_gaps.map((g) => ({ category: cs.category, gap: g }))),
    ...cross_category_state.global_evidence_gaps.map((g) => ({ category: "cross_category", gap: g })),
  ];

  const analyticalState = {
    analytical_state_version: "v1",
    category_states,
    cross_category_state,
    hypothesis_candidates: all_hypothesis_candidates,
    evidence_gaps,
    contradictions: cross_category_state.contradictions,
    qa_notes: [],
  };

  // Run QA
  analyticalState.qa_notes = qaAnalyticalState(analyticalState);

  const warningCount = analyticalState.qa_notes.filter((n) => n.severity === "warning").length;
  const errorCount   = analyticalState.qa_notes.filter((n) => n.severity === "error").length;

  process.stdout.write(
    `  [L6A-analytical-state] Built: ` +
    `${category_states.length} category states | ` +
    `${all_hypothesis_candidates.length} hypothesis candidates | ` +
    `${cross_category_state.convergence_clusters.length} convergence clusters | ` +
    `${evidence_gaps.length} evidence gaps | ` +
    (errorCount   > 0 ? `${errorCount} errors ` : "") +
    (warningCount > 0 ? `${warningCount} warnings` : "") +
    "\n"
  );

  return analyticalState;
}

/**
 * Get the category state for a specific category.
 *
 * @param {object}   analyticalState
 * @param {string}   category
 * @returns {object|null}
 */
export function getCategoryState(analyticalState, category) {
  return (analyticalState?.category_states || []).find((cs) => cs.category === category) || null;
}
