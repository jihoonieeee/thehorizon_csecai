/**
 * Framework tag registry — category-organised view.
 *
 * Thin wrapper over the canonical Validated AI Threat Taxonomy registry
 * (lib/config/taxonomyRegistry.js), adding a by-domain view for convenient
 * lookups during evidence extraction and analytics.
 *
 * Canonical source of truth: lib/config/taxonomyRegistry.js
 * Import that directly for getTag / validate* / buildTaxonomyContextForPrompt.
 */

export {
  TAXONOMY,
  DOMAINS,
  PRIMARY_TAGS_BY_DOMAIN,
  SECONDARY_DIMENSIONS,
  VALID_PRIMARY_TAGS,
  VALID_SECONDARY_DIMENSIONS,
  getTag,
  domainOf,
  parentOf,
  childrenOf,
  referencesFor,
  buildTaxonomyContextForPrompt,
} from "../config/taxonomyRegistry.js";

import { TAXONOMY, PRIMARY_TAGS_BY_DOMAIN } from "../config/taxonomyRegistry.js";

/**
 * Tags grouped by domain, with the frameworks each domain references.
 * Shape: { <domain>: { frameworks: [...], tags: [tagName, ...] } }
 */
function buildCategoryView() {
  const result = {};
  for (const [domain, tags] of Object.entries(PRIMARY_TAGS_BY_DOMAIN)) {
    const frameworks = new Set();
    for (const tag of tags) {
      const e = TAXONOMY[tag];
      for (const ref of [e.primary_reference, ...e.secondary_references]) {
        if (ref) frameworks.add(ref.split(/\s|:/)[0]);
      }
    }
    result[domain] = { frameworks: [...frameworks].sort(), tags: [...tags].sort() };
  }
  return result;
}

export const FRAMEWORK_TAG_REGISTRY = buildCategoryView();
export const TAGS_BY_CATEGORY = PRIMARY_TAGS_BY_DOMAIN;

/** Return all tag names for a given domain. */
export function getTagsForCategory(category) {
  return FRAMEWORK_TAG_REGISTRY[category]?.tags || [];
}

/** Return all frameworks relevant to a given domain. */
export function getFrameworksForCategory(category) {
  return FRAMEWORK_TAG_REGISTRY[category]?.frameworks || [];
}
