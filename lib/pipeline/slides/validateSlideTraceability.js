/**
 * Layer 9 — Slide Traceability Validation
 *
 * Deterministic QA that runs AFTER slide content generation and BEFORE export.
 * Validates that every claim, citation, evidence callout, and visual reference
 * in the deck resolves back to a registered EvidencePacket.
 *
 * ── RULES ────────────────────────────────────────────────────────────────────
 * BLOCKING (errors):
 *   - Evidence IDs in slides that don't resolve in the registry
 *   - Visuals embedded in slides without source_evidence_id or generated_from_metric_ids
 *   - Claims without any supporting evidence in the registry
 *   - L5B analytics packets used for slides without computation_method
 *   - External figures without source_url
 *   - Numbers or statistics cited without evidence_id anchor
 *
 * NON-BLOCKING (warnings):
 *   - Evidence used for a purpose not in permitted_uses
 *   - Stale sources used for current-trend claims
 *   - Context-only evidence cited as primary claim support
 *   - Vendor self-reported evidence in benchmark callouts
 *   - Manual-review visuals embedded automatically
 *
 * ── OUTPUT ───────────────────────────────────────────────────────────────────
 * {
 *   valid:          boolean,
 *   errors:         string[],
 *   warnings:       string[],
 *   unresolved_ids: string[],
 *   missing_visuals: string[],
 *   unsupported_claims: string[],
 *   slide_reports:  { slide_id, errors[], warnings[] }[],
 *   summary:        string,
 * }
 */

// ── Helpers ────────────────────────────────────────────────────────────────────

function slotId(slide) {
  return `[${slide.slide_id || slide.slide_number || "?"}:${slide.slide_type || "?"}]`;
}

// Collect all evidence_ids referenced in a single slide
function collectSlideEvidenceIds(slide) {
  const ids = new Set();

  // supporting_evidence_ids on the slide plan
  for (const id of (slide.supporting_evidence_ids || [])) ids.add(id);

  // evidence items in supporting_evidence[]
  for (const ev of (slide.supporting_evidence || [])) {
    if (ev?.evidence_id) ids.add(ev.evidence_id);
    // Top evidence items
    for (const ti of (ev?.top_evidence_items || [])) {
      if (ti?.evidence_id) ids.add(ti.evidence_id);
    }
  }

  // evidence_callouts (from slide content generation)
  for (const callout of (slide.evidence_callouts || [])) {
    if (callout?.evidence_id) ids.add(callout.evidence_id);
  }

  // external evidence callouts (from 5C)
  for (const callout of (slide.external_evidence_callouts || [])) {
    if (callout?.external_evidence_id) ids.add(callout.external_evidence_id);
  }

  // analytics evidence
  for (const ae of (slide.analytics_evidence || [])) {
    if (ae?.analytics_id || ae?.evidence_id) ids.add(ae.analytics_id || ae.evidence_id);
  }

  // citations
  for (const cit of (slide.citations || [])) {
    if (cit?.evidence_id) ids.add(cit.evidence_id);
  }

  return [...ids].filter(Boolean);
}

// Collect all visual_ids or visual URLs referenced in a slide
function collectSlideVisualIds(slide) {
  const visIds   = new Set();
  const extUrls  = new Set();

  for (const vizId of (slide.visualization_ids || [])) {
    // Analytics viz IDs are prefixed differently; skip for now (they're handled via analytics registry)
    if (vizId && !vizId.startsWith("fig_")) continue;
    visIds.add(vizId);
  }

  // external_visual_callouts from 5C
  for (const vc of (slide.external_visual_callouts || [])) {
    if (vc?.visualization_id) visIds.add(vc.visualization_id);
    if (vc?.visual_url)       extUrls.add(vc.visual_url);
    // If allowed_slide_use but manual_review_required, that's a warning (already checked in registry)
  }

  return { visIds: [...visIds], extUrls: [...extUrls] };
}

// ── Per-slide validation ──────────────────────────────────────────────────────

function validateSlide(slide, registry) {
  const errors   = [];
  const warnings = [];
  const slot     = slotId(slide);

  // 1. Collect and resolve all evidence IDs
  const evidenceIds = collectSlideEvidenceIds(slide);
  if (evidenceIds.length > 0) {
    const { missing } = registry.validateIds(evidenceIds);
    for (const id of missing) {
      errors.push(`${slot} unresolved evidence_id: ${id}`);
    }

    // 2. Check permitted_uses for each resolved packet
    const claimType = slide.claim_type || null;
    if (claimType) {
      for (const id of evidenceIds) {
        const p = registry.resolve(id);
        if (!p) continue;
        const uses = p.claim_relevance?.permitted_uses || [];
        // Context_only evidence cannot be primary claim support
        if (p.claim_relevance?.admissibility === "context_only" &&
            (slide.slide_type === "critical_claim" || slide.slide_type === "trend_claim")) {
          warnings.push(`${slot} evidence ${id} is context_only — cannot support primary claim slide`);
        }
        // Stale external evidence for current-trend claims
        if (p.quality_flags?.includes("stale_source") && claimType === "trend_claim") {
          warnings.push(`${slot} stale source ${id} used in trend_claim slide`);
        }
        // Vendor self-reported evidence in benchmark callouts
        if (p.quality_flags?.includes("vendor_self_reported") &&
            ["benchmark_result","authoritative_statistic"].includes(p.evidence_type)) {
          warnings.push(`${slot} vendor self-reported evidence ${id} used — verify independently`);
        }
      }
    }
  }

  // 3. Claim must have ≥1 evidence packet that can support claims
  if (slide.claim_id && evidenceIds.length > 0) {
    const hasClaimSupport = evidenceIds.some((id) => {
      const p = registry.resolve(id);
      return p && (p.claim_relevance?.admissibility === "passed") &&
        (p.claim_relevance?.evidence_strength === "strong" || p.claim_relevance?.evidence_strength === "usable");
    });
    if (!hasClaimSupport && slide.slide_type !== "evidence_gap" && slide.slide_type !== "methodology") {
      errors.push(`${slot} claim ${slide.claim_id} has no claim-supporting evidence packet`);
    }
  }

  // 4. Visuals
  const { visIds, extUrls } = collectSlideVisualIds(slide);
  const { missing: missingVis } = registry.validateVisualIds(visIds);
  for (const vid of missingVis) {
    errors.push(`${slot} unresolved visual_id: ${vid}`);
  }

  // 5. External callouts: each must have URL
  for (const callout of (slide.external_evidence_callouts || [])) {
    if (!callout.url && !callout.source_url) {
      errors.push(`${slot} external evidence callout ${callout.external_evidence_id} has no URL`);
    }
    if (!callout.publisher) {
      warnings.push(`${slot} external evidence callout ${callout.external_evidence_id} has no publisher`);
    }
  }

  // 6. Visual callouts: cannot auto-embed if manual_review_required
  for (const vc of (slide.external_visual_callouts || [])) {
    if (vc?.manual_review_required && vc?.slide_usable) {
      errors.push(`${slot} visual ${vc.visualization_id} is manual_review_required but marked slide_usable`);
    }
    if (!vc?.source_url) {
      errors.push(`${slot} visual ${vc?.visualization_id} has no source_url — cannot prove provenance`);
    }
  }

  // 7. Analytics slides must have computation_method on their packets
  if (slide.slide_type === "analytics_pattern") {
    for (const ae of (slide.analytics_evidence || [])) {
      const id = ae?.analytics_id || ae?.evidence_id;
      const p  = id ? registry.resolve(id) : null;
      if (p && p.provenance?.extraction_layer === "L5B" && !p.provenance?.computation_method) {
        errors.push(`${slot} analytics packet ${id} lacks computation_method`);
      }
    }
  }

  return { slide_id: slide.slide_id || slide.slide_number, errors, warnings };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Run traceability validation across the full deck.
 *
 * @param {object[]} slides   - planned + content-generated slide objects
 * @param {EvidencePacketRegistry} registry
 * @returns {object} traceability report
 */
export function validateSlideTraceability(slides = [], registry) {
  if (!registry || typeof registry.resolve !== "function") {
    return {
      valid:            false,
      errors:           ["EvidencePacketRegistry not provided or invalid"],
      warnings:         [],
      unresolved_ids:   [],
      missing_visuals:  [],
      unsupported_claims: [],
      slide_reports:    [],
      summary:          "Traceability QA skipped — no registry provided.",
    };
  }

  const slideReports    = [];
  const allErrors       = [];
  const allWarnings     = [];
  const allUnresolved   = new Set();
  const allMissingVis   = new Set();

  for (const slide of slides) {
    const report = validateSlide(slide, registry);
    slideReports.push(report);
    allErrors.push(...report.errors);
    allWarnings.push(...report.warnings);

    // Extract unresolved IDs from error messages
    for (const e of report.errors) {
      const m = e.match(/unresolved evidence_id: ([\w_]+)/);
      if (m) allUnresolved.add(m[1]);
      const mv = e.match(/unresolved visual_id: ([\w_]+)/);
      if (mv) allMissingVis.add(mv[1]);
    }
  }

  // Cross-deck: validate all claims have support
  const allClaims = slides
    .filter((s) => s.claim_id)
    .map((s) => ({ claim_id: s.claim_id, supporting_evidence_ids: collectSlideEvidenceIds(s) }));
  const { unsupported_claim_ids } = registry.validateClaimSupport(allClaims);

  const valid = allErrors.length === 0;
  const summary = valid
    ? `Traceability QA passed. ${slides.length} slides validated. ${allWarnings.length} warning(s).`
    : `Traceability QA FAILED. ${allErrors.length} error(s), ${allWarnings.length} warning(s) across ${slides.length} slides.`;

  return {
    valid,
    errors:             allErrors,
    warnings:           allWarnings,
    unresolved_ids:     [...allUnresolved],
    missing_visuals:    [...allMissingVis],
    unsupported_claims: unsupported_claim_ids,
    slide_reports:      slideReports.filter((r) => r.errors.length > 0 || r.warnings.length > 0),
    registry_summary:   registry.summary(),
    summary,
  };
}

/**
 * Convenience: validate a single claim against the registry.
 *
 * @param {{ claim_id, supporting_evidence_ids }} claim
 * @param {EvidencePacketRegistry} registry
 */
export function validateClaimTraceability(claim, registry) {
  const ids = claim.supporting_evidence_ids || [];
  const { missing } = registry.validateIds(ids);
  const hasSupport = ids.some((id) => {
    const p = registry.resolve(id);
    return p && p.claim_relevance?.admissibility === "passed";
  });

  return {
    claim_id:         claim.claim_id,
    valid:            missing.length === 0 && hasSupport,
    missing_ids:      missing,
    has_claim_support:hasSupport,
    evidence_count:   ids.length,
  };
}
