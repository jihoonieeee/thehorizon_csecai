import { ALL_SOURCE_TYPES } from "../../config/sourceTypes.js";

// All vocabulary-defined types are always accepted. "unknown" gets conditional
// treatment (flagged for human review rather than rejected outright).
const ACCEPTED_SOURCE_TYPES = new Set(ALL_SOURCE_TYPES.filter((t) => t !== "unknown"));

// PR newswire domains — high volume, almost never primary intelligence.
// Curated sources are exempt (they may legitimately syndicate through these).
const PR_WIRE_DOMAINS = new Set([
  "prnewswire.com", "businesswire.com", "globenewswire.com",
  "accesswire.com", "einpresswire.com", "prlog.org",
  "pitchengine.com", "prweb.com", "newswire.com", "cision.com",
]);

// Ephemeral CDN paths that expire and become dead URLs (warn, not reject).
// cdn.openai.com PDF links have historically 404'd within weeks.
const EPHEMERAL_CDN_RE = /^https:\/\/(cdn\.openai\.com|storage\.googleapis\.com|s3\.amazonaws\.com)\//;

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}

function isCurated(source) {
  return source.trust_tier === "curated" || (source.tags || []).includes("curated");
}

function getAcceptanceDecision(source) {
  if (!source.title || !source.url) {
    return { reject: true, reason: "missing_title_or_url" };
  }

  // Curated sources bypass all filtering — manually vetted
  if (isCurated(source)) return { reject: false };

  const url    = source.url;
  const domain = domainOf(url);

  // HTTPS required (http:// leaks data in transit; also flags malformed URLs)
  if (!url.startsWith("https://")) {
    return { reject: true, reason: "url_not_https" };
  }

  // Private / localhost hosts never belong in production corpus
  if (domain && PRIVATE_HOST_RE.test(domain)) {
    return { reject: true, reason: "private_host" };
  }

  // PR wire domains: high-volume press releases with negligible intelligence value
  if (domain && PR_WIRE_DOMAINS.has(domain)) {
    return { reject: true, reason: `pr_wire_domain:${domain}` };
  }

  // Ephemeral CDN paths: accept but flag — these links expire and become dead URLs
  if (EPHEMERAL_CDN_RE.test(url)) {
    return { reject: false, needsReview: true, reason: "ephemeral_cdn_url" };
  }

  // All controlled-vocabulary types are accepted unconditionally
  if (ACCEPTED_SOURCE_TYPES.has(source.source_type)) return { reject: false };

  // Unknown type: accept but flag for human review
  if (source.source_type === "unknown") {
    return { reject: false, needsReview: true, reason: "unknown_source_type" };
  }

  return { reject: true, reason: `unsupported_source_type:${source.source_type}` };
}

export function filterAcceptableSources(sources) {
  const accepted = [];
  const rejected = [];

  for (const source of sources) {
    const decision = getAcceptanceDecision(source);

    if (decision.reject) {
      rejected.push({
        id: source.id,
        title: source.title,
        url: source.url,
        publisher: source.publisher,
        source_type: source.source_type,
        reason: decision.reason,
      });
    } else {
      accepted.push(
        decision.needsReview
          ? { ...source, needs_review: true, needs_review_reason: decision.reason }
          : source
      );
    }
  }

  return { accepted, rejected };
}
