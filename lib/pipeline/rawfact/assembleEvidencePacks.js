/**
 * Layer 5a.7 — Evidence Pack Assembly
 *
 * Assembles per-category evidence packs from all sources' evidence_items.
 * Deterministic — no LLM. Produces structured, slide-ready evidence bundles.
 *
 * Output (per category):
 * {
 *   category,
 *   critical_evidence[],   — critical priority items from primary sources
 *   high_evidence[],       — high priority items
 *   supporting_evidence[], — medium priority items
 *   statistics[],          — statistic-type items that contain numbers
 *   case_studies[],        — incident/exploit/research items from high-trust sources
 *   mitigations[],         — mitigation/defensive_control/governance_action items
 *   governance_context[],  — governance_action items
 *   outlook_signals[]      — strategic/ecosystem/capability/adversary_adoption items
 * }
 */

const ANALYSIS_CATEGORIES = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

const PRIORITY_ORDER = {
  critical: 0, high: 1, medium: 2, low: 3, archive_only: 4,
};

// ── Evidence type grouping rules ──────────────────────────────────────────────

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

const OUTLOOK_SOURCE_TYPES = new Set([
  "capability_demonstration", "adversary_adoption_signal", "strategic_signal",
  "infrastructure_dependency_signal", "trust_boundary_shift", "benchmark_evaluation",
  "ecosystem_signal",
]);

// ── Item selector ─────────────────────────────────────────────────────────────

function sortByScore(items) {
  return [...items].sort((a, b) => {
    const pA = PRIORITY_ORDER[a.score_data?.evidence_priority] ?? 4;
    const pB = PRIORITY_ORDER[b.score_data?.evidence_priority] ?? 4;
    if (pA !== pB) return pA - pB;
    const sA = a.score_data?.evidence_score ?? 0;
    const sB = b.score_data?.evidence_score ?? 0;
    return sB - sA;
  });
}

function filterRepresentatives(items) {
  return items.filter((item) =>
    item.evidence_cluster?.is_representative !== false
  );
}

function hasNumbers(item) {
  if ((item.numbers || []).length > 0) return true;
  return /\d+%|\$[\d,.]+|\d+\s*(million|billion|thousand|k\b)|[<>≥≤]\s*\d+/i.test(item.fact || "");
}

// ── Pack builder for a single category ───────────────────────────────────────

function buildCategoryPack(category, sources) {
  // Collect all evidence items for this category (matching category_hint)
  const allItems = [];
  for (const source of sources) {
    for (const item of (source.evidence_items || [])) {
      if (item.category_hint === category || !item.category_hint) {
        allItems.push({ ...item, _source_type: source.source_type, _trust_tier: source.trust_tier });
      }
    }
  }

  if (allItems.length === 0) {
    return {
      category,
      source_count: sources.length,
      item_count: 0,
      critical_evidence:  [],
      high_evidence:      [],
      supporting_evidence:[],
      statistics:         [],
      case_studies:       [],
      mitigations:        [],
      governance_context: [],
      outlook_signals:    [],
    };
  }

  const sorted = sortByScore(allItems);
  const reps   = filterRepresentatives(sorted);

  // critical_evidence — critical priority, high authority, small set
  const critical_evidence = reps
    .filter((i) => i.score_data?.evidence_priority === "critical")
    .slice(0, 5);

  // high_evidence
  const high_evidence = reps
    .filter((i) => i.score_data?.evidence_priority === "high")
    .slice(0, 8);

  // supporting_evidence (medium)
  const supporting_evidence = reps
    .filter((i) => i.score_data?.evidence_priority === "medium")
    .slice(0, 10);

  // statistics — items with numbers
  const statistics = sorted
    .filter((i) => hasNumbers(i) || i.evidence_type === "statistic")
    .slice(0, 8);

  // case_studies — concrete incident/exploit/research from good sources
  const case_studies = reps
    .filter((i) => CASE_STUDY_TYPES.has(i.evidence_type))
    .filter((i) => ["primary","high","curated"].includes(i._trust_tier) ||
                   (i.score_data?.evidence_score ?? 0) >= 50)
    .slice(0, 6);

  // mitigations
  const mitigations = sorted
    .filter((i) => MITIGATION_TYPES.has(i.evidence_type))
    .slice(0, 6);

  // governance_context
  const governance_context = sorted
    .filter((i) => GOVERNANCE_TYPES.has(i.evidence_type))
    .slice(0, 4);

  // outlook_signals
  const outlook_signals = sorted
    .filter((i) =>
      OUTLOOK_TYPES.has(i.evidence_type) ||
      OUTLOOK_SOURCE_TYPES.has(i._source_type)
    )
    .slice(0, 6);

  // Deduplicate across buckets: case_studies and statistics may overlap with
  // critical/high. Track which IDs are already in priority buckets and strip
  // duplicates from the thematic buckets so the LLM doesn't see the same item twice.
  const priorityIds = new Set([
    ...critical_evidence.map((i) => i.evidence_id),
    ...high_evidence.map((i) => i.evidence_id),
    ...supporting_evidence.map((i) => i.evidence_id),
  ]);
  const dedupedCaseStudies     = case_studies.filter((i) => !priorityIds.has(i.evidence_id));
  const dedupedStatistics      = statistics.filter((i) => !priorityIds.has(i.evidence_id));
  const dedupedMitigations     = mitigations.filter((i) => !priorityIds.has(i.evidence_id));
  const dedupedGovernance      = governance_context.filter((i) => !priorityIds.has(i.evidence_id));
  const dedupedOutlookSignals  = outlook_signals.filter((i) => !priorityIds.has(i.evidence_id));

  return {
    category,
    source_count:    sources.length,
    item_count:      allItems.length,
    critical_evidence,
    high_evidence,
    supporting_evidence,
    statistics:         dedupedStatistics,
    case_studies:       dedupedCaseStudies,
    mitigations:        dedupedMitigations,
    governance_context: dedupedGovernance,
    outlook_signals:    dedupedOutlookSignals,
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
 *
 * @param {object[]} packs
 * @param {string}   category
 * @returns {object|null}
 */
export function findEvidencePack(packs, category) {
  return (packs || []).find((p) => p.category === category) || null;
}
