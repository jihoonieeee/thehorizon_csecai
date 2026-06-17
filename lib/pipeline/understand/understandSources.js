/**
 * Layer 4 — Batch taxonomy understanding (multi-stage chain).
 *
 * Runs understandSource() with bounded concurrency.
 * Reports per-stage counts including discard rates.
 */

import { understandSource, TAXONOMY_VERSION } from "./understandSource.js";

export { TAXONOMY_VERSION };
export const UNDERSTAND_VERSION = TAXONOMY_VERSION;

const DEFAULT_CONCURRENCY = 5;

/**
 * @param {object[]} sources
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @param {number}   [opts.concurrency=5]
 * @param {Function} [opts.onProgress]
 * @returns {Promise<{ sources: object[], counts: object, discarded: object[] }>}
 */
export async function understandSources(sources, opts = {}) {
  const {
    skipLlm     = false,
    concurrency = DEFAULT_CONCURRENCY,
    onProgress  = null,
  } = opts;

  const results = new Array(sources.length);

  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((source) => understandSource(source, { skipLlm }))
    );
    for (let j = 0; j < batch.length; j++) {
      results[i + j] = batchResults[j];
    }
    if (onProgress) {
      onProgress(Math.min(i + concurrency, sources.length), sources.length);
    }
  }

  const alreadyDone    = sources.filter((s) => s.taxonomy_version === TAXONOMY_VERSION).length;
  const newResults     = results.filter((_, i) => sources[i].taxonomy_version !== TAXONOMY_VERSION);

  // Stage outcome counts
  const llmProcessed   = newResults.filter((r) => r.understanding?.llm_used === true).length;
  const fallback       = newResults.filter((r) => r.understanding?.llm_used === false).length;
  const noDomainMatch  = newResults.filter((r) => r.understanding?.taxonomy_validation_status === "no_domain_match").length;
  const noTagsFound    = newResults.filter((r) => r.understanding?.taxonomy_validation_status === "no_tags_found").length;
  const validated      = newResults.filter((r) => r.understanding?.taxonomy_validation_status === "validated").length;
  const weak           = newResults.filter((r) => r.understanding?.taxonomy_validation_status === "weak").length;
  const needsReview    = newResults.filter((r) => r.understanding?.taxonomy_validation_status === "needs_manual_review").length;

  // Sources discarded by taxonomy (no domain match or no tags found)
  const discarded = results.filter((r) =>
    r.understanding?.taxonomy_validation_status === "no_domain_match" ||
    r.understanding?.taxonomy_validation_status === "no_tags_found"
  );

  if (newResults.length > 0) {
    process.stdout.write(
      `  [L4-taxonomy] ${newResults.length} processed: ` +
      `validated=${validated} weak=${weak} review=${needsReview} ` +
      `no_domain=${noDomainMatch} no_tags=${noTagsFound} fallback=${fallback}\n`
    );
    if (noDomainMatch + noTagsFound > 0) {
      process.stdout.write(
        `  [L4-taxonomy] ${noDomainMatch + noTagsFound} sources discarded by taxonomy gates ` +
        `(no_domain=${noDomainMatch}, no_tags=${noTagsFound})\n`
      );
    }
  }

  return {
    sources: results,
    discarded,
    counts: {
      total:           sources.length,
      already_done:    alreadyDone,
      llm_processed:   llmProcessed,
      fallback,
      validated,
      weak,
      needs_review:    needsReview,
      no_domain_match: noDomainMatch,
      no_tags_found:   noTagsFound,
      discarded:       discarded.length,
    },
  };
}
