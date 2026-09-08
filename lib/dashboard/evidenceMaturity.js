/**
 * Unified threat maturity ladder for the dashboard.
 *
 * Single source of truth for the five levels shown in the category card bar
 * and the per-source reality badge. Both read from intelligence.maturity_level —
 * the LLM-assigned field written by scripts/labelMaturityLevels.js.
 *
 * Falls back to a deterministic rule (from maturityLevel.js) for sources not
 * yet classified by the LLM.
 *
 * Shared by api/dashboard.js (display) and scripts/generateDashboardInsights.js
 * (confidence + assessment) so the two never drift.
 */

import { maturityOf, MATURITY_RANK } from "../pipeline/scoring/maturityLevel.js";

// ── The four-level ladder ─────────────────────────────────────────────────────
// Display order = increasing operational maturity (left → right on the bar).
export const MATURITY_RUNGS = [
  { key: "research",     label: "Research",    color: "#94a3b8",
    desc: "Identified through research, simulation, benchmarks, or controlled lab testing only." },
  { key: "validated",    label: "Validated",   color: "#f59e0b",
    desc: "Confirmed to affect a real system, or shown feasible via a reproducible exploit. No adversary use." },
  { key: "observed",     label: "Observed",    color: "#ef4444",
    desc: "Used against real-world targets outside controlled testing — at least one documented instance." },
  { key: "operational",  label: "Operational", color: "#7f1d1d",
    desc: "Repeated, systematic, or at-scale use by threat actors — sustained adversary adoption." },
];

/**
 * Tally an array of sources onto the five-rung ladder.
 * Reads intelligence.maturity_level first; falls back to deterministic rule.
 *
 * @returns {{ research, validated, observed, operational, other, total }}
 */
export function computeEvidenceMaturity(sources = []) {
  const m = { research: 0, validated: 0, observed: 0, operational: 0, other: 0 };
  for (const s of sources) {
    const level = maturityOf(s);
    if (level in m) m[level]++;
    else            m.other++;
  }
  m.total = sources.length;
  return m;
}

/**
 * Deterministic confidence in category-level threat-landscape conclusions.
 *
 * A research/disclosure-only sample can never justify "High" confidence; a
 * tiny sample is "Low" regardless of maturity. This caps LLM overstatement.
 *
 * @returns {{ level: "High"|"Medium"|"Low", reason: string }}
 */
export function deriveConfidence(maturity) {
  const m = maturity || {};
  const total = m.total || 0;
  const operationalEvidence = (m.observed || 0) + (m.operational || 0);
  const validatedEvidence   = (m.validated || 0);

  if (total < 5) {
    return { level: "Low", reason: `only ${total} source${total !== 1 ? "s" : ""} — too thin for a landscape conclusion` };
  }

  if (operationalEvidence === 0 && validatedEvidence === 0) {
    const level = total >= 8 ? "Medium" : "Low";
    return {
      level,
      reason: `${total} sources but all ${m.research || 0} are research — capability studied, not confirmed against a real system`,
    };
  }

  if (operationalEvidence === 0) {
    return {
      level: "Medium",
      reason: `${total} sources with ${validatedEvidence} validated finding${validatedEvidence !== 1 ? "s" : ""} but no confirmed in-the-wild use`,
    };
  }

  if (total >= 15 && operationalEvidence >= 3) {
    return { level: "High", reason: `${total} sources including ${operationalEvidence} with observed/operational in-the-wild activity` };
  }

  return {
    level: "Medium",
    reason: `${total} sources with ${operationalEvidence} in-the-wild data point${operationalEvidence !== 1 ? "s" : ""} — beyond research but not yet a confirmed pattern`,
  };
}

/** Short one-line summary, e.g. "15 research · 4 disclosed · 2 observed". */
export function maturityShortLine(m = {}) {
  return MATURITY_RUNGS
    .map(r => m[r.key] ? `${m[r.key]} ${r.label.toLowerCase()}` : null)
    .filter(Boolean).join(" · ") || "no data";
}

/** Sort comparator — higher maturity first. */
export function byMaturityDesc(a, b) {
  return (MATURITY_RANK[maturityOf(b)] || 0) - (MATURITY_RANK[maturityOf(a)] || 0);
}
