/**
 * Backward-compat re-export wrapper for the analytics taxonomy layer.
 *
 * The old Layer 7.2A analytics taxonomy has been replaced by the new
 * Layer 5b.3 extractAnalyticsFeatures pipeline. This file re-exports
 * the public API in the old shape so callers that import `applyAnalyticsTaxonomies`
 * or the VALID_* vocab sets do not need to be updated immediately.
 *
 * The new modules to use directly:
 *   - lib/pipeline/analytics/extractAnalyticsFeatures.js  (Layer 5b.3)
 *   - lib/pipeline/analytics/analyticsEligibility.js      (Layer 5b.1)
 *   - lib/pipeline/analytics/analyticsProfiles.js         (Layer 5b.2)
 *   - lib/pipeline/analytics/runAnalyticsBranch.js        (Layer 5b orchestrator)
 */

export {
  VALID_ATTACK_VECTORS,
  VALID_ATTACK_SURFACES,
  VALID_AI_LAYERS,
  VALID_OPERATIONAL_STATUSES,
  VALID_MATURITIES,
  VALID_IMPACT_SCOPES,
  VALID_IMPACT_TYPES,
  VALID_SIGNAL_CLUSTERS,
  VALID_RECURRING_THEMES,
} from "./extractAnalyticsFeatures.js";

import { extractAnalyticsFeatures } from "./extractAnalyticsFeatures.js";
import { applyAnalyticsEligibility } from "./analyticsEligibility.js";
import { applyAnalyticsProfiles }    from "./analyticsProfiles.js";

/**
 * Apply analytics taxonomy to a batch of sources.
 * Backward-compat wrapper — sets both `analytics_features` (new) and
 * `analytics_taxonomy` (old shape) on each source.
 *
 * @param {object[]} sources
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipLlm=false]
 * @param {number}   [opts.concurrency=5]
 * @returns {Promise<object[]>}
 */
export async function applyAnalyticsTaxonomies(sources, opts = {}) {
  // Run eligibility + profiles so extractAnalyticsFeatures has the context it needs
  const withEligibility = applyAnalyticsEligibility(sources);
  const withProfiles    = applyAnalyticsProfiles(withEligibility);
  return extractAnalyticsFeatures(withProfiles, opts);
}
