/**
 * Layer 5b.4 — Analytics Feature Normalisation
 *
 * Deterministic only. Validates and normalises analytics_features produced by
 * extractAnalyticsFeatures (Layer 5b.3).
 *
 * Responsibilities:
 *   - Validate controlled vocabulary values (drop invalid)
 *   - Enforce source-type profile dimension restrictions
 *   - Normalise dates into month buckets
 *   - Downgrade low-confidence noisy outputs
 *   - Attach source metadata for aggregation
 *   - Ensure backward compatibility fields are present
 */

import {
  VALID_ATTACK_VECTORS, VALID_ATTACK_SURFACES, VALID_AI_LAYERS,
  VALID_OPERATIONAL_STATUSES, VALID_MATURITIES, VALID_IMPACT_SCOPES,
  VALID_IMPACT_TYPES, VALID_SIGNAL_CLUSTERS, VALID_RECURRING_THEMES,
  VALID_ADVERSARY_ADOPTION_STAGES, VALID_CAPABILITY_STAGES,
  VALID_DEFENSIVE_CONTROLS, VALID_GOVERNANCE_FUNCTIONS,
  VALID_DEPENDENCY_TYPES, VALID_TRUST_BOUNDARY_SHIFT_TYPES,
} from "./extractAnalyticsFeatures.js";

import { getAnalyticsProfile } from "./analyticsProfiles.js";
import {
  VALID_PRIMARY_TAGS, VALID_SUB_TECHNIQUES, VALID_AI_ENABLED_ROLES,
  VALID_AI_CAPABILITIES, DOMAINS,
} from "../../config/taxonomyRegistry.js";

// Keep only registry-valid tags (no normalisation — taxonomy tags are exact).
function keepValid(arr, vocab, max = 12) {
  return [...new Set((Array.isArray(arr) ? arr : []).filter((v) => vocab.has(v)))].slice(0, max);
}

// ── Normalisation helpers ─────────────────────────────────────────────────────

function filterVocab(arr, vocab, max = 8) {
  return [...new Set((Array.isArray(arr) ? arr : [])
    .map((v) => String(v || "").toLowerCase().replace(/-/g, "_"))
    .filter((v) => vocab.has(v))
  )].slice(0, max);
}

function pickOne(val, vocab, fallback = "unknown") {
  const v = String(val || "").toLowerCase().replace(/-/g, "_");
  return vocab.has(v) ? v : fallback;
}

function toMonthBucket(dateStr) {
  if (!dateStr) return null;
  const part = String(dateStr).slice(0, 7);
  return /^\d{4}-\d{2}$/.test(part) ? part : null;
}

function toIsoDate(dateStr) {
  if (!dateStr) return null;
  try {
    return new Date(dateStr).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

// ── Dimension filter by profile ───────────────────────────────────────────────

function applyProfileRestrictions(features, profile) {
  const allowed = new Set(profile.enabled_dimensions || []);

  return {
    ...features,
    attack_vectors:   allowed.has("attack_vector") ? features.attack_vectors : [],
    attack_surfaces:  allowed.has("attack_surface") ? features.attack_surfaces : [],
    ai_layers:        allowed.has("ai_layer") ? features.ai_layers : [],
    impact_types:     allowed.has("impact_type") ? features.impact_types : [],
    signal_clusters:  allowed.has("signal_cluster") ? features.signal_clusters : [],
    recurring_themes: allowed.has("recurring_theme") ? features.recurring_themes : [],
    sectors:          allowed.has("sector") ? features.sectors : [],
    technologies:     allowed.has("technology") ? features.technologies : [],
    geography:        allowed.has("geography") ? features.geography : [],
    defensive_controls:  allowed.has("defensive_control") ? features.defensive_controls : [],
    governance_functions: allowed.has("governance_function") ? features.governance_functions : [],
    adversary_adoption_stage: allowed.has("adversary_adoption_stage")
      ? features.adversary_adoption_stage : "none",
    capability_stage: allowed.has("capability_stage") ? features.capability_stage : "unknown",
    dependency_types: allowed.has("dependency_type") ? features.dependency_types : [],
    trust_boundary_shift_types: allowed.has("trust_boundary_shift_type")
      ? features.trust_boundary_shift_types : [],
    // impact_scope and operational_status/threat_maturity are always kept for aggregation
    impact_scope:        allowed.has("impact_scope") ? features.impact_scope : "unknown",
    operational_status:  allowed.has("operational_status") ? features.operational_status : "unknown",
    threat_maturity:     allowed.has("threat_maturity") ? features.threat_maturity : "unknown",
  };
}

// ── Low-confidence downgrade ──────────────────────────────────────────────────

function applyConfidenceDowngrade(features) {
  if (features.confidence !== "low") return features;

  // Low confidence: reduce noisy arrays to first element only, reset ambiguous fields
  return {
    ...features,
    attack_vectors:   features.attack_vectors.slice(0, 2),
    attack_surfaces:  features.attack_surfaces.slice(0, 2),
    ai_layers:        features.ai_layers.slice(0, 2),
    signal_clusters:  features.signal_clusters.slice(0, 2),
    recurring_themes: features.recurring_themes.slice(0, 2),
  };
}

/**
 * Normalise analytics_features for a single source.
 *
 * @param {object} source - Source with analytics_features set.
 * @returns {object} Source with normalised analytics_features.
 */
export function normalizeSourceAnalyticsFeatures(source) {
  const raw = source.analytics_features;
  if (!raw) return source;

  const st      = source.source_type || "unknown";
  const profile = getAnalyticsProfile(st);
  const date    = toIsoDate(source.date_published);
  const month   = toMonthBucket(date);

  // Validate all vocab fields
  let normalised = {
    source_id:     source.id,
    source_type:   st,
    main_category: source.main_category || "unclear_or_adjacent",
    trust_tier:    source.trust_tier || "unknown",
    date_published: date,
    month_bucket:  month,
    analytics_use: raw.analytics_use || "full_analytics",
    aggregation_weight: profile.aggregation_weight || 1.0,

    attack_vectors:             filterVocab(raw.attack_vectors, VALID_ATTACK_VECTORS, 8),
    attack_surfaces:            filterVocab(raw.attack_surfaces, VALID_ATTACK_SURFACES, 8),
    ai_layers:                  filterVocab(raw.ai_layers, VALID_AI_LAYERS, 5),
    operational_status:         pickOne(raw.operational_status, VALID_OPERATIONAL_STATUSES),
    threat_maturity:            pickOne(raw.threat_maturity, VALID_MATURITIES),
    impact_scope:               pickOne(raw.impact_scope, VALID_IMPACT_SCOPES),
    impact_types:               filterVocab(raw.impact_types, VALID_IMPACT_TYPES, 5),
    signal_clusters:            filterVocab(raw.signal_clusters, VALID_SIGNAL_CLUSTERS, 6),
    recurring_themes:           filterVocab(raw.recurring_themes, VALID_RECURRING_THEMES, 5),
    sectors:                    (Array.isArray(raw.sectors) ? raw.sectors : []).slice(0, 5),
    technologies:               (Array.isArray(raw.technologies) ? raw.technologies : []).slice(0, 8),
    geography:                  (Array.isArray(raw.geography) ? raw.geography : []).slice(0, 5),
    defensive_controls:         filterVocab(raw.defensive_controls, VALID_DEFENSIVE_CONTROLS, 5),
    governance_functions:       filterVocab(raw.governance_functions, VALID_GOVERNANCE_FUNCTIONS, 4),
    adversary_adoption_stage:   pickOne(raw.adversary_adoption_stage, VALID_ADVERSARY_ADOPTION_STAGES, "none"),
    capability_stage:           pickOne(raw.capability_stage, VALID_CAPABILITY_STAGES),
    dependency_types:           filterVocab(raw.dependency_types, VALID_DEPENDENCY_TYPES, 5),
    trust_boundary_shift_types: filterVocab(raw.trust_boundary_shift_types, VALID_TRUST_BOUNDARY_SHIFT_TYPES, 4),
    confidence:                 ["high","medium","low"].includes(raw.confidence) ? raw.confidence : "low",
    extraction_method:          raw.extraction_method || "deterministic_fallback",
    reason:                     raw.reason || "",

    // ── taxonomy-v9 features ──
    // primary_tags (coded IDs) + sub_techniques + AI-enabled overlay. These power
    // the taxonomy-aware aggregations in analyticsAggregation.js.
    primary_domain: (DOMAINS.includes(raw.primary_domain) || raw.primary_domain === "unclear_or_adjacent")
      ? raw.primary_domain : (source.main_category || "unknown"),
    primary_tags:              keepValid(raw.primary_tags, VALID_PRIMARY_TAGS),
    primary_threat_tags:       keepValid(raw.primary_tags || raw.primary_threat_tags, VALID_PRIMARY_TAGS), // back-compat alias
    sub_techniques:            keepValid(raw.sub_techniques, VALID_SUB_TECHNIQUES),
    ai_enabled:                raw.ai_enabled === true,
    ai_enabled_roles:          keepValid(raw.ai_enabled_roles, VALID_AI_ENABLED_ROLES),
    ai_capabilities:           keepValid(raw.ai_capabilities, VALID_AI_CAPABILITIES),
    automation_level:          raw.automation_level || "unknown",
    autonomy_level:            raw.autonomy_level || "unknown",
    taxonomy_validation_status: ["validated","weak","needs_manual_review","rejected"].includes(raw.taxonomy_validation_status)
      ? raw.taxonomy_validation_status : "needs_manual_review",
  };

  // Apply profile dimension restrictions
  normalised = applyProfileRestrictions(normalised, profile);

  // Downgrade noise for low-confidence sources
  normalised = applyConfidenceDowngrade(normalised);

  return { ...source, analytics_features: normalised };
}

/**
 * Normalise analytics features for all sources (Layer 5b.4).
 *
 * @param {object[]} sources
 * @returns {object[]}
 */
export function normalizeAllAnalyticsFeatures(sources) {
  return sources.map(normalizeSourceAnalyticsFeatures);
}
