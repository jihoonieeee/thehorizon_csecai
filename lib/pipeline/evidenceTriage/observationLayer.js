/**
 * Evidence Triage — Observation Layer (Part 2)
 *
 * Generates factual observations from triaged evidence items using a bounded LLM call.
 * The LLM classifies and groups evidence; deterministic validation enforces constraints.
 *
 * An observation is a constrained factual pattern derived from converging evidence.
 * The LLM must NOT generate observations from isolated weak evidence, speculation,
 * or unsupported generic claims.
 *
 * Output: { observations[], llm_used, model_used }
 */

import { routedLLM } from "../../llm/llmRouter.js";
import {
  VALID_OBSERVATION_TYPES, VALID_OBSERVATION_SCOPE, VALID_SIGNAL_TEMPORALITY,
  VALID_LIMITATIONS,
} from "./evidenceTriageVocab.js";

export const OBSERVATION_LAYER_VERSION = "obs-v1.0";

// ── LLM schema ────────────────────────────────────────────────────────────────

const OBSERVATION_SCHEMA = {
  type: "object",
  required: ["observations"],
  properties: {
    observations: {
      type: "array", maxItems: 8,
      items: {
        type: "object",
        required: [
          "observation_id", "observation_text", "observation_type",
          "supporting_evidence_ids", "evidence_types", "source_types",
          "limitations", "observation_scope", "signal_temporality",
        ],
        properties: {
          observation_id:          { type: "string" },
          observation_text:        { type: "string" },
          observation_type:        { type: "string" },
          supporting_evidence_ids: { type: "array", items: { type: "string" } },
          evidence_types:          { type: "array", items: { type: "string" } },
          source_types:            { type: "array", items: { type: "string" } },
          limitations:             { type: "array", items: { type: "string" } },
          observation_scope:       { type: "string" },
          signal_temporality:      { type: "string" },
        },
      },
    },
  },
};

const OBSERVATION_SYSTEM = `You are a senior AI cybersecurity analyst generating FACTUAL OBSERVATIONS from evidence.

An observation is a constrained factual pattern derived from converging evidence items.
It is NOT analysis. It is NOT an executive conclusion. It is NOT speculation.

OBSERVATION GENERATION RULES:
- Generate an observation ONLY IF multiple evidence items converge on the same technique, target, actor behavior, capability, or gap — OR one exceptionally strong cluster exists and the observation remains narrow.
- Do NOT generate observations from isolated weak evidence, generic reporting, or unsupported speculation.
- observation_text MUST be factual, non-executive, non-speculative, and close to the evidence.
- Do NOT use "is increasing", "is growing", "is becoming", or "is evolving" unless evidence directly supports it.
- Name the specific technique, target surface, actor behavior, capability result, or gap you observe.

OBSERVATION TYPES (pick the best fit):
  repeated_technique, repeated_target_surface, repeated_affected_layer,
  repeated_actor_behavior, repeated_capability_result, repeated_defensive_gap,
  repeated_governance_pressure, repeated_dependency_exposure,
  repeated_trust_boundary_issue, narrow_exceptional_event

OBSERVATION SCOPE:
  single_event, repeated_pattern, capability_marker, exposure_marker, adoption_marker, context_marker

SIGNAL TEMPORALITY:
  emerging, persistent, recurring, declining, isolated

ID FORMAT: obs_<n> (obs_1, obs_2, ...)

RULES:
- supporting_evidence_ids MUST only include IDs shown in the EVIDENCE section below.
- Every observation MUST cite at least 1 allowed evidence ID.
- evidence_types and source_types describe what was seen across that evidence.
- limitations must only use: single_source, lab_only, no_operational_observation, unclear_reproducibility, unclear_scope, unclear_ai_role, vendor_self_reported, uncertain_attribution, narrow_time_window, duplicate_reporting, weak_source_type_fit, missing_quantitative_detail, conflicting_evidence.

Return strict JSON only.`;

function formatTriagedItem(item, triage) {
  if (!item || !triage) return null;
  const lines = [
    `[${item.evidence_id}] strength=${triage.evidence_strength} type=${item.evidence_type || "?"} source_type=${triage.source_type}`,
  ];
  if (item.fact) lines.push(`  fact: ${item.fact.slice(0, 200)}`);
  if ((item.entities || []).length) lines.push(`  entities: ${item.entities.slice(0, 4).join(", ")}`);
  if ((item.numbers  || []).length) lines.push(`  numbers: ${item.numbers.slice(0, 3).join(" | ")}`);
  if (triage.limitations?.length)   lines.push(`  limitations: ${triage.limitations.join(", ")}`);
  if (triage.permitted_uses?.length) lines.push(`  permitted_uses: ${triage.permitted_uses.join(", ")}`);
  return lines.join("\n");
}

function buildObservationPrompt(category, pairedItems, allowedIds) {
  const catLabel = category.replace(/_/g, " ").toUpperCase();
  const lines = [
    `CATEGORY: ${catLabel}`,
    ``,
    `EVIDENCE (strong and usable items only — ${pairedItems.length} items):`,
  ];

  for (const { item, triage } of pairedItems) {
    const formatted = formatTriagedItem(item, triage);
    if (formatted) lines.push(formatted);
  }

  lines.push(
    ``,
    `ALLOWED evidence_ids: ${allowedIds.join(", ") || "(none)"}`,
    ``,
    `Generate 0–8 factual observations. Each must cite at least one allowed evidence ID. ` +
    `Do not generate observations from isolated weak evidence or speculation.`,
  );
  return lines.join("\n");
}

// ── Deterministic validation ───────────────────────────────────────────────────

function validateObservations(raw, allowedIds) {
  const allowed = new Set(allowedIds);
  const valid = [];
  for (const obs of (raw || [])) {
    if (!obs.observation_id || !obs.observation_text) continue;
    if (!VALID_OBSERVATION_TYPES.has(obs.observation_type)) continue;
    if (!VALID_OBSERVATION_SCOPE.has(obs.observation_scope)) continue;
    if (!VALID_SIGNAL_TEMPORALITY.has(obs.signal_temporality)) continue;
    const ids = (obs.supporting_evidence_ids || []).filter((id) => allowed.has(id));
    if (ids.length === 0) continue;
    const lims = (obs.limitations || []).filter((l) => VALID_LIMITATIONS.has(l));
    valid.push({ ...obs, supporting_evidence_ids: ids, limitations: lims });
  }
  return valid;
}

// ── Deterministic fallback ─────────────────────────────────────────────────────

function deterministicObservations(pairedItems) {
  const byKey = {};
  for (const { item, triage } of pairedItems) {
    if (triage.evidence_strength === "archive") continue;
    const key = `${triage.source_type}:${item.evidence_type || "unknown"}`;
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push({ item, triage });
  }

  const obs = [];
  let n = 1;
  for (const [key, group] of Object.entries(byKey)) {
    if (group.length < 2) continue;
    const [st, et] = key.split(":");
    const ids = group.slice(0, 5).map(({ item: i }) => i.evidence_id).filter(Boolean);
    const lims = [...new Set(group.flatMap(({ triage: t }) => t.limitations || []))].slice(0, 3);
    obs.push({
      observation_id:          `obs_${n++}`,
      observation_text:        `Multiple ${et.replace(/_/g, " ")} evidence items observed from ${st.replace(/_/g, " ")} sources.`,
      observation_type:        "repeated_technique",
      supporting_evidence_ids: ids,
      evidence_types:          [et],
      source_types:            [st],
      limitations:             lims,
      observation_scope:       ids.length >= 3 ? "repeated_pattern" : "capability_marker",
      signal_temporality:      "isolated",
    });
  }
  return obs;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Generate observations from triaged evidence items.
 *
 * @param {object[]} items         - Evidence items (from source.evidence_items)
 * @param {object[]} triageResults - Parallel triage results (matched by evidence_id)
 * @param {string}   category
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @returns {Promise<{ observations: object[], llm_used: boolean, model_used: string }>}
 */
export async function generateObservations(items, triageResults, category, opts = {}) {
  const { skipLlm = false } = opts;

  const triageById = Object.fromEntries(
    (triageResults || []).map((t) => [t.evidence_id, t])
  );
  const pairedItems = (items || [])
    .map((item) => ({ item, triage: triageById[item.evidence_id] }))
    .filter(({ triage }) => triage &&
      (triage.evidence_strength === "strong" || triage.evidence_strength === "usable")
    );

  const allowedIds = pairedItems.map(({ item }) => item.evidence_id).filter(Boolean);

  if (pairedItems.length === 0) {
    return { observations: [], llm_used: false, model_used: "none" };
  }

  if (skipLlm || pairedItems.length < 2) {
    return {
      observations: deterministicObservations(pairedItems),
      llm_used: false,
      model_used: "deterministic",
    };
  }

  try {
    const { result, llm_metadata } = await routedLLM(
      OBSERVATION_SYSTEM,
      buildObservationPrompt(category, pairedItems, allowedIds),
      {
        task: "evidence_triage_observations",
        requires_json: true,
        schema: OBSERVATION_SCHEMA,
        logLabel: `obs-${category}`,
      }
    );

    const validated = validateObservations(result?.observations, allowedIds);
    return {
      observations: validated.length ? validated : deterministicObservations(pairedItems),
      llm_used:     true,
      model_used:   llm_metadata?.model_used || "unknown",
    };
  } catch (err) {
    process.stdout.write(
      `  [obs-layer] LLM failed for ${category}: ${err.message} — using deterministic fallback\n`
    );
    return {
      observations: deterministicObservations(pairedItems),
      llm_used: false,
      model_used: "deterministic",
    };
  }
}
