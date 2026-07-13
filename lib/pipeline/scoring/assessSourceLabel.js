/**
 * assessSourceLabel.js — LLM label validation for non-research sources.
 *
 * WHY: The deterministic labelOf() assigns "critical" to every source typed as
 * "incident" or "threat_intelligence", but source_type is set at Layer 3 from
 * title/abstract heuristics before the full text is read. A vendor blog that
 * MENTIONS an incident isn't the same as a confirmed adversary campaign report.
 * Conversely, an "exploit_disclosure" that documents active in-the-wild use
 * should be "critical" but the deterministic path would call it "important".
 *
 * This module adds one Haiku call per eligible source at Layer 4 to confirm or
 * override the deterministic label based on actual content. The result is stored
 * as `source_label` (top-level column) and `intelligence.source_label_reason`.
 *
 * LABELS (single source of truth — mirrors sourceLabel.js):
 *
 *   critical   — adversaries demonstrably used this technique/tool in real
 *                operations OR this is the FIRST public disclosure of a new
 *                attack class / attack surface. Analysts must read this.
 *
 *   important  — a working exploit or capability was demonstrated (PoC /
 *                vendor test / red-team) but no confirmed real-world use,
 *                OR a notable new technique within a known attack surface.
 *
 *   supporting — corroborating detail: a second/third source on a known
 *                technique, routine vendor advisory, reference material,
 *                or a CVE with no evidence of exploitation.
 *
 *   archive    — background context, defensive content, governance/policy,
 *                or a source that turned out not to be AI-threat-relevant
 *                despite passing the keyword gate.
 *
 * ELIGIBLE SOURCE TYPES (the ones where source_type alone is unreliable):
 *   incident, threat_intelligence, exploit_disclosure,
 *   capability_demonstration, adversary_adoption_signal, attack_surface_signal
 *
 * Research sources (research_finding, benchmark_evaluation) are handled by
 * researchSignificance.js and are NOT re-assessed here.
 */

import { routedLLM } from "../../llm/llmRouter.js";

export const LABEL_ASSESS_VERSION = "label-v1-2026-07-13";

export const SOURCE_LABELS = ["critical", "important", "supporting", "archive"];

// Source types where a Haiku label check is worth running.
// Research sources are handled by researchSignificance.js.
// Governance/advisory/defensive types are deterministically "supporting"/"archive".
export const LABEL_ELIGIBLE_TYPES = new Set([
  "incident",
  "threat_intelligence",
  "exploit_disclosure",
  "capability_demonstration",
  "adversary_adoption_signal",
  "attack_surface_signal",
  "vulnerability",           // CVEs — often mis-labelled as important when they're just disclosures
]);

export function isLabelEligible(source = {}) {
  return LABEL_ELIGIBLE_TYPES.has(source.source_type);
}

const LABEL_SCHEMA = {
  type: "object",
  properties: {
    label:  { type: "string", enum: SOURCE_LABELS },
    reason: { type: "string" },
  },
  required: ["label", "reason"],
  additionalProperties: false,
};

function buildPrompt(source) {
  const title     = source.title || "(no title)";
  const publisher = source.publisher || "unknown";
  const type      = source.source_type || "unknown";
  const text      = (source.short_summary || source.summary || source.clean_text || source.full_text || "").slice(0, 1200);

  return {
    system: `You assign ONE importance label to an AI-security source for a threat-intelligence team.

LABELS — pick the strongest one that the evidence in the text DIRECTLY SUPPORTS:

  critical   — adversaries CONFIRMED to have used this technique/tool in real operations
               (e.g. a nation-state group used prompt injection in a campaign; malware
               distributed via a poisoned AI model hub; an LLM agent was hijacked in
               production to exfiltrate data). OR: this is the FIRST public disclosure
               of a genuinely new attack surface or threat class.

  important  — a working exploit or capability was DEMONSTRATED (PoC, red-team, vendor
               lab test) but no confirmed real-world adversary use. OR: a clearly novel
               technique within a known attack surface.

  supporting — corroborating detail on a known technique, a routine vendor advisory,
               a CVE with no evidence of exploitation, a second/third source on a
               topic already covered by a critical or important source.

  archive    — background context, defensive guidance, governance/policy, or content
               that is not directly about an offensive AI-security threat.

RULES:
- Label what the text SAYS HAPPENED, not what COULD happen. Speculation about
  future risk or hypothetical scenarios → at most "supporting".
- "Adversaries are increasingly using X" with no specific incident cited → "supporting".
- A CVE with "actively exploited in the wild" phrasing confirmed by CISA/vendor → "critical".
- A CVE disclosure with no exploitation evidence → "supporting".
- Return JSON: { "label": "<label>", "reason": "<one sentence>" }`,

    user: `SOURCE
Title: ${title}
Publisher: ${publisher}
Type: ${type}

${text}`,
  };
}

/**
 * Run the LLM label assessment for a single source.
 * Returns null if the source is not eligible or if the LLM call fails.
 *
 * @param {object} source  - DB row or normalise() output
 * @param {object} [opts]
 * @param {Function} [opts.llmFn]  - injectable LLM fn for tests
 * @returns {Promise<{label, reason, version}|null>}
 */
export async function assessSourceLabel(source, opts = {}) {
  if (!isLabelEligible(source)) return null;

  const { system, user } = buildPrompt(source);

  try {
    const llmFn = opts.llmFn;
    let raw;
    if (llmFn) {
      raw = await llmFn(system, user, { task: "source_label", schema: LABEL_SCHEMA, json: true });
    } else {
      const { result } = await routedLLM(system, user, {
        task:   "source_label",
        schema: LABEL_SCHEMA,
        json:   true,
      });
      raw = result;
    }

    const label = raw?.label;
    if (!SOURCE_LABELS.includes(label)) return null;

    return {
      label,
      reason:  raw.reason || "",
      version: LABEL_ASSESS_VERSION,
    };
  } catch {
    return null;
  }
}
