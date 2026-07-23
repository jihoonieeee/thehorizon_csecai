/**
 * Canonical Publisher Classification (single source of truth)
 *
 * Three Layer-3 modules used to each maintain their own publisher keyword lists
 * (trustAssessment, originTracking, sourceQuality) and disagreed on the same
 * publisher — e.g. Google/Microsoft were "major_vendor" in one and "security_firm"
 * in another, AI labs were classified three different ways. That produced
 * contradictory evidence_role / independence_level / source_quality on the same
 * source.
 *
 * This module is now the ONLY place publisher keyword fragments live. It returns a
 * rich canonical class; each consumer maps it to the category vocabulary it
 * already uses (see classifyForTrust / classifyForOrigin), so existing behaviour
 * is preserved while the keyword lists are unified.
 *
 * Canonical classes:
 *   primary_authority — government / standards / CERT bodies
 *   ai_lab            — frontier AI labs (Anthropic, OpenAI, DeepMind, …)
 *   academic          — universities, arXiv, conferences, publishers
 *   security_firm     — security vendors / threat-intel firms
 *   major_vendor      — large general tech platforms (Google, Microsoft, …)
 *   media             — news outlets / blogs
 *   other             — none of the above
 */

const PRIMARY_AUTHORITY_FRAGMENTS = [
  "cisa", "nist", "ncsc", "csa.gov", "csa.gov.sg", "enisa", "mitre",
  "dhs.gov", "fbi.gov", "europol", "interpol", "whitehouse.gov",
  "cisa.gov", "nist.gov", "ncsc.gov.uk", "atlas.mitre.org",
];

const AI_LAB_FRAGMENTS = [
  "anthropic", "openai", "google deepmind", "deepmind",
  "mistral", "cohere", "stability ai",
];

const ACADEMIC_FRAGMENTS = [
  "arxiv", "university", "université", "instituto", "institute",
  "college", "academia", "research lab", "ieee", "acm.org", "usenix",
  "springer", "elsevier", "proceedings", ".edu", "arxiv.org",
];

const SECURITY_FIRM_FRAGMENTS = [
  "crowdstrike", "mandiant", "palo alto", "sentinelone", "trend micro",
  "elastic", "recorded future", "fortinet", "cisco", "splunk",
  "secureworks", "checkpoint", "rapid7", "tenable",
  "proofpoint", "bitdefender", "kaspersky", "eset", "malwarebytes",
  "watchguard", "sophossec", "infosec", "security research", "threat intelligence",
];

const MAJOR_VENDOR_FRAGMENTS = [
  "google", "microsoft", "meta", "amazon", "apple", "ibm",
];

const MEDIA_FRAGMENTS = [
  "wired", "ars technica", "arstechnica.com", "the register", "theregister.com",
  "bleeping", "zdnet", "dark reading", "krebs", "reuters", "bbc", "cnn",
  "thehackernews", "securityweek", "cyberscoop", "infosecurity",
  "helpnetsecurity", "threatpost",
  // Additional media/news outlets confirmed from corpus audits (batches 12–13)
  "csoonline", "cso online", "techtimes", "tech times",
  "security affairs", "securityaffairs",
  "therecord", "the record", "404 media",
  "techcrunch", "sc magazine", "scmagazine",
  "cybersecurity dive", "hackread", "hackernoon",
  "cybernexora", "innovaiden", "threat-modeling.com",
];

function haystack(source) {
  const pub = (source.publisher || "").toLowerCase();
  const url = (source.url || source.canonical_url || "").toLowerCase();
  return `${pub} ${url}`;
}

/**
 * Classify a source's publisher into a canonical class. Order matters:
 * authority → ai_lab → academic → security_firm → major_vendor → media.
 *
 * @param {object} source
 * @returns {"primary_authority"|"ai_lab"|"academic"|"security_firm"|"major_vendor"|"media"|"other"}
 */
export function classifyPublisherCanonical(source) {
  const hay = haystack(source);
  const connectorId = source.collection_metadata?.connector_id || "";

  if (PRIMARY_AUTHORITY_FRAGMENTS.some((f) => hay.includes(f)) ||
      connectorId.startsWith("cisa") || connectorId.startsWith("nist")) {
    return "primary_authority";
  }
  if (AI_LAB_FRAGMENTS.some((f) => hay.includes(f))) return "ai_lab";
  if (ACADEMIC_FRAGMENTS.some((f) => hay.includes(f)) ||
      connectorId.startsWith("arxiv")) {
    return "academic";
  }
  if (SECURITY_FIRM_FRAGMENTS.some((f) => hay.includes(f))) return "security_firm";
  if (MAJOR_VENDOR_FRAGMENTS.some((f) => hay.includes(f))) return "major_vendor";
  if (MEDIA_FRAGMENTS.some((f) => hay.includes(f))) return "media";
  return "other";
}

/**
 * Mapping for trustAssessment.js — AI labs are treated as major vendors for
 * evidence purposes (their security research is vendor-interested), and "other"
 * is preserved as the fallback.
 */
export function classifyForTrust(source) {
  const c = classifyPublisherCanonical(source);
  if (c === "ai_lab") return "major_vendor";
  return c;  // primary_authority | academic | security_firm | major_vendor | media | other
}

/**
 * Mapping for originTracking.js and sourceQuality.js — AI labs are primary
 * authorities, large vendors fold into security_firm, and the fallback is
 * "unknown" (not "other").
 */
export function classifyForOrigin(source) {
  const c = classifyPublisherCanonical(source);
  if (c === "ai_lab") return "primary_authority";
  if (c === "major_vendor") return "security_firm";
  if (c === "other") return "unknown";
  return c;  // primary_authority | academic | security_firm | media
}
