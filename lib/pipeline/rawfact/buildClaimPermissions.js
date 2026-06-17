/**
 * Claim Permission Derivation — deterministic.
 *
 * Derives claim_permissions for an evidence item from three inputs:
 *   1. source_type → base can_support set (sourceTypeClaimPermissions.js)
 *   2. fact_qa.blocked_uses[] → items blocked by fact QA
 *   3. source_intent → commercial interest + evidence posture caps
 *
 * Output:
 * {
 *   permitted_claim_types: string[],
 *   blocked_claim_types:   string[],
 *   permission_reason:     string,
 *   required_caveats:      string[],
 * }
 *
 * Claim types vocabulary:
 *   factual, case_study, capability, adoption, trend_over_time,
 *   emerging_signal, outlook, recommendation, strategic_assessment,
 *   market_wide, corpus_scoped_pattern
 */

import { permissionsFor } from "../../config/sourceTypeClaimPermissions.js";

// ── Maps from permitted_use (triage vocab) → claim_type (analysis vocab) ──────

const USE_TO_CLAIM_TYPES = {
  fact_support:        ["factual"],
  case_study:          ["case_study"],
  capability_support:  ["capability"],
  adoption_support:    ["adoption"],
  trend_input:         ["trend_over_time", "corpus_scoped_pattern"],
  outlook_input:       ["outlook", "emerging_signal"],
  recommendation_input:["recommendation"],
  exposure_analysis:   ["factual", "case_study"],
  context_only:        [],   // anchors no claim types
  not_used:            [],
  analytics:           ["corpus_scoped_pattern"],
  visual_support:      [],
  trend_support:       ["corpus_scoped_pattern"],
  benchmark_support:   ["capability"],
  statistic_support:   ["factual"],
  claim_support:       ["factual"],
  governance_context:  ["recommendation"],
  conflict_check:      [],
  background_context:  [],
};

// ── Maps from fact_qa.blocked_uses → claim_types to block ────────────────────

const BLOCKED_USE_TO_CLAIM_TYPES = {
  adoption_support:        ["adoption"],
  trend_input:             ["trend_over_time"],
  real_world_factual:      ["factual"],
  market_wide:             ["market_wide", "strategic_assessment"],
  fact_support:            ["factual", "case_study"],
  case_study:              ["case_study"],
  capability_support:      ["capability"],
};

// ── Intent-based additional blocks ───────────────────────────────────────────

const INTENT_BLOCKED_CLAIMS = {
  vendor_marketing:   ["adoption", "trend_over_time", "market_wide", "strategic_assessment"],
  speculative_blog:   ["factual", "adoption", "trend_over_time", "market_wide", "case_study"],
  thought_leadership: ["adoption", "market_wide"],
};

const INTENT_REQUIRED_CAVEATS = {
  vendor_marketing:   ["vendor-reported: corroboration required for adoption/trend claims"],
  speculative_blog:   ["speculative source: no factual or adoption claims permitted"],
  thought_leadership: ["commentary source: adoption and market-wide claims need corroboration"],
  news_summary:       ["secondary reporting: verify against primary source before factual claim"],
};

/**
 * Build claim_permissions for an evidence item.
 *
 * @param {object} item     - Normalized evidence item
 * @param {string} sourceType - source.source_type
 * @param {object} [factQa]   - Result of classifyFactSupport(item)
 * @param {object} [sourceIntent] - Result of classifySourceIntent(source)
 * @returns {{ permitted_claim_types, blocked_claim_types, permission_reason, required_caveats }}
 */
export function buildClaimPermissions(item, sourceType, factQa = null, sourceIntent = null) {
  const permissions    = permissionsFor(sourceType);
  const canSupportSet  = permissions.can_support || new Set();

  // ── 1. Base permitted claim types from source_type can_support ────────────
  const permittedSet = new Set();
  for (const use of canSupportSet) {
    for (const ct of (USE_TO_CLAIM_TYPES[use] || [])) {
      permittedSet.add(ct);
    }
  }

  // Source types that can never be "strong" also can't support strategic_assessment alone
  if (permissions.never_strong) {
    permittedSet.delete("strategic_assessment");
    permittedSet.delete("market_wide");
  }

  // ── 2. Block from fact_qa.blocked_uses[] ──────────────────────────────────
  const blockedSet = new Set();
  const factQaBlockedUses = factQa?.blocked_uses || [];
  for (const use of factQaBlockedUses) {
    for (const ct of (BLOCKED_USE_TO_CLAIM_TYPES[use] || [])) {
      blockedSet.add(ct);
      permittedSet.delete(ct);
    }
  }

  // ── 3. Apply source_intent additional blocks ──────────────────────────────
  const intentClass = sourceIntent?.intent_class;
  if (intentClass && INTENT_BLOCKED_CLAIMS[intentClass]) {
    for (const ct of INTENT_BLOCKED_CLAIMS[intentClass]) {
      blockedSet.add(ct);
      permittedSet.delete(ct);
    }
  }

  // ── 4. Evidence triage data additional blocks ──────────────────────────────
  const triageData = item.triage_data || {};
  const strength = triageData.evidence_strength || "archive";
  const permitted_uses = triageData.permitted_uses || [];

  // context-only strength → cannot support factual, adoption, trend, case_study
  if (strength === "context" || strength === "archive") {
    for (const ct of ["factual", "adoption", "trend_over_time", "case_study", "strategic_assessment", "market_wide"]) {
      blockedSet.add(ct);
      permittedSet.delete(ct);
    }
  }

  // Adoption requires observed_use=true in triage
  if (!permitted_uses.includes("adoption_support")) {
    blockedSet.add("adoption");
    permittedSet.delete("adoption");
  }

  // market_wide: almost always blocked; requires ≥2 independent operational sources
  // The item-level gate cannot prove that — block by default, let L6 QA unlock if
  // corroboration is demonstrated across multiple items
  blockedSet.add("market_wide");
  permittedSet.delete("market_wide");

  // ── 5. Quote entailment floor ─────────────────────────────────────────────
  const quoteEntailment = factQa?.quote_entailment || "none";
  if (quoteEntailment === "none" || quoteEntailment === "weak") {
    // Weak/absent entailment: cannot support factual claims or case studies
    blockedSet.add("factual");
    blockedSet.add("case_study");
    permittedSet.delete("factual");
    permittedSet.delete("case_study");
  }

  // ── 6. Required caveats ───────────────────────────────────────────────────
  const required_caveats = [
    ...(factQa?.required_caveats || []),
    ...(intentClass && INTENT_REQUIRED_CAVEATS[intentClass] ? INTENT_REQUIRED_CAVEATS[intentClass] : []),
  ];

  // Research findings always carry lab caveat unless triage confirmed observed_use
  if (
    (sourceType === "research_finding" || sourceType === "benchmark_evaluation") &&
    !triageData.observed_use
  ) {
    if (!required_caveats.some((c) => c.includes("lab"))) {
      required_caveats.push("research/lab finding: real-world adversary adoption not established");
    }
  }

  const permission_reason = [
    `source_type=${sourceType}`,
    factQa?.support_level ? `support_level=${factQa.support_level}` : null,
    intentClass ? `intent=${intentClass}` : null,
    strength !== "archive" ? `strength=${strength}` : null,
    quoteEntailment !== "none" ? `entailment=${quoteEntailment}` : null,
  ].filter(Boolean).join("; ");

  return {
    permitted_claim_types: [...permittedSet],
    blocked_claim_types:   [...blockedSet],
    permission_reason,
    required_caveats:      [...new Set(required_caveats)],
  };
}
