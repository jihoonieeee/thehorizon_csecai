/**
 * Evidence Triage — Evidence Selector (Part 8)
 *
 * After claims are finalized, selects the best-supporting evidence for each claim.
 * Deterministic — no LLM. Applied only after claim_priority is assigned.
 *
 * Evidence selection order for a claim:
 *   1. strong operational (incident, threat_intelligence, exploit_disclosure, vulnerability)
 *   2. strong exploit or vulnerability evidence
 *   3. strong benchmark or demonstration evidence
 *   4. strong research evidence
 *   5. contextual / usable evidence
 *
 * Within group, prefer: clearer quote > named entities > quantitative detail
 *   > lower limitation pressure > broader relevance > recent > independent corroboration
 *
 * Do not use: duplicate_reporting items, archive items, or not_used items.
 *
 * Slide headline rule: use critical claim where available, otherwise high claim.
 * Never build a slide headline from an unsupported evidence item alone.
 */

const OPERATIONAL_TYPES = new Set([
  "incident", "threat_intelligence", "exploit_disclosure", "vulnerability",
]);
const EXPLOIT_VULN_TYPES = new Set(["exploit_disclosure", "vulnerability"]);
const BENCHMARK_DEMO_TYPES = new Set(["benchmark_evaluation", "capability_demonstration"]);
const RESEARCH_TYPES = new Set(["research_finding", "adversary_adoption_signal"]);

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, rejected: 3 };

function evidenceGroup(triage) {
  if (!triage || triage.evidence_strength === "archive") return 6;
  const st = triage.source_type || "unknown";
  if (OPERATIONAL_TYPES.has(st) && triage.evidence_strength === "strong") return 1;
  if (EXPLOIT_VULN_TYPES.has(st)) return 2;
  if (BENCHMARK_DEMO_TYPES.has(st)) return 3;
  if (RESEARCH_TYPES.has(st)) return 4;
  return 5; // contextual / usable / other
}

function itemQualityScore(item, triage) {
  let score = 0;
  if (item.quote_verified === true) score += 10;
  if ((item.entities || []).length > 0) score += 8;
  if ((item.numbers  || []).length > 0) score += 6;
  score -= (triage?.limitations || []).length * 3;
  if (triage?.evidence_strength === "strong") score += 5;
  if (item.is_atomic === true) score += 3;
  if (item.date_published) {
    const ageDays = (Date.now() - new Date(item.date_published).getTime()) / 86_400_000;
    if      (ageDays <=  30) score += 4;
    else if (ageDays <=  90) score += 2;
    else if (ageDays <= 365) score += 1;
  }
  if (item.evidence_cluster?.is_multi_source) score += 4;
  return score;
}

function isExcluded(item, triage) {
  if (!triage || triage.evidence_strength === "archive") return true;
  if (triage.permitted_uses?.includes("not_used")) return true;
  if (triage.limitations?.includes("duplicate_reporting") &&
      item.evidence_cluster?.is_representative === false) return true;
  return false;
}

function selectForClaim(claim, items, triageById, maxItems) {
  const supportingIds = new Set(claim.supporting_evidence_ids || []);
  const candidates = [];

  for (const item of (items || [])) {
    const triage = triageById[item.evidence_id];
    if (!triage) continue;
    if (!supportingIds.has(item.evidence_id)) continue;
    if (isExcluded(item, triage)) continue;

    candidates.push({
      ...item,
      _group:   evidenceGroup(triage),
      _quality: itemQualityScore(item, triage),
    });
  }

  candidates.sort((a, b) => {
    if (a._group !== b._group) return a._group - b._group;
    return b._quality - a._quality;
  });

  return candidates.slice(0, maxItems).map(({ _group, _quality, ...item }) => item);
}

/**
 * Select evidence for all non-rejected claims.
 *
 * @param {object[]} claims        - Claims with claim_priority
 * @param {object[]} items         - All evidence items
 * @param {object[]} triageResults - Triage results matched by evidence_id
 * @param {object}   [opts]
 * @returns {object[]} selected_evidence_by_claim[]
 */
export function selectEvidenceForClaims(claims, items, triageResults, opts = {}) {
  const { maxPerClaim = 5 } = opts;

  const triageById = Object.fromEntries(
    (triageResults || []).map((t) => [t.evidence_id, t])
  );

  return [...(claims || [])]
    .filter((c) => c.claim_priority !== "rejected")
    .sort((a, b) => (PRIORITY_ORDER[a.claim_priority] ?? 3) - (PRIORITY_ORDER[b.claim_priority] ?? 3))
    .map((claim) => ({
      claim_id:          claim.claim_id,
      claim_priority:    claim.claim_priority,
      claim_text:        claim.claim_text,
      selected_evidence: selectForClaim(claim, items, triageById, maxPerClaim),
    }));
}

/**
 * Build slide headline entries for critical and high claims.
 * Each entry carries the claim text as the headline and the best supporting evidence item.
 * Never builds a headline from unsupported evidence alone.
 */
export function buildSlideHeadlines(selectedEvidenceByClaim) {
  return (selectedEvidenceByClaim || [])
    .filter((s) => ["critical", "high"].includes(s.claim_priority))
    .map((s) => ({
      claim_id:       s.claim_id,
      claim_priority: s.claim_priority,
      headline:       s.claim_text,
      lead_evidence:  s.selected_evidence[0] || null,
    }));
}
