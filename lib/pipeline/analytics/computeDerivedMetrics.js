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

function metric(value, inputs, explanation) {
  const v = clamp(value);
  return { value: v, label: toLabel(v), inputs, explanation };
}

// ── Individual metric formulas ─────────────────────────────────────────────────

/**
 * operationalisation_index: proportion of corpus with operational status.
 * Weights confirmed_incident highest, poc_available lower, theorized = 0.
 */
function computeOperationalisationIndex(aggregates) {
  const dist = aggregates.maturity_analytics?.operational_status_distribution || {};
  const total = sumObj(dist);
  if (total === 0) return metric(0, { total: 0 }, "No sources with operational status data");

  const confirmed    = dist.confirmed_incident  || 0;
  const inWild       = dist.observed_in_wild    || 0;
  const poc          = dist.poc_available       || 0;
  const inDev        = dist.in_development      || 0;
  const theorized    = dist.theorized           || 0;

  // Weighted score: full credit for confirmed/observed, partial for PoC
  const operationalScore = confirmed * 1.0 + inWild * 0.9 + poc * 0.5 + inDev * 0.15;
  const value = (operationalScore / total) * 100;

  return metric(value, { total, confirmed, in_wild: inWild, poc, in_development: inDev, theorized },
    `${confirmed + inWild} operational sources (confirmed incident / observed in wild) out of ${total}`);
}

/**
 * adversary_adoption_index: weighted average of adversary adoption stages.
 * Weighted more heavily when there are many adversary/threat-intel sources.
 */
function computeAdversaryAdoptionIndex(aggregates) {
  const adv     = aggregates.adversary_adoption_analytics || {};
  const stages  = adv.adoption_stage_distribution || {};
  const total   = sumObj(stages);

  const STAGE_WEIGHTS = { none: 0, experimenting: 25, operationalizing: 75, widespread: 100 };

  if (total === 0) return metric(0, { total: 0 }, "No adversary adoption stage data");

  let weightedSum = 0;
  for (const [stage, count] of Object.entries(stages)) {
    weightedSum += (STAGE_WEIGHTS[stage] ?? 10) * count;
  }
  const stageScore = weightedSum / total;

  // Volume factor: more adversary-adoption sources relative to total corpus = higher pressure
  const corpusTotal  = aggregates.corpus_overview?.total_analytics_eligible || 1;
  const volumeFactor = Math.min(30, (adv.total_adversary_sources || 0) / corpusTotal * 60);

  // Blend: 70% stage quality + 30% volume
  const value = stageScore * 0.7 + volumeFactor;

  return metric(value,
    { total, stage_counts: stages, corpus_volume_pct: Math.round(volumeFactor * 100 / 30) },
    `Adversary adoption stage score: ${Math.round(stageScore)}/100, volume factor: ${Math.round(volumeFactor)}`);
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

  if (offensiveTotal === 0) return metric(0, { agentic_count: 0 }, "No offensive sources");

  // Base: proportion of offensive corpus
  const base = (agenticCount / offensiveTotal) * 60;

  // Operational boost: agentic operational status from category_analytics
  const agenticCat  = aggregates.category_analytics?.per_category?.agentic_ai_threats || {};
  const opDist = agenticCat.operational_status_distribution || {};
  const opTotal = sumObj(opDist);
  const opScore = opTotal > 0
    ? ((opDist.confirmed_incident || 0) + (opDist.observed_in_wild || 0) + (opDist.poc_available || 0) * 0.5) / opTotal * 40
    : 0;

  return metric(base + opScore,
    { agentic_count: agenticCount, offensive_total: offensiveTotal, operational_boost: Math.round(opScore) },
    `Agentic sources are ${Math.round(agenticCount / offensiveTotal * 100)}% of offensive corpus; operational boost ${Math.round(opScore)}/40`);
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

  return metric(base + impBoost,
    { ai_enabled_count: aiEnabled, total: totalSources, operational_boost: Math.round(impBoost) },
    `AI-enabled threat sources: ${aiEnabled}/${totalSources}; operational boost: ${Math.round(impBoost)}/30`);
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

  return metric(volumeScore + diversityScore,
    { governance_sources: govCount, total_sources: totalSrc, unique_functions: uniqueFns },
    `${govCount} governance sources (${Math.round(govCount / totalSrc * 100)}% of corpus), ${uniqueFns} unique governance functions`);
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

  return metric(raw,
    { defensive_sources: defCount, unique_controls: uniqueControls, mitigation_gaps: gapCount },
    `${defCount} defensive sources, ${uniqueControls} controls, ${gapCount} unmitigated attack vectors`);
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

  return metric(volumeScore + diversityScore + growthScore,
    { ecosystem_sources: ecoCount, unique_dependency_types: uniqueDeps, attack_surface_growth_signals: attackSurfaceGrowth },
    `${ecoCount} ecosystem/dependency sources, ${uniqueDeps} dependency types, ${attackSurfaceGrowth} attack surface growth signals`);
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

  return metric(volumeScore + highSeverityScore + diversityScore,
    { trust_boundary_sources: tbCount, authority_delegation: authDelegation, human_oversight_reduction: oversightReduction },
    `${tbCount} trust boundary shift sources; ${authDelegation} authority delegation + ${oversightReduction} oversight reduction signals`);
}

/**
 * research_to_threat_pipeline_index: how quickly is research converting to operational threat.
 * High when many lab-demonstrated or PoC capabilities exist alongside high threat maturity.
 */
function computeResearchToThreatPipelineIndex(aggregates) {
  const cap    = aggregates.capability_analytics || {};
  const capDist = cap.capability_stage_distribution || {};
  const capTotal = sumObj(capDist);

  const matDist = aggregates.maturity_analytics?.threat_maturity_distribution || {};
  const matTotal = sumObj(matDist);

  // Capability pipeline pressure: lab_demonstrated + poc_available driving toward real threat
  const labDemo  = capDist.lab_demonstrated || 0;
  const pocAvail = capDist.poc_available    || 0;
  const inWild   = capDist.in_wild          || 0;
  const capScore = capTotal > 0
    ? (labDemo * 0.4 + pocAvail * 0.7 + inWild * 1.0) / capTotal * 60
    : 0;

  // Threat maturity pressure: established + mature threats
  const established = matDist.established || 0;
  const mature      = matDist.mature      || 0;
  const matScore = matTotal > 0
    ? (established + mature) / matTotal * 40
    : 0;

  return metric(capScore + matScore,
    {
      capability_total: capTotal,
      lab_demonstrated: labDemo, poc_available: pocAvail, in_wild: inWild,
      maturity_total: matTotal, established, mature,
    },
    `Capability pipeline: ${labDemo} lab + ${pocAvail} PoC + ${inWild} in-wild; maturity pressure: ${established + mature}/${matTotal} established/mature`);
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
  return {
    operationalisation_index:          computeOperationalisationIndex(aggregates),
    adversary_adoption_index:           computeAdversaryAdoptionIndex(aggregates),
    agentic_risk_index:                 computeAgenticRiskIndex(aggregates),
    ai_enabled_threat_index:            computeAiEnabledThreatIndex(aggregates),
    governance_pressure_index:          computeGovernancePressureIndex(aggregates),
    defensive_maturity_index:           computeDefensiveMaturityIndex(aggregates),
    ecosystem_dependency_index:         computeEcosystemDependencyIndex(aggregates),
    trust_boundary_shift_index:         computeTrustBoundaryShiftIndex(aggregates),
    research_to_threat_pipeline_index:  computeResearchToThreatPipelineIndex(aggregates),
  };
}
