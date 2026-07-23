/**
 * Validation 3.4 — Source Context & Reliability Annotation
 *
 * Purpose: annotate a source with qualitative context about who produced it,
 * what role it can play as evidence, and how much it needs cross-checking.
 *
 * This layer does NOT decide whether a claim is true.
 * It does NOT produce a numeric credibility score.
 * Numeric confidence is produced later, at the evidence/claim level (L5A/L6),
 * after cross-source corroboration is assessed.
 *
 * ── OUTPUT FIELDS ─────────────────────────────────────────────────────────────
 *   trust_tier             — legacy coarse field kept for DB filters and display
 *   trust_tier_reason      — how trust_tier was assigned
 *
 *   publisher_class        — what kind of organisation published this
 *   evidence_role          — how this source should function as evidence
 *   independence_level     — whether the publisher is independent of the claim's subject
 *   verification_status    — whether the content has been cross-checked
 *   evidence_strength_hint — coarse hint used by L5A when evidence items are built
 *   reliability_notes      — human-readable caveats about this source
 */

import { classifyForTrust, classifyPublisherCanonical } from "./publisherClass.js";

// ── Publisher classification ──────────────────────────────────────────────────
// Keyword fragments live in the canonical classifier (publisherClass.js); this
// module maps the canonical class to the evidence-oriented vocabulary it uses
// (AI labs → major_vendor) and keeps the connector-trust-tier fallback.

function classifyPublisher(source) {
  const c = classifyForTrust(source);
  if (c !== "other") return c;

  // Fallback: check trust_tier if explicitly set by connector
  const existing = source.trust_tier;
  if (existing === "primary") return "primary_authority";
  if (existing === "high")    return "security_firm";

  return "other";
}

// ── Evidence role (from source_type) ─────────────────────────────────────────

const SOURCE_TYPE_TO_EVIDENCE_ROLE = {
  vulnerability:             "primary_fact",
  exploit_disclosure:        "technical_analysis",
  incident:                  "incident_report",
  research_finding:          "technical_analysis",
  capability_demonstration:  "technical_analysis",
  benchmark_evaluation:      "technical_analysis",
  threat_intelligence:       "technical_analysis",
  governance_signal:         "primary_fact",
  adversary_adoption_signal: "technical_analysis",
  defensive_capability:      "context_only",
  attack_surface_signal:     "context_only",
  societal_harm:             "incident_report",
};

// Media outlets produce secondary content regardless of source_type — a news site
// covering a research finding is still a secondary summary, not primary analysis.
// Uses the canonical classifier from publisherClass.js (single source of truth).
function isMediaPublisher(source) {
  return classifyPublisherCanonical(source) === "media";
}

function classifyEvidenceRole(source, publisherClass) {
  // Media always secondary regardless of source_type
  if (isMediaPublisher(source) || publisherClass === "media") return "secondary_summary";

  const fromType = SOURCE_TYPE_TO_EVIDENCE_ROLE[source.source_type];
  if (fromType) return fromType;

  // Heuristics when source_type is missing or unknown
  if (publisherClass === "primary_authority") return "primary_fact";
  if (publisherClass === "other")             return "discovery_lead";
  return "context_only";
}

// ── Independence level ────────────────────────────────────────────────────────

function classifyIndependence(source, publisherClass) {
  if (publisherClass === "primary_authority") return "independent";
  if (publisherClass === "academic")          return "independent";

  // Vendor reporting about threats to their own platform or customers is interested
  if (publisherClass === "major_vendor" || publisherClass === "security_firm") {
    const text = `${source.title || ""} ${source.validation_summary || ""}`.toLowerCase();
    // If the vendor is the subject (self-disclosure of their research/product)
    const pub = (source.publisher || "").toLowerCase();
    const mentionsSelf = text.includes(pub.split(" ")[0]) && pub.length > 3;
    return mentionsSelf ? "self_reported" : "vendor_interested";
  }

  if (publisherClass === "media")  return "unknown";  // media is secondary, varies
  return "unknown";
}

// ── Verification status ───────────────────────────────────────────────────────

function classifyVerificationStatus(source, publisherClass, independenceLevel) {
  // Government advisory or standard is treated as verified by default
  if (publisherClass === "primary_authority") return "verified";

  // Corroboration signals in collection metadata
  const corroboration = source.corroboration_status || source.collection_metadata?.corroboration_status;
  if (corroboration === "corroborated")         return "partially_verified";
  if (corroboration === "not_corroborated")     return "unverified";

  // Web-discovery sources have not been cross-checked
  if (source.source_origin === "web_discovery") return "needs_crosscheck";

  // A single vendor self-reporting → needs external crosscheck
  if (independenceLevel === "self_reported")    return "needs_crosscheck";
  if (independenceLevel === "vendor_interested") return "partially_verified";

  // Academic preprints (arXiv without peer-review signal) → needs crosscheck
  if (publisherClass === "academic") return "needs_crosscheck";

  if (publisherClass === "security_firm") return "partially_verified";
  if (publisherClass === "media")         return "unverified";

  return "unverified";
}

// ── Evidence strength hint ────────────────────────────────────────────────────
// A coarse categorical hint for L5A evidence item extraction. NOT a claim score.

function deriveEvidenceStrengthHint(publisherClass, evidenceRole, independenceLevel, verificationStatus) {
  // context_only or discovery_lead roles can never be strong evidence
  if (evidenceRole === "context_only" || evidenceRole === "discovery_lead") {
    return "context_only";
  }
  if (evidenceRole === "secondary_summary") return "weak";

  if (verificationStatus === "verified" && independenceLevel === "independent") {
    return "strong";
  }
  if (publisherClass === "primary_authority") return "strong";
  if (verificationStatus === "partially_verified" &&
      (publisherClass === "academic" || publisherClass === "security_firm" || publisherClass === "major_vendor")) {
    return "moderate";
  }
  if (verificationStatus === "needs_crosscheck") return "weak";

  return "weak";
}

// ── Trust tier (legacy coarse field) ─────────────────────────────────────────

const PUBLISHER_CLASS_TO_TRUST_TIER = {
  primary_authority: "primary",
  major_vendor:      "high",
  academic:          "high",
  security_firm:     "high",
  media:             "medium",
  other:             "medium",
};

const TRUST_RANK = { primary: 4, high: 3, curated: 3, medium: 2, low: 1, unknown: 0 };

function deriveTrustTier(source, publisherClass) {
  const existing = source.trust_tier === "curated" ? "medium" : source.trust_tier;
  const classTier = PUBLISHER_CLASS_TO_TRUST_TIER[publisherClass] || "medium";
  if (existing && existing !== "unknown") {
    // F16 — the connector tier is a PRIOR, not a final value. Connectors over-assign
    // (arXiv hard-codes "high", web discovery uses a domain map), so a media
    // republication arriving via a "high" feed should not stay "high". When the
    // content-derived publisher class clearly implies a LOWER tier, downgrade to it.
    // We never UPGRADE on class alone (that would inflate from a misclassified
    // publisher) — only the connector or curation can grant a higher tier.
    if (publisherClass && publisherClass !== "unknown" &&
        (TRUST_RANK[classTier] ?? 2) < (TRUST_RANK[existing] ?? 2)) {
      return { trust_tier: classTier, reason: `class_downgrade_from_${existing}:${publisherClass}` };
    }
    return { trust_tier: existing, reason: "connector_assigned" };
  }
  return { trust_tier: classTier, reason: `publisher_class:${publisherClass}` };
}

// ── Reliability notes ─────────────────────────────────────────────────────────

function buildReliabilityNotes(publisherClass, evidenceRole, independenceLevel, verificationStatus, source) {
  const notes = [];

  if (independenceLevel === "self_reported") {
    notes.push("Self-reported: publisher is also the subject — treat as unconfirmed until corroborated.");
  }
  if (independenceLevel === "vendor_interested") {
    notes.push("Vendor-interested: publisher has a commercial stake in the topic.");
  }
  if (verificationStatus === "needs_crosscheck") {
    notes.push("Needs crosscheck: single source or unverified claim — flag as early signal only.");
  }
  if (publisherClass === "academic" && verificationStatus === "needs_crosscheck") {
    notes.push("Academic preprint: not peer-reviewed — treat findings as preliminary.");
  }
  if (evidenceRole === "secondary_summary") {
    notes.push("Secondary summary: reports on another event — prefer primary source for citations.");
  }
  if (source.source_origin === "web_discovery") {
    notes.push("Web-discovered: not from a fixed trusted feed — verify before promoting to primary evidence.");
  }

  return notes;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Annotate a source with qualitative source context and reliability signals.
 *
 * Replaces the old numeric credibility-score model.
 * Downstream layers use these fields as filters and caveats, not weights.
 *
 * @param {object} source
 * @returns {{
 *   trust_tier: string,
 *   trust_tier_reason: string,
 *   publisher_class: string,
 *   evidence_role: string,
 *   independence_level: string,
 *   verification_status: string,
 *   evidence_strength_hint: string,
 *   reliability_notes: string[],
 * }}
 */
export function annotateSourceContext(source) {
  const publisher_class     = classifyPublisher(source);
  const evidence_role       = classifyEvidenceRole(source, publisher_class);
  const independence_level  = classifyIndependence(source, publisher_class);
  const verification_status = classifyVerificationStatus(source, publisher_class, independence_level);
  const evidence_strength_hint = deriveEvidenceStrengthHint(
    publisher_class, evidence_role, independence_level, verification_status
  );
  const reliability_notes = buildReliabilityNotes(
    publisher_class, evidence_role, independence_level, verification_status, source
  );
  const { trust_tier, reason: trust_tier_reason } = deriveTrustTier(source, publisher_class);

  return {
    trust_tier,
    trust_tier_reason,
    publisher_class,
    evidence_role,
    independence_level,
    verification_status,
    evidence_strength_hint,
    reliability_notes,
  };
}

// ── Deprecated alias ──────────────────────────────────────────────────────────
// Kept so any code that still calls assessTrustAndCredibility does not break.
// Will be removed once all callers are updated.
export function assessTrustAndCredibility(source) {
  return annotateSourceContext(source);
}
