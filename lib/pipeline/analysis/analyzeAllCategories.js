/**
 * Layer 8B — Per-Category Analysis Runner
 *
 * Thin concurrency wrapper — no direct LLM calls. Delegates to analyzeCategory()
 * which makes one LLM call per active category (see analyzeCategory.js for details).
 *
 * Processes dossiers CONCURRENCY=3 at a time (parallel within batch, sequential batches).
 * Active category = dossier.source_count > 0 (buildAllDossiers skips empty categories).
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
 * Run category analysis for all active dossiers.
 *
 * @param {object[]} dossiers - Output of buildAllDossiers().
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @returns {Promise<object[]>} One analysis object per active category.
 */
/**
 * Run category analysis for all active dossiers.
 *
 * @param {object[]} dossiers        - Output of buildAllDossiers()
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @param {object}   [opts.analyticalState] - From buildAnalyticalState (L6A)
 * @returns {Promise<object[]>}
 */
export async function analyzeAllCategories(dossiers, opts = {}) {
  const { analyticalState, ...restOpts } = opts;
  const results = [];

  for (let i = 0; i < dossiers.length; i += CONCURRENCY) {
    const batch = dossiers.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((dossier) => {
        // Inject per-category analytical state if available
        const categoryState = analyticalState
          ? (analyticalState.category_states || []).find((cs) => cs.category === dossier.category) || null
          : null;
        return analyzeCategory(dossier, { ...restOpts, categoryState });
      })
    );
    results.push(...batchResults);
  }

  return results;
}
