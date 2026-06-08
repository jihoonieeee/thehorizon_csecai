/**
 * Layer 2 — Source Validation
 *
 * Determines whether a raw source from Layer 1 is valid, safe, and usable
 * before it is archived and passed to deeper pipeline layers.
 *
 * Hard gates (block immediately):
 *   - missing title
 *   - missing, unsafe, or private-IP URL
 *   - exact duplicate (same source ID or content hash already archived)
 *
 * Soft checks (recorded but do not block):
 *   - missing or unrecognised publisher
 *   - missing or implausible publish date
 *   - insufficient body text (< 50 chars)
 *   - low AI-cyber relevance (relevance_tier = "off_topic")
 *
 * Low-relevance sources from primary/high/curated trust tiers are passed
 * through with a flag rather than rejected — those publishers may cover
 * adjacent context worth keeping.
 */

import { checkUrlSafety } from "../validation/urlSafety.js";
import { assessAiRelevance } from "../validation/aiRelevance.js";

// Map internal urlSafety statuses to the pipeline.md schema values.
function mapUrlSafetyStatus(urlCheck) {
  if (!urlCheck) return "unknown";
  if (urlCheck.safe) return "safe";
  switch (urlCheck.status) {
    case "private_ip":
    case "unsafe_redirect":
      return "unsafe";
    case "unsafe_protocol":
      return "suspicious";
    default:
      return "unknown";
  }
}

const STRUCTURAL_BLOCKING_FLAGS = new Set([
  "missing_title",
  "missing_url",
  "unsafe_url",
  "duplicate_id",
  "duplicate_content",
]);

// Sources from authoritative publishers are kept even when AI-cyber relevance is low —
// they may carry adjacent context or policy value not captured by keyword scoring.
const AUTHORITATIVE_TIERS = new Set(["primary", "high", "curated"]);

/**
 * Validate a single raw source.
 *
 * @param {object} source       Normalised source from Layer 1
 * @param {object} context
 * @param {Set<string>} [context.knownIds]           Source IDs already archived
 * @param {Set<string>} [context.knownContentHashes] Content hashes already archived
 * @returns {Promise<ValidationResult>}
 */
export async function validateSource(source, context = {}) {
  const { knownIds = new Set(), knownContentHashes = new Set() } = context;

  const url = source.url || "";
  const has_title = Boolean(source.title?.trim());
  const has_body  = (source.full_text?.length ?? 0) >= 50;
  const validation_flags = [];

  // ── Hard gate 1: title ─────────────────────────────────────────────────────
  if (!has_title) {
    validation_flags.push("missing_title");
    return buildResult(source, {
      url, has_title, has_body, validation_flags,
      url_safety_status: "unknown",
      is_duplicate: false, duplicate_of: null,
      ai_cyber_relevant: false,
      relevance_tier: "off_topic",
      ai_relevance_score: 0,
      ai_specificity_score: 0,
    });
  }

  // ── Hard gate 2: URL safety (async HEAD for HTTP, sync for HTTPS) ──────────
  const urlCheck = url ? await checkUrlSafety(url) : null;
  const url_safety_status = mapUrlSafetyStatus(urlCheck);

  if (!urlCheck?.safe) {
    validation_flags.push(url ? "unsafe_url" : "missing_url");
    return buildResult(source, {
      url, has_title, has_body, validation_flags,
      url_safety_status,
      is_duplicate: false, duplicate_of: null,
      ai_cyber_relevant: false,
      relevance_tier: "off_topic",
      ai_relevance_score: 0,
      ai_specificity_score: 0,
    });
  }

  // ── Duplicate check ────────────────────────────────────────────────────────
  let is_duplicate = false;
  let duplicate_of = null;

  if (knownIds.has(source.id)) {
    is_duplicate = true;
    duplicate_of = source.id;
    validation_flags.push("duplicate_id");
  } else if (source.content_hash && knownContentHashes.has(source.content_hash)) {
    is_duplicate = true;
    duplicate_of = source.content_hash;
    validation_flags.push("duplicate_content");
  }

  // ── Soft checks ────────────────────────────────────────────────────────────
  if (!source.publisher || source.publisher === "Unknown") {
    validation_flags.push("missing_publisher");
  }

  if (!source.date_published) {
    validation_flags.push("no_publish_date");
  } else {
    const d = new Date(source.date_published);
    if (Number.isNaN(d.getTime())) {
      validation_flags.push("invalid_date_format");
    } else if (d.getFullYear() < 2020) {
      validation_flags.push("date_too_old");
    }
  }

  if (!has_body) {
    validation_flags.push("insufficient_text");
  }

  // ── AI-cyber relevance ─────────────────────────────────────────────────────
  const rel = assessAiRelevance(source);
  const ai_cyber_relevant = rel.relevance_tier !== "off_topic";

  // Low-relevance sources from authoritative publishers pass with a flag so
  // that their contextual value is preserved for downstream layers.
  if (!ai_cyber_relevant) {
    const tier = source.trust_tier || "unknown";
    if (["primary", "high", "curated"].includes(tier)) {
      validation_flags.push("low_relevance_authoritative");
    } else {
      validation_flags.push("low_ai_cyber_relevance");
    }
  }

  return buildResult(source, {
    url, has_title, has_body, validation_flags,
    url_safety_status,
    is_duplicate, duplicate_of,
    ai_cyber_relevant,
    relevance_tier: rel.relevance_tier,
    ai_relevance_score: rel.ai_relevance_score,
    ai_specificity_score: rel.ai_specificity_score,
  });
}

function buildResult(source, fields) {
  const hasStructuralFail = fields.validation_flags.some((f) => STRUCTURAL_BLOCKING_FLAGS.has(f));

  // Off-topic relevance is a hard block for non-authoritative sources.
  // Primary/high/curated publishers may cover adjacent context not captured by keyword scoring.
  const tier = source.trust_tier || "unknown";
  const relevanceFail = !fields.ai_cyber_relevant &&
    !AUTHORITATIVE_TIERS.has(tier) &&
    fields.validation_flags.includes("low_ai_cyber_relevance");

  const is_valid = !hasStructuralFail && !relevanceFail;
  const validity_reason = fields.validation_flags.length === 0
    ? "ok"
    : fields.validation_flags.join("; ");

  return {
    // Pipeline.md Layer 2 output schema
    source_id:        source.id,
    url:              fields.url,
    is_valid,
    validity_reason,
    publisher:        source.publisher || "",
    published_date:   source.date_published || null,
    has_title:        fields.has_title,
    has_body:         fields.has_body,
    url_safety_status: fields.url_safety_status,

    // Extended fields used by downstream layers
    is_duplicate:         fields.is_duplicate,
    duplicate_of:         fields.duplicate_of,
    ai_cyber_relevant:    fields.ai_cyber_relevant,
    relevance_tier:       fields.relevance_tier,
    ai_relevance_score:   fields.ai_relevance_score,
    ai_specificity_score: fields.ai_specificity_score,
    validation_flags:     fields.validation_flags,
  };
}
