/**
 * Source Intake Quality Layer
 *
 * Deterministic assessment of source usability independent of AI relevance.
 * No LLM calls. Returns a structured quality verdict with reason codes.
 *
 * source_quality_status values:
 *   usable             — suitable for full pipeline including trend/adoption claims
 *   usable_with_caveat — usable but with limitations (vendor interest, thin content)
 *   context_only       — can inform context but not be cited as primary evidence
 *   reject             — discard (marketing, SEO, entirely unknown provenance)
 *
 * Reason codes must come from the REASON_CODES set below — no ad-hoc strings.
 */

import { classifyForOrigin } from "./publisherClass.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const REASON_CODES = new Set([
  "missing_primary_origin",
  "vendor_interested",
  "marketing_framing",
  "thin_but_structured",
  "unsupported_statistical_claim",
  "circular_reporting_risk",
  "primary_source",
  "official_advisory",
  "peer_review_or_preprint",
  "incident_report",
  "threat_intel_report",
  "low_signal_blog",
  "seo_or_feed_content",
  "paywall_stub",
  "unknown_publisher",
  "stale_without_new_evidence",
]);

// Source types that are intentionally short/structured — short text is NOT a quality failure
const STRUCTURED_SHORT_TYPES = new Set([
  "vulnerability",
  "advisory",
  "exploit_disclosure",
  "incident",
  "patch_note",
]);

// ── Status ordering (lower index = better) ────────────────────────────────────
const STATUS_ORDER = ["usable", "usable_with_caveat", "context_only", "reject"];

function worstStatus(a, b) {
  const ia = STATUS_ORDER.indexOf(a);
  const ib = STATUS_ORDER.indexOf(b);
  return STATUS_ORDER[Math.max(ia >= 0 ? ia : 0, ib >= 0 ? ib : 0)];
}

// ── Publisher / content classification helpers ────────────────────────────────

function getPublisherClass(source) {
  // Prefer an upstream-assigned publisher_class (set by trustAssessment); fall
  // back to the canonical classifier so the keyword lists stay unified.
  if (source.publisher_class) return source.publisher_class;
  return classifyForOrigin(source);
}

function getContentQuality(source) {
  // Allow explicit content_quality to be set upstream
  if (source.content_quality) return source.content_quality;

  const text = `${source.title || ""} ${source.summary || ""} ${source.full_text?.slice(0, 500) || ""}`.toLowerCase();

  // Marketing framing signals
  const marketingSignals = [
    "our solution", "our product", "our platform", "download now", "free trial",
    "learn more", "schedule a demo", "contact us", "sign up", "get started",
    "industry-leading", "best-in-class", "cutting-edge solution",
    "whitepaper", "ebook", "webinar registration",
  ];
  const marketingHits = marketingSignals.filter((s) => text.includes(s)).length;
  if (marketingHits >= 2) return "marketing";

  // SEO / keyword stuffing
  const repeatedAiMentions = (text.match(/\bai\b/g) || []).length;
  if (repeatedAiMentions > 20 && (source.full_text?.length || 0) < 800) return "keyword_stuffing";

  // Thin content — short but not structured short type
  const textLen = (source.full_text?.length || source.summary?.length || 0);
  if (textLen < 300 && !STRUCTURED_SHORT_TYPES.has(source.source_type)) return "thin_content";

  return "adequate";
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Assess the intake quality of a source.
 *
 * @param {object} source
 * @returns {{
 *   source_quality_status: "usable"|"usable_with_caveat"|"context_only"|"reject",
 *   source_quality_reasons: string[],
 * }}
 */
export function assessSourceQuality(source) {
  const reasons = [];
  let status = "usable";

  const isStructuredShort = STRUCTURED_SHORT_TYPES.has(source.source_type);
  const textLen = source.full_text?.length ?? source.summary?.length ?? 0;
  const isCurated = source.trust_tier === "curated" || source.is_curated === true;

  const publisherClass = getPublisherClass(source);
  const contentQuality = getContentQuality(source);
  const trustTier = source.trust_tier || "unknown";

  // ── Structured short types: thin_but_structured is never a reject ──────────
  if (isStructuredShort && textLen < 200) {
    reasons.push("thin_but_structured");
    // NOT a reject — structured short sources are informative even when brief
  }

  // ── Primary source signals ─────────────────────────────────────────────────
  if (trustTier === "primary" || publisherClass === "primary_authority") {
    reasons.push("primary_source");
    status = worstStatus(status, "usable");

    if (
      source.source_type === "advisory" ||
      (source.title || "").toLowerCase().includes("advisory") ||
      (source.title || "").toLowerCase().includes("cve-")
    ) {
      reasons.push("official_advisory");
    }
  }

  // ── Academic sources ───────────────────────────────────────────────────────
  if (publisherClass === "academic") {
    reasons.push("peer_review_or_preprint");
    status = worstStatus(status, "usable");
  }

  // ── Security firm + threat_intel_report ───────────────────────────────────
  if (publisherClass === "security_firm" && source.source_type === "threat_intelligence") {
    reasons.push("threat_intel_report");
    status = worstStatus(status, "usable");
  }

  // ── Incident reports ───────────────────────────────────────────────────────
  if (source.source_type === "incident") {
    reasons.push("incident_report");
    status = worstStatus(status, "usable");
  }

  // ── Media / low signal blog ────────────────────────────────────────────────
  if (
    (trustTier === "medium" || trustTier === "low" || trustTier === "unknown") &&
    publisherClass === "media"
  ) {
    reasons.push("low_signal_blog");
    status = worstStatus(status, "usable_with_caveat");
  }

  // ── Vendor-interested independence ────────────────────────────────────────
  const independenceLevel = source.independence_level || "unknown";
  if (independenceLevel === "vendor_interested") {
    reasons.push("vendor_interested");
    status = worstStatus(status, "usable_with_caveat");
  }

  // Also infer vendor interest from publisher + source type
  if (
    publisherClass === "security_firm" &&
    source.source_type !== "threat_intelligence" &&
    source.source_type !== "vulnerability" &&
    source.source_type !== "exploit_disclosure"
  ) {
    if (!reasons.includes("vendor_interested")) {
      reasons.push("vendor_interested");
      status = worstStatus(status, "usable_with_caveat");
    }
  }

  // ── Marketing framing ─────────────────────────────────────────────────────
  if (contentQuality === "marketing") {
    reasons.push("marketing_framing");
    if (!isCurated) {
      status = worstStatus(status, "reject");
    } else {
      status = worstStatus(status, "context_only");
    }
  }

  // ── SEO / keyword stuffing ────────────────────────────────────────────────
  if (contentQuality === "keyword_stuffing") {
    reasons.push("seo_or_feed_content");
    status = worstStatus(status, "reject");
  }

  // ── Thin content (non-structured) → paywall stub ──────────────────────────
  if (contentQuality === "thin_content" && !isStructuredShort) {
    reasons.push("paywall_stub");
    status = worstStatus(status, "context_only");
  }

  // ── Unknown publisher + no date + very short ──────────────────────────────
  const hasPublisher = source.publisher && source.publisher !== "Unknown" && source.publisher !== "";
  const hasDate = !!source.date_published;

  if (!hasPublisher && !hasDate && textLen < 300) {
    if (!isCurated) {
      reasons.push("unknown_publisher");
      status = worstStatus(status, "reject");
    }
  } else if (!hasPublisher && publisherClass === "unknown") {
    reasons.push("missing_primary_origin");
    status = worstStatus(status, "usable_with_caveat");
  }

  // ── Stale content (pre-2020, not high trust, no new evidence signal) ───────
  if (source.date_published) {
    const year = new Date(source.date_published).getFullYear();
    const isHighTrust = trustTier === "primary" || trustTier === "high" || trustTier === "curated";
    // Relative cutoff (run year − 6) so the staleness boundary auto-advances.
    const staleCutoff = new Date().getFullYear() - 6;
    if (year < staleCutoff && !isHighTrust) {
      // Check for "new evidence" signals: explicit new evidence phrases
      const text = `${source.title || ""} ${source.summary || ""}`.toLowerCase();
      const hasNewEvidence = /new|2024|2025|2026|updated|revised|follow.?up/.test(text);
      if (!hasNewEvidence) {
        reasons.push("stale_without_new_evidence");
        status = worstStatus(status, "context_only");
      }
    }
  }

  // ── Circular reporting risk ───────────────────────────────────────────────
  if (source.independence_level === "circular_reporting_risk") {
    if (!reasons.includes("circular_reporting_risk")) {
      reasons.push("circular_reporting_risk");
      status = worstStatus(status, "usable_with_caveat");
    }
  }

  // Ensure at least one reason code
  if (reasons.length === 0) {
    reasons.push("primary_source");
  }

  return {
    source_quality_status:  status,
    source_quality_reasons: reasons,
  };
}
