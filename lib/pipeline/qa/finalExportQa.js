/**
 * L9.2 — Final Citation and Provenance QA
 *
 * Runs before PPTX/report export. Hard-blocks export when blocked claims
 * appear in slides. Warns on unresolved citations, analytics-only real-world
 * claims, and duplicate-reporting inflation.
 *
 * ── CHECKS ────────────────────────────────────────────────────────────────────
 * Check 1 (BLOCKING) — blocked_claim_in_slide
 *   A slide references a claim_id that failed L6 QA and is in blocked_claims[].
 *
 * Check 2 (WARNING) — unresolved_evidence_id
 *   An evidence_callout references an evidence_id not present in evidence_registry.
 *
 * Check 3 (WARNING) — unregistered_citation
 *   A slide citation URL does not appear in source_registry.
 *
 * Check 4 (WARNING) — analytics_only_real_world_claim
 *   A factual/adoption/case_study/incident slide is backed only by analytics
 *   evidence packets (which describe the collection, not the real world).
 *
 * Check 5 (WARNING) — all_duplicate_reporting
 *   All evidence callouts on a slide are flagged as duplicate_reporting=true
 *   with primary_origin=false — the slide is inflated from re-reporting.
 *
 * ── RETURN VALUE ─────────────────────────────────────────────────────────────
 * {
 *   passed:           boolean — true only when no blocking issues AND no warnings
 *   exportBlocked:    boolean — true when any blocking issue exists
 *   failed_slides:    [{ slide_id, issues[] }]
 *   warnings:         [{ slide_id, issue, ...details }]
 *   blocking_issues:  [{ slide_id, issue, claim_id }]
 *   qa_summary:       { total_slides, slides_with_issues, blocking_count, warning_count }
 * }
 */

/**
 * Run final citation and provenance QA on the complete deck.
 *
 * @param {object[]|object} deck            - Array of slides, or { slides: [] } object
 * @param {object}          analysisPackage - Output of buildAnalysisPackage() (from L6.8)
 * @returns {Promise<object>}
 */
export async function runFinalExportQa(deck, analysisPackage) {
  const { approved_claims, blocked_claims, evidence_registry, source_registry } = analysisPackage || {};
  const blockedIds  = new Set((blocked_claims  || []).map((c) => c.claim_id).filter(Boolean));
  const approvedIds = new Set((approved_claims || []).map((c) => c.claim_id).filter(Boolean));

  const safeRegistry   = evidence_registry instanceof Map ? evidence_registry : new Map();
  const safeSourceReg  = source_registry    instanceof Map ? source_registry    : new Map();

  const failed_slides    = [];
  const warnings         = [];
  const blocking_issues  = [];

  const slides = Array.isArray(deck) ? deck : (deck?.slides || []);

  for (const slide of slides) {
    const slideId     = slide.slide_id || slide.slide_number || "(unknown)";
    const slideIssues = [];

    // ── Check 1: blocked claim in slide ──────────────────────────────────────
    if (slide.claim_id && blockedIds.has(slide.claim_id)) {
      const issue = { slide_id: slideId, issue: "blocked_claim_in_slide", claim_id: slide.claim_id };
      blocking_issues.push(issue);
      slideIssues.push("blocked_claim_in_slide");
    }

    // ── Check 2: evidence_id resolution ──────────────────────────────────────
    for (const callout of (slide.evidence_callouts || [])) {
      if (callout.evidence_id && !safeRegistry.has(callout.evidence_id)) {
        warnings.push({
          slide_id:    slideId,
          issue:       "unresolved_evidence_id",
          evidence_id: callout.evidence_id,
        });
      }
    }

    // ── Check 3: citation URL in source_registry ──────────────────────────────
    for (const citation of (slide.citations || [])) {
      const urlMatch = typeof citation === "string" && citation.match(/https?:\/\/[^\s)]+/);
      if (urlMatch) {
        const url      = urlMatch[0];
        const inReg    = [...safeSourceReg.values()].some((s) => s.source_url === url);
        if (!inReg) {
          warnings.push({ slide_id: slideId, issue: "unregistered_citation", url });
        }
      }
    }

    // ── Check 4: analytics-only for real-world claim types ───────────────────
    const realWorldTypes = new Set(["factual", "adoption", "case_study", "incident"]);
    if (slide.claim_type && realWorldTypes.has(slide.claim_type)) {
      const callouts = slide.evidence_callouts || [];
      if (callouts.length > 0) {
        const allAnalytics = callouts.every((c) => {
          const pkt = safeRegistry.get(c.evidence_id);
          return pkt?.evidence_class === "analytics" ||
                 pkt?.source_branch  === "L5B"       ||
                 pkt?.origin         === "5B_analytics";
        });
        if (allAnalytics) {
          warnings.push({
            slide_id:   slideId,
            issue:      "analytics_only_real_world_claim",
            claim_type: slide.claim_type,
          });
        }
      }
    }

    // ── Check 5: all duplicate reporting ─────────────────────────────────────
    const callouts = slide.evidence_callouts || [];
    if (callouts.length > 0) {
      const allDupe = callouts.every((c) => {
        const pkt = safeRegistry.get(c.evidence_id);
        return pkt?.duplicate_reporting === true && pkt?.primary_origin === false;
      });
      if (allDupe) {
        warnings.push({ slide_id: slideId, issue: "all_duplicate_reporting" });
      }
    }

    if (slideIssues.length > 0) {
      failed_slides.push({ slide_id: slideId, issues: slideIssues });
    }
  }

  const exportBlocked = blocking_issues.length > 0;

  return {
    passed:          !exportBlocked && warnings.length === 0,
    exportBlocked,
    failed_slides,
    warnings,
    blocking_issues,
    qa_summary: {
      total_slides:       slides.length,
      slides_with_issues: failed_slides.length,
      blocking_count:     blocking_issues.length,
      warning_count:      warnings.length,
    },
  };
}
