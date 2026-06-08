/**
 * Source-Type Claim Permissions (Evidence Triage, Part 2).
 *
 * The deterministic source of truth for what each source type can legitimately
 * prove and support. The LLM may judge whether an item FITS these rules; it must
 * never invent permissions outside them. Deterministic validation bounds every
 * evidence item's permitted_uses to `can_support` for its source type and enforces
 * the observed-use / corroboration constraints.
 *
 * Fields per source type:
 *   can_prove        — one-line statement of what the type can establish
 *   strong_if        — descriptive conditions (used in prompts + the doc)
 *   can_support      — Set of permitted_uses allowed for this type
 *   cannot_prove     — descriptive blocks (used in prompts + the doc)
 *   needs_observed   — uses that require observed real-world use (beyond the global rule)
 *   needs_corroboration — uses that need corroboration to count (e.g. trend_input)
 */

const U = (...uses) => new Set(uses);

export const SOURCE_TYPE_CLAIM_PERMISSIONS = {
  incident: {
    can_prove: "real-world activity happened",
    strong_if: ["event confirmed", "victim/sector/actor/target/campaign named", "impact/outcome described", "AI role explicit if AI-enabled claim"],
    can_support: U("fact_support", "case_study", "recommendation_input", "adoption_support", "trend_input"),
    needs_observed: U("adoption_support"),
    needs_corroboration: U("trend_input"),
    cannot_prove: ["broad trend by itself", "ecosystem-wide change by itself", "AI-specific significance if AI role unclear"],
    // An incident IS observed real-world activity by definition — so adoption_support
    // (which globally requires observed use) is grantable without an extra LLM flag.
    inherently_observed: true,
  },
  vulnerability: {
    can_prove: "a concrete weakness exists",
    strong_if: ["affected component named", "weakness technically described", "exploitability/exposure clear", "mitigation/patch relevance"],
    can_support: U("fact_support", "recommendation_input", "case_study", "exposure_analysis", "capability_support"),
    needs_observed: U(),
    needs_corroboration: U(),
    cannot_prove: ["active exploitation unless observed", "adversary adoption unless observed", "broad trend by itself"],
  },
  exploit_disclosure: {
    can_prove: "a working attack method exists",
    strong_if: ["exploit/PoC/payload/chain/method demonstrated", "target system identified", "abuse outcome clear", "reproducibility indicated"],
    can_support: U("capability_support", "case_study", "recommendation_input", "outlook_input", "trend_input"),
    needs_observed: U(),
    needs_corroboration: U("trend_input"),
    cannot_prove: ["widespread use unless observed", "adversary adoption unless observed"],
  },
  threat_intelligence: {
    can_prove: "adversary behaviour was observed",
    strong_if: ["actor/campaign/tool/infrastructure/TTP named", "operational use described", "defender-relevant indicators present"],
    can_support: U("adoption_support", "fact_support", "case_study", "recommendation_input", "trend_input"),
    needs_observed: U(),  // threat_intel IS observed use by definition
    needs_corroboration: U("trend_input"),
    cannot_prove: ["future use without evidence", "ecosystem-wide adoption by itself"],
    inherently_observed: true,  // threat-intel reports observed adversary behaviour
  },
  research_finding: {
    can_prove: "a capability/weakness/defense was demonstrated in research",
    strong_if: ["empirical result exists", "method concrete", "models/systems/datasets named", "operational path clear"],
    can_support: U("capability_support", "outlook_input", "recommendation_input", "fact_support"),
    needs_observed: U(),
    needs_corroboration: U(),
    cannot_prove: ["real-world use", "adversary adoption", "operational trend by itself"],
    // Research may back high/critical claims only with strong empirical grounding,
    // major analytical change, plausible operational path, broad relevance, low ambiguity.
    high_priority_requires: ["strong_empirical_grounding", "major_analytical_change", "plausible_operational_path", "broad_relevance", "low_ambiguity"],
  },
  benchmark_evaluation: {
    can_prove: "a measured capability or weakness exists",
    strong_if: ["metric stated", "method clear", "baseline/comparison exists", "tested systems named"],
    can_support: U("capability_support", "outlook_input", "fact_support", "recommendation_input"),
    needs_observed: U(),
    needs_corroboration: U(),
    cannot_prove: ["operational use", "adversary adoption", "real-world trend"],
  },
  capability_demonstration: {
    can_prove: "a capability can be executed",
    strong_if: ["capability actually demonstrated", "concrete abuse/defense path shown", "repeatability/automation/scaling indicated"],
    can_support: U("capability_support", "case_study", "outlook_input", "recommendation_input"),
    needs_observed: U(),
    needs_corroboration: U(),
    cannot_prove: ["real-world deployment unless observed", "adversary adoption unless observed"],
  },
  adversary_adoption_signal: {
    can_prove: "adversaries are experimenting with or using a capability",
    strong_if: ["observed usage described", "adoption stage identifiable", "actor/campaign/tool/operational setting named"],
    can_support: U("adoption_support", "trend_input", "outlook_input", "recommendation_input", "case_study"),
    needs_observed: U(),  // it IS an observed-adoption signal
    needs_corroboration: U("trend_input"),
    cannot_prove: ["ecosystem-wide adoption by itself"],
    inherently_observed: true,  // an adoption signal IS observed adversary use
  },
  defensive_capability: {
    can_prove: "a mitigation/detection/defensive control exists",
    strong_if: ["specific control named", "threat relationship explicit", "deployment/evaluation context stated"],
    can_support: U("recommendation_input", "context_only", "outlook_input"),
    needs_observed: U(),
    needs_corroboration: U(),
    cannot_prove: ["attacker activity", "adversary adoption", "exploitation"],
  },
  governance_signal: {
    can_prove: "a policy/standard/regulation/institutional response exists",
    strong_if: ["authority/framework named", "requirement/policy direction specific", "security relevance explicit"],
    can_support: U("context_only", "recommendation_input", "outlook_input"),
    needs_observed: U(),
    needs_corroboration: U(),
    cannot_prove: ["attacker activity", "exploitation", "adversary adoption", "operational trend"],
  },
  attack_surface_signal: {
    can_prove: "an AI attack-surface expansion or trust/dependency shift exists",
    strong_if: ["specific platform/tool/integration/dependency/autonomy-or-trust boundary named", "security-relevant exposure clear", "affected ecosystem/workflow/stakeholders identified"],
    can_support: U("context_only", "outlook_input", "recommendation_input", "exposure_analysis"),
    needs_observed: U(),
    needs_corroboration: U(),
    cannot_prove: ["attacker activity", "exploitation", "adversary adoption", "operational trend by itself"],
  },
  societal_harm_signal: {
    can_prove: "AI contributed to population-scale or social harm",
    strong_if: ["harm pattern specific", "AI contribution explicit", "scale/affected group/mechanism described"],
    can_support: U("context_only", "case_study", "outlook_input", "recommendation_input"),
    needs_observed: U(),
    needs_corroboration: U(),
    cannot_prove: ["named attacker attribution unless observed", "adversary adoption unless observed"],
  },
  unknown: {
    can_prove: "nothing beyond narrow context unless the source type is refined",
    strong_if: [],   // never strong while still unknown
    can_support: U("context_only"),
    needs_observed: U(),
    needs_corroboration: U(),
    cannot_prove: ["operational activity", "trend", "adoption", "executive judgment"],
    never_strong: true,
  },
};

export function permissionsFor(sourceType) {
  return SOURCE_TYPE_CLAIM_PERMISSIONS[sourceType] || SOURCE_TYPE_CLAIM_PERMISSIONS.unknown;
}

/** Is this permitted_use allowed for this source type? */
export function canSupport(sourceType, use) {
  if (use === "not_used" || use === "context_only") return true;
  return permissionsFor(sourceType).can_support.has(use);
}

/** Does this use require observed real-world use for this source type? */
export function requiresObservedUse(sourceType, use) {
  if (use === "adoption_support") return true;   // global rule
  return permissionsFor(sourceType).needs_observed.has(use);
}

/** Can this source type ever be classified `strong`? (unknown cannot) */
export function canBeStrong(sourceType) {
  return !permissionsFor(sourceType).never_strong;
}

/**
 * Is this source type observed real-world use by its very nature?
 * Incidents, threat-intelligence, and adversary-adoption signals report things
 * that actually happened, so observed-gated uses (e.g. adoption_support) are
 * grantable without a separate per-item LLM `observed_use` flag. Without this,
 * the rawfact triage path (which passes no LLM judgements) could never grant
 * adoption_support, making every adoption claim structurally unreachable.
 */
export function isInherentlyObserved(sourceType) {
  return permissionsFor(sourceType).inherently_observed === true;
}
