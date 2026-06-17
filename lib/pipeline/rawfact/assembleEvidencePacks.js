/**
 * Layer 5a.7 — Evidence Pack Assembly (safe-use buckets)
 *
 * Assembles per-category evidence packs from all sources' evidence_items.
 * Deterministic — no LLM. Buckets organize rawfacts by what they can SAFELY be
 * used for (driven by triage_data.evidence_strength + permitted_uses), NOT by any
 * claim-importance label. There is no `critical_evidence`/`high_evidence` here:
 * importance is decided later by the analysis layer.
 *
 * Output (per category):
 * {
 *   category, source_count, item_count,
 *   strong_evidence[],         — evidence_strength === "strong"
 *   usable_evidence[],         — evidence_strength === "usable"
 *   context_evidence[],        — evidence_strength === "context" (framing only)
 *   statistics[],              — items carrying a number (quantitative anchors)
 *   case_study_candidates[],   — permitted_use case_study (CANDIDATES — final pick is later)
 *   recommendation_inputs[],   — permitted_use recommendation_input / mitigations
 *   outlook_inputs[],          — permitted_use outlook_input / forward-looking types
 *   exposure_inputs[],         — permitted_use exposure_analysis
 *   governance_context[],      — governance_action items
 *   archived_items[],          — evidence_strength === "archive" (kept for audit only)
 * }
 */

import { compareEvidenceByStrength, strengthRank } from "../evidenceTriage/evidenceTriageVocab.js";

const ANALYSIS_CATEGORIES = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

// ── Evidence-type grouping (thematic, independent of strength) ─────────────────

const CASE_STUDY_TYPES = new Set([
  "incident_event", "exploit_chain", "attack_method", "threat_actor_activity",
  "adversary_adoption", "research_result", "capability_delta",
]);

const MITIGATION_TYPES = new Set([
  "mitigation", "defensive_control", "governance_action", "vulnerability_fact",
]);

const GOVERNANCE_TYPES = new Set(["governance_action"]);

const OUTLOOK_TYPES = new Set([
  "capability_delta", "adversary_adoption", "strategic_signal",
  "ecosystem_shift", "infrastructure_dependency", "trust_boundary_shift",
  "benchmark_result",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

const strengthOf = (i) => i.triage_data?.evidence_strength || "archive";
const permittedUses = (i) => i.triage_data?.permitted_uses || [];
const can = (i, use) => permittedUses(i).includes(use);

function sortByStrength(items) {
  return [...items].sort(compareEvidenceByStrength);
}

function filterRepresentatives(items) {
  return items.filter((item) => item.evidence_cluster?.is_representative !== false);
}

function hasNumbers(item) {
  if ((item.numbers || []).length > 0) return true;
  return /\d+%|\$[\d,.]+|\d+\s*(million|billion|thousand|k\b)|[<>≥≤]\s*\d+/i.test(item.fact || "");
}

// A number may enter the chartable `statistics` bucket only if its methodological
// quality permits it. assessMethodQuality sets statistical_use; "context_only" /
// "not_allowed" means the number lacks the methodology to be charted (e.g. a
// vendor's unmethodical "300% increase") and must stay text/context, not a chart.
// Items with no statistical_use verdict (non method-required types) are allowed.
function chartableStatistic(item) {
  const su = item.statistical_use;
  if (!su) return true;
  return su === "chart_allowed" || su === "text_only_with_caveat";
}

// ── Pack builder for a single category ───────────────────────────────────────

function buildCategoryPack(category, sources) {
  const allItems = [];
  for (const source of sources) {
    for (const item of (source.evidence_items || [])) {
      if (item.category_hint === category || !item.category_hint) {
        allItems.push({ ...item, _source_type: source.source_type, _trust_tier: source.trust_tier });
      }
    }
  }

  const empty = {
    category, source_count: sources.length, item_count: 0,
    strong_evidence: [], usable_evidence: [], context_evidence: [],
    statistics: [], case_study_candidates: [], recommendation_inputs: [],
    outlook_inputs: [], exposure_inputs: [], governance_context: [], archived_items: [],
  };
  if (allItems.length === 0) return empty;

  const sorted = sortByStrength(allItems);
  const reps   = filterRepresentatives(sorted);

  // Strength buckets (representatives only — duplicates don't fill slide buckets).
  const strong_evidence  = reps.filter((i) => strengthOf(i) === "strong").slice(0, 8);
  const usable_evidence  = reps.filter((i) => strengthOf(i) === "usable").slice(0, 10);
  const context_evidence = reps.filter((i) => strengthOf(i) === "context").slice(0, 10);
  const archived_items   = sorted.filter((i) => strengthOf(i) === "archive").slice(0, 5);

  // Safe-use thematic buckets — admissible (non-archive) items only, gated by
  // permitted_uses where the use is permission-controlled.
  const admissible = reps.filter((i) => strengthOf(i) !== "archive");

  const statistics = admissible
    .filter((i) => (hasNumbers(i) || i.evidence_type === "statistic") && chartableStatistic(i))
    .slice(0, 8);

  const case_study_candidates = admissible
    .filter((i) => can(i, "case_study") || CASE_STUDY_TYPES.has(i.evidence_type))
    .slice(0, 8);

  const recommendation_inputs = admissible
    .filter((i) => can(i, "recommendation_input") || MITIGATION_TYPES.has(i.evidence_type))
    .slice(0, 6);

  const outlook_inputs = admissible
    .filter((i) => can(i, "outlook_input") || OUTLOOK_TYPES.has(i.evidence_type))
    .slice(0, 6);

  const exposure_inputs = admissible
    .filter((i) => can(i, "exposure_analysis"))
    .slice(0, 6);

  const governance_context = admissible
    .filter((i) => GOVERNANCE_TYPES.has(i.evidence_type))
    .slice(0, 4);

  // Thematic buckets are CANDIDATE views over the same items; no dedup against the
  // strength buckets — every bucket independently lists what it is safe to use for.
  return {
    category,
    source_count: sources.length,
    item_count:   allItems.length,
    strong_evidence,
    usable_evidence,
    context_evidence,
    statistics,
    case_study_candidates,
    recommendation_inputs,
    outlook_inputs,
    exposure_inputs,
    governance_context,
    archived_items,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Assemble evidence packs for all active threat categories.
 *
 * @param {object[]} sources - All sources with evidence_items[]
 * @returns {object[]} Array of per-category evidence packs
 */
export function assembleEvidencePacks(sources) {
  const byCat = {};
  for (const source of sources) {
    const cat = source.main_category || "unclear_or_adjacent";
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(source);
  }

  return ANALYSIS_CATEGORIES
    .filter((cat) => (byCat[cat] || []).length > 0)
    .map((cat) => buildCategoryPack(cat, byCat[cat]));
}

/**
 * Find the evidence pack for a specific category.
 */
export function findEvidencePack(packs, category) {
  return (packs || []).find((p) => p.category === category) || null;
}

export { strengthRank };
