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

// ── Publisher classification ──────────────────────────────────────────────────

const PRIMARY_AUTHORITY_FRAGMENTS = [
  "cisa", "nist", "ncsc", "csa.gov", "enisa", "mitre",
  "dhs.gov", "fbi.gov", "europol", "interpol", "whitehouse.gov",
];

const MAJOR_VENDOR_FRAGMENTS = [
  "google", "microsoft", "meta", "amazon", "apple", "ibm",
];

const AI_LAB_FRAGMENTS = [
  "anthropic", "openai", "deepmind", "google deepmind",
  "mistral", "cohere", "stability ai",
];

const ACADEMIC_FRAGMENTS = [
  "arxiv", "university", "université", "instituto", "institute",
  "college", "academia", "research lab", "ieee", "acm", "usenix",
  "springer", "elsevier", "proceedings",
];

const SECURITY_FIRM_FRAGMENTS = [
  "crowdstrike", "mandiant", "palo alto", "sentinelone", "trend micro",
  "elastic", "recorded future", "fortinet", "cisco", "splunk",
  "secureworks", "checkpoint", "rapid7", "tenable",
  "proofpoint", "bitdefender", "kaspersky", "eset", "malwarebytes",
  "watchguard", "infosec", "security research", "threat intelligence",
];

function classifyPublisher(source) {
  const pub = (source.publisher || "").toLowerCase();
  const url = (source.url || source.canonical_url || "").toLowerCase();
  const hay = `${pub} ${url}`;
  const connectorId = source.collection_metadata?.connector_id || "";

  if (PRIMARY_AUTHORITY_FRAGMENTS.some((f) => hay.includes(f)) ||
      connectorId.startsWith("cisa") || connectorId.startsWith("nist")) {
    return "primary_authority";
  }
  if (AI_LAB_FRAGMENTS.some((f) => hay.includes(f))) {
    return "major_vendor";   // AI labs treated as major vendors for evidence purposes
  }
  if (ACADEMIC_FRAGMENTS.some((f) => hay.includes(f)) ||
      connectorId.startsWith("arxiv")) {
    return "academic";
  }
  if (MAJOR_VENDOR_FRAGMENTS.some((f) => hay.includes(f))) {
    return "major_vendor";
  }
  if (SECURITY_FIRM_FRAGMENTS.some((f) => hay.includes(f))) {
    return "security_firm";
  }

  // Fallback: check trust_tier if explicitly set by connector
  const existing = source.trust_tier;
  if (existing === "primary" || existing === "curated") return "primary_authority";
  if (existing === "high")                               return "security_firm";

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

// Media and "other" outlets produce secondary or discovery content regardless
// of what source_type says — a news site covering a research finding is still
// a secondary summary, not a primary technical analysis.
const MEDIA_FRAGMENTS = [
  "wired", "ars technica", "techcrunch", "the register", "bleeping",
  "zdnet", "dark reading", "krebs", "reuters", "bbc", "cnn", "thehackernews",
  "securityweek", "cyberscoop", "infosecurity", "helpnetsecurity",
];

function isMediaPublisher(source) {
  const hay = (source.publisher || "").toLowerCase();
  return MEDIA_FRAGMENTS.some((f) => hay.includes(f));
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

function deriveTrustTier(source, publisherClass) {
  const existing = source.trust_tier;
  if (existing && existing !== "unknown") {
    return { trust_tier: existing, reason: "connector_assigned" };
  }
  if (source.is_curated) {
    return { trust_tier: "curated", reason: "curated_flag" };
  }
  const tier = PUBLISHER_CLASS_TO_TRUST_TIER[publisherClass] || "medium";
  return { trust_tier: tier, reason: `publisher_class:${publisherClass}` };
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
