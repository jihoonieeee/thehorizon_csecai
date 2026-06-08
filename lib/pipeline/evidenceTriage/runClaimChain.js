/**
 * Evidence Triage — Claim Chain Orchestrator
 *
 * The full non-numeric evidence intelligence chain:
 *   Evidence → Triage → Observations → Viewpoints → Claims → Priority → Case Studies → Evidence Selection
 *
 * LLM classifies, interprets, groups, and explains.
 * Deterministic gates assign final claim_priority (critical/high/medium/rejected).
 * No 0–100 scores. No arbitrary weights.
 *
 * ── CHAIN STEPS ───────────────────────────────────────────────────────────────
 * 1. Triage: admissibility, evidence_strength, permitted_uses, limitations per item
 * 2. Observations: factual patterns from converging strong/usable evidence (LLM)
 * 3. Viewpoints: analytical explanations of observations (LLM)
 * 4. Claims: analytical statements with structured fields (LLM) + deterministic priority
 * 5. Case studies: best concrete illustrations selected after claims (deterministic)
 * 6. Evidence selection: ordered evidence per claim for slides (deterministic)
 *
 * ── OUTPUT ────────────────────────────────────────────────────────────────────
 * {
 *   triage_results[], observations[], viewpoints[], claims[],
 *   case_studies[], selected_evidence_by_claim[], slide_headlines[],
 *   counts{}, chain_version, llm_used
 * }
 */

import { triageEvidenceItems }                        from "./evidenceTriage.js";
import { generateObservations }                        from "./observationLayer.js";
import { generateViewpoints }                          from "./viewpointLayer.js";
import { generateClaims }                              from "./claimLayer.js";
import { selectCaseStudiesWithLlm }                    from "./caseStudySelector.js";
import { selectEvidenceForClaims, buildSlideHeadlines } from "./evidenceSelector.js";

export const CHAIN_VERSION = "claim-chain-v1.0";

const ANALYSIS_CATEGORIES = [
  "traditional_ai_threats",
  "llm_threats",
  "agentic_ai_threats",
  "ai_enabled_threats",
];

/**
 * Run the full claim chain for a set of evidence items (already triaged).
 *
 * @param {object[]} allItems      - Evidence items across all sources in the category
 * @param {object[]} triageResults - Pre-computed triage results for every item
 * @param {string}   category
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @returns {Promise<object>}
 */
export async function runClaimChain(allItems, triageResults, category, opts = {}) {
  const { skipLlm = false } = opts;

  const obsResult = await generateObservations(allItems, triageResults, category, { skipLlm });
  const { observations, llm_used: obs_llm, model_used: obs_model } = obsResult;

  const vpResult  = await generateViewpoints(observations, allItems, triageResults, category, { skipLlm });
  const { viewpoints, llm_used: vp_llm, model_used: vp_model } = vpResult;

  const clResult  = await generateClaims(viewpoints, observations, allItems, triageResults, category, { skipLlm });
  const { claims, llm_used: cl_llm, model_used: cl_model } = clResult;

  const case_studies             = await selectCaseStudiesWithLlm(allItems, triageResults, viewpoints, claims, category, { skipLlm });
  const selected_evidence_by_claim = selectEvidenceForClaims(claims, allItems, triageResults);
  const slide_headlines          = buildSlideHeadlines(selected_evidence_by_claim);

  const criticalClaims = claims.filter((c) => c.claim_priority === "critical").length;
  const highClaims     = claims.filter((c) => c.claim_priority === "high").length;
  const mediumClaims   = claims.filter((c) => c.claim_priority === "medium").length;
  const rejectedClaims = claims.filter((c) => c.claim_priority === "rejected").length;

  process.stdout.write(
    `  [claim-chain] ${category}: ${observations.length} obs, ${viewpoints.length} vp, ` +
    `claims(C=${criticalClaims}/H=${highClaims}/M=${mediumClaims}/R=${rejectedClaims}) ` +
    `via obs:${obs_model} vp:${vp_model} cl:${cl_model}\n`
  );

  return {
    triage_results:              triageResults,
    observations,
    viewpoints,
    claims,
    case_studies,
    selected_evidence_by_claim,
    slide_headlines,
    counts: {
      triaged_strong:  triageResults.filter((t) => t.evidence_strength === "strong").length,
      triaged_usable:  triageResults.filter((t) => t.evidence_strength === "usable").length,
      triaged_context: triageResults.filter((t) => t.evidence_strength === "context").length,
      triaged_archive: triageResults.filter((t) => t.evidence_strength === "archive").length,
      observations:    observations.length,
      viewpoints:      viewpoints.length,
      claims_critical: criticalClaims,
      claims_high:     highClaims,
      claims_medium:   mediumClaims,
      claims_rejected: rejectedClaims,
      case_studies:    case_studies.length,
    },
    chain_version: CHAIN_VERSION,
    llm_used: obs_llm || vp_llm || cl_llm || case_studies.some((cs) => cs.selected_by === "llm"),
  };
}

/**
 * Run the claim chain for a single source (triage step only).
 * Returns triage results for all evidence items in the source.
 * Full chain (obs→vp→claims) runs at the category level via runClaimChain().
 *
 * @param {object[]} items              - Evidence items for this source
 * @param {object}   source             - Source object
 * @param {object}   [llmByEvidenceId]  - Optional LLM semantic judgements per evidence_id
 * @returns {object[]} triageResults
 */
export function triageSourceItems(items, source, llmByEvidenceId = {}) {
  return triageEvidenceItems(items, source, llmByEvidenceId);
}

/**
 * Run the full claim chain for all active threat categories.
 * Items must already carry triage_data (from scoreEvidenceItems / runRawfactBranch).
 *
 * @param {object[]} sources - Sources with evidence_items[] carrying triage_data per item
 * @param {object}   [opts]
 * @returns {Promise<{ [category]: ChainResult }>}
 */
export async function runClaimChainAllCategories(sources, opts = {}) {
  const itemsByCategory   = {};
  const triageByCategory  = {};

  for (const source of (sources || [])) {
    const cat = source.main_category || "unclear_or_adjacent";
    if (!ANALYSIS_CATEGORIES.includes(cat)) continue;
    if (!itemsByCategory[cat]) { itemsByCategory[cat] = []; triageByCategory[cat] = []; }

    for (const item of (source.evidence_items || [])) {
      itemsByCategory[cat].push(item);
      if (item.triage_data) triageByCategory[cat].push(item.triage_data);
    }
  }

  const results = {};
  for (const cat of ANALYSIS_CATEGORIES) {
    const items        = itemsByCategory[cat]  || [];
    const triageResult = triageByCategory[cat] || [];
    if (items.length === 0) continue;
    results[cat] = await runClaimChain(items, triageResult, cat, opts);
  }
  return results;
}
