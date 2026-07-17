/**
 * classifySourceFamily()
 *
 * Pure deterministic function. Assigns a source_family to each source using
 * fields already set by the ingest + understand layers. No LLM call.
 *
 * source_family drives extraction routing: each family gets its own specialist
 * extractor with bespoke inclusion rules, prompt, and evidence schema additions.
 *
 * Priority order matters — a security-firm threat-intel report that happens to
 * come from a major vendor should be treated as threat_intel, not corporate_blog.
 */

export const SOURCE_FAMILIES = [
  "atlas_case_study",            // MITRE ATLAS structured case study
  "academic_paper",              // arXiv / peer-reviewed research
  "threat_intel_report",         // security-firm / government threat intelligence
  "major_capability_announcement", // new AI capability from major vendor
  "roundup_digest",              // multi-story digest or aggregation
  "corporate_blog",              // corporate blog (product / safety / policy posts)
  "news_blog",                   // default: news articles, security blogs, advisories
];

const MAJOR_VENDORS = new Set([
  "openai", "google", "microsoft", "anthropic", "meta", "amazon", "apple",
  "nvidia", "deepmind", "mistral", "cohere", "stability ai", "midjourney",
]);

const SECURITY_FIRMS = new Set([
  "mandiant", "crowdstrike", "palo alto", "unit 42", "sentinelone",
  "recorded future", "cisa", "ncsc", "nist", "cert", "google threat intelligence",
  "microsoft threat intelligence", "cisco talos", "checkpoint", "trend micro",
  "secureworks", "fireeye", "rapid7", "qualys", "tenable", "dragos",
  "darktrace", "cybereason", "vectra", "hiddenlayer", "protect ai",
]);

const CAPABILITY_SOURCE_TYPES = new Set([
  "capability_demonstration", "attack_surface_signal", "governance_signal",
]);

function publisherLC(source) {
  return (source.publisher || "").toLowerCase();
}

function connectorName(source) {
  return (source.collection_metadata?.connector_name || "").toLowerCase();
}

function isMajorVendor(source) {
  const pub = publisherLC(source);
  return [...MAJOR_VENDORS].some(v => pub.includes(v)) ||
    source.publisher_class === "major_vendor";
}

function isSecurityFirm(source) {
  const pub = publisherLC(source);
  return [...SECURITY_FIRMS].some(f => pub.includes(f)) ||
    source.publisher_class === "security_firm" ||
    source.publisher_class === "primary_authority";
}

/**
 * @param {object} source - Post-understand source object
 * @returns {string} One of SOURCE_FAMILIES
 */
export function classifySourceFamily(source) {
  // 1. MITRE ATLAS case study — highest priority, always use the ATLAS branch.
  if (source.intelligence?.atlas_id) return "atlas_case_study";

  const sourceType = source.source_type || "";
  const trustTier  = source.trust_tier  || "unknown";
  const isHighTrust = ["primary", "high"].includes(trustTier);

  // 2. Academic paper — arXiv connector or academic publisher class.
  if (
    sourceType === "research_finding" &&
    (
      source.publisher === "arXiv" ||
      connectorName(source) === "arxiv" ||
      source.publisher_class === "academic"
    )
  ) return "academic_paper";

  // 3. Threat intelligence report — source_type is the strongest signal; also
  //    catch security-firm high-trust sources that may carry other source_types.
  if (
    sourceType === "threat_intelligence" ||
    (isSecurityFirm(source) && isHighTrust && sourceType !== "research_finding")
  ) return "threat_intel_report";

  // 4. Roundup / digest — multi-story aggregation is identified by detectDigest
  //    or by content_quality flag from the understanding layer.
  if (source.is_digest === true || source.content_quality === "aggregation") {
    return "roundup_digest";
  }

  // 5. Major capability announcement — major vendor announcing a new capability
  //    that expands the AI attack surface or shifts the threat landscape.
  if (isMajorVendor(source) && CAPABILITY_SOURCE_TYPES.has(sourceType)) {
    return "major_capability_announcement";
  }

  // 6. Corporate blog — any other major-vendor post (product updates, safety
  //    research, policy statements). Sub-typed inside the extractor.
  if (isMajorVendor(source)) return "corporate_blog";

  // 7. Default.
  return "news_blog";
}
