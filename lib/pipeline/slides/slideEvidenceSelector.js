/**
 * Slide Evidence Selector
 *
 * Deterministic selection of evidence packets for each slide.
 * Enforces independence, quality, and usage rules — no numeric scoring.
 *
 * Selection priority:
 *   1. primary_origin over secondary_reporting
 *   2. independent over vendor_interested (unless vendor is original researcher)
 *   3. concrete named evidence (has entities, has numbers)
 *   4. chart_data: only chart_allowed statistical_use
 *   5. No duplicate_reporting items as separate proof
 *
 * evidence_sufficient = false triggers an evidence_gap slide instead of full claim slide.
 */

// ── Strength / admissibility rank ─────────────────────────────────────────────
//
// Shape-agnostic accessors: a packet may be an assembled dossier item (fields under
// `triage_data`), a canonical EvidencePacket (under `claim_relevance`), or a flat
// legacy shape. The old code read `packet.admissibility` top-level only — which is
// undefined on the dossier items this selector actually receives — so strong and
// usable both collapsed to one rank and the ordering was effectively dead. These read
// the real `evidence_strength` from whichever shape is present.

function pStrength(packet) {
  return packet?.triage_data?.evidence_strength
    || packet?.claim_relevance?.evidence_strength
    || packet?.evidence_strength
    || null;
}
function pAdmissibility(packet) {
  return packet?.triage_data?.admissibility
    || packet?.claim_relevance?.admissibility
    || packet?.admissibility
    || null;
}
function pMateriality(packet) {
  return packet?.triage_data?.materiality
    || packet?.claim_relevance?.materiality
    || packet?.materiality
    || "confirming";
}

const STRENGTH_RANK = { strong: 4, usable: 3, context: 2, archive: 0 };
const MATERIALITY_RANK = { novel: 3, escalating: 2, confirming: 1, redundant: 0 };

function admissibilityRank(packet) {
  const s = pStrength(packet);
  if (s && STRENGTH_RANK[s] != null) return STRENGTH_RANK[s];
  // No strength present — fall back to admissibility.
  switch (pAdmissibility(packet)) {
    case "passed":       return 3;
    case "context_only": return 2;
    case "failed":       return 0;
    default:             return 1;
  }
}

function isUsable(packet) {
  return admissibilityRank(packet) >= 2;
}

function isStrong(packet) {
  return admissibilityRank(packet) >= 3;
}

// ── Source quality rank ───────────────────────────────────────────────────────

function pOriginRole(packet) {
  return packet?.independence?.origin_role || packet?.origin_role || null;
}
function pIndependence(packet) {
  return packet?.independence?.independence_level || packet?.independence_level || null;
}
function pStatisticalUse(packet) {
  return packet?.method?.statistical_use || packet?.statistical_use || null;
}
function pMethodQuality(packet) {
  return packet?.method?.method_quality || packet?.method_quality || null;
}

function originRank(packet) {
  switch (pOriginRole(packet)) {
    case "primary_origin":      return 3;
    case "secondary_reporting": return 2;
    case "tertiary_commentary": return 1;
    default:                    return 1;
  }
}

function independenceRank(packet) {
  switch (pIndependence(packet)) {
    case "independent":             return 3;
    case "vendor_interested":       return 2; // vendor may be the primary researcher
    case "self_reported":           return 1;
    case "amplified_reporting":     return 0;
    case "circular_reporting_risk": return 0;
    default:                        return 2;
  }
}

function isConcrete(packet) {
  const hasEntities = (packet.key_entities || packet.entities || []).length > 0;
  const hasNumbers  = (packet.important_numbers || packet.numbers_statistics || []).length > 0;
  return hasEntities || hasNumbers;
}

function isChartAllowed(packet) {
  const su = pStatisticalUse(packet);
  return (
    su === "chart_allowed" ||
    // If statistical_use not set, allow if it has numbers and is strong
    (!su && isStrong(packet) && isConcrete(packet))
  );
}

function isDuplicateReporting(packet) {
  const ind = pIndependence(packet);
  return ind === "circular_reporting_risk" || ind === "amplified_reporting" ||
    pOriginRole(packet) === "tertiary_commentary";
}

// ── Sorting comparator ────────────────────────────────────────────────────────

function sortPackets(packets) {
  return [...packets].sort((a, b) => {
    // 1. Admissibility
    const admDiff = admissibilityRank(b) - admissibilityRank(a);
    if (admDiff !== 0) return admDiff;

    // 2. Origin role
    const originDiff = originRank(b) - originRank(a);
    if (originDiff !== 0) return originDiff;

    // 3. Independence
    const indepDiff = independenceRank(b) - independenceRank(a);
    if (indepDiff !== 0) return indepDiff;

    // 4. Concreteness
    const concA = isConcrete(a) ? 1 : 0;
    const concB = isConcrete(b) ? 1 : 0;
    if (concB !== concA) return concB - concA;

    // 5. Significance (materiality) — a pivotal signal over a routine one.
    return (MATERIALITY_RANK[pMateriality(b)] ?? 1) - (MATERIALITY_RANK[pMateriality(a)] ?? 1);
  });
}

// ── Auto-caveat generation ────────────────────────────────────────────────────

function generateCaveats(selected, corpusAudit) {
  const caveats = [];

  // From individual packets (shape-agnostic field reads)
  for (const ep of selected) {
    const indep = pIndependence(ep);
    if (indep === "vendor_interested") {
      caveats.push("Source has vendor interest — findings may reflect commercial perspective");
    }
    if (indep === "circular_reporting_risk" || indep === "amplified_reporting") {
      caveats.push("Multiple sources citing same origin — treat as single data point");
    }
    if (pStatisticalUse(ep) === "text_only_with_caveat") {
      caveats.push("Statistical data has methodology caveats — do not present as standalone chart");
    }
    const mq = pMethodQuality(ep);
    if (mq === "unclear_method" || mq === "anecdotal") {
      caveats.push("Quantitative data lacks clear methodology context");
    }
    const lims = ep.claim_relevance?.limitations || ep.triage_data?.limitations || ep.limitations || [];
    for (const lim of lims) {
      if (typeof lim === "string" && lim.length > 0) {
        caveats.push(lim);
      }
    }
  }

  // From corpus audit
  if (corpusAudit) {
    for (const lim of (corpusAudit.analysis_limitations || []).slice(0, 2)) {
      caveats.push(lim);
    }
  }

  // Deduplicate
  return [...new Set(caveats)];
}

// ── Provenance-based pre-selection filter (Phase 10) ─────────────────────────

function provenanceStatus(packet) {
  return packet?.provenance?.provenance_status || packet?.provenance_status || null;
}

function factQaSupportLevel(packet) {
  return packet?.fact_qa?.support_level || null;
}

function blockedForUse(packet, use) {
  return (packet?.fact_qa?.blocked_uses || []).includes(use);
}

function isDuplicateReportingItem(packet) {
  // Phase 4A: duplicate_reporting from clusterEvidenceItems
  return packet?.duplicate_reporting === true;
}

/**
 * Apply provenance and fact QA pre-selection filters to a packet list.
 *
 * Excluded:
 *   - provenance_status = "fabricated"
 *   - provenance_status = "unverifiable" (demoted to context only)
 *   - fact_qa.support_level = "unsupported"
 *   - duplicate_reporting=true and primary_origin=false → excluded from primary; context only
 *
 * @param {object[]} packets
 * @param {string}   [slideUse] - the slide's required use (e.g. "fact_support", "case_study")
 * @returns {{ primary: object[], contextOnly: object[], excluded: object[], caveats: string[] }}
 */
function applyProvenancePreFilter(packets, slideUse) {
  const primary     = [];
  const contextOnly = [];
  const excluded    = [];
  const caveats     = [];

  for (const ep of (packets || [])) {
    const ps  = provenanceStatus(ep);
    const sls = factQaSupportLevel(ep);

    if (ps === "fabricated") {
      excluded.push(ep);
      continue;
    }

    if (sls === "unsupported") {
      excluded.push(ep);
      continue;
    }

    if (slideUse && blockedForUse(ep, slideUse)) {
      excluded.push(ep);
      continue;
    }

    if (ps === "unverifiable") {
      // Only allow if evidence_strength is "strong"
      const s = pStrength(ep);
      if (s !== "strong") {
        contextOnly.push(ep);
        caveats.push("Evidence has unverifiable provenance — used for context only");
        continue;
      }
    }

    if (isDuplicateReportingItem(ep)) {
      contextOnly.push(ep);
      continue;
    }

    if (ps === "incomplete") {
      // Incomplete provenance: only allow if strong
      const s = pStrength(ep);
      if (s !== "strong" && s !== "usable") {
        contextOnly.push(ep);
        caveats.push("Evidence has incomplete provenance (missing URL, publisher, or quote)");
        continue;
      }
    }

    if (ep?.fact_qa?.requires_caveat) {
      caveats.push(`Source note: ${ep.fact_qa.support_level === "vendor_claim" ? "vendor-reported data" : ep.fact_qa.support_level}`);
    }

    if (ep?.source_intent?.tone_evidence_mismatch === "hype_without_evidence") {
      caveats.push("Source uses promotional/hype language without strong evidence backing");
    }

    primary.push(ep);
  }

  return { primary, contextOnly, excluded, caveats };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Select evidence packets for a single slide.
 *
 * @param {object}   slidePlan       - A single slide plan object from planSlides()
 * @param {object[]} evidencePackets - All available evidence packets for this category
 * @param {object}   [sourceIndex]   - Optional map of source_id → source object
 * @param {object}   [corpusAudit]   - Optional corpus audit for caveat generation
 * @returns {{
 *   main_claim_support: object[],
 *   case_study: object|null,
 *   chart_data: object[],
 *   caveat: string[],
 *   recommendation_basis: object[],
 *   outlook_basis: object[],
 *   selection_notes: string[],
 *   evidence_sufficient: boolean,
 * }}
 */
export function selectSlideEvidence(slidePlan, evidencePackets, sourceIndex, corpusAudit) {
  const allPackets = (evidencePackets || []);
  const notes      = [];

  // ── Phase 10: Provenance pre-selection filter ─────────────────────────────
  const slideUse = slidePlan?.required_use || null;
  const { primary: primaryPackets, contextOnly: contextPackets, excluded: excludedPackets, caveats: provenanceCaveats } =
    applyProvenancePreFilter(allPackets, slideUse);

  if (excludedPackets.length > 0) {
    notes.push(`provenance_filter: excluded ${excludedPackets.length} packet(s) (fabricated/unsupported/blocked)`);
  }

  // Use primary packets as the filtered pool, fall back to contextOnly if nothing primary
  const filteredPool = primaryPackets.length > 0 ? primaryPackets : contextPackets;

  // ── Filter out hard-failed packets ────────────────────────────────────────
  const usable = filteredPool.filter(isUsable);
  const strong  = usable.filter(isStrong);

  // ── Non-duplicate packets only ────────────────────────────────────────────
  const nonDuplicate = usable.filter((ep) => !isDuplicateReporting(ep));

  // ── Sorted by preference ──────────────────────────────────────────────────
  const ranked = sortPackets(nonDuplicate);

  // ── Main claim support (top 3 usable, non-duplicate) ─────────────────────
  const main_claim_support = ranked.slice(0, 3);

  if (main_claim_support.length === 0 && usable.length === 0) {
    notes.push("No usable evidence packets available for main claim");
  } else if (main_claim_support.length === 0 && usable.length > 0) {
    notes.push("Only duplicate-reporting evidence available — used with circular_reporting_risk caveat");
    main_claim_support.push(...sortPackets(usable).slice(0, 1));
  }

  // ── Case study: single concrete packet with named entity ──────────────────
  const concreteRanked = sortPackets(ranked.filter(isConcrete));
  const case_study = concreteRanked[0] || null;

  if (!case_study) {
    notes.push("No concrete named evidence available for case study");
  }

  // ── Chart data: only chart_allowed ────────────────────────────────────────
  const chart_data = sortPackets(usable.filter(isChartAllowed)).slice(0, 3);

  if (chart_data.length === 0) {
    notes.push("No chart-allowed evidence packets; statistical visualization not available");
  }

  // ── Recommendation basis ──────────────────────────────────────────────────
  const recTypes = new Set([
    "incident", "vulnerability", "threat_intelligence", "governance_signal",
    "defensive_capability", "adversary_adoption_signal",
  ]);
  const recommendation_basis = sortPackets(
    usable.filter((ep) => recTypes.has(ep.evidence_type || ep.source_type || ""))
  ).slice(0, 2);

  // ── Outlook basis ─────────────────────────────────────────────────────────
  const outlookTypes = new Set([
    "research_finding", "capability_demonstration", "benchmark_evaluation",
    "strategic_signal", "ecosystem_signal", "adversary_adoption_signal",
  ]);
  const outlook_basis = sortPackets(
    usable.filter((ep) => outlookTypes.has(ep.evidence_type || ep.source_type || ""))
  ).slice(0, 2);

  // ── Evidence sufficiency ──────────────────────────────────────────────────
  const slideType = slidePlan?.slide_type || "";
  const isContentSlide = ["category_content", "cross_category", "outlook", "exec_overview"].includes(slideType);

  const evidence_sufficient = !isContentSlide || (
    main_claim_support.length >= 1 ||
    strong.length >= 1
  );

  if (!evidence_sufficient) {
    notes.push(`evidence_gap: no usable evidence for ${slideType} slide — downgrade to evidence_gap slide`);
  }

  // ── Generate caveats ──────────────────────────────────────────────────────
  const allSelected = [
    ...main_claim_support,
    case_study ? [case_study] : [],
    ...chart_data,
  ].flat().filter(Boolean);

  const generatedCaveats = generateCaveats(allSelected, corpusAudit);
  // Merge provenance caveats (from pre-filter) with generated caveats
  const caveat = [...new Set([...provenanceCaveats, ...generatedCaveats])];

  return {
    main_claim_support,
    case_study,
    chart_data,
    caveat,
    recommendation_basis,
    outlook_basis,
    selection_notes: notes,
    evidence_sufficient,
    // Phase 10: provenance filter metadata
    provenance_filter: {
      excluded_count: excludedPackets.length,
      context_only_count: contextPackets.length,
    },
  };
}

/**
 * Apply evidence selection to all slides in a plan.
 * Slides with evidence_sufficient=false become evidence_gap slides.
 *
 * @param {object[]} slidePlan       - Ordered slide plan from planSlides()
 * @param {object[]} evidencePackets - All evidence packets
 * @param {object}   [sourceIndex]   - Optional source lookup map
 * @param {object}   [corpusAudit]   - Optional corpus audit
 * @returns {object[]} Plan with evidence_selection and possibly mutated slide_type
 */
export function applyEvidenceSelectionToPlan(slidePlan, evidencePackets, sourceIndex, corpusAudit) {
  return (slidePlan || []).map((slide) => {
    const STRUCTURAL = new Set(["title", "section_divider", "appendix", "landscape"]);
    if (STRUCTURAL.has(slide.slide_type)) {
      return slide;
    }

    // Get category-specific packets for this slide
    const slidePackets = slide.category
      ? (evidencePackets || []).filter((ep) =>
          !ep.category || ep.category === slide.category || ep.main_category === slide.category
        )
      : (evidencePackets || []);

    const selection = selectSlideEvidence(slide, slidePackets, sourceIndex, corpusAudit);

    const updatedSlide = {
      ...slide,
      evidence_selection: selection,
    };

    // Downgrade to evidence_gap if insufficient
    if (!selection.evidence_sufficient && slide.slide_type === "category_content") {
      updatedSlide.slide_type = "evidence_gap";
      updatedSlide.evidence_gap_reason = selection.selection_notes.join("; ");
    }

    return updatedSlide;
  });
}
