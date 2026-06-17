/**
 * Evidence Signal Map — deterministic summary of what the evidence supports
 * before any synthesis LLM call.
 *
 * Replaces the former "Analytical State Construction" framing. This module maps
 * the fused L5A/L5B/L5C evidence for each category into a structured set of
 * signals, candidates, and explicit BLOCKED opportunities — so the LLM
 * evaluates pre-structured candidates instead of discovering patterns from
 * loose evidence bags, and the post-synthesis validators know exactly which
 * claim types the evidence cannot support.
 *
 * ── ROLE ──────────────────────────────────────────────────────────────────────
 * Code constructs analytical relationships and determines what is/is not
 * supportable from the evidence.
 * LLM explains, prioritises, and writes evidence-backed judgments within the
 * ceilings set here.
 *
 * ── OUTPUTS ───────────────────────────────────────────────────────────────────
 * {
 *   analytical_state_version: "v2",
 *
 *   // evidence_signal_map shape (per category_state):
 *   category_states: [{
 *     category: string,
 *     dominant_threat_patterns: [],      — attack vectors with source counts
 *     operationalisation_signals: [],    — status + evidence IDs
 *     adversary_adoption_signals: [],    — operational-source-only
 *     capability_progression_signals: [], — r2p / p2o / watchlist
 *     trend_signals: [],                 — needs ≥3 non-zero months
 *     evidence_strength: {
 *       confidence_ceiling: "high"|"medium"|"low"|"none",
 *       // ...other strength fields
 *     },
 *     coverage_gaps: [],
 *
 *     // Each judgment now carries claim-level gates:
 *     candidate_judgments: [{
 *       hypothesis_id, candidate_claim, judgment_type,
 *       confidence_ceiling: "high"|"medium"|"low"|"none",
 *       ceiling_reason: string,           — why this ceiling was assigned
 *       allowed_claim_strength: "strong_statement"|"cautious_statement"|"mention_only"|"blocked",
 *       required_caveats: string[],       — caveats that MUST appear in any claim text
 *       supporting_evidence_ids: [],
 *       counter_evidence_ids: [],
 *       recommended_output_type: string,
 *       caveat_if_any: string|null,
 *     }],
 *
 *     // NEW: explicit list of claim types the evidence CANNOT support
 *     blocked_claim_opportunities: [{
 *       claim_type: string,   — e.g. "adoption", "trend_over_time", "market_wide"
 *       blocking_reason: string,
 *     }],
 *   }],
 *
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
 *
 * ── ALLOWED CLAIM STRENGTH (derived from ceiling) ─────────────────────────────
 * strong_statement  — ceiling=high; unqualified positive assertion allowed
 * cautious_statement — ceiling=medium; hedged assertion with caveat required
 * mention_only      — ceiling=low; acknowledge only, do not assert
 * blocked           — ceiling=none; no positive claim; use evidence_gap instead
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

// ── Pattern-level confidence from source frequency ────────────────────────────
//
// This function produces confidence for INDIVIDUAL PATTERNS based on how many
// sources discuss that pattern. It is a frequency measurement (mechanical), not
// a quality assessment. Evidence quality is assessed separately in
// buildEvidenceStrength() using reviewed triage results (strong/usable labels).
//
// Thresholds (documented here so they can be argued, not hidden weights):
//   ≥5 sources + ≥2 source types → "high" frequency signal
//   ≥2 sources                   → "medium" frequency signal
//   ≥1 source                    → "low" frequency signal
//   0 sources                    → "none"
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

  // ── Confidence ceiling — quality-gated, not just count-gated ─────────────
  //
  // Design principle: the ceiling reflects EVIDENCE QUALITY (strength tier from
  // triage review), not raw source counts. A large corpus of weak sources does
  // not earn a "high" ceiling. The criteria are documented here; every branch
  // explains WHY the ceiling is set, not just what number triggered it.
  //
  // "high"   — requires ≥2 STRONG items (triage-reviewed, not just usable) from
  //             ≥2 source types AND at least one operational source type present.
  //             Optionally boosted by external corroboration.
  // "medium" — ≥2 usable/strong items from any source type mix, or ≥1 with
  //             external corroboration (but no operational source for "high").
  // "low"    — ≥1 item reviewed as usable/strong; insufficient for trend/adoption.
  // "none"   — no usable evidence; do not make positive claims.

  const hasMultiTypeStrong = strongCount >= 2 && sourceTypeDiversity >= 2 && hasOperationalType;
  const hasExtensiveWithOperational = strongCount + usableCount >= 3 && sourceTypeDiversity >= 2 && hasOperationalType;

  // Gather the evidence IDs that drove the ceiling decision (traceable, not opaque).
  const strongIds   = allItems.filter((i) => i.evidence_strength === "strong" || i.triage_data?.evidence_strength === "strong").map((i) => i.evidence_id).filter(Boolean).slice(0, 5);
  const usableIds   = allItems.filter((i) => i.evidence_strength === "usable"  || i.triage_data?.evidence_strength === "usable").map((i) => i.evidence_id).filter(Boolean).slice(0, 5);
  const externalIds = catExternal.map((e) => e.evidence_id || e.id).filter(Boolean).slice(0, 3);

  let confidence_ceiling;
  let ceiling_reason;
  let ceiling_evidence_ids; // which items drove this ceiling (for audit traceability)

  if (hasMultiTypeStrong && catExternal.length > 0) {
    confidence_ceiling  = "high";
    ceiling_reason      = `${strongCount} strong items across ${sourceTypeDiversity} source types (including operational) + external corroboration`;
    ceiling_evidence_ids = [...strongIds, ...externalIds];
  } else if (hasMultiTypeStrong) {
    confidence_ceiling  = "high";
    ceiling_reason      = `${strongCount} strong items across ${sourceTypeDiversity} source types including operational source types`;
    ceiling_evidence_ids = strongIds;
  } else if (hasExtensiveWithOperational) {
    confidence_ceiling  = "high";
    ceiling_reason      = `${strongCount + usableCount} usable+ items from ${sourceTypeDiversity} source types including operational — sufficient for high ceiling`;
    ceiling_evidence_ids = [...strongIds, ...usableIds].slice(0, 5);
  } else if (strongCount + usableCount >= 2 || catExternal.length > 0) {
    confidence_ceiling  = "medium";
    ceiling_reason      = catExternal.length > 0 && strongCount + usableCount < 2
      ? "external corroboration present but insufficient rawfact evidence quality for high ceiling"
      : !hasOperationalType
        ? `${strongCount + usableCount} usable item(s) but no operational source type — adoption/factual claims caveated`
        : `${strongCount + usableCount} usable item(s) from ${sourceTypeDiversity} type(s) — below high-ceiling threshold`;
    ceiling_evidence_ids = [...strongIds, ...usableIds, ...externalIds].slice(0, 5);
  } else if (totalRawfact >= 1) {
    confidence_ceiling  = "low";
    ceiling_reason      = `${totalRawfact} evidence item(s), insufficient for trend/adoption claims`;
    ceiling_evidence_ids = [...strongIds, ...usableIds].slice(0, 3);
  } else {
    confidence_ceiling  = "none";
    ceiling_reason      = "no usable evidence — positive claims blocked";
    ceiling_evidence_ids = [];
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
    ceiling_reason,
    ceiling_evidence_ids: [...new Set(ceiling_evidence_ids)], // deduplicated IDs that drove this ceiling
  };
}

// ── Stage 7: Simple cross-category summary (no pre-analysis) ─────────────────
//
// Design principle: code provides evidence signals; the synthesis LLM forms
// analytical conclusions. Removed: CONVERGENCE_SEEDS matching, hypothesis
// candidate generation, cross-category convergence clusters, allowedClaimStrength,
// ceilingReason, deriveRequiredCaveats helpers (~480 lines of deterministic
// pseudo-analysis). These constrained the LLM unnecessarily and produced
// pre-structured "candidates" that the model was expected to validate rather than
// analyze independently.

function buildSimpleCrossState(categoryStates, aggregates) {
  const vecTracked = aggregates?.threat_pattern_analytics?.attack_vector_frequency_tracked || {};
  const topShared = Object.entries(vecTracked)
    .map(([v, d]) => ({ v, count: typeof d === "number" ? d : (d.count || 0) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(({ v, count }) => `${v} (${count} sources)`);

  const thinCategories = categoryStates
    .filter((cs) => cs.evidence_strength?.confidence_ceiling === "none" ||
                    cs.evidence_strength?.confidence_ceiling === "low")
    .map((cs) => ({ category: cs.category, ceiling: cs.evidence_strength.confidence_ceiling }));

  const global_evidence_gaps = thinCategories
    .map(({ category, ceiling }) =>
      `${category}: ${ceiling === "none" ? "no usable evidence" : "low evidence — claims must be caveated"}`
    );

  return {
    shared_attack_surfaces: topShared,
    thin_evidence_categories: thinCategories,
    global_evidence_gaps,
  };
}

// REMOVED: buildCategoryHypothesisCandidates (hypothesis generation from signals)
// REMOVED: CONVERGENCE_SEEDS + buildCrossAnalyticalState (convergence cluster generation)
// REMOVED: buildCrossHypothesisCandidates (cross-category hypothesis packaging)
// REMOVED: allowedClaimStrength, ceilingReason, deriveRequiredCaveats helpers
// These 480 lines of deterministic pre-analysis were replaced by presenting
// evidence signals directly to the synthesis LLM, which forms its own judgments.

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
  }

  return notes;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the evidence signal map (analytical state) from all prior layer outputs.
 *
 * Deterministic. Runs after dossier fusion and BEFORE any LLM synthesis call.
 * Produces per-category candidate_judgments (with confidence_ceiling,
 * ceiling_reason, allowed_claim_strength, required_caveats) and
 * blocked_claim_opportunities (claim types the evidence CANNOT support).
 *
 * @param {object[]} dossiers         - Fused dossiers from buildFusedDossiers
 * @param {object}   analyticsResult  - Full analytics branch result
 * @param {object[]} externalEvidence - From Layer 5C
 * @param {object[]} visualEvidence   - From Layer 5C visual
 * @returns {object}  evidence_signal_map / analyticalState
 */
export function buildAnalyticalState(dossiers, analyticsResult, externalEvidence = [], visualEvidence = []) {
  const aggregates = analyticsResult?.aggregates || {};

  const category_states = [];

  for (const dossier of dossiers) {
    const category = dossier.category;

    const dominant_threat_patterns       = buildDominantPatterns(category, dossier, aggregates);
    const operationalisation_signals     = buildOperationalisationSignals(category, dossier, aggregates);
    const adversary_adoption_signals     = buildAdversaryAdoptionSignals(category, aggregates);
    const capability_progression_signals = buildCapabilityProgressionSignals(category, aggregates);
    const trend_signals                  = buildTrendSignals(category, aggregates);
    const evidence_strength              = buildEvidenceStrength(dossier, externalEvidence, visualEvidence);

    const coverage_gaps = [
      ...(dossier.fusion_summary?.evidence_gaps || []),
      ...(aggregates.source_type_coverage_matrix?.thin_coverage_flags || [])
        .filter((f) => f.domain === category)
        .map((f) => f.reason),
    ].slice(0, 5);

    const blocked_claim_opportunities = buildBlockedClaimOpportunities(
      evidence_strength,
      operationalisation_signals,
      trend_signals
    );

    category_states.push({
      category,
      dominant_threat_patterns,
      operationalisation_signals,
      adversary_adoption_signals,
      capability_progression_signals,
      trend_signals,
      evidence_strength,
      coverage_gaps,
      blocked_claim_opportunities,
    });
  }

  // Simple cross-category summary — just shared attack surfaces and thin categories.
  const cross_category_summary = buildSimpleCrossState(category_states, aggregates);

  const evidence_gaps = [
    ...category_states.flatMap((cs) => cs.coverage_gaps.map((g) => ({ category: cs.category, gap: g }))),
    ...cross_category_summary.global_evidence_gaps.map((g) => ({ category: "cross_category", gap: g })),
  ];

  const analyticalState = {
    analytical_state_version: "v3",
    category_states,
    cross_category_summary,
    evidence_gaps,
    qa_notes: [],
  };

  analyticalState.qa_notes = qaAnalyticalState(analyticalState);

  const warningCount = analyticalState.qa_notes.filter((n) => n.severity === "warning").length;
  const errorCount   = analyticalState.qa_notes.filter((n) => n.severity === "error").length;
  const totalBlocked = category_states.reduce(
    (s, cs) => s + (cs.blocked_claim_opportunities?.length || 0), 0
  );

  process.stdout.write(
    `  [L6A-evidence-signal-map] Built: ` +
    `${category_states.length} category states | ` +
    `${evidence_gaps.length} evidence gaps | ` +
    `${totalBlocked} blocked claim opportunities | ` +
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

/**
 * Compute the blocked_claim_opportunities for a category based on evidence.
 *
 * Blocked entries indicate claim types the evidence CANNOT support — they must
 * never reach slides and will be rejected by the Claim Support Gate.
 *
 * @param {object} evidenceStrength  — from buildEvidenceStrength()
 * @param {object[]} operationalisationSignals
 * @param {object[]} trendSignals
 * @returns {{ claim_type: string, blocking_reason: string }[]}
 */
export function buildBlockedClaimOpportunities(evidenceStrength, operationalisationSignals, trendSignals) {
  const blocked = [];
  const {
    source_type_diversity,
    has_operational_sources,
    validated_evidence_count,
    confidence_ceiling,
  } = evidenceStrength;

  // No positive claim of any kind when ceiling is none
  if (confidence_ceiling === "none") {
    blocked.push({ claim_type: "factual",             blocking_reason: "no_evidence" });
    blocked.push({ claim_type: "adoption",            blocking_reason: "no_evidence" });
    blocked.push({ claim_type: "trend_over_time",     blocking_reason: "no_evidence" });
    blocked.push({ claim_type: "strategic_assessment",blocking_reason: "no_evidence" });
    return blocked;
  }

  // Adoption requires operational sources
  if (!has_operational_sources) {
    blocked.push({ claim_type: "adoption", blocking_reason: "no_operational_sources" });
  }

  // Trend over time requires ≥ 3 non-zero time buckets
  const trendInsufficient = (trendSignals || []).some(
    (t) => t.direction === "insufficient_data" || t.non_zero_buckets < 3
  );
  if (trendInsufficient || (trendSignals || []).length === 0) {
    blocked.push({ claim_type: "trend_over_time", blocking_reason: "insufficient_time_buckets" });
  }

  // Strategic assessment requires ≥ 2 source types AND some operational evidence
  if (source_type_diversity < 2 || !has_operational_sources) {
    if (!has_operational_sources) {
      blocked.push({
        claim_type: "market_wide",
        blocking_reason: "no_operational_sources_for_ecosystem_claim",
      });
      blocked.push({
        claim_type: "ecosystem_wide",
        blocking_reason: "no_operational_sources_for_ecosystem_claim",
      });
    }
  }

  return blocked;
}
