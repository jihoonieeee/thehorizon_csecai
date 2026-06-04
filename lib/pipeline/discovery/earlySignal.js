/**
 * Web Discovery — Early-Signal Decision Tree (Layer 1C)
 *
 * early_signal_value is NOT a weighted numeric formula. It is the output of an
 * explicit decision tree over categorical evidence-maturity states. The whole
 * point is auditability: every value can be traced to a named rule.
 *
 * The four levels (see docs/reasoning-early-signal-value.md):
 *   none     — buzzword / generic / restated-old / prediction-only / marketing /
 *              defensive-only with no threat behaviour / fresh page about an old
 *              event that adds no new evidence.
 *   weak     — a plausible NEW capability exists (research-proposed or
 *              demonstrated-possible) but no operational use is shown.
 *   moderate — no longer theoretical: reproducible PoC, benchmark/empirical
 *              result, public tooling, OR multiple independent sources / early
 *              adversary experimentation.
 *   strong   — confirmed actor use, observed incident, active exploitation,
 *              campaign, or a primary/high-trust operational-adoption report.
 *
 * INVARIANT: a non-"none" early_signal_value ALWAYS carries an early_signal_type.
 * If the caller did not supply a type, we derive a default from the mission so
 * the invariant can never be violated.
 *
 * INVARIANT: moderate / strong signals ALWAYS set needs_early_signal_qa=true and
 * early_signal_qa_status="pending" — they must be confirmed by a frontier-model
 * QA pass before they are treated as load-bearing.
 */

import {
  VALID_EARLY_SIGNAL_TYPE, defaultSignalType,
} from "../../config/webDiscoveryVocab.js";

const STRONG_STAGES = new Set(["actor_observed", "confirmed_operational_use"]);
const MODERATE_STAGES = new Set(["reproducible_poc", "tool_available"]);
const WEAK_STAGES = new Set(["conceptual", "lab_validated"]);

/**
 * Compute early_signal_value from categorical inputs.
 *
 * @param {object} input
 * @param {string} input.operationalization_stage
 * @param {string} input.corroboration_status
 * @param {string} input.source_quality           low|medium|high|primary
 * @param {string} input.novelty_assessment
 * @param {string} input.ai_threat_specificity    none|weak|moderate|strong
 * @param {string} [input.freshness_interpretation]
 * @param {string} [input.discovery_mission]       used to derive a default type
 * @param {string} [input.early_signal_type]       LLM-provided type (optional)
 * @param {boolean}[input.adds_new_evidence=true]  for fresh-page/old-event cases
 * @param {boolean}[input.is_marketing=false]
 * @param {boolean}[input.is_defensive_only=false]
 * @param {boolean}[input.is_prediction_only=false]
 * @param {boolean}[input.restated_old_as_new=false]
 * @returns {{ early_signal_value, early_signal_type, early_signal_reason,
 *             needs_early_signal_qa, early_signal_qa_status }}
 */
export function computeEarlySignal(input = {}) {
  const {
    operationalization_stage = "unknown",
    corroboration_status     = "none",
    source_quality           = "low",
    novelty_assessment       = "unknown",
    ai_threat_specificity    = "none",
    freshness_interpretation = "unknown",
    discovery_mission        = null,
    early_signal_type        = null,
    adds_new_evidence        = true,
    is_marketing             = false,
    is_defensive_only        = false,
    is_prediction_only       = false,
    restated_old_as_new      = false,
  } = input;

  const none = (reason) => finalize("none", null, reason, discovery_mission, early_signal_type);

  // ── Level: none ────────────────────────────────────────────────────────────
  if (ai_threat_specificity === "none")
    return none("buzzword-only / no concrete AI-threat anchor");
  if (is_marketing)
    return none("marketing-only content");
  if (is_prediction_only)
    return none("prediction without concrete evidence");
  if (restated_old_as_new)
    return none("old attack restated as new");
  if (is_defensive_only)
    return none("defensive-only content with no threat behaviour");
  if (!adds_new_evidence &&
      (freshness_interpretation === "fresh_publication_old_event" ||
       freshness_interpretation === "updated_old_report" ||
       freshness_interpretation === "historical_context")) {
    return none("fresh page about an old event that adds no new evidence");
  }

  // ── Level: strong ────────────────────────────────────────────────────────────
  if (STRONG_STAGES.has(operationalization_stage)) {
    return finalize("strong", early_signal_type,
      `operationalization_stage=${operationalization_stage} (confirmed actor use / incident / exploitation)`,
      discovery_mission, early_signal_type);
  }
  if (corroboration_status === "primary_source" && (source_quality === "primary" || source_quality === "high")) {
    return finalize("strong", early_signal_type,
      "primary-source corroboration from a primary/high-trust source (operational adoption)",
      discovery_mission, early_signal_type);
  }

  // ── Level: moderate ──────────────────────────────────────────────────────────
  if (MODERATE_STAGES.has(operationalization_stage)) {
    return finalize("moderate", early_signal_type,
      `operationalization_stage=${operationalization_stage} (reproducible PoC / public tooling)`,
      discovery_mission, early_signal_type);
  }
  if (corroboration_status === "independent_sources") {
    return finalize("moderate", early_signal_type,
      "multiple independent sources describe the same technique",
      discovery_mission, early_signal_type);
  }

  // ── Level: weak ──────────────────────────────────────────────────────────────
  if (WEAK_STAGES.has(operationalization_stage)) {
    return finalize("weak", early_signal_type,
      `operationalization_stage=${operationalization_stage} (new capability proposed/demonstrated; no operational use shown)`,
      discovery_mission, early_signal_type);
  }

  // A credible new-ish technique with at least moderate specificity but unknown
  // stage is still a weak signal rather than nothing.
  if ((novelty_assessment === "emerging" || novelty_assessment === "genuinely_new") &&
      (ai_threat_specificity === "moderate" || ai_threat_specificity === "strong")) {
    return finalize("weak", early_signal_type,
      `novelty=${novelty_assessment} with concrete specificity but unconfirmed operational stage`,
      discovery_mission, early_signal_type);
  }

  return none("insufficient evidence maturity for an early-signal claim");
}

/**
 * Enforce the invariants and attach the QA flag.
 */
function finalize(value, type, reason, mission, providedType) {
  if (value === "none") {
    return {
      early_signal_value: "none",
      early_signal_type: "none",
      early_signal_reason: reason,
      needs_early_signal_qa: false,
      early_signal_qa_status: "not_required",
    };
  }

  // INVARIANT: non-none value must carry a valid type. Prefer the provided type,
  // else derive a sensible default from the mission.
  let resolvedType = (type && VALID_EARLY_SIGNAL_TYPE.has(type) && type !== "none")
    ? type
    : (providedType && VALID_EARLY_SIGNAL_TYPE.has(providedType) && providedType !== "none")
      ? providedType
      : defaultSignalType(mission);

  const needsQa = value === "moderate" || value === "strong";

  return {
    early_signal_value: value,
    early_signal_type: resolvedType,
    early_signal_reason: reason,
    needs_early_signal_qa: needsQa,
    early_signal_qa_status: needsQa ? "pending" : "not_required",
  };
}

/**
 * Apply a frontier-model QA verdict to a moderate/strong early signal.
 * QA can confirm, downgrade, or reject the signal. Deterministic application of
 * the verdict so the audit trail is explicit.
 *
 * @param {object} signal  output of computeEarlySignal
 * @param {object} verdict { decision: "confirm"|"downgrade"|"reject", note }
 */
export function applyEarlySignalQa(signal, verdict) {
  if (!signal?.needs_early_signal_qa) return signal;
  const decision = verdict?.decision;
  if (decision === "confirm") {
    return { ...signal, early_signal_qa_status: "confirmed", early_signal_qa_note: verdict.note || null };
  }
  if (decision === "downgrade") {
    // strong → moderate → weak
    const downgraded = signal.early_signal_value === "strong" ? "moderate" : "weak";
    const stillNeedsQa = downgraded === "moderate";
    return {
      ...signal,
      early_signal_value: downgraded,
      early_signal_qa_status: "downgraded",
      needs_early_signal_qa: stillNeedsQa,
      early_signal_qa_note: verdict.note || null,
    };
  }
  if (decision === "reject") {
    return {
      ...signal,
      early_signal_value: "none",
      early_signal_type: "none",
      early_signal_qa_status: "rejected",
      needs_early_signal_qa: false,
      early_signal_qa_note: verdict.note || null,
    };
  }
  return signal;
}
