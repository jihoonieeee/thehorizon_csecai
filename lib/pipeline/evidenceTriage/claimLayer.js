/**
 * Evidence Triage — Claim Layer (Parts 4 + 5 + 6)
 *
 * The LLM generates structured claim fields.
 * Deterministic gates assign final claim_priority — the LLM must NOT decide priority directly.
 * Conflict/hype/redundancy controls prevent escalation on bad signals.
 *
 * ── PRIORITY GATES ────────────────────────────────────────────────────────────
 *   critical  — ALL gates pass (sufficiency, analytical_change, change_driver,
 *               broad_relevance+basis, multi_scope_impact+basis≥2,
 *               strong_viewpoint + strong_evidence, no blocking limitations,
 *               slide_driving_power)
 *   high      — sufficient + non-trivial change + driver + no blocking limitations,
 *               at least one critical gate missing
 *   medium    — sufficient or partial, valid, but narrow/caveated/isolated
 *   rejected  — insufficient, exceeds permissions, generic, or hype-only escalation
 *
 * Critical means: a claim demonstrates a MAJOR ANALYTICAL CHANGE with broad relevance,
 * multi-scope impact, strong evidence+viewpoint, no blocking limitations, and slide-driving power.
 * Critical is NOT: scary, dramatic, viral, novel without evidence, vendor-promoted.
 */

import { routedLLM } from "../../llm/llmRouter.js";
import {
  VALID_CLAIM_TYPES, VALID_EVIDENCE_SUFFICIENCY, VALID_ANALYTICAL_CHANGE,
  VALID_CHANGE_DRIVER, VALID_BROAD_RELEVANCE_BASES, VALID_MULTI_SCOPE_DIMENSIONS,
  VALID_SIGNAL_TEMPORALITY, CRITICAL_ANALYTICAL_CHANGE, CRITICAL_CHANGE_DRIVER,
  LIMITATION_EFFECTS,
} from "./evidenceTriageVocab.js";

export const CLAIM_LAYER_VERSION = "claim-v1.0";

// ── LLM schema ─────────────────────────────────────────────────────────────────

const CLAIM_SCHEMA = {
  type: "object",
  required: ["claims"],
  properties: {
    claims: {
      type: "array", maxItems: 10,
      items: {
        type: "object",
        required: [
          "claim_id", "claim_text", "claim_type", "analytical_change", "change_driver",
          "signal_temporality", "supporting_viewpoint_ids", "supporting_observation_ids",
          "supporting_evidence_ids", "evidence_sufficiency",
          "broad_relevance", "broad_relevance_basis", "multi_scope_impact", "multi_scope_basis",
          "strong_viewpoint_support", "strong_evidence_support", "blocking_limitations",
          "slide_driving_power", "reasoning",
        ],
        properties: {
          claim_id:                   { type: "string" },
          claim_text:                 { type: "string" },
          claim_type:                 { type: "string" },
          analytical_change:          { type: "string" },
          change_driver:              { type: "string" },
          signal_temporality:         { type: "string" },
          supporting_viewpoint_ids:   { type: "array", items: { type: "string" } },
          supporting_observation_ids: { type: "array", items: { type: "string" } },
          supporting_evidence_ids:    { type: "array", items: { type: "string" } },
          evidence_sufficiency:       { type: "string" },
          broad_relevance:            { type: "boolean" },
          broad_relevance_basis:      { type: "array", items: { type: "string" } },
          multi_scope_impact:         { type: "boolean" },
          multi_scope_basis:          { type: "array", items: { type: "string" } },
          strong_viewpoint_support:   { type: "boolean" },
          strong_evidence_support:    { type: "boolean" },
          blocking_limitations:       { type: "boolean" },
          slide_driving_power:        { type: "boolean" },
          caveat_if_any:              { type: ["string", "null"] },
          reasoning:                  { type: "string" },
        },
      },
    },
  },
};

const CLAIM_SYSTEM = `You are a senior AI cybersecurity analyst generating ANALYTICAL CLAIMS from viewpoints.

A claim is a final analytical statement derived from viewpoints. Your role is to generate claims with precise structured fields. Deterministic logic assigns final claim_priority — you do NOT decide priority.

CLAIM TYPES:
  category_insight  — analytical conclusion about this threat category
  trend_claim       — directional trend across time (requires ≥3 non-duplicate items, ≥2 time windows, ≥2 independent publishers)
  executive_judgment — high-level strategic assessment (requires broad relevance + strong evidence)
  recommendation    — defensive action (requires concrete risk, control gap, or exposure)
  outlook           — forward-looking assessment (requires capability/adoption/infrastructure/trust change)

ANALYTICAL_CHANGE values:
  capability_increased, exposure_expanded, adoption_moved_forward,
  defensive_assumption_failed, trust_boundary_shifted, dependency_risk_increased,
  governance_pressure_intensified, no_clear_change

CHANGE_DRIVER values:
  newly_emerged, materially_expanded, operationalized, scaled, becoming_systemic,
  defensive_failure, governance_acceleration, persistent_unresolved, not_applicable

SIGNAL_TEMPORALITY values:
  emerging, persistent, recurring, declining, isolated

EVIDENCE_SUFFICIENCY:
  sufficient — claim type requirements are fully met
  partial    — evidence exists but requirements not fully met
  insufficient — evidence does not support the claim

BROAD_RELEVANCE_BASIS (allowed values):
  common_ai_deployment_pattern, widely_used_infrastructure_layer,
  multiple_organizations_or_sectors, reusable_attacker_capability,
  reusable_defensive_assumption, ecosystem_wide_workflow, foundational_trust_model

MULTI_SCOPE_BASIS (allowed values — need ≥2 for multi_scope_impact=true):
  actors, systems, workflows, infrastructure_layers, organization_types,
  threat_categories, deployment_environments

YOU DECIDE these boolean fields based on evidence, viewpoints, and analytical judgment:
  broad_relevance       — true ONLY if at least one valid broad_relevance_basis applies
  multi_scope_impact    — true ONLY if at least 2 valid multi_scope_basis entries apply
  strong_viewpoint_support — true if at least one STRONG viewpoint supports this claim
  strong_evidence_support  — true if at least one strong evidence item supports this claim
  blocking_limitations  — true if any limitation blocks this specific claim
  slide_driving_power   — true ONLY if the claim explains a MAJOR analytical change that can anchor an executive takeaway; NOT because it sounds dramatic

REJECTION RULES — set evidence_sufficiency="insufficient" if any applies:
  - trend_claim without ≥3 non-duplicate items spanning ≥2 time windows and ≥2 independent publishers
  - adoption claim without observed adversary use
  - executive_judgment without broad relevance
  - generic claim that merely restates evidence without analytical change
  - claim escalating solely due to hype, media volume, virality, novelty, or vendor emphasis

Do NOT invent evidence IDs. Only cite IDs shown in the sections below.
Return strict JSON only.`;

function buildClaimPrompt(category, viewpoints, observations, pairedItems, allowedVpIds, allowedObsIds, allowedEvIds) {
  const catLabel = category.replace(/_/g, " ").toUpperCase();
  const lines = [
    `CATEGORY: ${catLabel}`,
    ``,
    `VIEWPOINTS (${viewpoints.length}):`,
  ];
  for (const vp of viewpoints) {
    lines.push(
      `[${vp.viewpoint_id}] type=${vp.viewpoint_type} analytical_change=${vp.analytical_change} ` +
      `change_driver=${vp.change_driver} strength=${vp.strength}`,
      `  ${vp.viewpoint_text}`,
    );
    if (vp.caveat_if_any) lines.push(`  caveat: ${vp.caveat_if_any}`);
  }

  lines.push(``, `OBSERVATIONS (${observations.length}):`);
  for (const obs of observations) {
    lines.push(
      `[${obs.observation_id}] ${obs.observation_type} / ${obs.observation_scope}`,
      `  ${obs.observation_text}`,
    );
    if (obs.limitations?.length) lines.push(`  limitations: ${obs.limitations.join(", ")}`);
  }

  lines.push(``, `EVIDENCE (strong/usable items, ${pairedItems.length} shown):`);
  for (const { item, triage } of pairedItems.slice(0, 15)) {
    lines.push(
      `  [${item.evidence_id}] (${triage.source_type}/${triage.evidence_strength}) ${(item.fact || "").slice(0, 150)}`
    );
    if (triage.limitations?.length) lines.push(`    lims: ${triage.limitations.join(", ")}`);
  }

  lines.push(
    ``,
    `ALLOWED viewpoint_ids: ${allowedVpIds.join(", ") || "(none)"}`,
    `ALLOWED observation_ids: ${allowedObsIds.join(", ") || "(none)"}`,
    `ALLOWED evidence_ids: ${allowedEvIds.join(", ") || "(none)"}`,
    ``,
    `Generate 0–10 claims. Only cite allowed IDs. Set evidence_sufficiency=insufficient for ` +
    `trend_claims without temporal breadth, adoption claims without observed use, or hype-driven claims.`,
  );
  return lines.join("\n");
}

// ── Deterministic blocking limitation check (Part 5) ──────────────────────────

function checkBlockingLimitations(claim, triageResults) {
  const supportingIds = new Set(claim.supporting_evidence_ids || []);
  const allLimitations = new Set(
    (triageResults || [])
      .filter((t) => supportingIds.has(t.evidence_id))
      .flatMap((t) => t.limitations || [])
  );

  const claimCtx = {
    claim_type:             claim.claim_type,
    analytical_change:      claim.analytical_change,
    asserts_operational:    claim.analytical_change === "adoption_moved_forward" ||
                            ["incident", "exploit_disclosure", "threat_intelligence"]
                              .some((st) => (claim.claim_text || "").toLowerCase().includes(st.replace(/_/g, " "))),
    asserts_adoption:       claim.analytical_change === "adoption_moved_forward" ||
                            (claim.claim_type === "trend_claim" && /adoption/i.test(claim.claim_text)),
    asserts_actor_specific: /\b(APT|Lazarus|Sandworm|actor|threat group|campaign)\b/i.test(claim.claim_text),
    asserts_ai_significance: true,
    independent_corroboration: !allLimitations.has("single_source"),
    conflict_resolved:      !allLimitations.has("conflicting_evidence"),
    broad_relevance_basis:  claim.broad_relevance_basis || [],
    priority_target:        "critical",
  };

  for (const lim of allLimitations) {
    const effect = LIMITATION_EFFECTS[lim];
    if (effect && effect(claimCtx)) return true;
  }
  return false;
}

// ── Deterministic support-flag derivation (Part 5 hardening) ──────────────────
// Three critical gates used to be bare LLM booleans (strong_viewpoint_support,
// strong_evidence_support, slide_driving_power). They are now derived from the
// triage strength and viewpoint strength that already exist in the data, so the
// LLM cannot escalate a claim to critical on opinion alone.

/**
 * Derive the three support flags deterministically.
 * @param {object} claim                 - Validated claim with supporting_*_ids
 * @param {object} viewpointStrengthById - { viewpoint_id: "strong"|"moderate"|"weak" }
 * @param {object} triageById            - { evidence_id: triage_data }
 * @returns {{ strong_evidence_support, strong_viewpoint_support, slide_driving_power }}
 */
export function deriveClaimSupportFlags(claim, viewpointStrengthById = {}, triageById = {}) {
  const evIds = claim.supporting_evidence_ids || [];
  const vpIds = claim.supporting_viewpoint_ids || [];

  const strong_evidence_support  = evIds.some((id) => triageById[id]?.evidence_strength === "strong");
  const strong_viewpoint_support = vpIds.some((id) => viewpointStrengthById[id] === "strong");
  // Concrete replacement for the old free-form "slide_driving_power" opinion:
  // a claim can anchor an executive takeaway only if it rests on strong evidence
  // AND represents a real (non-"no_clear_change") analytical change.
  const slide_driving_power =
    strong_evidence_support && CRITICAL_ANALYTICAL_CHANGE.has(claim.analytical_change);

  return { strong_evidence_support, strong_viewpoint_support, slide_driving_power };
}

/**
 * Deterministically verify trend-claim recurrence rules.
 * A trend_claim is only valid with:
 *   - ≥3 non-duplicate, non-archive supporting evidence items
 *   - ≥2 distinct publishers / source origins
 *   - ≥2 distinct time windows (month buckets) — only enforced when ≥2 items are dated,
 *     so undated-but-otherwise-valid corpora are not falsely rejected.
 *
 * @param {object} claim       - Claim with supporting_evidence_ids
 * @param {object} itemsById   - { evidence_id: evidence_item (publisher, date_published) }
 * @param {object} triageById  - { evidence_id: triage_data }
 * @returns {boolean} true if recurrence rules pass
 */
export function checkTrendRecurrence(claim, itemsById = {}, triageById = {}) {
  const ids = claim.supporting_evidence_ids || [];

  // Non-duplicate, non-archive items
  const usable = ids.filter((id) => {
    const t = triageById[id];
    if (!t) return false;
    if (t.evidence_strength === "archive") return false;
    if ((t.limitations || []).includes("duplicate_reporting")) return false;
    return true;
  });
  if (usable.length < 3) return false;

  // ≥2 distinct publishers (fall back to source_id, then id, as an origin key)
  const publishers = new Set();
  for (const id of usable) {
    const it = itemsById[id];
    publishers.add(it?.publisher || it?.source_id || id);
  }
  if (publishers.size < 2) return false;

  // ≥2 distinct month windows — only enforced when enough items carry dates
  const buckets = new Set();
  let dated = 0;
  for (const id of usable) {
    const d = itemsById[id]?.date_published || itemsById[id]?.published_date;
    if (d) { dated++; buckets.add(String(d).slice(0, 7)); }  // YYYY-MM
  }
  if (dated >= 2 && buckets.size < 2) return false;  // same-window burst

  return true;
}

// ── Deterministic priority assignment (Part 5) ─────────────────────────────────

/**
 * Assign final claim_priority from deterministic gates.
 * The LLM populates structured fields; this function decides priority.
 */
export function assignClaimPriority(claim, triageResults = []) {
  const {
    evidence_sufficiency, analytical_change, change_driver,
    broad_relevance, broad_relevance_basis, multi_scope_impact, multi_scope_basis,
    strong_viewpoint_support, strong_evidence_support, slide_driving_power,
    claim_type,
  } = claim;

  if (!evidence_sufficiency || !VALID_EVIDENCE_SUFFICIENCY.has(evidence_sufficiency)) return "rejected";
  if (evidence_sufficiency === "insufficient") return "rejected";
  if (!analytical_change || !VALID_ANALYTICAL_CHANGE.has(analytical_change)) return "rejected";
  if (!change_driver || !VALID_CHANGE_DRIVER.has(change_driver)) return "rejected";

  // Trend claims must have sufficient evidence (LLM enforces via sufficiency, we double-check)
  if (claim_type === "trend_claim" && evidence_sufficiency !== "sufficient") return "rejected";

  // Adoption claims require at least one supporting evidence item with adoption_support permission.
  // adoption_support is only granted when observed_use=true in triage — this is the deterministic guard
  // ensuring no adoption claim passes without real observed adversary use.
  if (analytical_change === "adoption_moved_forward") {
    const supportingIds = new Set(claim.supporting_evidence_ids || []);
    const hasAdoptionSupport = (triageResults || []).some(
      (t) => supportingIds.has(t.evidence_id) && (t.permitted_uses || []).includes("adoption_support")
    );
    if (!hasAdoptionSupport) return "rejected";
  }

  // Check actual blocking limitations from triage
  const hasBlockingLim = checkBlockingLimitations(claim, triageResults);
  if (hasBlockingLim) {
    return evidence_sufficiency === "sufficient" ? "medium" : "rejected";
  }

  // Validated basis arrays
  const validBasis  = (broad_relevance_basis || []).filter((b) => VALID_BROAD_RELEVANCE_BASES.has(b));
  const validScope  = (multi_scope_basis     || []).filter((b) => VALID_MULTI_SCOPE_DIMENSIONS.has(b));

  // Critical: ALL gates must pass
  const criticalGates = [
    evidence_sufficiency === "sufficient",
    CRITICAL_ANALYTICAL_CHANGE.has(analytical_change),
    CRITICAL_CHANGE_DRIVER.has(change_driver),
    broad_relevance === true && validBasis.length > 0,
    multi_scope_impact === true && validScope.length >= 2,
    strong_viewpoint_support === true,
    strong_evidence_support === true,
    !hasBlockingLim,
    slide_driving_power === true,
  ];

  if (criticalGates.every(Boolean)) return "critical";

  // High: sufficient + non-trivial change + valid driver + no blocking limitations
  if (
    evidence_sufficiency === "sufficient" &&
    CRITICAL_ANALYTICAL_CHANGE.has(analytical_change) &&
    CRITICAL_CHANGE_DRIVER.has(change_driver) &&
    !hasBlockingLim
  ) {
    return "high";
  }

  // Medium: valid and evidence-supported but narrower/caveated
  if (["sufficient", "partial"].includes(evidence_sufficiency)) return "medium";

  return "rejected";
}

// ── Structural validation ───────────────────────────────────────────────────────

function validateRawClaim(claim, allowedVpIds, allowedObsIds, allowedEvIds) {
  const vpSet  = new Set(allowedVpIds);
  const obsSet = new Set(allowedObsIds);
  const evSet  = new Set(allowedEvIds);

  if (!claim.claim_id || !claim.claim_text) return null;
  if (!VALID_CLAIM_TYPES.has(claim.claim_type)) return null;
  if (!VALID_ANALYTICAL_CHANGE.has(claim.analytical_change)) return null;
  if (!VALID_CHANGE_DRIVER.has(claim.change_driver)) return null;
  if (!VALID_EVIDENCE_SUFFICIENCY.has(claim.evidence_sufficiency)) return null;
  if (!VALID_SIGNAL_TEMPORALITY.has(claim.signal_temporality)) return null;

  const vpIds  = (claim.supporting_viewpoint_ids  || []).filter((id) => vpSet.has(id));
  const obsIds = (claim.supporting_observation_ids || []).filter((id) => obsSet.has(id));
  const evIds  = (claim.supporting_evidence_ids    || []).filter((id) => evSet.has(id));

  // Must cite at least one viewpoint or observation
  if (vpIds.length === 0 && obsIds.length === 0) return null;

  const validBasis = (claim.broad_relevance_basis || []).filter((b) => VALID_BROAD_RELEVANCE_BASES.has(b));
  const validScope = (claim.multi_scope_basis     || []).filter((b) => VALID_MULTI_SCOPE_DIMENSIONS.has(b));

  return {
    ...claim,
    supporting_viewpoint_ids:   vpIds,
    supporting_observation_ids: obsIds,
    supporting_evidence_ids:    evIds,
    broad_relevance_basis:      validBasis,
    multi_scope_basis:          validScope,
    // Coerce booleans — LLM output may be strings
    broad_relevance:           claim.broad_relevance === true && validBasis.length > 0,
    multi_scope_impact:        claim.multi_scope_impact === true && validScope.length >= 2,
    strong_viewpoint_support:  claim.strong_viewpoint_support === true,
    strong_evidence_support:   claim.strong_evidence_support === true,
    blocking_limitations:      claim.blocking_limitations === true,
    slide_driving_power:       claim.slide_driving_power === true,
  };
}

// ── Part 6: Conflict / hype / redundancy controls ─────────────────────────────

const HYPE_PATTERNS = [
  /\b(unprecedented|revolutionary|game[- ]changing|major breakthrough)\b/i,
  /\b(surge|explosion|skyrocket|suddenly|rapidly spreading)\b/i,
];

function suppressHypeClaims(claims) {
  return claims.map((c) => {
    if (c.claim_priority === "rejected") return c;
    if (HYPE_PATTERNS.some((re) => re.test(c.claim_text)) &&
        c.analytical_change === "no_clear_change") {
      return { ...c, claim_priority: "rejected", hype_suppressed: true };
    }
    return c;
  });
}

function mergeRedundantClaims(claims) {
  // Group by analytical_change + claim_type; keep highest-priority as primary
  const groups = {};
  for (const c of claims) {
    const key = `${c.analytical_change}:${c.claim_type}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  const PRIO_ORDER = { critical: 0, high: 1, medium: 2, rejected: 3 };
  const merged = [];
  for (const group of Object.values(groups)) {
    if (group.length === 1) { merged.push(group[0]); continue; }
    group.sort((a, b) => (PRIO_ORDER[a.claim_priority] ?? 3) - (PRIO_ORDER[b.claim_priority] ?? 3));
    const primary = group[0];
    merged.push({
      ...primary,
      secondary_claim_ids: group.slice(1).map((s) => s.claim_id),
    });
  }
  return merged;
}

// ── Deterministic fallback ─────────────────────────────────────────────────────

function deterministicClaims(viewpoints, observations) {
  const best = (viewpoints || []).find((v) => v.strength === "strong") ||
               (viewpoints || [])[0];
  if (!best) return [];

  return [{
    claim_id:                   "cl_1",
    claim_text:                 best.viewpoint_text.slice(0, 120),
    claim_type:                 "category_insight",
    analytical_change:          best.analytical_change || "no_clear_change",
    change_driver:              best.change_driver || "not_applicable",
    signal_temporality:         "isolated",
    supporting_viewpoint_ids:   [best.viewpoint_id],
    supporting_observation_ids: best.supporting_observation_ids || [],
    supporting_evidence_ids:    best.supporting_evidence_ids || [],
    evidence_sufficiency:       "partial",
    broad_relevance:            false,
    broad_relevance_basis:      [],
    multi_scope_impact:         false,
    multi_scope_basis:          [],
    strong_viewpoint_support:   best.strength === "strong",
    strong_evidence_support:    false,
    blocking_limitations:       false,
    slide_driving_power:        false,
    caveat_if_any:              "Deterministic fallback — LLM unavailable.",
    reasoning:                  "Deterministic fallback from best viewpoint.",
    claim_priority:             "medium",
  }];
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Generate claims from viewpoints + assign deterministic priority.
 *
 * @param {object[]} viewpoints    - From viewpointLayer
 * @param {object[]} observations  - From observationLayer
 * @param {object[]} items         - Evidence items
 * @param {object[]} triageResults - Triage results matched by evidence_id
 * @param {string}   category
 * @param {object}   [opts]
 * @returns {Promise<{ claims: object[], llm_used: boolean, model_used: string }>}
 */
export async function generateClaims(viewpoints, observations, items, triageResults, category, opts = {}) {
  const { skipLlm = false } = opts;

  if ((viewpoints || []).length === 0) {
    return { claims: [], llm_used: false, model_used: "none" };
  }

  const triageById = Object.fromEntries(
    (triageResults || []).map((t) => [t.evidence_id, t])
  );
  const pairedItems = (items || [])
    .map((item) => ({ item, triage: triageById[item.evidence_id] }))
    .filter(({ triage }) => triage &&
      (triage.evidence_strength === "strong" || triage.evidence_strength === "usable")
    );

  const allowedVpIds  = viewpoints.map((v) => v.viewpoint_id).filter(Boolean);
  const allowedObsIds = (observations || []).map((o) => o.observation_id).filter(Boolean);
  const allowedEvIds  = pairedItems.map(({ item }) => item.evidence_id).filter(Boolean);

  let rawClaims  = [];
  let llm_used   = false;
  let model_used = "deterministic";

  if (!skipLlm) {
    try {
      const { result, llm_metadata } = await routedLLM(
        CLAIM_SYSTEM,
        buildClaimPrompt(
          category, viewpoints, observations, pairedItems,
          allowedVpIds, allowedObsIds, allowedEvIds,
        ),
        {
          task: "evidence_triage_claims",
          requires_json: true,
          schema: CLAIM_SCHEMA,
          logLabel: `claims-${category}`,
        }
      );
      rawClaims  = result?.claims || [];
      llm_used   = true;
      model_used = llm_metadata?.model_used || "unknown";
    } catch (err) {
      process.stdout.write(
        `  [claim-layer] LLM failed for ${category}: ${err.message} — using deterministic fallback\n`
      );
    }
  }

  // Structural validation
  const validated = rawClaims
    .map((c) => validateRawClaim(c, allowedVpIds, allowedObsIds, allowedEvIds))
    .filter(Boolean);

  // Lookup maps for deterministic flag derivation + trend recurrence
  // (triageById is already built above for pairedItems)
  const itemsById         = Object.fromEntries((items || []).map((i) => [i.evidence_id, i]));
  const vpStrengthById    = Object.fromEntries((viewpoints || []).map((v) => [v.viewpoint_id, v.strength]));

  // Deterministic priority assignment — LLM must NOT decide this.
  // Before assigning, override the three support gates with deterministic values
  // (derived from triage/viewpoint strength) and enforce trend recurrence rules.
  const withPriority = validated.length
    ? validated.map((c) => {
        const flags = deriveClaimSupportFlags(c, vpStrengthById, triageById);
        let evidence_sufficiency = c.evidence_sufficiency;
        // Trend claims that fail the recurrence rules are downgraded to insufficient,
        // which assignClaimPriority maps to "rejected".
        if (c.claim_type === "trend_claim" && !checkTrendRecurrence(c, itemsById, triageById)) {
          evidence_sufficiency = "insufficient";
        }
        const c2 = { ...c, ...flags, evidence_sufficiency };
        return { ...c2, claim_priority: assignClaimPriority(c2, triageResults) };
      })
    : deterministicClaims(viewpoints, observations);

  // Part 6 controls
  const deHyped = suppressHypeClaims(withPriority);
  const deduped = mergeRedundantClaims(deHyped);

  return { claims: deduped, llm_used, model_used };
}
