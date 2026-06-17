/**
 * Corpus Coverage & Bias Audit
 *
 * Deterministic assessment of source corpus quality for a given category.
 * No LLM calls. Flags structural limitations that govern what claim types are
 * valid, and produces a blocked_claim_types[] list for downstream enforcement.
 *
 * ── FLAG EFFECTS ON CLAIMS ────────────────────────────────────────────────────
 *   vendor_heavy           → block market_wide and ecosystem_wide strategic
 *                            claims ONLY; NOT all strategic assessment.
 *   research_heavy         → block adoption and operational claims;
 *                            ALLOW capability claims (lab findings are valid).
 *   operational_evidence_sparse → block adoption and real_world_factual claims.
 *   category_undercovered  → label as insufficiently assessed UNLESS strong
 *                            primary-source evidence exists (≥1 primary_origin
 *                            source with trust_tier=primary or academic).
 *   time_window_sparse     → block trend_over_time claims;
 *                            ALLOW emerging_signal claims with caveat.
 *
 * ── analysis_allowed VALUES ───────────────────────────────────────────────────
 *   full         — 0 or 1 flags; full analytical claims permitted
 *   limited      — 2+ flags; flagged claim types restricted (see blocked_claim_types)
 *   insufficient — critical flags; only capability/outlook/cautionary claims
 */

// ── Type classification helpers ───────────────────────────────────────────────

const RESEARCH_TYPES = new Set([
  "research_finding", "benchmark_evaluation", "capability_demonstration",
  "academic", "arxiv",
]);

const OPERATIONAL_TYPES = new Set([
  "incident", "threat_intelligence", "adversary_adoption_signal",
  "exploit_disclosure", "vulnerability",
]);

function getPublisherClass(source) {
  if (source.publisher_class) return source.publisher_class;
  const pub = (source.publisher || "").toLowerCase();
  const url = (source.url       || "").toLowerCase();

  if (
    pub.includes("cisa") || pub.includes("nist") || pub.includes("ncsc") ||
    pub.includes("csa") || pub.includes("enisa") || pub.includes("anthropic") ||
    pub.includes("openai") || url.includes("cisa.gov") || url.includes("nist.gov")
  ) return "primary_authority";

  if (
    pub.includes("arxiv") || pub.includes("university") || pub.includes("college") ||
    url.includes("arxiv.org") || url.includes(".edu")
  ) return "academic";

  if (
    pub.includes("crowdstrike") || pub.includes("mandiant") || pub.includes("palo alto") ||
    pub.includes("recorded future") || pub.includes("sentinelone") || pub.includes("trend micro") ||
    pub.includes("elastic") || pub.includes("cisco") || pub.includes("google") ||
    pub.includes("microsoft") || pub.includes("meta")
  ) return "security_firm";

  if (
    pub.includes("wired") || pub.includes("ars technica") || pub.includes("the register") ||
    pub.includes("bleeping computer") || pub.includes("dark reading")
  ) return "media";

  return "unknown";
}

function isVendorInterested(source) {
  return (
    source.independence_level === "vendor_interested" ||
    getPublisherClass(source) === "security_firm"
  );
}

function isResearch(source) {
  return RESEARCH_TYPES.has(source.source_type) || getPublisherClass(source) === "academic";
}

function isOperational(source) {
  return OPERATIONAL_TYPES.has(source.source_type);
}

function isPrimaryOrigin(source) {
  return (
    source.origin_role === "primary_origin" ||
    source.trust_tier === "primary" ||
    getPublisherClass(source) === "primary_authority" ||
    getPublisherClass(source) === "academic"
  );
}

// ── Time coverage helpers ─────────────────────────────────────────────────────

function getTimeWindows(sources) {
  const dates = sources
    .map((s) => s.date_published)
    .filter(Boolean)
    .map((d) => new Date(d))
    .filter((d) => !isNaN(d.getTime()))
    .map((d) => d.toISOString().slice(0, 7)); // YYYY-MM

  return [...new Set(dates)];
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build a corpus audit for a set of sources in a given category.
 *
 * @param {object[]} sources   - Array of source objects for this category
 * @param {string}   category  - Category label for reporting
 * @returns {object} corpus_audit
 */
export function buildCorpusAudit(sources, category) {
  const total = sources.length;

  // ── Counts by type and publisher ─────────────────────────────────────────
  const source_count_by_type = {};
  const source_count_by_publisher_class = {};
  const publisherCounts = {};

  for (const s of sources) {
    const type = s.source_type || "unknown";
    source_count_by_type[type] = (source_count_by_type[type] || 0) + 1;

    const pc = getPublisherClass(s);
    source_count_by_publisher_class[pc] = (source_count_by_publisher_class[pc] || 0) + 1;

    const pub = (s.publisher || "unknown").toLowerCase();
    publisherCounts[pub] = (publisherCounts[pub] || 0) + 1;
  }

  // ── Primary vs secondary ─────────────────────────────────────────────────
  const primaryCount   = sources.filter(isPrimaryOrigin).length;
  const secondaryCount = sources.filter((s) => !isPrimaryOrigin(s) && s.origin_role !== "unknown_origin").length;
  const unknownOriginCount = sources.filter((s) => !isPrimaryOrigin(s) && !s.origin_role || s.origin_role === "unknown_origin").length;

  const primary_vs_secondary_count = {
    primary:  primaryCount,
    secondary: secondaryCount,
    unknown:  unknownOriginCount,
  };

  // ── Vendor interest ────────────────────────────────────────────────────────
  const vendor_interested_count = sources.filter(isVendorInterested).length;

  // ── Unknown publisher ─────────────────────────────────────────────────────
  const unknown_publisher_count = sources.filter((s) => {
    const pub = s.publisher || "";
    return !pub || pub === "Unknown" || pub === "";
  }).length;

  // ── Time coverage ─────────────────────────────────────────────────────────
  const dates = sources
    .map((s) => s.date_published)
    .filter(Boolean)
    .map((d) => new Date(d))
    .filter((d) => !isNaN(d.getTime()))
    .sort((a, b) => a - b);

  const earliest = dates.length > 0 ? dates[0].toISOString().slice(0, 10) : null;
  const latest   = dates.length > 0 ? dates[dates.length - 1].toISOString().slice(0, 10) : null;
  const span_days = (earliest && latest)
    ? Math.round((new Date(latest) - new Date(earliest)) / (1000 * 60 * 60 * 24))
    : 0;

  const timeWindows = getTimeWindows(sources);
  const time_coverage = {
    earliest,
    latest,
    span_days,
    sparse: span_days < 30 || timeWindows.length < 2,
  };

  // ── Category coverage ─────────────────────────────────────────────────────
  const category_coverage = {};
  for (const s of sources) {
    const cat = s.main_category || s.candidate_domain || "unknown";
    category_coverage[cat] = (category_coverage[cat] || 0) + 1;
  }

  // ── Flag detection ─────────────────────────────────────────────────────────
  //
  // Threshold documentation (thresholds are documented here, not hidden):
  //
  //   single_publisher_dominance: > 50%
  //     Rationale: when one publisher provides more than half the evidence base,
  //     perspective diversity is insufficient for trend claims. A 50% majority
  //     is the natural threshold before a single source can dominate the signal.
  //
  //   vendor_heavy: vendor_interested > 60%
  //     Rationale: majority-vendor corpora have commercial incentive bias.
  //     60% (not 50%) allows meaningful vendor coverage — vendors produce real
  //     threat intelligence — while flagging corpora that are predominantly
  //     self-promotional.
  //
  //   research_heavy: research > 70% AND operational = 0
  //     Rationale: a corpus can be majority research (70%) and still be useful
  //     for capability claims IF there is any operational evidence. The zero
  //     operational check matters more than the 70% threshold — the threshold
  //     just prevents false positives on balanced corpora with 60–70% research.
  //
  // These are mechanical decision boundaries; the consequences (blocked claim types)
  // are documented in the file header and enforced downstream in claimQa.js.

  const source_concentration_flags = [];
  const evidence_gap_flags         = [];

  // single_publisher_dominance: one publisher > 50% of sources
  if (total > 0) {
    const maxPubCount = Math.max(...Object.values(publisherCounts));
    if (maxPubCount > total * 0.5) {
      const dominantPub = Object.entries(publisherCounts)
        .find(([, v]) => v === maxPubCount)?.[0] || "unknown";
      source_concentration_flags.push(`single_publisher_dominance:${dominantPub}`);
    }
  }

  // vendor_heavy: vendor_interested > 60% of sources
  if (total > 0 && vendor_interested_count > total * 0.6) {
    source_concentration_flags.push("vendor_heavy");
  }

  // research_heavy: research > 70% AND operational = 0
  const researchCount     = sources.filter(isResearch).length;
  const operationalCount  = sources.filter(isOperational).length;

  if (total > 0 && researchCount > total * 0.7 && operationalCount === 0) {
    source_concentration_flags.push("research_heavy");
  }

  // operational_evidence_sparse: no incident/adversary/threat_intel sources
  if (operationalCount === 0) {
    evidence_gap_flags.push("operational_evidence_sparse");
  }

  // category_undercovered: < 3 sources UNLESS strong primary-source evidence exists
  // Exception: ≥1 source with trust_tier=primary or publisher_class=primary_authority
  // or publisher_class=academic AND source has concrete main_category match.
  const hasPrimaryStrengthSource = sources.some(
    (s) => s.trust_tier === "primary" ||
            getPublisherClass(s) === "primary_authority" ||
            getPublisherClass(s) === "academic"
  );
  if (total < 3 && !hasPrimaryStrengthSource) {
    evidence_gap_flags.push("category_undercovered");
  } else if (total < 3 && hasPrimaryStrengthSource) {
    // Has strong primary source — not undercovered, but note it as thin
    evidence_gap_flags.push("category_thin_but_primary_sourced");
  }

  // time_window_sparse: block trend_over_time; allow emerging_signal with caveat
  if (time_coverage.sparse) {
    evidence_gap_flags.push("time_window_sparse");
  }

  // primary_sources_sparse
  if (primaryCount < 2) {
    evidence_gap_flags.push("primary_sources_sparse");
  }

  // too_many_unknown_publishers
  if (total > 0 && unknown_publisher_count > total * 0.4) {
    source_concentration_flags.push("too_many_unknown_publishers");
  }

  // ── Derive blocked_claim_types ────────────────────────────────────────────
  // Specific claim types that this corpus cannot support. Used by claimQa.js
  // to gate claims before synthesis output reaches slide planning.
  const blocked_claim_types = [];

  if (source_concentration_flags.includes("vendor_heavy")) {
    // Block only market_wide and ecosystem_wide — not all strategic assessment
    blocked_claim_types.push("market_wide");
    blocked_claim_types.push("ecosystem_wide");
  }
  if (source_concentration_flags.includes("research_heavy")) {
    // Block adoption and operational; capability is still allowed (lab findings)
    blocked_claim_types.push("adoption");
    blocked_claim_types.push("real_world_factual");
  }
  if (evidence_gap_flags.includes("operational_evidence_sparse")) {
    // Block adoption and real_world_factual claims
    if (!blocked_claim_types.includes("adoption")) blocked_claim_types.push("adoption");
    if (!blocked_claim_types.includes("real_world_factual")) blocked_claim_types.push("real_world_factual");
  }
  if (evidence_gap_flags.includes("time_window_sparse")) {
    // Block trend_over_time; emerging_signal is allowed (with caveat)
    blocked_claim_types.push("trend_over_time");
  }
  if (evidence_gap_flags.includes("category_undercovered")) {
    // Block strategic_assessment unless primary source exists (checked above)
    blocked_claim_types.push("strategic_assessment");
  }

  // ── analysis_allowed decision ─────────────────────────────────────────────
  const allFlags = [...source_concentration_flags, ...evidence_gap_flags].filter(
    (f) => f !== "category_thin_but_primary_sourced"
  );

  const criticalFlags = allFlags.filter((f) =>
    f === "operational_evidence_sparse" ||
    f === "primary_sources_sparse" ||
    f === "category_undercovered"
  );

  // insufficient: source_count < 2 OR (operational_sparse AND primary_sparse)
  const isInsufficient =
    total < 2 ||
    (
      evidence_gap_flags.includes("operational_evidence_sparse") &&
      evidence_gap_flags.includes("primary_sources_sparse")
    );

  let analysis_allowed;
  const analysis_limitations = [];

  if (isInsufficient) {
    analysis_allowed = "insufficient";
    if (total < 2) analysis_limitations.push("Fewer than 2 sources — cannot support analytical claims");
    if (evidence_gap_flags.includes("operational_evidence_sparse") && evidence_gap_flags.includes("primary_sources_sparse")) {
      analysis_limitations.push("No operational evidence and no primary sources — only speculative outlook permitted");
    }
  } else if (allFlags.length >= 2) {
    analysis_allowed = "limited";
    for (const flag of allFlags) {
      switch (flag) {
        case "vendor_heavy":
          // Block market_wide and ecosystem_wide claims only; not all strategic assessment
          analysis_limitations.push("Vendor-heavy corpus — market_wide and ecosystem_wide strategic claims are blocked; category-specific claims allowed with vendor-bias caveat");
          break;
        case "research_heavy":
          // Block adoption/operational; capability claims (lab findings) still valid
          analysis_limitations.push("Research-heavy corpus — adoption and operational claims are blocked; capability (lab) claims are allowed");
          break;
        case "time_window_sparse":
          // Block trend_over_time; allow emerging_signal with caveat
          analysis_limitations.push("Sparse time coverage — trend_over_time claims are blocked; emerging_signal claims allowed with caveat (single reporting window)");
          break;
        case "primary_sources_sparse":
          analysis_limitations.push("Few primary sources — findings depend on secondary reporting accuracy; all factual claims require caveat");
          break;
        case "operational_evidence_sparse":
          // Block adoption and real_world_factual only
          analysis_limitations.push("No confirmed operational evidence — adoption and real-world factual claims are blocked; capability and outlook claims allowed");
          break;
        case "category_undercovered":
          analysis_limitations.push("Category has fewer than 3 sources and no strong primary-source evidence — labeled insufficiently assessed; strategic_assessment blocked");
          break;
        default:
          if (flag.startsWith("single_publisher_dominance")) {
            analysis_limitations.push(`Single-publisher dominance detected — trend claims blocked; perspective diversity is insufficient`);
          }
      }
    }
  } else {
    analysis_allowed = "full";
  }

  return {
    category,
    source_count_by_type,
    source_count_by_publisher_class,
    primary_vs_secondary_count,
    vendor_interested_count,
    unknown_publisher_count,
    category_coverage,
    time_coverage,
    source_concentration_flags,
    evidence_gap_flags,
    analysis_allowed,
    analysis_limitations,
    blocked_claim_types,      // NEW: explicit list of blocked claim types for claimQa.js
  };
}
