/**
 * Evidence-maturity ladder + deterministic confidence.
 *
 * Shared by api/dashboard.js (display) and scripts/generateDashboardInsights.js
 * (confidence + assessment), so the two never drift.
 *
 * The ladder answers "what does a source COUNT mean?" — a category that is 90%
 * research papers is a fundamentally weaker threat-landscape signal than one
 * backed by incidents or operational campaigns. We surface this so analysts
 * cannot mistake a research-heavy sample for confirmed in-the-wild activity.
 *
 * Maps both the live connector source_type values (research_paper,
 * vulnerability_advisory, …) AND the controlled-vocab Layer-3 types
 * (research_finding, exploit_disclosure, …) onto five rungs.
 */

// Display order = increasing operational maturity (left → right on the bar).
export const MATURITY_RUNGS = [
  { key: "research",      label: "Research" },
  { key: "vulnerabilities", label: "Vulnerabilities" },
  { key: "exploitation",  label: "Observed exploitation" },
  { key: "incidents",     label: "Incidents" },
  { key: "operational",   label: "Operational campaigns" },
];

const SOURCE_TYPE_TO_RUNG = {
  // Research / lab evidence
  research_paper:           "research",
  research_finding:         "research",
  benchmark_evaluation:     "research",
  capability_demonstration: "research",
  dataset_or_benchmark:     "research",
  defensive_capability:     "research",
  // Disclosed vulnerabilities
  vulnerability_advisory:   "vulnerabilities",
  vulnerability:            "vulnerabilities",
  // Demonstrated / disclosed exploitation
  exploit_disclosure:       "exploitation",
  // Real incidents
  incident:                 "incidents",
  // Operational adversary activity / campaigns
  threat_intelligence:      "operational",
  adversary_adoption_signal:"operational",
  // Everything else (blogs, governance, surface signals, unknown) → not on the
  // operational ladder; counted only in `other` for an honest total.
};

/**
 * Tally an array of sources (each with a .source_type) onto the ladder.
 * @returns {{ research, vulnerabilities, exploitation, incidents, operational, other, total }}
 */
export function computeEvidenceMaturity(sources = []) {
  const m = { research: 0, vulnerabilities: 0, exploitation: 0, incidents: 0, operational: 0, other: 0 };
  for (const s of sources) {
    const rung = SOURCE_TYPE_TO_RUNG[s?.source_type] || "other";
    m[rung]++;
  }
  m.total = sources.length;
  return m;
}

/**
 * Deterministic confidence in CATEGORY-LEVEL threat-landscape conclusions.
 *
 * The cardinal rule (per analyst feedback): a research/vulnerability-only sample
 * can never justify "High" confidence in landscape claims, and a tiny sample is
 * "Low" regardless of maturity. This caps LLM overstatement structurally.
 *
 * @returns {{ level: "High"|"Medium"|"Low", reason: string }}
 */
export function deriveConfidence(maturity) {
  const m = maturity || {};
  const total = m.total || 0;
  const operationalEvidence = (m.exploitation || 0) + (m.incidents || 0) + (m.operational || 0);

  if (total < 5) {
    return { level: "Low", reason: `only ${total} source${total !== 1 ? "s" : ""} — too thin for a landscape conclusion` };
  }

  if (operationalEvidence === 0) {
    // Research + disclosed vulnerabilities only: capability is shown, in-the-wild use is not.
    const level = total >= 8 ? "Medium" : "Low";
    return {
      level,
      reason: `${total} sources but ${m.research || 0} research / ${m.vulnerabilities || 0} vulnerability disclosures and no observed exploitation — capability demonstrated, not confirmed in the wild`,
    };
  }

  if (total >= 15 && operationalEvidence >= 3) {
    return { level: "High", reason: `${total} sources including ${operationalEvidence} with observed exploitation / incidents / operational activity` };
  }

  return {
    level: "Medium",
    reason: `${total} sources with ${operationalEvidence} operational data point${operationalEvidence !== 1 ? "s" : ""} — beyond pure research but not yet a confirmed pattern`,
  };
}

/** Short one-line maturity summary, e.g. "15 research · 4 vuln · 0 exploited". */
export function maturityShortLine(m = {}) {
  return [
    `${m.research || 0} research`,
    `${m.vulnerabilities || 0} vuln`,
    `${m.exploitation || 0} exploited`,
    (m.incidents ? `${m.incidents} incident` : null),
    (m.operational ? `${m.operational} operational` : null),
  ].filter(Boolean).join(" · ");
}
