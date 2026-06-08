/**
 * Evidence Triage — Viewpoint Layer (Part 3)
 *
 * Generates viewpoints from observations. Viewpoints explain WHY observations matter —
 * what analytical change they represent and what drives that change.
 *
 * The LLM assigns viewpoint_type, analytical_change, change_driver, strength, and reasoning.
 * Deterministic validation enforces vocabulary constraints and structural requirements.
 *
 * Output: { viewpoints[], llm_used, model_used }
 */

import { routedLLM } from "../../llm/llmRouter.js";
import {
  VALID_VIEWPOINT_TYPES, VALID_ANALYTICAL_CHANGE, VALID_CHANGE_DRIVER,
  VALID_VIEWPOINT_STRENGTH, VALID_LIMITATIONS,
} from "./evidenceTriageVocab.js";

export const VIEWPOINT_LAYER_VERSION = "vp-v1.0";

const VIEWPOINT_SCHEMA = {
  type: "object",
  required: ["viewpoints"],
  properties: {
    viewpoints: {
      type: "array", maxItems: 6,
      items: {
        type: "object",
        required: [
          "viewpoint_id", "viewpoint_text", "viewpoint_type", "analytical_change",
          "change_driver", "supporting_observation_ids", "supporting_evidence_ids",
          "strength", "reasoning",
        ],
        properties: {
          viewpoint_id:               { type: "string" },
          viewpoint_text:             { type: "string" },
          viewpoint_type:             { type: "string" },
          analytical_change:          { type: "string" },
          change_driver:              { type: "string" },
          supporting_observation_ids: { type: "array", items: { type: "string" } },
          supporting_evidence_ids:    { type: "array", items: { type: "string" } },
          caveat_if_any:              { type: ["string", "null"] },
          strength:                   { type: "string" },
          reasoning:                  { type: "string" },
        },
      },
    },
  },
};

const VIEWPOINT_SYSTEM = `You are a senior AI cybersecurity analyst generating VIEWPOINTS from observations.

A viewpoint explains WHY one or more observations matter analytically — what change is happening and what drives it.

VIEWPOINT RULES:
- Connect at least one observation to an analytical change.
- analytical_change must be one of: capability_increased, exposure_expanded, adoption_moved_forward, defensive_assumption_failed, trust_boundary_shifted, dependency_risk_increased, governance_pressure_intensified, no_clear_change.
- change_driver must be one of: newly_emerged, materially_expanded, operationalized, scaled, becoming_systemic, defensive_failure, governance_acceleration, persistent_unresolved, not_applicable.
- strength = "strong" if: connects ≥2 observations OR one exceptional observation, analytical_change is not no_clear_change, change_driver is not not_applicable, does not exceed source-type permissions.
- strength = "moderate" if: supported but narrower or more caveated.
- strength = "weak" if: summarizes evidence only, no clear analytical change, relies on speculation.
- caveat_if_any: required when limitations exist in the supporting observations.

CRITICAL SOURCE-TYPE PERMISSION RULES — Do NOT violate:
- research_finding cannot prove real-world use or adversary adoption.
- governance_signal cannot prove attacker activity or operational trends.
- benchmark_evaluation cannot prove operational use or adversary adoption.
- Lab-only evidence (lab_only limitation) cannot support operational-use claims.
- context_only evidence cannot support operational claims.

VIEWPOINT TYPES:
  operational_pattern, capability_shift, exposure_shift, adoption_movement,
  defensive_gap, infrastructure_risk, trust_boundary_risk, governance_pressure, outlook_signal

ID FORMAT: vp_<n> (vp_1, vp_2, ...)

Return strict JSON only.`;

function buildViewpointPrompt(category, observations, pairedItems, allowedObsIds, allowedEvidenceIds) {
  const catLabel = category.replace(/_/g, " ").toUpperCase();
  const lines = [
    `CATEGORY: ${catLabel}`,
    ``,
    `OBSERVATIONS (${observations.length}):`,
  ];

  for (const obs of observations) {
    lines.push(
      `[${obs.observation_id}] ${obs.observation_type} / ${obs.observation_scope} / ${obs.signal_temporality}`,
      `  ${obs.observation_text}`,
      `  supports: [${obs.supporting_evidence_ids.join(", ")}]`,
    );
    if (obs.limitations?.length) lines.push(`  limitations: ${obs.limitations.join(", ")}`);
  }

  lines.push(``, `EVIDENCE CONTEXT (strong/usable items):`);
  for (const { item, triage } of pairedItems.slice(0, 12)) {
    if (item.fact) {
      lines.push(`  [${item.evidence_id}] (${triage.source_type}/${triage.evidence_strength}) ${item.fact.slice(0, 150)}`);
    }
  }

  lines.push(
    ``,
    `ALLOWED observation_ids: ${allowedObsIds.join(", ") || "(none)"}`,
    `ALLOWED evidence_ids: ${allowedEvidenceIds.join(", ") || "(none)"}`,
    ``,
    `Generate 0–6 viewpoints. Each must connect at least one allowed observation. ` +
    `Do not exceed source-type permissions.`,
  );
  return lines.join("\n");
}

// ── Deterministic validation ───────────────────────────────────────────────────

function validateViewpoints(raw, allowedObsIds, allowedEvidenceIds) {
  const obsSet = new Set(allowedObsIds);
  const evSet  = new Set(allowedEvidenceIds);
  const valid  = [];

  for (const vp of (raw || [])) {
    if (!vp.viewpoint_id || !vp.viewpoint_text) continue;
    if (!VALID_VIEWPOINT_TYPES.has(vp.viewpoint_type)) continue;
    if (!VALID_ANALYTICAL_CHANGE.has(vp.analytical_change)) continue;
    if (!VALID_CHANGE_DRIVER.has(vp.change_driver)) continue;
    if (!VALID_VIEWPOINT_STRENGTH.has(vp.strength)) continue;
    const obsIds = (vp.supporting_observation_ids || []).filter((id) => obsSet.has(id));
    if (obsIds.length === 0) continue;
    const evIds  = (vp.supporting_evidence_ids || []).filter((id) => evSet.has(id));
    valid.push({ ...vp, supporting_observation_ids: obsIds, supporting_evidence_ids: evIds });
  }
  return valid;
}

function deterministicViewpoints(observations) {
  if (observations.length === 0) return [];
  const obs = observations[0];
  return [{
    viewpoint_id:               "vp_1",
    viewpoint_text:             `Evidence patterns in this category point to ongoing activity that warrants monitoring.`,
    viewpoint_type:             "operational_pattern",
    analytical_change:          "no_clear_change",
    change_driver:              "not_applicable",
    supporting_observation_ids: [obs.observation_id],
    supporting_evidence_ids:    obs.supporting_evidence_ids.slice(0, 2),
    caveat_if_any:              "Evidence too sparse for a clear analytical judgment.",
    strength:                   "weak",
    reasoning:                  "Deterministic fallback — insufficient LLM output.",
  }];
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Generate viewpoints from observations and triaged evidence.
 *
 * @param {object[]} observations  - From observationLayer
 * @param {object[]} items         - Evidence items
 * @param {object[]} triageResults - Triage results matched by evidence_id
 * @param {string}   category
 * @param {object}   [opts]
 * @returns {Promise<{ viewpoints: object[], llm_used: boolean, model_used: string }>}
 */
export async function generateViewpoints(observations, items, triageResults, category, opts = {}) {
  const { skipLlm = false } = opts;

  if ((observations || []).length === 0) {
    return { viewpoints: [], llm_used: false, model_used: "none" };
  }

  const triageById = Object.fromEntries(
    (triageResults || []).map((t) => [t.evidence_id, t])
  );
  const pairedItems = (items || [])
    .map((item) => ({ item, triage: triageById[item.evidence_id] }))
    .filter(({ triage }) => triage &&
      (triage.evidence_strength === "strong" || triage.evidence_strength === "usable")
    );

  const allowedObsIds     = observations.map((o) => o.observation_id).filter(Boolean);
  const allowedEvidenceIds = pairedItems.map(({ item }) => item.evidence_id).filter(Boolean);

  if (skipLlm) {
    return {
      viewpoints: deterministicViewpoints(observations),
      llm_used: false,
      model_used: "deterministic",
    };
  }

  try {
    const { result, llm_metadata } = await routedLLM(
      VIEWPOINT_SYSTEM,
      buildViewpointPrompt(category, observations, pairedItems, allowedObsIds, allowedEvidenceIds),
      {
        task: "evidence_triage_viewpoints",
        requires_json: true,
        schema: VIEWPOINT_SCHEMA,
        logLabel: `vp-${category}`,
      }
    );

    const validated = validateViewpoints(result?.viewpoints, allowedObsIds, allowedEvidenceIds);
    return {
      viewpoints: validated.length ? validated : deterministicViewpoints(observations),
      llm_used:   true,
      model_used: llm_metadata?.model_used || "unknown",
    };
  } catch (err) {
    process.stdout.write(
      `  [vp-layer] LLM failed for ${category}: ${err.message} — using deterministic fallback\n`
    );
    return {
      viewpoints: deterministicViewpoints(observations),
      llm_used: false,
      model_used: "deterministic",
    };
  }
}
