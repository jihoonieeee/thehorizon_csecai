/**
 * Validation 3.6 — Evidence Potential + Source Usefulness Roles
 *
 * Deterministic pre-extraction estimate of:
 *   evidence_potential   — how likely this source is to yield admissible evidence
 *   source_usefulness_roles — which downstream pipeline roles it can serve
 *
 * Computed BEFORE Layer 5A extraction so:
 *   - Layer 5A can apply the correct extraction profile
 *   - Layer 6 knows what each source is useful for WITHOUT guessing
 *   - Budget can be allocated (primary candidates get full extraction,
 *     context_only sources get shallow extraction or none)
 *
 * evidence_potential values:
 *   primary_evidence_candidate   — very likely to yield strong/usable evidence (CVE, incident, TI report)
 *   supporting_evidence_candidate — likely to yield supporting/context evidence (research, benchmark, capability demo)
 *   context_only                 — useful for framing but unlikely to yield claim-supporting facts
 *   analytics_only               — useful for corpus analytics but not for specific claims
 *   archive_only                 — keep for audit trail but do not extract evidence
 *
 * source_usefulness_roles (array, can have multiple):
 *   factual_claim_support   — can support a specific factual claim
 *   trend_support           — can support a trend over time
 *   adoption_support        — can support adoption/prevalence claims
 *   case_study_support      — can be used as a concrete case study
 *   recommendation_input    — informs defensive recommendations
 *   outlook_input           — informs future trajectory assessment
 *   chart_input             — contributes to analytics/visualisation
 *   context_only            — context framing only, no specific claim support
 */

// ── Source type → base evidence potential ─────────────────────────────────────

const SOURCE_TYPE_POTENTIAL = {
  // Primary evidence candidates — yield concrete, citable, claim-supporting facts
  vulnerability:             "primary_evidence_candidate",
  exploit_disclosure:        "primary_evidence_candidate",
  incident:                  "primary_evidence_candidate",
  threat_intelligence:       "primary_evidence_candidate",
  adversary_adoption_signal: "primary_evidence_candidate",
  advisory:                  "primary_evidence_candidate",

  // Supporting evidence candidates — yield useful supporting facts but often need corroboration
  research_finding:          "supporting_evidence_candidate",
  capability_demonstration:  "supporting_evidence_candidate",
  benchmark_evaluation:      "supporting_evidence_candidate",
  governance_signal:         "supporting_evidence_candidate",
  attack_surface_signal:     "supporting_evidence_candidate",

  // Context/analytics — useful for framing, but not for specific claim support
  defensive_capability:      "context_only",
  societal_harm:             "context_only",
  unknown:                   "analytics_only",
};

// ── Source type → base usefulness roles ──────────────────────────────────────

const SOURCE_TYPE_USEFULNESS = {
  vulnerability:             ["factual_claim_support", "recommendation_input", "chart_input"],
  exploit_disclosure:        ["factual_claim_support", "case_study_support", "recommendation_input"],
  incident:                  ["factual_claim_support", "case_study_support", "trend_support", "outlook_input"],
  threat_intelligence:       ["factual_claim_support", "adoption_support", "trend_support"],
  adversary_adoption_signal: ["adoption_support", "trend_support", "factual_claim_support"],
  research_finding:          ["trend_support", "case_study_support", "chart_input", "outlook_input"],
  capability_demonstration:  ["case_study_support", "trend_support", "chart_input"],
  benchmark_evaluation:      ["chart_input", "trend_support"],
  governance_signal:         ["recommendation_input", "context_only"],
  attack_surface_signal:     ["trend_support", "chart_input", "context_only"],
  defensive_capability:      ["recommendation_input", "context_only"],
  societal_harm:             ["case_study_support", "context_only"],
  unknown:                   ["context_only"],
};

// ── Publisher class adjustments ───────────────────────────────────────────────

// Publisher classes that upgrade a supporting candidate to primary
const PUBLISHER_UPGRADES_TO_PRIMARY = new Set([
  "primary_authority",  // government, CERT, standards body
  "ai_lab",             // Anthropic, OpenAI, DeepMind — their research IS authoritative
]);

// Publisher classes that downgrade a primary candidate to supporting
const PUBLISHER_DOWNGRADES_FROM_PRIMARY = new Set([
  "media",   // journalism is secondary reporting
]);

// ── Usefulness role modifiers by publisher class ──────────────────────────────

function addRolesFromPublisherClass(roles, publisherClass) {
  const extra = [];
  if (publisherClass === "primary_authority" || publisherClass === "ai_lab") {
    extra.push("factual_claim_support");
  }
  if (publisherClass === "media") {
    // Media → secondary reporting, downgrade fact support
    return roles
      .filter((r) => r !== "factual_claim_support")
      .concat(roles.includes("context_only") ? [] : ["context_only"]);
  }
  return [...new Set([...roles, ...extra])];
}

// ── Origin role adjustments ───────────────────────────────────────────────────

function adjustForOriginRole(potential, roles, originRole, independenceLevel) {
  // Secondary reporting (news sites covering a primary finding) → context only
  if (originRole === "secondary_reporting") {
    const adjusted = potential === "primary_evidence_candidate" ? "supporting_evidence_candidate" : potential;
    const adjustedRoles = roles
      .filter((r) => r !== "factual_claim_support")
      .concat(["context_only"]);
    return { potential: adjusted, roles: [...new Set(adjustedRoles)] };
  }

  // Tertiary commentary → context only regardless of source type
  if (originRole === "tertiary_commentary") {
    return { potential: "context_only", roles: ["context_only", "outlook_input"] };
  }

  // Circular reporting risk → no trend support (corroboration is fake)
  if (independenceLevel === "circular_reporting_risk") {
    const adjustedRoles = roles.filter((r) => r !== "trend_support" && r !== "adoption_support");
    return { potential, roles: adjustedRoles };
  }

  // Vendor self-reported evidence without external corroboration
  if (independenceLevel === "vendor_interested" || independenceLevel === "self_reported") {
    const adjustedRoles = roles.filter((r) => r !== "adoption_support");
    return {
      potential: potential === "primary_evidence_candidate" ? "supporting_evidence_candidate" : potential,
      roles: [...new Set([...adjustedRoles, "context_only"])],
    };
  }

  return { potential, roles };
}

// ── Content quality adjustments ───────────────────────────────────────────────

function adjustForContentQuality(potential, roles, contentQuality, sourceType) {
  const isStructured = new Set([
    "vulnerability", "exploit_disclosure", "incident", "governance_signal",
  ]).has(sourceType);

  if (contentQuality === "marketing" || contentQuality === "keyword_stuffing") {
    return { potential: "archive_only", roles: [] };
  }
  if (contentQuality === "thin_content" && !isStructured) {
    return {
      potential: "context_only",
      roles: roles.filter((r) => r !== "factual_claim_support" && r !== "case_study_support"),
    };
  }
  return { potential, roles };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute evidence_potential and source_usefulness_roles.
 *
 * @param {object} source — must have: source_type, publisher_class, origin_role,
 *                          independence_level, content_quality, trust_tier
 * @returns {{ evidence_potential: string, source_usefulness_roles: string[] }}
 */
export function computeEvidencePotential(source) {
  const sourceType       = source.source_type  || "unknown";
  const publisherClass   = source.publisher_class || "other";
  const originRole       = source.origin_role  || "unknown_origin";
  const independence     = source.independence_level || "unknown";
  const contentQuality   = source.content_quality || "adequate";
  const trustTier        = source.trust_tier || "unknown";

  // Base potential and roles from source type
  let potential = SOURCE_TYPE_POTENTIAL[sourceType] || "analytics_only";
  let roles     = [...(SOURCE_TYPE_USEFULNESS[sourceType] || ["context_only"])];

  // Publisher class adjustments
  if (PUBLISHER_UPGRADES_TO_PRIMARY.has(publisherClass) && potential === "supporting_evidence_candidate") {
    potential = "primary_evidence_candidate";
  }
  if (PUBLISHER_DOWNGRADES_FROM_PRIMARY.has(publisherClass) && potential === "primary_evidence_candidate") {
    potential = "supporting_evidence_candidate";
  }
  roles = addRolesFromPublisherClass(roles, publisherClass);

  // Origin role and independence adjustments
  const adjusted = adjustForOriginRole(potential, roles, originRole, independence);
  potential = adjusted.potential;
  roles     = adjusted.roles;

  // Content quality adjustments
  const qualityAdjusted = adjustForContentQuality(potential, roles, contentQuality, sourceType);
  potential = qualityAdjusted.potential;
  roles     = qualityAdjusted.roles;

  return {
    evidence_potential:    potential,
    source_usefulness_roles: [...new Set(roles)],
  };
}

/**
 * Derive source_route from evidence_potential + gate status.
 * This is the richer replacement for downstream_route.
 *
 * source_route values:
 *   layer4_evidence  — high-priority extraction, full L5A profile
 *   layer4_context   — light extraction, context_only L5A profile
 *   analytics_only   — skip L5A evidence extraction; feed L5B aggregates only
 *   archive          — store but do not process downstream
 *   discard          — remove entirely
 */
export function deriveSourceRoute(evidencePotential, layer3Status, downstreamRoute) {
  if (downstreamRoute === "discard") return "discard";
  if (layer3Status === "reject") return "discard";

  switch (evidencePotential) {
    case "primary_evidence_candidate":
    case "supporting_evidence_candidate":
      return "layer4_evidence";

    case "context_only":
      return "layer4_context";

    case "analytics_only":
      return "analytics_only";

    case "archive_only":
      return "archive";

    default:
      return "layer4_context";
  }
}

/**
 * Classify how much usable content was fetched.
 * Called after source text is available (post-connector normalization).
 *
 * source_content_status values:
 *   fetched_full_text  — substantial text available (> 500 chars)
 *   fetched_summary    — summary/abstract only (structured summary present)
 *   thin_structured    — short but structured type (CVE, advisory)
 *   paywall_stub       — title + teaser only
 *   pdf_pending        — linked PDF not yet fetched
 *   repo_pending       — GitHub/code repo, text not yet extracted
 *   unavailable        — no text available
 */
export function classifyContentStatus(source) {
  const textLen = (source.full_text?.length || 0);
  const hasText = textLen > 0;

  const isStructured = new Set([
    "vulnerability", "exploit_disclosure", "incident", "governance_signal",
  ]).has(source.source_type);

  if (!hasText) {
    const url = (source.url || "").toLowerCase();
    if (url.includes("github.com") || url.includes("gitlab.com")) return "repo_pending";
    if (url.endsWith(".pdf")) return "pdf_pending";
    return "unavailable";
  }

  if (textLen < 200 && isStructured) return "thin_structured";
  if (textLen < 200) {
    // Paywalled content has characteristic patterns
    const paywallSignals = ["subscribe", "sign in to read", "premium content", "member access"];
    const text = (source.full_text || source.summary || "").toLowerCase();
    if (paywallSignals.some((s) => text.includes(s))) return "paywall_stub";
    return "paywall_stub";
  }
  if (textLen < 500 && (source.summary?.length || 0) >= textLen) return "fetched_summary";
  return "fetched_full_text";
}
