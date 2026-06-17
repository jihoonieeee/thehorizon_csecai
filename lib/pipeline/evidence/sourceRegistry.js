/**
 * Source Registry — immutable provenance store.
 *
 * Every EvidencePacket's URL must trace through this registry.
 * LLMs must never generate URLs. All downstream URL resolution
 * must go through lookupSource(sourceId) or lookupEvidence(evidenceId).
 *
 * provenance_status values:
 *   "complete"      — source_url present, publisher present, publication_date present
 *   "incomplete"    — one or more required fields missing
 *   "unverifiable"  — URL fails basic checks or source is unknown trust
 *   "fabricated"    — URL detected as LLM-generated placeholder
 */

import { createHash } from "crypto";

// ── Common placeholder domains that indicate LLM-generated URLs ──────────────

const FABRICATED_DOMAIN_PATTERNS = [
  /^example\.com$/i,
  /^source\.org$/i,
  /^report\.com$/i,
  /^study\.net$/i,
  /^security-research\.com$/i,
  /^ai-threats\.org$/i,
  /^ai-security\.org$/i,
  /^threat-intelligence\.org$/i,
  /^cybersecurity-report\.com$/i,
  /^research-report\.org$/i,
];

// Domains that are allowed to use HTTP (non-HTTPS) — internal/localhost
const HTTP_EXEMPT_DOMAINS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractDomain(url) {
  if (!url || typeof url !== "string") return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Try naive extraction
    const m = url.match(/^https?:\/\/([^/]+)/i);
    return m ? m[1].replace(/^www\./, "") : null;
  }
}

function isFabricatedDomain(domain) {
  if (!domain) return false;
  return FABRICATED_DOMAIN_PATTERNS.some((p) => p.test(domain));
}

function computeContentHash(source) {
  const str = `${source.url || ""}|${source.title || ""}|${source.publisher || ""}`;
  return createHash("sha256").update(str).digest("hex").slice(0, 16);
}

/**
 * Determine provenance_status for a source based on its fields.
 */
function computeSourceProvenanceStatus(source) {
  const url       = source.url || source.source_url || "";
  const publisher = source.publisher || "";
  const pubDate   = source.date_published || source.publication_date || "";

  if (!url || !publisher || publisher === "Unknown" || !pubDate) {
    return "incomplete";
  }

  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    return "incomplete";
  }

  if (url.startsWith("http://")) {
    const domain = extractDomain(url);
    if (!HTTP_EXEMPT_DOMAINS.has(domain)) {
      // HTTP on non-exempt domain is unverifiable unless trust tier is known
      if (!source.trust_tier || source.trust_tier === "unknown") {
        return "unverifiable";
      }
    }
  }

  const domain = extractDomain(url);
  if (isFabricatedDomain(domain)) {
    return "unverifiable";
  }

  return "complete";
}

/**
 * Determine provenance_status for an evidence item.
 */
function computeEvidenceProvenanceStatus(evidenceItem) {
  const url   = evidenceItem.url || evidenceItem.source_url || "";
  const pub   = evidenceItem.publisher || "";
  const evId  = evidenceItem.evidence_id || "";
  const quote = evidenceItem.source_quote || evidenceItem.supporting_text || "";

  if (!url || !pub || !evId || !quote || quote.length < 10) {
    return "incomplete";
  }

  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    return "incomplete";
  }

  const domain = extractDomain(url);
  if (isFabricatedDomain(domain)) {
    return "unverifiable";
  }

  return "complete";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a registry of all sources, keyed by source_id.
 *
 * @param {object[]} sources
 * @returns {Map<string, object>} source_id → RegistryEntry
 */
export function buildSourceRegistry(sources) {
  const registry = new Map();

  for (const source of (sources || [])) {
    const source_id = source.id || source.source_id;
    if (!source_id) continue;

    const provenance_status = computeSourceProvenanceStatus(source);

    registry.set(source_id, {
      source_id,
      source_url:         source.url || source.source_url || null,
      source_title:       source.title || null,
      publisher:          source.publisher || null,
      publication_date:   source.date_published || source.publication_date || null,
      trust_tier:         source.trust_tier || "unknown",
      content_hash:       computeContentHash(source),
      retrieval_timestamp: source.retrieved_at || source.ingested_at || null,
      provenance_status,
    });
  }

  return registry;
}

/**
 * Build a registry of all evidence packets, keyed by evidence_id.
 *
 * @param {object[]} evidencePackets - Flat list of all evidence items
 * @returns {Map<string, object>} evidence_id → EvidenceRegistryEntry
 */
export function buildEvidenceRegistry(evidencePackets) {
  const registry = new Map();

  for (const item of (evidencePackets || [])) {
    const evId = item.evidence_id;
    if (!evId) continue;

    const provenance_status = computeEvidenceProvenanceStatus(item);

    registry.set(evId, {
      evidence_id:       evId,
      source_id:         item.source_id || null,
      source_url:        item.url || item.source_url || null,
      source_title:      item.source_title || null,
      publisher:         item.publisher || null,
      publication_date:  item.date || item.date_published || null,
      source_branch:     item.source_branch || null,
      source_type:       item.source_type || null,
      extracted_quote:   item.source_quote || item.supporting_text || null,
      retrieval_timestamp: item.retrieval_timestamp || null,
      provenance_status,
    });
  }

  return registry;
}

/**
 * Look up a source by ID in the registry.
 *
 * @param {string} sourceId
 * @param {Map}    registry
 * @returns {object|null}
 */
export function lookupSource(sourceId, registry) {
  return registry.get(sourceId) || null;
}

/**
 * Look up an evidence item by ID in the evidence registry.
 *
 * @param {string} evidenceId
 * @param {Map}    registry
 * @returns {object|null}
 */
export function lookupEvidence(evidenceId, registry) {
  return registry.get(evidenceId) || null;
}

/**
 * Validate a URL against the source and evidence registries.
 *
 * @param {string} url
 * @param {Map}    sourceRegistry
 * @param {Map}    [evidenceRegistry]
 * @returns {{ valid: boolean, reason: string }}
 */
export function validateUrl(url, sourceRegistry, evidenceRegistry) {
  if (!url || typeof url !== "string") {
    return { valid: false, reason: "url_missing" };
  }

  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    return { valid: false, reason: "invalid_scheme" };
  }

  const domain = extractDomain(url);
  if (isFabricatedDomain(domain)) {
    return { valid: false, reason: "fabricated_domain" };
  }

  // Check source registry
  for (const entry of sourceRegistry.values()) {
    if (entry.source_url === url) {
      return { valid: true, reason: "found_in_source_registry" };
    }
  }

  // Check evidence registry
  if (evidenceRegistry) {
    for (const entry of evidenceRegistry.values()) {
      if (entry.source_url === url) {
        return { valid: true, reason: "found_in_evidence_registry" };
      }
    }
  }

  return { valid: false, reason: "unregistered_url" };
}

/**
 * Collect all unique URLs from a source registry.
 *
 * @param {Map} sourceRegistry
 * @returns {Set<string>}
 */
export function getRegisteredUrls(sourceRegistry) {
  const urls = new Set();
  for (const entry of sourceRegistry.values()) {
    if (entry.source_url) urls.add(entry.source_url);
  }
  return urls;
}
