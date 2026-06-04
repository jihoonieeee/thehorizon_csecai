/**
 * Taxonomy validation — enforces taxonomy-v9 assignment rules.
 *
 * Primary tag validation:
 *   - tag must exist in VALID_PRIMARY_TAGS
 *   - domain must match the tag's domain
 *   - supporting_quote required (≥ 20 chars, non-generic)
 *   - source must be traceable (has url or id)
 *
 * Sub-technique validation:
 *   - must exist in VALID_SUB_TECHNIQUES
 *   - must belong to the selected primary tag
 *   - supporting_quote required
 *
 * AI-enabled overlay validation:
 *   - ai_enabled_roles must be in AE01–AE09
 *   - ai_capabilities must be in VALID_AI_CAPABILITIES
 *   - ai_enabled=true without roles → downgrade to weak
 *
 * Outputs:
 *   validation_status ∈ { validated, weak, rejected, needs_manual_review }
 */

import {
  VALID_PRIMARY_TAGS, VALID_SUB_TECHNIQUES, VALID_AI_ENABLED_ROLES,
  VALID_AI_CAPABILITIES, TAXONOMY, SUB_TECHNIQUES,
  validateSubTechnique, isValidAiEnabledRole,
} from "./taxonomyRegistry.js";

const CONFIDENCES = new Set(["high", "medium", "low"]);

const GENERIC_PHRASES = [
  "responsible ai", "ai ethics", "ai governance",
  "trustworthy ai", "ai principles", "broadly", "in general",
  "could potentially", "may pose risks", "raises concerns",
];

const ADVERSARIAL_SIGNALS = [
  "attack", "exploit", "inject", "poison", "bypass", "jailbreak", "evade",
  "extract", "exfiltrat", "leak", "compromise", "hijack", "escape", "spoof",
  "manipulat", "abuse", "steal", "forge", "deepfake", "phish", "malware",
  "backdoor", "vulnerab", "breach", "tamper", "impersonat",
];

function hasTraceableSource(source) {
  return !!(source && (source.url || source.source_id || source.id));
}

function looksGeneric(quote) {
  const q = String(quote || "").toLowerCase();
  if (!q) return true;
  const generic     = GENERIC_PHRASES.some((p) => q.includes(p));
  const adversarial = ADVERSARIAL_SIGNALS.some((p) => q.includes(p));
  return generic && !adversarial;
}

function normalizeConfidence(c) {
  return CONFIDENCES.has(c) ? c : "medium";
}

/**
 * Validate a single proposed primary threat tag.
 */
export function validateThreatTag(rawTag, source = {}, opts = {}) {
  const tag = rawTag?.tag;
  const reject = (caveat) => ({
    tag: tag || null, domain: null, confidence: "low",
    validation_status: "rejected", caveat_if_any: caveat,
    reference_urls: [],
  });

  if (!tag) return reject("no tag supplied");
  if (!VALID_PRIMARY_TAGS.has(tag)) return reject(`'${tag}' is not in the taxonomy registry`);

  const entry = TAXONOMY[tag];
  const assignedDomain = rawTag.domain || rawTag.primary_domain || opts.domain || null;
  if (assignedDomain && assignedDomain !== entry.domain) {
    return reject(`domain mismatch: '${tag}' belongs to ${entry.domain}, not ${assignedDomain}`);
  }

  const quote = rawTag.supporting_quote || rawTag.evidence || "";
  const traceable = hasTraceableSource(source);

  let validation_status = "validated";
  let caveat_if_any = null;

  if (!quote || quote.trim().length < 20) {
    validation_status = traceable ? "weak" : "needs_manual_review";
    caveat_if_any = !quote || quote.trim().length === 0
      ? "no supporting quote provided"
      : "supporting quote too short (< 20 chars)";
  } else if (looksGeneric(quote)) {
    validation_status = "weak";
    caveat_if_any = "evidence reads as generic AI-risk discussion, not specific threat behaviour";
  } else if (!traceable) {
    validation_status = "needs_manual_review";
    caveat_if_any = "source has no traceable URL or id";
  }

  return {
    tag,
    domain: entry.domain,
    label: entry.label,
    confidence: normalizeConfidence(rawTag.confidence),
    validation_status,
    caveat_if_any,
    reference_urls: [],
    supporting_quote: rawTag.supporting_quote || rawTag.evidence || "",
    reason: rawTag.reason || "",
  };
}

/**
 * Validate a proposed sub-technique for a given primary tag.
 */
export function validateSubTechniqueTag(rawSub, primaryTag, source = {}) {
  const subtag = typeof rawSub === "string" ? rawSub : rawSub?.id || rawSub?.tag;
  const reject = (caveat) => ({
    id: subtag || null, parent_tag: primaryTag,
    validation_status: "rejected", caveat_if_any: caveat,
  });

  if (!subtag) return reject("no sub-technique id supplied");
  if (!VALID_SUB_TECHNIQUES.has(subtag)) return reject(`'${subtag}' is not a known sub-technique`);

  const def = SUB_TECHNIQUES[subtag];
  if (def.parent_tag !== primaryTag) {
    return reject(`'${subtag}' belongs to ${def.parent_tag}, not ${primaryTag}`);
  }

  const quote = typeof rawSub === "object" ? (rawSub.supporting_quote || "") : "";
  const traceable = hasTraceableSource(source);

  let validation_status = "validated";
  let caveat_if_any = null;

  if (!quote || quote.trim().length < 20) {
    validation_status = traceable ? "weak" : "needs_manual_review";
    caveat_if_any = "no supporting quote for sub-technique";
  } else if (looksGeneric(quote)) {
    validation_status = "weak";
    caveat_if_any = "sub-technique quote reads as generic";
  }

  return {
    id: subtag,
    parent_tag: primaryTag,
    validation_status,
    caveat_if_any,
    supporting_quote: quote,
  };
}

/**
 * Validate AI-enabled overlay fields.
 * Returns { valid, ai_enabled_roles, ai_capabilities, automation_level, autonomy_level, caveats }.
 */
export function validateAiEnabledOverlay(raw = {}) {
  const caveats = [];
  const roles = (Array.isArray(raw.ai_enabled_roles) ? raw.ai_enabled_roles : [])
    .filter((r) => {
      if (!isValidAiEnabledRole(r)) { caveats.push(`'${r}' is not a valid AE role`); return false; }
      return true;
    });

  const caps = (Array.isArray(raw.ai_capabilities) ? raw.ai_capabilities : [])
    .filter((c) => {
      if (!VALID_AI_CAPABILITIES.has(c)) { caveats.push(`'${c}' is not a valid ai_capability`); return false; }
      return true;
    });

  const AUTOMATION = new Set(["human_assisted", "semi_autonomous", "autonomous", "unknown"]);
  const AUTONOMY = new Set(["human_assisted", "semi_autonomous", "autonomous", "multi_agent", "unknown"]);

  const aiEnabled = raw.ai_enabled === true;

  if (aiEnabled && roles.length === 0) {
    caveats.push("ai_enabled=true but no valid ai_enabled_roles provided — downgraded");
  }

  return {
    valid: caveats.length === 0 || (aiEnabled && roles.length > 0),
    ai_enabled: aiEnabled,
    ai_enabled_roles: roles,
    ai_capabilities: caps,
    automation_level: AUTOMATION.has(raw.automation_level) ? raw.automation_level : "unknown",
    autonomy_level: AUTONOMY.has(raw.autonomy_level) ? raw.autonomy_level : "unknown",
    caveats,
  };
}

/**
 * Validate a list of proposed primary tags.
 */
export function validateThreatTags(rawTags = [], source = {}, opts = {}) {
  const all = (Array.isArray(rawTags) ? rawTags : []).map((t) => validateThreatTag(t, source, opts));
  return {
    all,
    validated:           all.filter((r) => r.validation_status === "validated"),
    weak:                all.filter((r) => r.validation_status === "weak"),
    rejected:            all.filter((r) => r.validation_status === "rejected"),
    needs_manual_review: all.filter((r) => r.validation_status === "needs_manual_review"),
  };
}

/**
 * Validate a list of sub-techniques against their primary tag.
 */
export function validateSubTechniques(rawSubs = [], primaryTag, source = {}) {
  if (!primaryTag) return { all: [], validated: [], rejected: [] };
  const all = (Array.isArray(rawSubs) ? rawSubs : [])
    .map((s) => validateSubTechniqueTag(s, primaryTag, source));
  return {
    all,
    validated: all.filter((r) => r.validation_status === "validated"),
    weak:      all.filter((r) => r.validation_status === "weak"),
    rejected:  all.filter((r) => r.validation_status === "rejected"),
  };
}

/**
 * Validate a full taxonomy assignment object.
 * Accepts the shape from normalizeTaxonomyAssignment or LLM output.
 */
export function validateFullAssignment(raw, source = {}) {
  const tagResults = validateThreatTags(
    (Array.isArray(raw.primary_tags) ? raw.primary_tags : []).map((t) => ({
      tag: t,
      supporting_quote: raw.tag_quotes?.[t] || "",
      confidence: raw.confidence || "medium",
    })),
    source,
    { domain: raw.primary_domain }
  );

  const subResults = {};
  for (const primaryTag of tagResults.validated.map((r) => r.tag)) {
    const subs = (Array.isArray(raw.sub_techniques) ? raw.sub_techniques : [])
      .filter((s) => {
        const id = typeof s === "string" ? s : s?.id;
        const def = id ? require("./taxonomyRegistry.js").SUB_TECHNIQUES?.[id] : null;
        return def?.parent_tag === primaryTag;
      });
    if (subs.length) {
      subResults[primaryTag] = validateSubTechniques(subs, primaryTag, source);
    }
  }

  const overlay = validateAiEnabledOverlay(raw);

  const overallStatus =
    tagResults.validated.length > 0 ? "validated" :
    tagResults.weak.length > 0 ? "weak" :
    tagResults.needs_manual_review.length > 0 ? "needs_manual_review" :
    "needs_manual_review";

  return {
    primary_tags:            tagResults,
    sub_techniques:          subResults,
    ai_enabled_overlay:      overlay,
    taxonomy_validation_status: overallStatus,
    taxonomy_validation_reasons: [
      ...tagResults.rejected.map((r) => r.caveat_if_any).filter(Boolean),
      ...overlay.caveats,
    ],
  };
}