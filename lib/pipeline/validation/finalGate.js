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
const OPERATIONAL_AI_NEXUS_MIN_SPECIFICITY = 10; // lowered from 20: captures incident reports
// where AI appears as an attack element, not just the article's primary subject
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
 * @param {string}  [qualityOpts.content_quality]    — LLM-assessed content quality
 * @param {string}  [qualityOpts.url_safety_status]  — URL resolution result
 * @param {boolean} [qualityOpts.url_reachable]      — URL reachability result
 * @param {string}  [qualityOpts.ai_threat_focus]    — LLM or deterministic focus verdict
 * @param {string}  [qualityOpts.llm_verdict]        — LLM routing verdict ("pass"|"review"|"reject"|null)
 * @param {string}  [qualityOpts.llm_rejection_reason] — LLM rejection reason when verdict="reject"
 * @returns {{
 *   layer3_status: "pass"|"reject"|"review",
 *   final_validity_reason: string,
 *   downstream_route: "layer4"|"layer4_with_review"|"discard",
 *   route_reason_codes: string[],
 * }}
 */
// Phrases that appear in the fetched text when a page is behind a paywall.
// Checked against lowercase full_text + summary concatenation.
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
    source = null,   // raw source object for paywall/thin text checks
  } = qualityOpts;
  const sourceType = typing?.source_type || "unknown";
  const isStructured = STRUCTURED_SHORT_TYPES.has(sourceType);
  const isCurated = trust.trust_tier === "curated";

  // ── Hard reject: URL safety failures ────────────────────────────────────
  // domain_switch: HTTP redirect landed on a completely different registered
  // domain — almost certainly a dead link, domain parking, or link hijack.
  // redirect_dead_end: redirect went to a known link-shortener or social
  // platform — the real content is not accessible at this URL.
  // Both are hard rejects regardless of trust tier; the URL simply does not
  // lead to the source content.
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

  // ── Soft reject: confirmed unreachable ───────────────────────────────────
  // Curated sources may be paywalled PDFs or offline references — pass them.
  // Everything else: unreachable = reject.
  if (url_reachable === false) {
    if (isCurated) {
      return {
        layer3_status:        "pass",
        final_validity_reason: `url_unreachable_curated: trust_tier=curated; proceeding`,
        downstream_route:     "layer4",
        route_reason_codes:   [],
      };
    }
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
  // Runs before the LLM passthrough so it overrides even an LLM "pass" verdict.
  // Curated sources are exempt (they may be paywalled PDFs imported manually).
  // Structured types (CVE, advisory, exploit_disclosure, incident) are exempt —
  // their value is in the structured fields, not prose length.
  if (!isCurated && !isStructured && source) {
    const textLen = (source.full_text?.length || 0);
    const textLower = `${source.full_text || ""} ${source.summary || ""}`.toLowerCase();
    const hasPaywallPhrase = PAYWALL_PHRASES.some(p => textLower.includes(p));

    // Paywalled: short text AND contains a subscription/login prompt
    if (textLen < 600 && hasPaywallPhrase) {
      return {
        layer3_status:        "reject",
        final_validity_reason: "paywall_stub: text is a subscription prompt with no extractable content",
        downstream_route:     "discard",
        route_reason_codes:   reasonCodes("paywall_stub"),
      };
    }

    // Extremely thin non-structured content (< 200 chars): no substance regardless
    if (textLen < 200 && textLen > 0) {
      return {
        layer3_status:        "reject",
        final_validity_reason: `thin_text: only ${textLen} chars of text; insufficient for analysis`,
        downstream_route:     "discard",
        route_reason_codes:   reasonCodes("thin_text_reject"),
      };
    }
  }

  // ── LLM verdict passthrough ───────────────────────────────────────────────
  // When the unified Layer 3 LLM call ran, use its verdict as the primary
  // quality/relevance routing signal. This block runs BEFORE the deterministic
  // off_topic, non-English, provenance, and quality blocks so the LLM's holistic
  // judgement is not overridden by keyword heuristics (novelty-signal rescue,
  // operational-AI-nexus pass) that fire on the deterministic path only.
  //
  // Structural hard overrides above (URL safety, validity) always apply.
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
      // Curated sources that the LLM is uncertain about still pass — they're
      // manually imported and we trust the curation decision over the LLM.
      if (isCurated) {
        return {
          layer3_status:        "pass",
          final_validity_reason: `llm_review_but_curated: proceeding`,
          downstream_route:     "layer4",
          route_reason_codes:   [],
        };
      }
      return {
        layer3_status:        "reject",
        final_validity_reason: `llm_review_rejected: ${llm_rejection_reason || content_quality || ai_threat_focus || "borderline"}`,
        downstream_route:     "discard",
        route_reason_codes:   reasonCodes("llm_verdict_review_rejected", content_quality),
      };
    }

    // llm_verdict === "pass" — trust it unconditionally; structural flags no longer downgrade.
    return {
      layer3_status:        "pass",
      final_validity_reason: `llm_pass: ${ai_threat_focus || "central"} / ${content_quality || "substantive"}`,
      downstream_route:     "layer4",
      route_reason_codes:   reasonCodes(ai_threat_focus === "adjacent" ? "adjacent_context_keep" : null),
    };
  }

  // ── Deterministic fallback (skipLlm or LLM failure) ──────────────────────
  // Everything below only runs when llm_verdict is null.

  // ── Hard reject: not genuinely about an AI threat ─────────────────────────
  // Exceptions:
  //   1. primary/high/curated sources get review (rule-based scoring may miss relevance)
  //   2. novelty_signal sources NEVER get pre-gate discarded — they go to review
  //      for human confirmation of potential emerging technique coverage.
  if (relevance.relevance_tier === "off_topic") {
    const hasNoveltyPath = relevance.relevance_path === "novelty_signal" ||
      relevance.relevance_path === "both";

    // ── Operational AI-nexus pass (P1 calibration) ────────────────────────────
    // High/primary-trust operational evidence with a real AI nexus (AI-as-tool /
    // AI-as-target / AI-as-enabling-tech). The relevance LLM marks these "passing"
    // because AI is not the article's *subject*, but for a horizon scan they ARE
    // first-class evidence. Pass instead of burying in review.
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

  // ── Hard reject: non-English ─────────────────────────────────────────────
  // Non-English sources produce unreliable LLM summaries. Reject unconditionally.
  if (validity.filter_flags.includes("possible_non_english")) {
    return {
      layer3_status:        "reject",
      final_validity_reason: `possible_non_english: trust_tier=${trust.trust_tier}`,
      downstream_route:     "discard",
      route_reason_codes:   [],
    };
  }

  // ── Hard reject: combined provenance weakness ─────────────────────────────
  // Anonymous origin (no publisher AND no publish date) → reject regardless of text.
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

  // ── Hard reject: stale sources ────────────────────────────────────────────
  if (validity.filter_flags.includes("stale_publish_date")) {
    return {
      layer3_status:        "reject",
      final_validity_reason: `stale_publish_date: trust_tier=${trust.trust_tier}`,
      downstream_route:     "discard",
      route_reason_codes:   [],
    };
  }

  // ── Deterministic fallback (skipLlm or LLM failure) ──────────────────────
  // Only reached when llm_verdict is null. Mirrors legacy behaviour.

  // Marketing / keyword-stuffing
  if (content_quality === "marketing" || content_quality === "keyword_stuffing") {
    return {
      layer3_status:        "reject",
      final_validity_reason: `content_quality_reject: ${content_quality}`,
      downstream_route:     "discard",
      route_reason_codes:   reasonCodes("content_quality_fail", content_quality),
    };
  }

  // Thin content (structured → pass; unstructured → reject)
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

  // Adjacent context
  if (ai_threat_focus === "adjacent") {
    return {
      layer3_status:        "pass",
      final_validity_reason: "adjacent_context_keep: AI-security reference context, not an offensive finding",
      downstream_route:     "layer4",
      route_reason_codes:   reasonCodes("adjacent_context_keep"),
    };
  }

  // Structural weakness flags → reject
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
