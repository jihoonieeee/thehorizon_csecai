/**
 * Layer 5b.1 — Analytics Eligibility
 *
 * Deterministic rules only. Decides whether a source contributes to analytics
 * and at what level.
 *
 * ── ELIGIBILITY LEVELS ────────────────────────────────────────────────────────
 *   full_analytics     — extract all dimensions enabled by source-type profile
 *   limited_analytics  — extract structural + basic taxonomy only (no LLM)
 *   context_only       — counted in corpus totals but no dimension extraction
 *   exclude            — not included in any analytics
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 * analytics_eligibility: {
 *   eligible_for_analytics: boolean,
 *   analytics_use: "full_analytics" | "limited_analytics" | "context_only" | "exclude",
 *   reason: string,
 *   allowed_analytics_dimensions: string[]
 * }
 */

// All available analytics dimensions (from spec)
const ALL_DIMENSIONS = [
  "attack_vector","attack_surface","ai_layer","operational_status","threat_maturity",
  "impact_scope","impact_type","signal_cluster","recurring_theme","sector","technology",
  "source_type","trust_tier","main_category","time_period","geography",
  "defensive_control","governance_function","adversary_adoption_stage","capability_stage",
  "dependency_type","trust_boundary_shift_type",
];

// Source types that contribute governance/defensive/maturity analytics even without attack data
const CONTEXT_ELIGIBLE_TYPES = new Set([
  "governance_signal","defensive_capability","attack_surface_signal",
  "benchmark_evaluation",
]);

// High-trust tiers that upgrade ambiguous sources
const HIGH_TRUST_TIERS = new Set(["primary","curated","high"]);

// Categories that are off-topic for threat analytics
const OFF_TOPIC_CATEGORIES = new Set(["unclear_or_adjacent"]);

/**
 * Assess analytics eligibility for a single source.
 *
 * @param {object} source
 * @returns {object} eligibility object
 */
export function assessAnalyticsEligibility(source) {
  const st        = source.source_type || "unknown";
  const cat       = source.main_category || "unknown";
  const trust     = source.trust_tier || "unknown";
  const l3Status  = source.layer3_status || "pass";
  const relevance = source.relevance_tier || "unknown";

  // ── Hard excludes ──────────────────────────────────────────────────────────

  // Layer 3 rejected sources are excluded unless curated
  if (l3Status === "reject" && trust !== "curated") {
    return {
      eligible_for_analytics: false,
      analytics_use: "exclude",
      reason: "layer3_rejected",
      allowed_analytics_dimensions: [],
    };
  }

  // Off-topic relevance tier — exclude unless high-trust
  if (relevance === "off_topic" && !HIGH_TRUST_TIERS.has(trust)) {
    return {
      eligible_for_analytics: false,
      analytics_use: "exclude",
      reason: "off_topic",
      allowed_analytics_dimensions: [],
    };
  }

  // ── Context-only: governance, defensive, ecosystem, strategic ─────────────
  // These still contribute to corpus counts and dimension analytics
  if (CONTEXT_ELIGIBLE_TYPES.has(st)) {
    const dimensions = [
      "sector","technology","geography","source_type","trust_tier",
      "main_category","time_period","governance_function","defensive_control",
      "capability_stage","ai_layer","signal_cluster","recurring_theme",
    ];
    return {
      eligible_for_analytics: true,
      analytics_use: cat === "unclear_or_adjacent" ? "context_only" : "limited_analytics",
      reason: `context_type:${st}`,
      allowed_analytics_dimensions: dimensions,
    };
  }

  // ── Unknown source type: limited unless high-trust ────────────────────────
  if (st === "unknown") {
    if (HIGH_TRUST_TIERS.has(trust)) {
      return {
        eligible_for_analytics: true,
        analytics_use: "limited_analytics",
        reason: "unknown_type_high_trust",
        allowed_analytics_dimensions: ["source_type","trust_tier","main_category","time_period","sector"],
      };
    }
    return {
      eligible_for_analytics: false,
      analytics_use: "exclude",
      reason: "unknown_type_low_trust",
      allowed_analytics_dimensions: [],
    };
  }

  // ── Low trust: limited analytics ─────────────────────────────────────────
  if (trust === "low" || trust === "unknown") {
    return {
      eligible_for_analytics: true,
      analytics_use: "limited_analytics",
      reason: `low_trust:${trust}`,
      allowed_analytics_dimensions: [
        "source_type","trust_tier","main_category","time_period",
        "attack_vector","ai_layer","signal_cluster",
      ],
    };
  }

  // ── Off-topic category: context only ────────────────────────────────────
  if (OFF_TOPIC_CATEGORIES.has(cat)) {
    return {
      eligible_for_analytics: true,
      analytics_use: "context_only",
      reason: `unclear_category`,
      allowed_analytics_dimensions: ["source_type","trust_tier","time_period"],
    };
  }

  // ── Full analytics: all remaining sources with good standing ─────────────
  return {
    eligible_for_analytics: true,
    analytics_use: "full_analytics",
    reason: `eligible:${st}:${trust}`,
    allowed_analytics_dimensions: ALL_DIMENSIONS,
  };
}

/**
 * Apply analytics eligibility to all sources (Layer 5b.1).
 *
 * @param {object[]} sources
 * @returns {object[]} Sources with `analytics_eligibility` field attached.
 */
export function applyAnalyticsEligibility(sources) {
  return sources.map((source) => ({
    ...source,
    analytics_eligibility: assessAnalyticsEligibility(source),
  }));
}
