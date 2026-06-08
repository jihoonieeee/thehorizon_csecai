/**
 * Layer 5b.2 — Source-Type Analytics Profiles
 *
 * Deterministic config only. Each source type defines:
 *   enabled_dimensions    — which analytics dimensions to extract
 *   required_fields       — must be present in output
 *   optional_fields       — extract if source supports it
 *   aggregation_weight    — relative weight in corpus-wide aggregations (1.0 = default)
 *   default_analytics_use — the typical eligibility level for this type
 *   useful_chart_types    — which chart types this source type contributes data for
 *
 * Called by extractAnalyticsFeatures to constrain LLM output and guide extraction.
 */

export const ANALYTICS_PROFILES = {

  vulnerability: {
    description: "CVE disclosures, advisories, patches for AI/ML systems",
    enabled_dimensions: [
      "attack_vector","attack_surface","ai_layer","operational_status","threat_maturity",
      "impact_scope","impact_type","sector","technology","signal_cluster","recurring_theme",
    ],
    required_fields:    ["attack_surfaces","ai_layers","operational_status","threat_maturity","impact_types"],
    optional_fields:    ["attack_vectors","sectors","geography","signal_clusters"],
    aggregation_weight: 1.3,
    default_analytics_use: "full_analytics",
    useful_chart_types: [
      "attack_surface_distribution","operational_status_distribution",
      "threat_maturity_distribution","ai_layer_distribution","impact_type_frequency",
    ],
    extraction_hints: "Focus on exploitability, affected ecosystem, blast radius, patch status, exploitation status.",
  },

  exploit_disclosure: {
    description: "Working exploits, PoC code, jailbreak demonstrations",
    enabled_dimensions: [
      "attack_vector","attack_surface","ai_layer","operational_status","threat_maturity",
      "impact_scope","impact_type","signal_cluster","recurring_theme","technology",
      "adversary_adoption_stage","capability_stage",
    ],
    required_fields:    ["attack_vectors","operational_status","threat_maturity"],
    optional_fields:    ["attack_surfaces","ai_layers","impact_types","signal_clusters","capability_stage"],
    aggregation_weight: 1.4,
    default_analytics_use: "full_analytics",
    useful_chart_types: [
      "attack_vector_frequency","operational_status_distribution",
      "threat_maturity_distribution","capability_stage_distribution",
    ],
    extraction_hints: "Focus on exploit chain, reproducibility, access required, public tooling, operational realism.",
  },

  incident: {
    description: "Confirmed real-world breaches, AI-enabled attack campaigns",
    enabled_dimensions: [
      "attack_vector","attack_surface","ai_layer","operational_status","threat_maturity",
      "impact_scope","impact_type","sector","geography","signal_cluster","recurring_theme",
    ],
    required_fields:    ["attack_vectors","impact_types","impact_scope","operational_status"],
    optional_fields:    ["sectors","geography","ai_layers","signal_clusters","attack_surfaces"],
    aggregation_weight: 1.5,
    default_analytics_use: "full_analytics",
    useful_chart_types: [
      "attack_vector_frequency","impact_type_frequency","impact_scope_distribution",
      "monthly_category_timeline","sector_distribution",
    ],
    extraction_hints: "Focus on confirmed impact, victim/sector, scale, attacker method, repeatability.",
  },

  threat_intelligence: {
    description: "Threat actor profiles, TTPs, IOCs, campaign attribution",
    enabled_dimensions: [
      "attack_vector","attack_surface","ai_layer","operational_status","threat_maturity",
      "impact_scope","impact_type","sector","geography","signal_cluster","recurring_theme",
      "adversary_adoption_stage",
    ],
    required_fields:    ["attack_vectors","operational_status","adversary_adoption_stage"],
    optional_fields:    ["sectors","geography","ai_layers","signal_clusters","impact_types"],
    aggregation_weight: 1.3,
    default_analytics_use: "full_analytics",
    useful_chart_types: [
      "attack_vector_frequency","adversary_adoption_stage_distribution",
      "threat_maturity_distribution","signal_cluster_heatmap",
    ],
    extraction_hints: "Focus on observed TTPs, actor/campaign details, sectors, operational confidence.",
  },

  research_finding: {
    description: "Novel security research — academic papers, arXiv preprints, blogs",
    enabled_dimensions: [
      "attack_vector","attack_surface","ai_layer","operational_status","threat_maturity",
      "impact_scope","impact_type","technology","signal_cluster","recurring_theme","capability_stage",
    ],
    required_fields:    ["ai_layers","capability_stage","threat_maturity"],
    optional_fields:    ["attack_vectors","attack_surfaces","technologies","signal_clusters"],
    aggregation_weight: 1.0,
    default_analytics_use: "full_analytics",
    useful_chart_types: [
      "capability_stage_distribution","threat_maturity_distribution",
      "ai_layer_distribution","research_to_threat_pipeline",
    ],
    extraction_hints: "Focus on attack vector, AI layer, capability stage, operational status, threat maturity, tested systems.",
  },

  defensive_capability: {
    description: "Detection methods, mitigations, hardening guides, security controls",
    enabled_dimensions: [
      "ai_layer","technology","signal_cluster","recurring_theme",
      "defensive_control","sector","impact_type",
    ],
    required_fields:    ["defensive_controls","ai_layers"],
    optional_fields:    ["technologies","sectors","signal_clusters","impact_types"],
    aggregation_weight: 0.8,
    default_analytics_use: "limited_analytics",
    useful_chart_types: [
      "defensive_control_frequency","ai_layer_distribution","defensive_control_by_attack_vector",
    ],
    extraction_hints: "Focus on defensive gap addressed, capability proposed, deployment readiness, effectiveness signal.",
  },

  governance_signal: {
    description: "Government advisories, regulatory requirements, AI governance frameworks",
    enabled_dimensions: [
      "sector","geography","signal_cluster","recurring_theme",
      "governance_function","ai_layer","impact_scope","impact_type",
    ],
    required_fields:    ["governance_functions","sectors"],
    optional_fields:    ["geography","signal_clusters","ai_layers","recurring_themes"],
    aggregation_weight: 0.7,
    default_analytics_use: "limited_analytics",
    useful_chart_types: [
      "governance_function_frequency","governance_by_sector","governance_by_geography",
    ],
    extraction_hints: "Focus on issuing authority, governance issue, affected sectors, compliance implications.",
  },

  attack_surface_signal: {
    description: "AI attack-surface expansion / dependency / trust-boundary shifts — new tooling, MCP servers, AI APIs, agent autonomy, concentration & strategic risk",
    enabled_dimensions: [
      "ai_layer","technology","sector","signal_cluster","recurring_theme",
      "dependency_type","trust_boundary_shift_type","attack_surface","impact_scope","impact_type",
    ],
    required_fields:    ["ai_layers"],
    optional_fields:    ["technologies","sectors","dependency_types","trust_boundary_shift_types","attack_surfaces","signal_clusters","recurring_themes","impact_types"],
    aggregation_weight: 0.8,
    default_analytics_use: "limited_analytics",
    useful_chart_types: [
      "dependency_type_frequency","ecosystem_dependency_distribution","trust_boundary_shift_frequency","ai_layer_distribution",
    ],
    extraction_hints: "Focus on what part of the AI attack surface expands or shifts (new tooling/platform, dependency/concentration risk, autonomy/trust boundary), the security exposure created, and affected ecosystem/stakeholders. Do not use to claim adversary adoption or attacker activity.",
  },

  societal_harm_signal: {
    description: "Confirmed societal harms — deepfake fraud, disinformation impact",
    enabled_dimensions: [
      "attack_vector","ai_layer","operational_status","threat_maturity",
      "impact_scope","impact_type","sector","geography","signal_cluster","recurring_theme",
    ],
    required_fields:    ["impact_types","impact_scope","attack_vectors"],
    optional_fields:    ["sectors","geography","ai_layers","signal_clusters"],
    aggregation_weight: 0.6,
    default_analytics_use: "full_analytics",
    useful_chart_types: [
      "impact_type_frequency","impact_scope_distribution","attack_vector_frequency",
    ],
    extraction_hints: "Focus on harm type, affected population, trust system, institutional response. Do not infer adversary adoption from this source type alone.",
  },

  benchmark_evaluation: {
    description: "Red team results, safety evaluations, model capability benchmarks",
    enabled_dimensions: [
      "ai_layer","technology","capability_stage","operational_status","threat_maturity",
      "signal_cluster","recurring_theme",
    ],
    required_fields:    ["capability_stage","ai_layers"],
    optional_fields:    ["technologies","signal_clusters","recurring_themes"],
    aggregation_weight: 1.0,
    default_analytics_use: "limited_analytics",
    useful_chart_types: [
      "capability_stage_distribution","ai_layer_distribution","threat_maturity_distribution",
    ],
    extraction_hints: "Focus on capability measured, key result, trajectory signal.",
  },

  capability_demonstration: {
    description: "PoC capabilities shown to work; not yet observed in the wild",
    enabled_dimensions: [
      "attack_vector","attack_surface","ai_layer","operational_status","threat_maturity",
      "capability_stage","technology","signal_cluster","recurring_theme",
    ],
    required_fields:    ["capability_stage","attack_vectors","operational_status"],
    optional_fields:    ["ai_layers","attack_surfaces","technologies","signal_clusters"],
    aggregation_weight: 1.1,
    default_analytics_use: "full_analytics",
    useful_chart_types: [
      "capability_stage_distribution","attack_vector_frequency","operational_status_distribution",
    ],
    extraction_hints: "Focus on demonstrated capability, affected system, ease of replication, defender implications.",
  },

  adversary_adoption_signal: {
    description: "Evidence of adversaries adopting or operationalising AI capabilities",
    enabled_dimensions: [
      "attack_vector","ai_layer","operational_status","threat_maturity",
      "sector","geography","signal_cluster","recurring_theme","adversary_adoption_stage",
    ],
    required_fields:    ["adversary_adoption_stage","attack_vectors","operational_status"],
    optional_fields:    ["sectors","geography","ai_layers","signal_clusters"],
    aggregation_weight: 1.2,
    default_analytics_use: "full_analytics",
    useful_chart_types: [
      "adversary_adoption_stage_distribution","attack_vector_frequency","threat_maturity_distribution",
    ],
    extraction_hints: "Focus on who is adopting, what capability, observed evidence, spread trajectory.",
  },

  unknown: {
    description: "Source type could not be determined",
    enabled_dimensions: ["source_type","trust_tier","main_category","time_period"],
    required_fields:    [],
    optional_fields:    ["sector","signal_cluster"],
    aggregation_weight: 0.4,
    default_analytics_use: "limited_analytics",
    useful_chart_types: ["source_type_distribution"],
    extraction_hints: "Extract only basic metadata.",
  },
};

/**
 * Get the analytics profile for a given source type.
 *
 * @param {string} sourceType
 * @returns {object} profile (falls back to "unknown" profile)
 */
export function getAnalyticsProfile(sourceType) {
  return ANALYTICS_PROFILES[sourceType] || ANALYTICS_PROFILES.unknown;
}

/**
 * Attach analytics_profile to each source (Layer 5b.2).
 *
 * @param {object[]} sources
 * @returns {object[]}
 */
export function applyAnalyticsProfiles(sources) {
  return sources.map((source) => ({
    ...source,
    analytics_profile: getAnalyticsProfile(source.source_type || "unknown"),
  }));
}
