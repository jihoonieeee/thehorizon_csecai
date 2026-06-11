/**
 * Primary-Origin and Independence Tracking
 *
 * Deterministic inference of a source's role in the information chain.
 * No LLM calls.
 *
 * origin_role values:
 *   primary_origin       — source produced the original finding/data
 *   secondary_reporting  — source is reporting on another source's finding
 *   tertiary_commentary  — source is commenting on reporting about a finding
 *   unknown_origin       — cannot determine
 *
 * independence_level values:
 *   independent            — no conflict of interest detected
 *   vendor_interested      — publisher has commercial interest in the subject
 *   self_reported          — publisher is reporting about their own org/product
 *   circular_reporting_risk — same claim appears from multiple publishers citing same single source
 *   unknown                — cannot determine
 */

import { classifyForOrigin } from "./publisherClass.js";

// ── Secondary reporting signal phrases ───────────────────────────────────────

const SECONDARY_PHRASES = [
  "according to",
  "reported by",
  "citing",
  "based on a report from",
  "as reported by",
  "per a report from",
  "per researchers at",
  "researchers at",
  "as noted by",
  "referenced from",
  "sourced from",
  "originally reported by",
  "first reported by",
  "details were shared by",
];

const TERTIARY_PHRASES = [
  "reporting on a report",
  "commentary on",
  "analysis of the report",
  "responding to the claims",
  "reacting to the findings",
];

// ── Publisher class map ───────────────────────────────────────────────────────

function getPublisherClass(source) {
  // Prefer an upstream-assigned publisher_class (set by trustAssessment); fall
  // back to the canonical classifier so the keyword lists stay unified.
  if (source.publisher_class) return source.publisher_class;
  return classifyForOrigin(source);
}

// ── Extract cited source names from text ─────────────────────────────────────

function extractCitedSources(text) {
  const cited = [];
  const lowerText = text.toLowerCase();

  for (const phrase of SECONDARY_PHRASES) {
    const idx = lowerText.indexOf(phrase);
    if (idx !== -1) {
      // Extract the source name following the phrase (up to 50 chars)
      const snippet = text.slice(idx + phrase.length, idx + phrase.length + 60).trim();
      // Stop at sentence boundaries or common delimiters
      const match = snippet.match(/^([^,.;:()[\]\n]{3,50})/);
      if (match) {
        cited.push(match[1].trim());
      }
    }
  }

  // Also scan for explicit URL citations in text
  const urlMatches = text.match(/https?:\/\/[^\s"<>]{10,80}/g) || [];
  cited.push(...urlMatches.slice(0, 5));

  return [...new Set(cited)];
}

// ── Circular reporting detection state ───────────────────────────────────────
// Module-level registry for detecting when ≥3 distinct publishers cite the same
// origin. The registry MUST be reset and fully populated before labeling so the
// result is deterministic and never leaks across pipeline runs:
//
//   resetCircularRegistry()           — clear state at the start of every batch
//   prepopulateCircularRegistry(srcs) — register every source's citations first
//   inferOriginRole(source)           — then label (read-only against the registry)
//
// Populating the whole batch up front makes the ≥3-publisher verdict independent
// of processing order (validation runs concurrently), so the same input always
// yields the same independence labels.

const _circularRegistry = new Map(); // primaryOriginKey → Set of publisher IDs

function publisherKeyOf(source) {
  return (source.publisher || source.url || source.id || "unknown").toLowerCase();
}

/** Register a single source's cited origins into the registry. Idempotent. */
function registerCitations(source, citedSources) {
  if (!citedSources || citedSources.length === 0) return;
  const pubKey = publisherKeyOf(source);
  for (const cited of citedSources) {
    const key = cited.toLowerCase().slice(0, 40);
    if (!_circularRegistry.has(key)) _circularRegistry.set(key, new Set());
    _circularRegistry.get(key).add(pubKey);
  }
}

/**
 * Read-only check: does any origin cited by this source already have ≥3 distinct
 * publishers registered? Deterministic when the registry was pre-populated.
 * Falls back to registering-then-checking when used standalone (registry empty
 * for this source's citations), so single-source callers still work.
 */
function checkCircularReporting(source, citedSources) {
  if (!citedSources || citedSources.length === 0) return false;
  // Standalone safety: if the batch pre-pass did not run, register on the fly so
  // the function still behaves for direct per-source callers (e.g. debug scripts).
  registerCitations(source, citedSources);
  const pubKey = publisherKeyOf(source);
  for (const cited of citedSources) {
    const key = cited.toLowerCase().slice(0, 40);
    const publishers = _circularRegistry.get(key);
    // Closes the 2-outlet amplification hole: if ≥2 DISTINCT publishers cite the SAME
    // origin, neither is independent corroboration of it — both are derivative. (Only
    // fires when a shared origin is actually identified via citation, so it never
    // over-merges genuinely independent reporting.) Also: ≥1 OTHER publisher besides
    // this source citing the same origin makes this one a re-report, not an origin.
    if (publishers && publishers.size >= 2) return true;
    if (publishers) {
      let others = 0;
      for (const p of publishers) if (p !== pubKey) others++;
      if (others >= 1) return true;
    }
  }
  return false;
}

/** Reset the circular reporting registry (call between pipeline runs). */
export function resetCircularRegistry() {
  _circularRegistry.clear();
}

/**
 * Pre-populate the circular-reporting registry from a full batch of sources so
 * that subsequent inferOriginRole() calls produce order-independent verdicts.
 * Call resetCircularRegistry() first if reusing the module across runs.
 *
 * @param {object[]} sources
 */
export function prepopulateCircularRegistry(sources = []) {
  for (const source of sources) {
    const text = `${source.title || ""} ${source.summary || ""} ${source.full_text?.slice(0, 2000) || ""}`;
    registerCitations(source, extractCitedSources(text));
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Infer the origin role and independence level of a source.
 *
 * @param {object} source
 * @returns {{
 *   origin_role: "primary_origin"|"secondary_reporting"|"tertiary_commentary"|"unknown_origin",
 *   independence_level: "independent"|"vendor_interested"|"self_reported"|"circular_reporting_risk"|"unknown",
 *   primary_origin_url: string|null,
 *   cited_sources: string[],
 *   origin_reasoning: string,
 * }}
 */
export function inferOriginRole(source) {
  const text = `${source.title || ""} ${source.summary || ""} ${source.full_text?.slice(0, 2000) || ""}`;
  const lowerText = text.toLowerCase();
  const publisherClass = getPublisherClass(source);
  const sourceType = source.source_type || "unknown";
  const publisher = (source.publisher || "").toLowerCase();

  // ── Detect secondary reporting phrases ────────────────────────────────────
  const citedSources = extractCitedSources(text);
  const hasSecondaryPhrase = SECONDARY_PHRASES.some((p) => lowerText.includes(p));
  const hasTertiaryPhrase  = TERTIARY_PHRASES.some((p) => lowerText.includes(p));

  // ── Determine origin_role ─────────────────────────────────────────────────
  let origin_role;
  let origin_reasoning;
  let primary_origin_url = null;

  const primaryTypes = new Set([
    "vulnerability", "advisory", "exploit_disclosure", "incident", "research_finding",
    "official_statement", "threat_intelligence",
  ]);

  const primaryPublisherClasses = new Set(["primary_authority", "academic"]);

  // Web-discovery clustering already determined independence for syndicated /
  // derivative members (dedupeCandidates). That cluster signal is more reliable
  // than phrase heuristics: a syndicated repost or derivative coverage is
  // secondary reporting regardless of whether it uses an "according to" phrase.
  const webIndependence = source.source_independence_status;
  if (webIndependence === "syndicated" || webIndependence === "derivative") {
    origin_role = "secondary_reporting";
    origin_reasoning = `web-discovery cluster: ${webIndependence} of ${source.original_source_url || "original"}`;
    primary_origin_url = source.original_source_url || null;
  } else if (
    primaryTypes.has(sourceType) &&
    primaryPublisherClasses.has(publisherClass) &&
    !hasSecondaryPhrase
  ) {
    origin_role = "primary_origin";
    origin_reasoning = `${publisherClass} publisher with primary source type (${sourceType})`;
  } else if (hasTertiaryPhrase) {
    origin_role = "tertiary_commentary";
    origin_reasoning = "Text contains tertiary commentary phrases";
  } else if (hasSecondaryPhrase || (publisherClass === "media" && citedSources.length > 0)) {
    origin_role = "secondary_reporting";
    origin_reasoning = hasSecondaryPhrase
      ? `Text contains secondary reporting phrase; cited: ${citedSources.slice(0, 2).join(", ")}`
      : `Media source referencing ${citedSources.slice(0, 2).join(", ")}`;

    // Try to extract the primary origin URL from cited_sources
    const urlCited = citedSources.find((c) => c.startsWith("http"));
    if (urlCited) primary_origin_url = urlCited;
  } else if (
    sourceType === "threat_intelligence" && publisherClass === "security_firm"
  ) {
    // Security firm threat intel = primary for their OWN research
    origin_role = "primary_origin";
    origin_reasoning = "Security firm producing own threat intelligence";
  } else if (publisherClass === "media") {
    origin_role = "secondary_reporting";
    origin_reasoning = "Media outlet — typically secondary reporting";
  } else if (primaryPublisherClasses.has(publisherClass)) {
    origin_role = "primary_origin";
    origin_reasoning = `${publisherClass} publisher`;
  } else {
    origin_role = "unknown_origin";
    origin_reasoning = "Could not determine origin role from available signals";
  }

  // F17 — near-dup cluster representative: this story ran near-verbatim across N
  // other outlets (the members were removed in Layer 2; this row carries the
  // count). A syndicated story is secondary reporting, not a unique primary
  // origin — UNLESS this is itself an authority/academic source. This keeps a
  // widely-syndicated wire story from being counted as an independent origin.
  if (
    origin_role === "primary_origin" &&
    (source.near_duplicate_count || 0) >= 2 &&
    publisherClass !== "primary_authority" &&
    publisherClass !== "academic"
  ) {
    origin_role = "secondary_reporting";
    origin_reasoning = `syndicated cluster representative (${source.near_duplicate_count} near-duplicates) — not a unique primary origin`;
  }

  // ── Determine independence_level ──────────────────────────────────────────
  let independence_level;

  // Self-reported: publisher is subject of the article
  const titleLower = (source.title || "").toLowerCase();
  const isSelfReported = (
    (publisher && titleLower.includes(publisher.slice(0, 12))) ||
    (source.url && publisher && source.url.toLowerCase().includes(publisher.replace(/\s+/g, "").slice(0, 10)))
  );

  // Circular reporting: same claim from ≥3 publishers
  const isCircular = checkCircularReporting(source, citedSources);

  if (isCircular) {
    independence_level = "circular_reporting_risk";
  } else if (isSelfReported && origin_role !== "primary_origin") {
    independence_level = "self_reported";
  } else if (publisherClass === "security_firm") {
    // Security firms often have vendor interest unless it's a pure advisory
    const isNeutralType = ["vulnerability", "exploit_disclosure", "incident"].includes(sourceType);
    independence_level = isNeutralType ? "independent" : "vendor_interested";
  } else if (
    publisherClass === "primary_authority" ||
    publisherClass === "academic"
  ) {
    independence_level = "independent";
  } else {
    independence_level = "unknown";
  }

  return {
    origin_role,
    independence_level,
    primary_origin_url,
    cited_sources: citedSources.slice(0, 10),
    origin_reasoning,
  };
}
