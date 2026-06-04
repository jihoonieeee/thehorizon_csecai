/**
 * Layer 5b.6 — Derived Metrics
 *
 * Deterministic — no LLM calls. Computes 9 composite indexes (0–100) from
 * the structured aggregate groups produced by analyticsAggregation.js.
 *
 * Each metric: { value: 0-100, label: string, inputs: {}, explanation: string }
 *
 * ── METRICS ──────────────────────────────────────────────────────────────────
 *   operationalisation_index       — how much research has crossed into operational threat
 *   adversary_adoption_index       — adversary uptake of AI capabilities
 *   agentic_risk_index             — risk from agentic AI threat category
 *   ai_enabled_threat_index        — AI-enabled attack activity level
 *   governance_pressure_index      — volume and diversity of regulatory/governance signals
 *   defensive_maturity_index       — depth of defensive coverage relative to threat surface
 *   ecosystem_dependency_index     — dependency risk from AI ecosystem expansion
 *   trust_boundary_shift_index     — frequency and severity of trust boundary erosion
 *   research_to_threat_pipeline_index — speed at which research converts to operational threat
 */

// ── Helpers ────────────────────────────────────────────────────────────────────

function clamp(v) {
  return Math.min(100, Math.max(0, Math.round(v)));
}

function toLabel(value) {
  if (value >= 75) return "very_high";
  if (value >= 50) return "high";
  if (value >= 25) return "moderate";
  return "low";
}

function sumObj(obj) {
  return Object.values(obj || {}).reduce((a, b) => a + b, 0);
}

function metric(indexId, value, inputs, formula, sourceCount) {
  const v = clamp(value);
  const confidence = sourceCount >= 20 ? "high" : sourceCount >= 5 ? "medium" : "low";
  const caveat = sourceCount < 5
    ? `Low confidence: only ${sourceCount} source(s) — score may not be representative`
    : sourceCount < 20
    ? `Medium confidence: ${sourceCount} source(s) — treat as directional, not definitive`
    : null;
  return {
    index_id:    indexId,
    score:       v,
    value:       v,   // backward compat alias
    label:       toLabel(v),
    inputs,
    formula,
    source_count: sourceCount,
    confidence,
    caveat_if_any: caveat,
    // backward compat
    explanation: formula,
  };
}

// ── Individual metric formulas ─────────────────────────────────────────────────

/**
 * operationalisation_index: proportion of corpus with operational status.
 * Weights confirmed_incident highest, poc_available lower, theorized = 0.
 */
function computeOperationalisationIndex(aggregates) {
  const dist  = aggregates.maturity_analytics?.operational_status_distribution || {};
  const total = sumObj(dist);
  if (total === 0) return metric("operationalisation_index", 0, { total: 0 },
    "score = (active*1.0 + limited*0.9 + poc*0.5 + research*0.15) / total × 100", 0);

  // Map new vocabulary → weights
  const active   = (dist.active_operational_use || 0) + (dist.mainstream_operational_use || 0);
  const limited  = dist.limited_operational_use || 0;
  const poc      = dist.proof_of_concept        || 0;
  const research = (dist.research_only || 0) + (dist.theoretical || 0);

  const operationalScore = active * 1.0 + limited * 0.9 + poc * 0.5 + research * 0.15;
  const value = (operationalScore / total) * 100;

  return metric("operationalisation_index", value,
    { total, active_operational: active, limited_operational: limited, poc, research_or_theoretical: research },
    "score = (active*1.0 + limited*0.9 + poc*0.5 + research*0.15) / total × 100",
    total);
}

/**
 * adversary_adoption_index: weighted average of adversary adoption stages.
 * Weighted more heavily when there are many adversary/threat-intel sources.
 */
function computeAdversaryAdoptionIndex(aggregates) {
  const adv     = aggregates.adversary_adoption_analytics || {};
  const stages  = adv.adoption_stage_distribution || {};
  const total   = sumObj(stages);

  // Updated for new VALID_ADVERSARY_ADOPTION_STAGES vocabulary
  const STAGE_WEIGHTS = {
    none_observed:           0,
    speculative:             5,
    research_claimed:       15,
    early_experimentation:  30,
    limited_operational_use:60,
    active_operational_use: 85,
    widespread_use:        100,
    unknown:                 5,
  };

  if (total === 0) return metric("adversary_adoption_index", 0, { total: 0 },
    "score = (Σ stage_weight × count) / total × 0.7 + (adversary_sources / corpus_total × 60 capped at 30) × 0.3", 0);

  let weightedSum = 0;
  for (const [stage, count] of Object.entries(stages)) {
    weightedSum += (STAGE_WEIGHTS[stage] ?? 10) * count;
  }
  const stageScore = weightedSum / total;

  const corpusTotal  = aggregates.corpus_overview?.total_analytics_eligible || 1;
  const volumeFactor = Math.min(30, (adv.total_adversary_sources || 0) / corpusTotal * 60);
  const value = stageScore * 0.7 + volumeFactor;

  return metric("adversary_adoption_index", value,
    { total, stage_counts: stages, corpus_volume_pct: Math.round(volumeFactor * 100 / 30) },
    "score = (Σ stage_weight × count) / total × 0.7 + volume_factor (capped 30)",
    adv.total_adversary_sources || 0);
}

/**
 * agentic_risk_index: proportion of offensive corpus from agentic threats,
 * amplified by how operationalised those sources are.
 */
function computeAgenticRiskIndex(aggregates) {
  const catCounts   = aggregates.corpus_overview?.category_counts || {};
  const agenticCount = catCounts.agentic_ai_threats || 0;
  const offensiveTotal = (catCounts.traditional_ai_threats || 0)
    + (catCounts.llm_threats || 0)
    + (catCounts.agentic_ai_threats || 0)
    + (catCounts.ai_enabled_threats || 0);

  if (offensiveTotal === 0) return metric("agentic_runtime_risk_index", 0, { agentic_count: 0 },
    "score = (agentic_count / offensive_total) × 60 + operational_boost (max 40)", 0);

  const base = (agenticCount / offensiveTotal) * 60;

  const agenticCat  = aggregates.category_analytics?.per_category?.agentic_ai_threats || {};
  const opDist = agenticCat.operational_status_distribution || {};
  const opTotal = sumObj(opDist);
  const opScore = opTotal > 0
    ? ((opDist.active_operational_use || 0) + (opDist.limited_operational_use || 0) + (opDist.proof_of_concept || 0) * 0.5) / opTotal * 40
    : 0;

  return metric("agentic_runtime_risk_index", base + opScore,
    { agentic_count: agenticCount, offensive_total: offensiveTotal, operational_boost: Math.round(opScore) },
    "score = (agentic_count / offensive_total) × 60 + operational_boost (max 40)",
    agenticCount);
}

/**
 * ai_enabled_threat_index: AI-as-a-weapon activity — deepfakes, AI phishing, etc.
 * Combines volume share with operational status weight.
 */
function computeAiEnabledThreatIndex(aggregates) {
  const catCounts    = aggregates.corpus_overview?.category_counts || {};
  const aiEnabled    = catCounts.ai_enabled_threats || 0;
  const totalSources = aggregates.corpus_overview?.total_analytics_eligible || 1;

  // Base: share of total corpus
  const base = (aiEnabled / totalSources) * 70;

  // Impact boost: impact_scope_distribution for ai_enabled category
  const aiCat  = aggregates.category_analytics?.per_category?.ai_enabled_threats || {};
  const impactDist = aiCat.operational_status_distribution || {};
  const impTotal   = sumObj(impactDist);
  const impBoost = impTotal > 0
    ? ((impactDist.confirmed_incident || 0) + (impactDist.observed_in_wild || 0)) / impTotal * 30
    : 0;

  return metric("ai_enabled_offensive_use_index", base + impBoost,
    { ai_enabled_count: aiEnabled, total: totalSources, operational_boost: Math.round(impBoost) },
    "score = (ai_enabled_count / total_eligible) × 70 + operational_boost (max 30)",
    aiEnabled);
}

/**
 * governance_pressure_index: how much governance/regulatory activity is present.
 * Combines volume of governance sources with diversity of governance functions.
 */
function computeGovernancePressureIndex(aggregates) {
  const gov       = aggregates.governance_analytics || {};
  const govCount  = gov.total_governance_sources || 0;
  const totalSrc  = aggregates.corpus_overview?.total_analytics_eligible || 1;
  const fnFreq    = gov.governance_function_frequency || {};
  const uniqueFns = Object.keys(fnFreq).length;

  // Volume factor: governance sources / total * 60
  const volumeScore = Math.min(60, (govCount / totalSrc) * 120);

  // Diversity factor: unique governance functions (max ~10 expected)
  const diversityScore = Math.min(40, (uniqueFns / 8) * 40);

  return metric("governance_pressure_index", volumeScore + diversityScore,
    { governance_sources: govCount, total_sources: totalSrc, unique_functions: uniqueFns },
    "score = min(60, governance/total × 120) + min(40, unique_functions/8 × 40)",
    govCount);
}

/**
 * defensive_maturity_index: how much defensive coverage exists relative to the threat surface.
 * Penalises for mitigation gaps.
 */
function computeDefensiveMaturityIndex(aggregates) {
  const def      = aggregates.defensive_analytics || {};
  const defCount = def.total_defensive_sources || 0;
  const ctrlFreq = def.defensive_control_frequency || {};
  const uniqueControls = Object.keys(ctrlFreq).length;
  const gapCount = (def.mitigation_gap_signals || []).length;

  const totalSrc = aggregates.corpus_overview?.total_analytics_eligible || 1;

  // Coverage score: defensive / total, capped. A 15% share = decent coverage.
  const coverageScore = Math.min(50, (defCount / totalSrc) * 200);

  // Control diversity: how many distinct controls (max ~10)
  const diversityScore = Math.min(30, (uniqueControls / 8) * 30);

  // Gap penalty: each unmitigated attack vector vector = -5 (max -20)
  const gapPenalty = Math.min(20, gapCount * 5);

  // Floor at 20 so even minimal defensive activity registers
  const raw = Math.max(20, coverageScore + diversityScore - gapPenalty);

  return metric("defensive_coverage_index", raw,
    { defensive_sources: defCount, unique_controls: uniqueControls, mitigation_gaps: gapCount },
    "score = min(50, def/total × 200) + min(30, controls/8 × 30) - min(20, gaps × 5); floor at 20",
    defCount);
}

/**
 * ecosystem_dependency_index: risk from growing AI ecosystem dependencies.
 * Combines volume and diversity of dependency signals.
 */
function computeEcosystemDependencyIndex(aggregates) {
  const eco     = aggregates.ecosystem_analytics || {};
  const ecoCount = eco.total_ecosystem_sources || 0;
  const depFreq  = eco.dependency_type_frequency || {};
  const uniqueDeps = Object.keys(depFreq).length;
  const attackSurfaceGrowth = sumObj(eco.attack_surface_growth_signals || {});

  const totalSrc = aggregates.corpus_overview?.total_analytics_eligible || 1;

  // Volume factor
  const volumeScore = Math.min(50, (ecoCount / totalSrc) * 200);

  // Dependency diversity
  const diversityScore = Math.min(30, (uniqueDeps / 6) * 30);

  // Attack surface growth signal
  const growthScore = Math.min(20, (attackSurfaceGrowth / Math.max(ecoCount, 1)) * 20);

  return metric("infrastructure_dependency_index", volumeScore + diversityScore + growthScore,
    { ecosystem_sources: ecoCount, unique_dependency_types: uniqueDeps, attack_surface_growth_signals: attackSurfaceGrowth },
    "score = min(50, eco/total × 200) + min(30, dep_types/6 × 30) + min(20, growth_signals/eco × 20)",
    ecoCount);
}

/**
 * trust_boundary_shift_index: severity of trust assumption erosion signals.
 * Authority delegation and human oversight reduction are high-severity signals.
 */
function computeTrustBoundaryShiftIndex(aggregates) {
  const tb      = aggregates.trust_boundary_analytics || {};
  const tbCount = tb.total_trust_boundary_sources || 0;
  const shiftFreq = tb.trust_boundary_shift_frequency || {};
  const authDelegation = tb.authority_delegation_signals || 0;
  const oversightReduction = tb.human_oversight_reduction_signals || 0;

  const totalSrc = aggregates.corpus_overview?.total_analytics_eligible || 1;

  // Volume factor
  const volumeScore = Math.min(40, (tbCount / totalSrc) * 200);

  // High-severity signal boost
  const highSeverityScore = Math.min(40, (authDelegation + oversightReduction) * 8);

  // Shift diversity
  const diversityScore = Math.min(20, (Object.keys(shiftFreq).length / 5) * 20);

  return metric("trust_boundary_shift_index", volumeScore + highSeverityScore + diversityScore,
    { trust_boundary_sources: tbCount, authority_delegation: authDelegation, human_oversight_reduction: oversightReduction },
    "score = min(40, tb/total × 200) + min(40, (auth_del+oversight_red) × 8) + min(20, shift_types/5 × 20)",
    tbCount);
}

/**
 * research_to_threat_pipeline_index: how quickly is research converting to operational threat.
 * High when many lab-demonstrated or PoC capabilities exist alongside high threat maturity.
 */
function computeResearchToThreatPipelineIndex(aggregates) {
  const cap     = aggregates.capability_analytics || {};
  // capability_stage_distribution is now { stage: { count, source_ids } }; extract counts
  const rawDist = cap.capability_stage_distribution || {};
  const capDist = {};
  for (const [k, v] of Object.entries(rawDist)) {
    capDist[k] = typeof v === "number" ? v : (v.count || 0);
  }
  const capTotal = sumObj(capDist);

  const matDist  = aggregates.maturity_analytics?.threat_maturity_distribution || {};
  const matTotal = sumObj(matDist);

  // Updated for new VALID_CAPABILITY_STAGES vocabulary
  const labValidated        = capDist.lab_validated         || 0;
  const benchmarkDemonstrated = capDist.benchmark_demonstrated || 0;
  const poc                 = capDist.proof_of_concept      || 0;
  const toolAvailable       = capDist.tool_available        || 0;
  const opReported          = capDist.operationally_reported|| 0;

  const capScore = capTotal > 0
    ? (labValidated * 0.3 + benchmarkDemonstrated * 0.4 + poc * 0.6 + toolAvailable * 0.8 + opReported * 1.0) / capTotal * 60
    : 0;

  const operational = (matDist.operational || 0) + (matDist.mainstream || 0);
  const matScore = matTotal > 0 ? (operational / matTotal) * 40 : 0;

  return metric("research_to_threat_pipeline_index", capScore + matScore,
    {
      capability_total: capTotal,
      lab_validated: labValidated, benchmark_demonstrated: benchmarkDemonstrated,
      poc, tool_available: toolAvailable, operationally_reported: opReported,
      maturity_total: matTotal, operational_or_mainstream: operational,
    },
    "score = (lab×0.3 + bench×0.4 + poc×0.6 + tool×0.8 + op×1.0) / capTotal × 60 + operational/total × 40",
    capTotal);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Compute all 9 derived metrics from aggregates (Layer 5b.6).
 * Deterministic — no LLM calls.
 *
 * @param {object} aggregates - Output of aggregateAnalytics()
 * @returns {object} derived_metrics with 9 named indexes
 */
export function computeDerivedMetrics(aggregates) {
  const opIdx        = computeOperationalisationIndex(aggregates);
  const adoptionIdx  = computeAdversaryAdoptionIndex(aggregates);
  const agenticIdx   = computeAgenticRiskIndex(aggregates);
  const aiEnabledIdx = computeAiEnabledThreatIndex(aggregates);
  const govIdx       = computeGovernancePressureIndex(aggregates);
  const defIdx       = computeDefensiveMaturityIndex(aggregates);
  const ecoIdx       = computeEcosystemDependencyIndex(aggregates);
  const tbIdx        = computeTrustBoundaryShiftIndex(aggregates);
  const r2tIdx       = computeResearchToThreatPipelineIndex(aggregates);

  return {
    // Canonical names (spec-aligned)
    operationalisation_index:          opIdx,
    adversary_adoption_index:          adoptionIdx,
    agentic_runtime_risk_index:        agenticIdx,
    ai_enabled_offensive_use_index:    aiEnabledIdx,
    governance_pressure_index:         govIdx,
    defensive_coverage_index:          defIdx,
    infrastructure_dependency_index:   ecoIdx,
    trust_boundary_shift_index:        tbIdx,
    research_to_threat_pipeline_index: r2tIdx,

    // Backward-compat aliases (old names used by slide/analysis layers)
    agentic_risk_index:                agenticIdx,
    ai_enabled_threat_index:           aiEnabledIdx,
    defensive_maturity_index:          defIdx,
    ecosystem_dependency_index:        ecoIdx,
  };
}
