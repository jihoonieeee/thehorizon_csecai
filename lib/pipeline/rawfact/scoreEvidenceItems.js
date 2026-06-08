/**
 * Layer 5a.5/5a.5b — Evidence Triage (categorical; NO numeric scoring, NO priority labels)
 *
 * Each evidence item is triaged into ONE categorical strength:
 *   triage_data.evidence_strength ∈ { strong | usable | context | archive }
 * plus triage_data.permitted_uses[] and triage_data.limitations[].
 * This is the SINGLE importance output of Layer 5A for an evidence item.
 *
 * ── WHAT THIS LAYER DOES NOT DO ───────────────────────────────────────────────
 *   - No 0–100 score. No `evidence_score`.
 *   - No claim-priority labels on evidence. Evidence items are NEVER
 *     critical / high / medium. Only CLAIMS (runClaimChain) get claim_priority.
 *   - No executive importance / slide-worthiness. Analysis (Layer 6) decides that.
 *
 * ── DUPLICATE PENALTY ─────────────────────────────────────────────────────────
 *   Second pass (after clustering): a non-representative member of a multi-source
 *   cluster is downgraded ONE level, but never below `usable` — it still carries
 *   useful corroboration metadata (the `duplicate_reporting` limitation handles
 *   independent-corroboration counting downstream).
 */

import { triageEvidenceItem } from "../evidenceTriage/evidenceTriage.js";
import { strengthRank } from "../evidenceTriage/evidenceTriageVocab.js";

// ── Evidence role (semantic role hint for dossier grouping; not importance) ────

const EVIDENCE_TYPE_TO_ROLE = {
  incident_event:            "real_world_incident",
  vulnerability_fact:        "vulnerability_exposure",
  exploit_chain:             "exploitability_signal",
  attack_method:             "attacker_capability",
  threat_actor_activity:     "attacker_capability",
  adversary_adoption:        "adversary_adoption",
  capability_delta:          "attacker_capability",
  benchmark_result:          "quantitative_anchor",
  research_result:           "attacker_capability",
  defensive_control:         "mitigation_or_defensive_priority",
  mitigation:                "mitigation_or_defensive_priority",
  governance_action:         "governance_context",
  ecosystem_shift:           "ecosystem_context",
  infrastructure_dependency: "infrastructure_dependency",
  trust_boundary_shift:      "trust_boundary_change",
  societal_harm:             "societal_harm_case",
  strategic_signal:          "strategic_shift",
  statistic:                 "quantitative_anchor",
  timeline_event:            "background_context",
};
const SOURCE_TYPE_DEFAULT_ROLE = {
  incident:              "operational_impact",
  governance_signal:     "governance_context",
  attack_surface_signal: "ecosystem_context",
  societal_harm_signal:  "societal_harm_case",
};
function classifyEvidenceRole(item, source) {
  return EVIDENCE_TYPE_TO_ROLE[item.evidence_type] ||
         SOURCE_TYPE_DEFAULT_ROLE[source.source_type] ||
         "background_context";
}

// ── Duplicate penalty (never drops a corroborating item below `usable`) ───────

const STRENGTH_DOWNGRADE = { strong: "usable", usable: "usable", context: "context", archive: "archive" };

function applyDuplicatePenalty(triage, item, apply) {
  if (!apply) return triage;
  const cluster = item.evidence_cluster || {};
  if (cluster.is_multi_source && cluster.is_representative === false) {
    const downgraded = STRENGTH_DOWNGRADE[triage.evidence_strength] || triage.evidence_strength;
    return { ...triage, evidence_strength: downgraded };
  }
  return triage;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Triage a single evidence item. Attaches `evidence_role` + `triage_data` only.
 *
 * @param {object}  item
 * @param {object}  source
 * @param {boolean} applyDuplicatePenaltyFlag
 * @returns {object} Item with evidence_role + triage_data
 */
export function scoreEvidenceItem(item, source, applyDuplicatePenaltyFlag = false) {
  // item.triage_judgment carries the per-item LLM semantic judgements from
  // judgeEvidenceItems.js (step 5b). Empty/absent → deterministic inference.
  const rawTriage = triageEvidenceItem(item, source, item.triage_judgment || {});
  const triage    = applyDuplicatePenalty(rawTriage, item, applyDuplicatePenaltyFlag);

  const penaltyApplied =
    applyDuplicatePenaltyFlag &&
    !!(item.evidence_cluster?.is_multi_source && item.evidence_cluster?.is_representative === false);
  if (penaltyApplied && !triage.limitations.includes("duplicate_reporting")) {
    triage.limitations = [...triage.limitations, "duplicate_reporting"];
  }

  return {
    ...item,
    evidence_role: classifyEvidenceRole(item, source),
    triage_data:   triage,
  };
}

/**
 * Triage all evidence items for a single source and attach a strength SUMMARY
 * (counts + strongest strength) — used only for status/reporting, never as a score.
 */
export function scoreSourceEvidenceItems(source, applyDuplicatePenaltyFlag = false) {
  const items = source.evidence_items || [];
  if (items.length === 0) return source;

  const triagedItems = items.map((item) => scoreEvidenceItem(item, source, applyDuplicatePenaltyFlag));

  const strengthOf = (i) => i.triage_data?.evidence_strength || "archive";
  const strongest = triagedItems.reduce(
    (best, i) => (strengthRank(strengthOf(i)) > strengthRank(best) ? strengthOf(i) : best),
    "archive",
  );

  const rawfact_evidence_summary = {
    strongest_strength:  strongest,
    evidence_item_count: triagedItems.length,
    strong_count:  triagedItems.filter((i) => strengthOf(i) === "strong").length,
    usable_count:  triagedItems.filter((i) => strengthOf(i) === "usable").length,
    context_count: triagedItems.filter((i) => strengthOf(i) === "context").length,
    archive_count: triagedItems.filter((i) => strengthOf(i) === "archive").length,
  };

  return {
    ...source,
    evidence_items: triagedItems,
    rawfact_evidence_summary,
  };
}

/**
 * Triage all evidence items across all sources (initial pass — no duplicate penalty).
 */
export function scoreAllEvidenceItems(sources) {
  return sources.map((s) => scoreSourceEvidenceItems(s, false));
}

/**
 * Re-triage after clustering, applying the duplicate downgrade to non-representatives.
 */
export function rescoreWithDuplicatePenalty(sources) {
  return sources.map((s) => scoreSourceEvidenceItems(s, true));
}
