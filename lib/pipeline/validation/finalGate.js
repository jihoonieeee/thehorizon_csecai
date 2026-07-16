/**
 * Validation 3.5 — Final Gate
 *
 * Combines the outputs of 3.1–3.4 into a single validation-layer decision.
 *
 * layer3_status values (also surfaced as validation_status):
 *   pass    — source proceeds to Layer 4
 *   reject  — source is discarded (invalid, excluded, or definitively off-topic)
 *   review  — source proceeds but is flagged for human review
 *
 * downstream_route values:
 *   layer4              — normal path
 *   layer4_with_review  — passes to Layer 4 but marked needs_review = true
 *   discard             — removed from pipeline
 */

// Soft flags that, when appearing ALONE without other weak signals, trigger "review"
// rather than rejection. Combined-weakness rules below override these.
const REVIEW_FLAGS = new Set([
  "minimal_text",
  "no_publish_date",
  "stale_publish_date",
]);

// Structured source types where thin content is NORMAL, not a quality failure.
// These should never be sent to review just for being short.
const STRUCTURED_SHORT_TYPES = new Set([
  "vulnerability", "advisory", "exploit_disclosure", "incident",
  "patch_note", "cve", "alert",
]);

// Operational evidence genres for the horizon scan. For these, AI is frequently
// the attacker's TOOL or the TARGET system rather than the article's subject
// (a Unit 42 campaign report, a CISA advisory, an incident write-up). The
// relevance LLM scores those "passing" → off_topic, which historically buried
// them in review/reject (operational RSS pass-rate ~10% vs arXiv/NVD ~88%; see
// docs/VALIDATION_CALIBRATION_AUDIT.md). When such a source is high/primary trust
// and carries a genuine AI nexus (LLM said "passing", not "none" → ai_specificity
// ≥ 20), we PASS it instead of routing to review. Strictly additive — these rows
// would otherwise be review or reject. Kill-switch: OPERATIONAL_GATE_OFF=1.
const OPERATIONAL_PASS_TYPES = new Set([
  "incident", "threat_intelligence", "vulnerability", "exploit_disclosure",
  "adversary_adoption_signal", "governance_signal",
  "news_article",  // incident/threat coverage from media outlets (The Record, BleepingComputer, etc.)
]);
const OPERATIONAL_AI_NEXUS_MIN_SPECIFICITY = 10;
const OPERATIONAL_GATE_ENABLED = process.env.OPERATIONAL_GATE_OFF !== "1";

/**
 * Build a route_reason_codes array explaining the routing decision for auditability.
 */
function reasonCodes(...codes) {
  return codes.filter(Boolean);
}

/**
 * @param {object} validity       — output of 3.1 checkSourceValidity
 * @param {object} relevance      — output of 3.2 assessAiRelevance (deterministic)
 * @param {object} typing         — source_type from LLM or deterministic fallback
 * @param {object} trust          — output of 3.4 annotateSourceContext (deterministic)
 * @param {object} [qualityOpts]
 * @param {string}  [qualityOpts.content_quality]      — LLM-assessed content quality
 * @param {string}  [qualityOpts.url_safety_status]    — URL resolution result
 * @param {boolean} [qualityOpts.url_reachable]        — URL reachability result
 * @param {string}  [qualityOpts.ai_threat_focus]      — LLM or deterministic focus verdict
 * @param {string}  [qualityOpts.llm_verdict]          — LLM routing verdict ("pass"|"review"|"reject"|null)
 * @param {string}  [qualityOpts.llm_rejection_reason] — LLM rejection reason when verdict="reject"
 * @param {string}  [qualityOpts.reading_value]        — LLM reading value (essential/recommended/analyst/background)
 * @param {object}  [qualityOpts.source]               — raw source object for paywall/thin text checks
 */
// Phrases that appear in the fetched text when a page is behind a paywall.
const PAYWALL_PHRASES = [
  "subscribe to continue reading",
  "subscribe to read",
  "sign in to read",
  "sign in to continue",
  "log in to read",
  "log in to continue",
  "create an account to read",
  "create a free account to",
  "member-only content",
  "members only",
  "premium content",
  "premium article",
  "subscription required",
  "unlock this article",
  "this content is for subscribers",
  "to continue reading, please",
  "register to read",
];

export function applyFinalGate(validity, relevance, typing, trust, qualityOpts = {}) {
  const {
    content_quality, url_safety_status, url_reachable, ai_threat_focus,
    llm_verdict = null, llm_rejection_reason = null,
    reading_value = null,
    source = null,
  } = qualityOpts;
  const sourceType = typing?.source_type || "unknown";
  const isStructured = STRUCTURED_SHORT_TYPES.has(sourceType);

  // ── Hard reject: URL safety failures ────────────────────────────────────
  if (url_safety_status === "domain_switch") {
    return {
      layer3_status:        "reject",
      final_validity_reason: "url_domain_switch: redirect changed registered domain",
      downstream_route:     "discard",
      route_reason_codes:   [],
    };
  }
  if (url_safety_status === "redirect_dead_end") {
    return {
      layer3_status:        "reject",
      final_validity_reason: "url_redirect_dead_end: redirect landed on link-shortener or social platform",
      downstream_route:     "discard",
      route_reason_codes:   [],
    };
  }

  // ── Hard reject: confirmed unreachable ───────────────────────────────────
  if (url_reachable === false) {
    return {
      layer3_status:        "reject",
      final_validity_reason: `url_unreachable: confirmed error response; trust_tier=${trust.trust_tier}`,
      downstream_route:     "discard",
      route_reason_codes:   [],
    };
  }

  // ── Hard reject: failed validity or excluded publisher ────────────────────
  if (!validity.is_valid || trust.trust_tier === "exclude") {
    return {
      layer3_status:        "reject",
      final_validity_reason: validity.validity_reason,
      downstream_route:     "discard",
      route_reason_codes:   [],
    };
  }

  // ── Paywall / thin-text gate ──────────────────────────────────────────────
  if (!isStructured && source) {
    const textLen = (source.full_text?.length || 0);
    const textLower = `${source.full_text || ""} ${source.summary || ""}`.toLowerCase();
    const hasPaywallPhrase = PAYWALL_PHRASES.some(p => textLower.includes(p));

    if (textLen < 600 && hasPaywallPhrase) {
      return {
        layer3_status:        "reject",
        final_validity_reason: "paywall_stub: text is a subscription prompt with no extractable content",
        downstream_route:     "discard",
        route_reason_codes:   reasonCodes("paywall_stub"),
      };
    }

    if (textLen < 200 && textLen > 0) {
      return {
        layer3_status:        "reject",
        final_validity_reason: `thin_text: only ${textLen} chars of text; insufficient for analysis`,
        downstream_route:     "discard",
        route_reason_codes:   reasonCodes("thin_text_reject"),
      };
    }
  }

  // ── Hard reject: defensive-capability sources ─────────────────────────────
  // Check both the LLM-assigned type and the stored type — the LLM may reclassify
  // a stored defensive_capability to something else in its reassessment.
  const storedSourceType = source?.source_type || "";
  if (sourceType === "defensive_capability" || storedSourceType === "defensive_capability") {
    return {
      layer3_status:        "reject",
      final_validity_reason: "defensive_capability: primary deliverable is a defense/mitigation, not an offensive finding",
      downstream_route:     "discard",
      route_reason_codes:   reasonCodes("defensive_capability_reject"),
    };
  }

  // ── Hard reject: AI is incidental ────────────────────────────────────────
  // Closes the contradiction when the LLM sets ai_threat_focus="passing"/"none"
  // but still returns verdict="pass".
  if (ai_threat_focus === "passing" || ai_threat_focus === "none") {
    return {
      layer3_status:        "reject",
      final_validity_reason: `ai_incidental: ai_threat_focus=${ai_threat_focus}; AI is not material to the threat`,
      downstream_route:     "discard",
      route_reason_codes:   reasonCodes("ai_incidental_reject"),
    };
  }

  // ── LLM verdict passthrough ───────────────────────────────────────────────
  if (llm_verdict !== null) {
    if (llm_verdict === "reject") {
      return {
        layer3_status:        "reject",
        final_validity_reason: `llm_reject: ${llm_rejection_reason || content_quality || "quality_or_relevance"}`,
        downstream_route:     "discard",
        route_reason_codes:   reasonCodes("llm_verdict_reject", llm_rejection_reason || content_quality),
      };
    }

    if (llm_verdict === "review") {
      return {
        layer3_status:        "reject",
        final_validity_reason: `llm_review_rejected: ${llm_rejection_reason || content_quality || ai_threat_focus || "borderline"}`,
        downstream_route:     "discard",
        route_reason_codes:   reasonCodes("llm_verdict_review_rejected", content_quality),
      };
    }

    // llm_verdict === "pass" — but still apply hard corpus-scope overrides.

    // Thin non-structured content has no extractable intelligence regardless of verdict.
    if (!isStructured && content_quality === "thin_content") {
      return {
        layer3_status:        "reject",
        final_validity_reason: "thin_content_override: insufficient text for evidence extraction (non-structured source)",
        downstream_route:     "discard",
        route_reason_codes:   reasonCodes("thin_content_reject"),
      };
    }

    // Background reading value = no distinct offensive intelligence.
    if (reading_value === "background") {
      return {
        layer3_status:        "reject",
        final_validity_reason: "background_reading_value: no distinct offensive intelligence; context-only or defensive-primary",
        downstream_route:     "discard",
        route_reason_codes:   reasonCodes("background_reject"),
      };
    }

    return {
      layer3_status:        "pass",
      final_validity_reason: `llm_pass: ${ai_threat_focus || "central"} / ${content_quality || "substantive"}`,
      downstream_route:     "layer4",
      route_reason_codes:   [],
    };
  }

  // ── Deterministic fallback (skipLlm or LLM failure) ──────────────────────
  // Everything below only runs when llm_verdict is null.

  if (relevance.relevance_tier === "off_topic") {
    const highOrPrimary = trust.trust_tier === "primary" || trust.trust_tier === "high";
    if (
      OPERATIONAL_GATE_ENABLED &&
      highOrPrimary &&
      OPERATIONAL_PASS_TYPES.has(sourceType) &&
      (relevance.ai_specificity_score || 0) >= OPERATIONAL_AI_NEXUS_MIN_SPECIFICITY
    ) {
      return {
        layer3_status:        "pass",
        final_validity_reason: `operational_ai_nexus_pass: type=${sourceType}; ai_specificity=${relevance.ai_specificity_score}; trust=${trust.trust_tier}`,
        downstream_route:     "layer4",
        route_reason_codes:   reasonCodes("operational_ai_nexus_pass", sourceType),
      };
    }

    return {
      layer3_status:        "reject",
      final_validity_reason: `off_topic: ai_specificity=${relevance.ai_specificity_score}; trust=${trust.trust_tier}`,
      downstream_route:     "discard",
      route_reason_codes:   [],
    };
  }

  if (validity.filter_flags.includes("possible_non_english")) {
    return {
      layer3_status:        "reject",
      final_validity_reason: `possible_non_english: trust_tier=${trust.trust_tier}`,
      downstream_route:     "discard",
      route_reason_codes:   [],
    };
  }

  const hasAnonOrigin = validity.filter_flags.includes("missing_publisher")
    && validity.filter_flags.includes("no_publish_date");
  if (hasAnonOrigin) {
    return {
      layer3_status:        "reject",
      final_validity_reason: `anonymous_undated: ${validity.validity_reason}`,
      downstream_route:     "discard",
      route_reason_codes:   [],
    };
  }

  if (validity.filter_flags.includes("stale_publish_date")) {
    return {
      layer3_status:        "reject",
      final_validity_reason: `stale_publish_date: trust_tier=${trust.trust_tier}`,
      downstream_route:     "discard",
      route_reason_codes:   [],
    };
  }

  if (content_quality === "marketing" || content_quality === "keyword_stuffing") {
    return {
      layer3_status:        "reject",
      final_validity_reason: `content_quality_reject: ${content_quality}`,
      downstream_route:     "discard",
      route_reason_codes:   reasonCodes("content_quality_fail", content_quality),
    };
  }

  if (content_quality === "thin_content") {
    if (isStructured) {
      return {
        layer3_status:        "pass",
        final_validity_reason: `thin_but_structured: ${sourceType} sources are intentionally concise`,
        downstream_route:     "layer4",
        route_reason_codes:   reasonCodes("thin_structured_pass", sourceType),
      };
    }
    return {
      layer3_status:        "reject",
      final_validity_reason: "thin_content: insufficient text for evidence extraction",
      downstream_route:     "discard",
      route_reason_codes:   reasonCodes("thin_content_reject"),
    };
  }

  if (ai_threat_focus === "adjacent") {
    return {
      layer3_status:        "pass",
      final_validity_reason: "adjacent_context_keep: AI-security reference context, not an offensive finding",
      downstream_route:     "layer4",
      route_reason_codes:   reasonCodes("adjacent_context_keep"),
    };
  }

  const hasReviewFlag = validity.filter_flags.some((f) => REVIEW_FLAGS.has(f));
  const unknownType   = typing.source_type === "unknown";

  if (hasReviewFlag || unknownType) {
    return {
      layer3_status:        "reject",
      final_validity_reason: validity.validity_reason,
      downstream_route:     "discard",
      route_reason_codes:   reasonCodes(unknownType ? "unknown_source_type" : null, hasReviewFlag ? "validity_flag" : null),
    };
  }

  return {
    layer3_status:        "pass",
    final_validity_reason: validity.validity_reason,
    downstream_route:     "layer4",
    route_reason_codes:   [],
  };
}
