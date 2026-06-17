/**
 * Dashboard Intelligence QA Gate
 *
 * Validates each dashboard_intelligence_object before it can appear in
 * main dashboard panels. Objects that fail QA are either demoted to
 * appendix_only or blocked entirely.
 *
 * ── QA CHECKS ─────────────────────────────────────────────────────────────────
 *   1. Evidence IDs resolve in the evidence registry
 *   2. Source URLs present (at least one source has a URL)
 *   3. Judgment passed analytical quality gate (not summary_only / unsupported)
 *   4. Caveats present when adoption/market-wide/forward-looking claims
 *   5. Analytics-only evidence does not support real-world claims
 *   6. Confidence does not exceed the category ceiling
 *   7. Short takeaway present and non-trivial (≥5 words)
 *   8. Judgment text is not overstated (no certainty language for low confidence)
 *
 * ── RESULT ────────────────────────────────────────────────────────────────────
 *   qa_pass:               boolean
 *   qa_issues:             string[]  (reasons for failure)
 *   qa_severity:           "blocking" | "warning"
 *   final_approved_for_dashboard: boolean
 *   final_approved_for_appendix:  boolean
 */

// Certainty language that must not appear in low/medium confidence judgments
const OVERCONFIDENT_PATTERNS = /\b(will certainly|is confirmed|definitively|without doubt|guaranteed|100% certain|absolutely|undoubtedly)\b/i;

// Analytics-only evidence classes (cannot support real-world claims)
const ANALYTICS_EVIDENCE_CLASSES = new Set(["analytics", "5B_analytics"]);
const REAL_WORLD_CLAIM_TYPES     = new Set(["factual", "adoption", "incident", "case_study"]);

/**
 * Run all QA checks on a single dashboard_intelligence_object.
 *
 * @param {object} intelObj           Dashboard intel object
 * @param {Map}    evidenceRegistry   Map<evidence_id, EvidencePacket>
 * @param {string} [categoryCeiling]  Optional category confidence ceiling
 * @returns {{ qa_pass, qa_issues, qa_severity, final_approved_for_dashboard, final_approved_for_appendix }}
 */
export function qaDashboardIntelObject(intelObj, evidenceRegistry, categoryCeiling) {
  const issues   = [];
  const warnings = [];

  // ── Check 1: Evidence IDs resolve ────────────────────────────────────────────
  const supportingIds = intelObj.supporting_evidence_ids || [];
  const unresolved = supportingIds.filter((id) => !evidenceRegistry?.has(id));
  if (unresolved.length > 0 && supportingIds.length > 0) {
    // If ALL ids are unresolved, it's a hard fail
    if (unresolved.length === supportingIds.length) {
      issues.push(`evidence_ids_unresolved: all ${unresolved.length} supporting evidence IDs are missing from registry`);
    } else {
      warnings.push(`evidence_ids_partial: ${unresolved.length}/${supportingIds.length} evidence IDs unresolved`);
    }
  }

  // ── Check 2: At least one source URL ─────────────────────────────────────────
  const hasUrl = (intelObj.source_links || []).some((l) => l.url);
  if (!hasUrl && (intelObj.evidence_for || []).length > 0) {
    warnings.push("no_source_url: no source URL available for any supporting evidence");
  }

  // ── Check 3: Analytical quality gate ─────────────────────────────────────────
  const quality = intelObj.analytical_quality || "unknown";
  if (quality === "unsupported") {
    issues.push(`quality_unsupported: judgment has no cited evidence`);
  } else if (quality === "summary_only") {
    issues.push(`quality_summary_only: judgment only restates evidence without mechanism/implication`);
  }

  // ── Check 4: Caveats required for adoption/market-wide/forward-looking ───────
  const flags       = intelObj.judgment_flags || {};
  const caveats     = intelObj.caveats || [];
  const needsCaveat = flags.implies_adoption || flags.is_market_wide || flags.is_forward_looking;
  const hasCaveat   = caveats.some((c) => c.trim().length >= 10);
  if (needsCaveat && !hasCaveat) {
    issues.push("missing_caveat: adoption/market-wide/forward-looking judgment requires a caveat");
  }

  // ── Check 5: Analytics-only cannot support real-world claims ─────────────────
  const claimType    = intelObj.judgment_type || "";
  const allEvidence  = intelObj.evidence_for || [];
  const analyticsOnly = allEvidence.length > 0 &&
    allEvidence.every((e) => ANALYTICS_EVIDENCE_CLASSES.has(e.source_type) ||
                              ANALYTICS_EVIDENCE_CLASSES.has(e.evidence_class));
  const isRealWorld = REAL_WORLD_CLAIM_TYPES.has(claimType) ||
    flags.implies_adoption || flags.implies_operational;
  if (analyticsOnly && isRealWorld) {
    issues.push("analytics_only_real_world_claim: real-world judgment backed only by corpus analytics");
  }

  // ── Check 6: Confidence vs ceiling ───────────────────────────────────────────
  if (categoryCeiling) {
    const CONF_RANK = { high: 3, medium: 2, low: 1, none: 0 };
    const claimConf = CONF_RANK[intelObj.confidence] ?? 0;
    const ceilConf  = CONF_RANK[categoryCeiling]     ?? 99;
    if (claimConf > ceilConf) {
      issues.push(`exceeds_ceiling: confidence "${intelObj.confidence}" exceeds category ceiling "${categoryCeiling}"`);
    }
  }

  // ── Check 7: Short takeaway present ──────────────────────────────────────────
  const takeaway = (intelObj.short_takeaway || "").trim();
  if (takeaway.split(/\s+/).length < 5) {
    warnings.push(`missing_short_takeaway: short_takeaway is absent or too brief (< 5 words)`);
  }

  // ── Check 8: Overconfident language in low/medium confidence judgments ────────
  if (intelObj.confidence !== "high" && OVERCONFIDENT_PATTERNS.test(intelObj.judgment || "")) {
    warnings.push("overconfident_language: certainty language present in a non-high confidence judgment");
  }

  const hasBlockingIssue = issues.length > 0;
  const hasWarningOnly   = warnings.length > 0 && !hasBlockingIssue;

  // Final approval decision
  const final_approved_for_dashboard = !hasBlockingIssue && !!intelObj.approved_for_dashboard;
  const final_approved_for_appendix  = !hasBlockingIssue || hasWarningOnly;

  return {
    qa_pass:                    !hasBlockingIssue,
    qa_issues:                  [...issues, ...warnings],
    qa_severity:                hasBlockingIssue ? "blocking" : "warning",
    final_approved_for_dashboard,
    final_approved_for_appendix,
    qa_warnings: warnings,
    qa_errors:   issues,
  };
}

/**
 * Run QA on all dashboard intelligence objects, updating their approval status.
 *
 * @param {object[]} intelObjects        Dashboard intel objects
 * @param {Map}      evidenceRegistry
 * @param {object}   [categoryAnalyses]  For ceiling lookup per category
 * @returns {{ passed: object[], appendix: object[], blocked: object[], qa_summary: object }}
 */
export function qaAllDashboardIntelObjects(intelObjects, evidenceRegistry, categoryAnalyses) {
  // Build ceiling map from category analyses
  const ceilingByCat = {};
  for (const ca of (categoryAnalyses || [])) {
    const ceiling = ca.analytical_state?.confidence_ceiling
      || ca.evidence_strength?.confidence_ceiling
      || null;
    if (ceiling) ceilingByCat[ca.category] = ceiling;
  }

  const passed   = [];
  const appendix = [];
  const blocked  = [];
  let   qa_issue_count = 0;

  for (const obj of (intelObjects || [])) {
    const ceiling = ceilingByCat[obj.category] || null;
    const result  = qaDashboardIntelObject(obj, evidenceRegistry, ceiling);

    const enriched = {
      ...obj,
      final_approved_for_dashboard: result.final_approved_for_dashboard,
      final_approved_for_appendix:  result.final_approved_for_appendix,
      qa_issues: result.qa_issues,
      qa_pass:   result.qa_pass,
    };

    if (result.qa_issues.length > 0) qa_issue_count++;

    if (result.final_approved_for_dashboard) {
      passed.push(enriched);
    } else if (result.final_approved_for_appendix) {
      appendix.push(enriched);
    } else {
      blocked.push(enriched);
    }
  }

  const qa_summary = {
    total:         intelObjects?.length ?? 0,
    passed:        passed.length,
    appendix_only: appendix.length,
    blocked:       blocked.length,
    with_issues:   qa_issue_count,
  };

  process.stdout.write(
    `  [dashboard-intel-qa] ${qa_summary.total} objects — ` +
    `passed=${qa_summary.passed} appendix=${qa_summary.appendix_only} ` +
    `blocked=${qa_summary.blocked} with_issues=${qa_summary.with_issues}\n`
  );

  return { passed, appendix, blocked, qa_summary };
}
