/**
 * Layer 8 QA — Citation Validation
 *
 * Two checks:
 *   validateCitations   — per-slide structural integrity (callout fields present,
 *                         each content slide has at least one citation)
 *   checkCitationCoverage — what fraction of must_read/high-priority sources
 *                           appear in the deck's evidence plan
 */

// Structural slide types exempt from citation checks
const STRUCTURAL_TYPES = new Set(["title", "section_divider", "appendix", "conclusion"]);

// ── Per-slide structural checks ───────────────────────────────────────────────

/**
 * Validate citation fields on every slide.
 *
 * @param {object[]} slides      - Generated slide content.
 * @param {object[]} [feedSources=[]] - Feed sources (unused here, kept for API symmetry).
 * @returns {{ total_issues: number, issues: object[] }}
 */
export function validateCitations(slides, feedSources = []) {
  const issues = [];

  for (const slide of slides) {
    if (STRUCTURAL_TYPES.has(slide.slide_type)) continue;

    // Each evidence callout must have title and publisher
    for (const callout of (slide.evidence_callouts || [])) {
      if (!callout.title?.trim()) {
        issues.push({
          slide_number: slide.slide_number,
          check:        "callout_has_title",
          severity:     "warning",
          message:      `Slide ${slide.slide_number}: an evidence callout is missing a title.`,
        });
      }
      if (!callout.publisher?.trim()) {
        issues.push({
          slide_number: slide.slide_number,
          check:        "callout_has_publisher",
          severity:     "warning",
          message:      `Slide ${slide.slide_number}: evidence callout "${callout.title || "(untitled)"}" is missing a publisher.`,
        });
      }
      if (!callout.key_fact?.trim()) {
        issues.push({
          slide_number: slide.slide_number,
          check:        "callout_has_key_fact",
          severity:     "warning",
          message:      `Slide ${slide.slide_number}: evidence callout "${callout.title || "(untitled)"}" is missing a key_fact.`,
        });
      }
    }

    // Content slides must have at least one citation string
    if ((slide.citations || []).length === 0) {
      issues.push({
        slide_number: slide.slide_number,
        check:        "has_citations",
        severity:     "warning",
        message:      `Slide ${slide.slide_number} (${slide.title || slide.slide_title || ""}) has no citations.`,
      });
    }
  }

  return { total_issues: issues.length, issues };
}

// ── Coverage check ────────────────────────────────────────────────────────────

/**
 * Check what fraction of high-priority sources appear in the deck's evidence plan.
 *
 * Uses `slide_plan[].evidence_used` source-ID lists for precise matching, so
 * this works even when the LLM paraphrases the title in a callout.
 *
 * @param {object[]} slides       - Generated slide content.
 * @param {object[]} feedSources  - Feed sources with `feed_score_data`.
 * @param {object[]} [slidePlan=[]] - Slide plan objects with `evidence_used` arrays.
 * @returns {{ high_priority: number, covered: number, coverage_pct: number, issues: object[] }}
 */
export function checkCitationCoverage(slides, feedSources, slidePlan = []) {
  const highPriority = feedSources.filter((s) =>
    s.rawfact_evidence_summary?.strongest_strength === "strong" ||
    s.rawfact_evidence_summary?.strongest_strength === "usable"
  );

  // Collect every rawfact evidence_id cited in any slide callout (format: raw_<source_id>)
  const citedEvidenceIds = new Set(
    slides.flatMap((s) => (s.evidence_callouts || []).map((c) => c.evidence_id || "").filter(Boolean))
  );

  // Also collect plan-level evidence_used IDs for backward-compat
  const plannedIds = new Set(slidePlan.flatMap((p) => p.evidence_used || []));

  // Fallback: title matching
  const calloutTitles = new Set(
    slides.flatMap((s) => (s.evidence_callouts || []).map((c) => (c.title || "").toLowerCase()))
  );

  const covered = highPriority.filter((s) => {
    const rawId = `raw_${s.id}`;
    return citedEvidenceIds.has(rawId) ||
           plannedIds.has(s.id)        ||
           calloutTitles.has((s.title || "").toLowerCase());
  }).length;

  const coverage_pct = highPriority.length > 0
    ? Math.round((covered / highPriority.length) * 100)
    : 100;

  const issues = [];

  // The coverage threshold scales with source volume: an 11-slide deck cannot
  // physically cite more than ~55 sources. For large source sets, require at
  // least 15 must_read/high sources cited OR 20% coverage (whichever is lower).
  // For small sets (≤20 sources), the original 50% threshold applies.
  const coverageThreshold = highPriority.length <= 20 ? 50
    : Math.max(5, Math.min(50, Math.round(55 / highPriority.length * 100)));

  if (highPriority.length > 0 && coverage_pct < coverageThreshold) {
    issues.push({
      check:        "citation_coverage",
      severity:     "warning",
      message:      `Only ${coverage_pct}% of high-priority sources are cited in the deck (${covered} / ${highPriority.length}). Threshold: ${coverageThreshold}%.`,
    });
  }

  return { high_priority: highPriority.length, covered, coverage_pct, issues };
}
