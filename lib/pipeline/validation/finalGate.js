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
 * @param {object} relevance      — output of 3.2 assessAiRelevance
 * @param {object} typing         — output of 3.3 classifyDataType (source_type)
 * @param {object} trust          — output of 3.4 annotateSourceContext
 * @param {object} [qualityOpts]  — { content_quality, url_safety_status, url_reachable }
 * @returns {{
 *   layer3_status: "pass"|"reject"|"review",
 *   final_validity_reason: string,
 *   downstream_route: "layer4"|"layer4_with_review"|"discard",
 *   route_reason_codes: string[],
 * }}
 */
export function applyFinalGate(validity, relevance, typing, trust, qualityOpts = {}) {
  const { content_quality, url_safety_status, url_reachable, ai_threat_focus } = qualityOpts;
  const sourceType = typing?.source_type || "unknown";
  const isStructured = STRUCTURED_SHORT_TYPES.has(sourceType);

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

  // ── Soft reject: confirmed unreachable + untrusted source ────────────────
  // url_reachable=false means the server returned a confirmed error (4xx/5xx
  // other than 403/405). Trusted publishers (primary/high/curated) may have
  // legitimate access restrictions, so they proceed to review instead.
  if (url_reachable === false) {
    const trusted = trust.trust_tier === "primary" || trust.trust_tier === "high" || trust.trust_tier === "curated";
    if (!trusted) {
      return {
        layer3_status:        "reject",
        final_validity_reason: `url_unreachable: confirmed error response; trust_tier=${trust.trust_tier}`,
        downstream_route:     "discard",
        route_reason_codes:   [],
      };
    }
    // Trusted but unreachable → review (may be paywall, geo-block, or transient).
    return {
      layer3_status:        "review",
      final_validity_reason: `url_unreachable_trusted: trust_tier=${trust.trust_tier}`,
      downstream_route:     "layer4_with_review",
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

    // primary and curated are unconditional review — keyword scoring routinely
    // misses NVD CVEs about AI tooling (described by product name, not threat term)
    // and CISA/AI-lab advisories that use policy language rather than attack vocabulary.
    // Extending the curated bypass to primary prevents hard-rejecting authoritative feeds.
    if (trust.trust_tier === "primary" || trust.trust_tier === "curated") {
      return {
        layer3_status:        "review",
        final_validity_reason: `off_topic_but_${trust.trust_tier}`,
        downstream_route:     "layer4_with_review",
        route_reason_codes:   [],
      };
    }

    // high tier still requires a minimal AI signal to avoid flooding Layer 4 with
    // generic ML papers from arXiv or vendor announcements with a single "AI" mention.
    if (trust.trust_tier === "high") {
      const hasMinimalAiSignal = (relevance.ai_specificity_score || 0) >= 5 || hasNoveltyPath;
      if (hasMinimalAiSignal) {
        return {
          layer3_status:        "review",
          final_validity_reason: `off_topic_but_trusted: ai_specificity=${relevance.ai_specificity_score}; trust=${trust.trust_tier}`,
          downstream_route:     "layer4_with_review",
        route_reason_codes:   [],
        };
      }
      return {
        layer3_status:        "reject",
        final_validity_reason: `off_topic_trusted_no_ai_signal: ai_specificity=${relevance.ai_specificity_score}; trust=${trust.trust_tier}`,
        downstream_route:     "discard",
        route_reason_codes:   [],
      };
    }
    if (hasNoveltyPath) {
      return {
        layer3_status:        "review",
        final_validity_reason: `off_topic_but_novelty_signal: path=${relevance.relevance_path}; ai_specificity=${relevance.ai_specificity_score}`,
        downstream_route:     "layer4_with_review",
        route_reason_codes:   [],
      };
    }
    return {
      layer3_status:        "reject",
      final_validity_reason: `off_topic: ai_specificity=${relevance.ai_specificity_score}`,
      downstream_route:     "discard",
        route_reason_codes:   [],
    };
  }

  // ── Hard reject: non-English without trusted publisher ───────────────────
  // Non-English sources produce unreliable LLM summaries and mis-classified
  // entity extractions. Only primary/high/curated publishers are trusted enough
  // to be worth the uncertainty; everything else is discarded.
  if (validity.filter_flags.includes("possible_non_english")) {
    const trusted = trust.trust_tier === "primary" || trust.trust_tier === "high" || trust.trust_tier === "curated";
    if (!trusted) {
      return {
        layer3_status:        "reject",
        final_validity_reason: `possible_non_english: trust_tier=${trust.trust_tier}`,
        downstream_route:     "discard",
        route_reason_codes:   [],
      };
    }
    // Trusted non-English sources proceed but flagged for human review.
    return {
      layer3_status:        "review",
      final_validity_reason: `possible_non_english_but_trusted: trust_tier=${trust.trust_tier}`,
      downstream_route:     "layer4_with_review",
        route_reason_codes:   [],
    };
  }

  // ── Hard reject: combined provenance weakness ─────────────────────────────
  // A source with no known publisher AND no publish date is anonymous in both
  // origin and time. If it also has thin text, a stale date, or non-English
  // text, it cannot be trusted as intelligence — reject rather than review.
  const hasAnonOrigin = validity.filter_flags.includes("missing_publisher")
    && validity.filter_flags.includes("no_publish_date");
  if (hasAnonOrigin) {
    const alsoWeak = validity.filter_flags.some((f) =>
      f === "minimal_text" || f === "stale_publish_date"
    );
    if (alsoWeak) {
      return {
        layer3_status:        "reject",
        final_validity_reason: `anonymous_and_weak: ${validity.validity_reason}`,
        downstream_route:     "discard",
        route_reason_codes:   [],
      };
    }
    // Anonymous + undated but with substantive text → review (may still be useful).
    return {
      layer3_status:        "review",
      final_validity_reason: `anonymous_undated: ${validity.validity_reason}`,
      downstream_route:     "layer4_with_review",
        route_reason_codes:   [],
    };
  }

  // ── Downgrade stale sources without high trust ────────────────────────────
  // stale_publish_date sources from low/medium/unknown trust publishers are too
  // old to be current threat intelligence. Primary/high/curated sources may
  // still be historically significant (e.g. a 2018 NIST framework).
  if (validity.filter_flags.includes("stale_publish_date")) {
    const highTrust = trust.trust_tier === "primary" || trust.trust_tier === "high" || trust.trust_tier === "curated";
    if (!highTrust) {
      return {
        layer3_status:        "reject",
        final_validity_reason: `stale_publish_date_low_trust: trust_tier=${trust.trust_tier}`,
        downstream_route:     "discard",
        route_reason_codes:   [],
      };
    }
    // High-trust old source → review (historical context only).
    return {
      layer3_status:        "review",
      final_validity_reason: `stale_publish_date_trusted: trust_tier=${trust.trust_tier}`,
      downstream_route:     "layer4_with_review",
        route_reason_codes:   [],
    };
  }

  // ── Marketing / keyword-stuffing ─────────────────────────────────────────
  // Curated sources are KEPT (not deleted) but downgraded to context_only.
  // "Curated" means "keep for audit," not "bypass quality judgement."
  if (content_quality === "marketing" || content_quality === "keyword_stuffing") {
    if (trust.trust_tier === "curated") {
      return {
        layer3_status:        "review",
        final_validity_reason: `content_quality=${content_quality}_curated_downgraded_to_context_only`,
        downstream_route:     "layer4_with_review",
        route_reason_codes:   reasonCodes("curated_marketing_downgrade", content_quality),
      };
    }
    return {
      layer3_status:        "reject",
      final_validity_reason: `content_quality_reject: ${content_quality}`,
      downstream_route:     "discard",
      route_reason_codes:   reasonCodes("content_quality_fail", content_quality),
    };
  }

  // ── Thin content ──────────────────────────────────────────────────────────
  // EXCEPTION: structured short types (CVEs, advisories, exploits, incidents)
  // are intentionally brief — their value is in the structured metadata, not
  // the prose. Sending them to review just for being short is wrong.
  // Non-structured thin content → review as before.
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
      layer3_status:        "review",
      final_validity_reason: "thin_content: insufficient text for evidence extraction",
      downstream_route:     "layer4_with_review",
      route_reason_codes:   reasonCodes("thin_content_review"),
    };
  }

  // ── Adjacent context: keep & process, don't reject or shelve in review ────
  // The relevance LLM explicitly judged this a landmark AI-security REFERENCE
  // (framework/standard, dual-use autonomous capability, standalone defense, or
  // SoK) rather than an offensive finding. It is NOT off_topic (so it skipped the
  // reject block above) and it has already cleared the structural/quality checks.
  // Pass it so Layer 4 processes it — it will be tagged adjacent_context and mapped
  // to unclear_or_adjacent, off the offensive counts. Keyed on the LLM verdict, not
  // the deterministic keyword tier, so the offline path's behaviour is unchanged.
  if (ai_threat_focus === "adjacent") {
    return {
      layer3_status:        "pass",
      final_validity_reason: "adjacent_context_keep: AI-security reference context, not an offensive finding",
      downstream_route:     "layer4",
      route_reason_codes:   reasonCodes("adjacent_context_keep"),
    };
  }

  // ── Review: structural flags warrant human attention ─────────────────────
  const hasReviewFlag = validity.filter_flags.some((f) => REVIEW_FLAGS.has(f));
  const unknownType   = typing.source_type === "unknown";

  if (hasReviewFlag || unknownType) {
    return {
      layer3_status:        "review",
      final_validity_reason: validity.validity_reason,
      downstream_route:     "layer4_with_review",
      route_reason_codes:   reasonCodes(unknownType ? "unknown_source_type" : null, hasReviewFlag ? "validity_flag" : null),
    };
  }

  // ── Pass ──────────────────────────────────────────────────────────────────
  return {
    layer3_status:        "pass",
    final_validity_reason: validity.validity_reason,
    downstream_route:     "layer4",
    route_reason_codes:   [],
  };
}
