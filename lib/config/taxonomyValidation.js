/**
 * Taxonomy validation — enforces the PDF assignment + validation rules.
 *
 * A primary threat tag may only be assigned when:
 *   • the tag exists in the registry AND is a primary_threat (not a secondary dimension)
 *   • the assigned domain matches the tag's domain
 *   • the source evidence directly describes the threat behaviour (a specific
 *     supporting quote), not generic AI-risk discussion
 *   • the source is traceable (has a URL or source id)
 *
 * Outputs validation_status ∈ {validated, weak, rejected, needs_manual_review}
 * plus a caveat. AI-enabled tags must carry a PAIRED mapping (operational ATT&CK
 * technique + AI capability modifier); T1588.007 alone is not acceptable.
 */

import {
  getTag, isPrimaryTag, isSecondaryDimension, domainOf,
} from "./taxonomyRegistry.js";

const CONFIDENCES = new Set(["high", "medium", "low"]);

// Phrases that signal generic AI-risk discussion rather than adversarial behaviour.
// Note: a quote matches "generic" only if it ALSO lacks an adversarial signal — so
// "ai safety risk in production LLM deployments" is NOT generic because the surrounding
// text will contain specific adversarial language. Only pure policy/ethics prose is caught.
const GENERIC_PHRASES = [
  "responsible ai", "ai ethics", "ai governance",
  "trustworthy ai", "ai principles", "broadly", "in general",
  "could potentially", "may pose risks", "raises concerns",
];
// "ai safety" and "ai risk" removed from generic phrases — these appear legitimately in
// technical threat descriptions (e.g. "AI safety guardrail bypassed", "AI risk of prompt injection").

// Verbs/nouns that indicate a concrete adversarial behaviour is described.
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
  // Generic only when it reads like risk-talk AND shows no adversarial signal.
  return generic && !adversarial;
}

function normalizeConfidence(c) {
  return CONFIDENCES.has(c) ? c : "medium";
}

/**
 * Validate a single proposed primary threat tag against its evidence + source.
 *
 * @param {{tag:string, domain?:string, primary_domain?:string,
 *          supporting_quote?:string, evidence?:string, reason?:string,
 *          confidence?:string,
 *          operational_attack_mapping?:string, ai_capability_modifier?:string}} rawTag
 * @param {object} source  - the source record (for URL/id traceability)
 * @param {object} [opts]  - { domain } assigned primary_domain fallback
 * @returns {{tag, domain, parent_tag, subdomain, confidence,
 *            validation_status, caveat_if_any,
 *            operational_mapping?, ai_capability_modifier?, reference_urls}}
 */
export function validateThreatTag(rawTag, source = {}, opts = {}) {
  const tag = rawTag?.tag;
  const reject = (caveat) => ({
    tag: tag || null, domain: null, parent_tag: null, subdomain: null,
    confidence: "low", validation_status: "rejected", caveat_if_any: caveat,
    reference_urls: [],
  });

  if (!tag) return reject("no tag supplied");

  // Secondary dimensions must never be assigned as primary threats.
  if (isSecondaryDimension(tag)) {
    return reject(`'${tag}' is a secondary dimension (qualifier/impact), not a primary threat tag`);
  }
  if (!isPrimaryTag(tag)) {
    return reject(`'${tag}' is not in the taxonomy registry`);
  }

  const entry         = getTag(tag);
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
      : "supporting quote too short to be specific (< 20 chars)";
  } else if (looksGeneric(quote)) {
    validation_status = "weak";
    caveat_if_any = "evidence reads as generic AI-risk discussion, not a specific threat behaviour";
  } else if (!traceable) {
    validation_status = "needs_manual_review";
    caveat_if_any = "source has no traceable URL or id";
  }

  const result = {
    tag,
    domain: entry.domain,
    parent_tag: entry.parent_tag,
    subdomain: entry.subdomain,
    confidence: normalizeConfidence(rawTag.confidence),
    validation_status,
    caveat_if_any,
    reference_urls: entry.reference_urls,
  };

  // AI-enabled tags must carry a paired operational mapping + AI modifier.
  if (entry.domain === "ai_enabled_threats") {
    const mapping = validateAiEnabledMapping({
      primary_threat_tag:        tag,
      operational_attack_mapping: rawTag.operational_attack_mapping || entry.operational_mapping,
      ai_capability_modifier:    rawTag.ai_capability_modifier || entry.ai_capability_modifier,
    });
    result.operational_mapping     = mapping.operational_attack_mapping;
    result.ai_capability_modifier  = mapping.ai_capability_modifier;
    if (!mapping.valid && validation_status === "validated") {
      result.validation_status = "weak";
      result.caveat_if_any = mapping.caveat;
    } else if (mapping.caveat && !result.caveat_if_any) {
      result.caveat_if_any = mapping.caveat;
    }
  }

  return result;
}

/**
 * Validate the paired operational mapping for an AI-enabled threat.
 * The operational technique must be present and must NOT be T1588.007 alone
 * (that is the AI capability modifier, not the operational technique).
 */
export function validateAiEnabledMapping({ primary_threat_tag, operational_attack_mapping, ai_capability_modifier } = {}) {
  const op  = String(operational_attack_mapping || "").trim();
  const mod = String(ai_capability_modifier || "").trim();

  const result = {
    primary_threat_tag: primary_threat_tag || null,
    operational_attack_mapping: op || null,
    ai_capability_modifier: mod || null,
    valid: true,
    caveat: null,
  };

  if (!op) {
    result.valid = false;
    result.caveat = "missing operational ATT&CK technique (paired mapping required)";
    return result;
  }
  // T1588.007 is a modifier, never the standalone operational technique.
  if (/^T1588\.007/i.test(op) && !mod) {
    result.valid = false;
    result.caveat = "T1588.007 is an AI capability modifier, not a standalone operational mapping";
    return result;
  }
  if (!mod) {
    result.valid = false;
    result.caveat = "missing AI capability modifier (paired mapping required)";
    return result;
  }
  // "Relevant ATT&CK technique required per case" is a registry placeholder, not a real technique.
  // The source must supply a concrete T-number; if it doesn't, downgrade to weak.
  if (/required per case/i.test(op)) {
    result.valid = false;
    result.caveat = "operational ATT&CK technique must be specified from the source evidence (e.g. T1059, T1078) — registry placeholder is not sufficient";
  }
  return result;
}

/**
 * Validate a list of proposed tags; returns validated/weak/rejected partitions.
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

/** Coerce a list of proposed secondary-dimension labels to the valid set. */
export function validateSecondaryDimensions(rawDims = []) {
  const out = [];
  for (const d of Array.isArray(rawDims) ? rawDims : []) {
    const tag = typeof d === "string" ? d : d?.tag;
    if (isSecondaryDimension(tag) && !out.includes(tag)) out.push(tag);
  }
  return out;
}
