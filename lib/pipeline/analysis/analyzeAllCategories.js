/**
 * Layer 6.3 Runner — Per-Category Analysis (concurrency wrapper)
 *
 * Thin concurrency wrapper — no direct LLM calls. Delegates to analyzeCategory()
 * which makes one LLM call per active category (see analyzeCategory.js for details).
 *
 * Processes dossiers CONCURRENCY=3 at a time (parallel within batch, sequential batches).
 * Active category = dossier.source_count > 0 (buildAllDossiers skips empty categories).
 *
 * ── RUN CAP HANDLING ──────────────────────────────────────────────────────────
 * When opts.maxCategories is set, categories beyond the cap are NOT silently
 * omitted — they are returned as stubs with:
 *   assessment_status: "not_synthesized_due_to_run_cap"
 *
 * This ensures downstream consumers (buildPresentationPacket, slide planner)
 * always receive a result for every active category and can render a "not
 * processed" section rather than encountering null/undefined.
 *
 * ── LLM CALL (delegated) ─────────────────────────────────────────────────────
 * Tool:    callLLM() via analyzeCategory.js
 * Keys:    OPENAI_API_KEY, OPENAI_API_KEY_2, GEMINI_API_KEY, GEMINI_API_KEY_2
 *          (GROQ_API_KEY NOT used — open-source models insufficient for
 *          citation-traced structured analysis)
 * Trigger: source_count >= 2 AND at least one OPENAI or GEMINI key present
 * Fallback: deterministicAnalysis() in analyzeCategory.js
 */

import { analyzeCategory } from "./analyzeCategory.js";

const CONCURRENCY = 3;

/**
 * Build a stub result for a category that was eligible but not processed
 * due to a synthesis run cap. Prevents null-reference errors in all callers.
 */
function buildRunCapStub(dossier) {
  return {
    category:            dossier.category,
    assessment_status:   "not_synthesized_due_to_run_cap",
    assessment_status_reason:
      "category was eligible but not processed due to synthesis run cap",
    llm_used:            false,
    skipped:             true,
    // Minimal fields to prevent downstream null errors
    top_insights:        [],
    biggest_happenings:  [],
    early_signals:       [],
    recommendations:     [],
    outlook:             null,
    evidence_gaps:       [],
    analysis_confidence: "none",
    key_source_ids:      [],
    // Claim chain fields
    claims:              [],
    claims_blocked_by_qa: [],
    selected_evidence_by_claim: [],
    case_studies:        [],
    viewpoints:          [],
    observations:        [],
    claim_chain_counts:  { claims_critical: 0, claims_high: 0, claims_medium: 0, claims_blocked: 0 },
  };
}

/**
 * Run category analysis for all active dossiers.
 *
 * The per-category analytical state (deterministic hypothesis candidates +
 * confidence ceiling from buildAnalyticalState) IS now threaded into each
 * analyzeCategory call. The synthesis LLM evaluates those pre-structured candidates
 * instead of inventing relationships, and validateCategoryAnalysis caps each output's
 * confidence to the category's deterministic ceiling. The cross-category half of the
 * analytical state is still consumed separately by runCrossCategorySynthesis.
 *
 * @param {object[]} dossiers         - Output of buildAllDossiers()
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @param {object}   [opts.analyticalState] - Output of buildAnalyticalState()
 * @param {number}   [opts.maxCategories]  - Optional cap on how many categories get full LLM synthesis.
 *                                           Categories beyond the cap receive a run-cap stub.
 * @returns {Promise<object[]>} One analysis object per active category (no missing entries).
 */
export async function analyzeAllCategories(dossiers, opts = {}) {
  const { analyticalState, maxCategories = Infinity, ...restOpts } = opts;
  const stateByCategory = new Map(
    (analyticalState?.category_states || []).map((cs) => [cs.category, cs])
  );
  const results = [];
  let synthesizedCount = 0;

  for (let i = 0; i < dossiers.length; i += CONCURRENCY) {
    const batch = dossiers.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((dossier) => {
        // If this category would exceed the run cap, return a stub immediately
        if (synthesizedCount >= maxCategories) {
          process.stdout.write(
            `  [L6-category] ${dossier.category}: skipped (run cap maxCategories=${maxCategories})\n`
          );
          return Promise.resolve(buildRunCapStub(dossier));
        }
        synthesizedCount++;
        return analyzeCategory(dossier, {
          ...restOpts,
          categoryState: stateByCategory.get(dossier.category) || null,
        });
      })
    );
    results.push(...batchResults);
  }

  return results;
}
