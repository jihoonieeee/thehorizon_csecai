/**
 * QA Pipeline Summary Output
 *
 * Generates a structured QA report from pipeline run results.
 * No LLM calls.
 */

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build a QA report from a pipeline result object.
 *
 * @param {object} pipelineResult
 * @returns {object} qaReport
 */
export function buildQaReport(pipelineResult) {
  const {
    run_id,
    sources: allSources = [],
    evidence_items: allEvidence = [],
    claims: allClaims = [],
    corpus_audits: corpusAudits = [],
    slides: allSlides = [],
  } = pipelineResult || {};

  const generated_at = new Date().toISOString();

  // ── Source stats ──────────────────────────────────────────────────────────
  const discovered = allSources.length;
  const rejected   = allSources.filter((s) => s.layer3_status === "reject" || s.downstream_route === "discard").length;
  const reviewRouted = allSources.filter((s) => s.downstream_route === "layer4_with_review").length;
  const accepted   = allSources.filter((s) =>
    s.layer3_status === "pass" || s.layer3_status === "review"
  );

  // Rejection breakdown by reason
  const rejection_breakdown = {};
  for (const s of allSources.filter((s) => s.downstream_route === "discard")) {
    const reasons = s.source_quality_reasons || [];
    const validity = s.final_validity_reason || s.validity_reason || "unknown";

    // Use validity reason as primary breakdown key
    const key = reasons[0] || validity.split(":")[0] || "unknown";
    rejection_breakdown[key] = (rejection_breakdown[key] || 0) + 1;
  }

  const primarySources   = accepted.filter((s) => s.trust_tier === "primary" || s.trust_tier === "high");
  const supportingSources = accepted.filter((s) => s.trust_tier !== "primary" && s.trust_tier !== "high");
  const contextOnly       = accepted.filter((s) => s.source_quality_status === "context_only");

  // ── Evidence stats ────────────────────────────────────────────────────────
  const extracted        = allEvidence.length;
  const archivedUnsupported = allEvidence.filter((e) =>
    e.quote_verification?.quote_entailment === "unsupported" ||
    e.admissibility === "failed"
  ).length;
  const archivedChangedMeaning = allEvidence.filter((e) =>
    e.quote_verification?.claim_preservation === "changed_meaning"
  ).length;
  const contextOnlyPartial = allEvidence.filter((e) =>
    e.admissibility === "context_only"
  ).length;
  const usableEvidence = allEvidence.filter((e) =>
    e.admissibility === "passed" || e.admissibility === "usable"
  ).length;
  const strongEvidence = allEvidence.filter((e) =>
    e.admissibility === "strong"
  ).length;

  // ── Claim stats ───────────────────────────────────────────────────────────
  const generated       = allClaims.length;
  const blockedClaims   = allClaims.filter((c) => c.allowed_to_proceed === false);
  const blocking_breakdown = {};
  for (const c of blockedClaims) {
    for (const reason of (c.blocking_reasons || ["unknown"])) {
      const key = reason.split(" —")[0].split(":")[0].trim();
      blocking_breakdown[key] = (blocking_breakdown[key] || 0) + 1;
    }
  }

  const supported         = allClaims.filter((c) => c.claim_support_status === "supported").length;
  const partially_supported = allClaims.filter((c) => c.claim_support_status === "partially_supported").length;

  // ── Corpus audit stats ────────────────────────────────────────────────────
  const per_category = {};
  for (const audit of corpusAudits) {
    per_category[audit.category] = {
      analysis_allowed:  audit.analysis_allowed,
      source_count:      (audit.source_count_by_type
        ? Object.values(audit.source_count_by_type).reduce((a, b) => a + b, 0)
        : 0),
      flags:             [
        ...(audit.source_concentration_flags || []),
        ...(audit.evidence_gap_flags || []),
      ],
    };
  }

  // ── Slide limitations ─────────────────────────────────────────────────────
  const slide_limitations = [];
  for (const slide of allSlides) {
    if (slide.slide_type === "evidence_gap") {
      slide_limitations.push(
        `Slide ${slide.slide_number} (${slide.category || "n/a"}): downgraded to evidence_gap — ${slide.evidence_gap_reason || "insufficient evidence"}`
      );
    }
    for (const caveat of (slide.evidence_selection?.caveat || [])) {
      slide_limitations.push(`Slide ${slide.slide_number}: ${caveat}`);
    }
  }

  // ── Evidence gaps ─────────────────────────────────────────────────────────
  const evidence_gaps = [
    ...new Set(corpusAudits.flatMap((a) => a.evidence_gap_flags || [])),
  ];

  // ── Top rejected domains ──────────────────────────────────────────────────
  const domainCounts = {};
  for (const s of allSources.filter((s) => s.downstream_route === "discard")) {
    try {
      const domain = new URL(s.url || "").hostname.replace(/^www\./, "");
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    } catch {
      domainCounts["invalid_url"] = (domainCounts["invalid_url"] || 0) + 1;
    }
  }
  const top_rejected_domains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([domain, count]) => `${domain} (${count})`);

  // ── Warnings ──────────────────────────────────────────────────────────────
  const warnings = [];

  if (rejected > discovered * 0.8 && discovered > 0) {
    warnings.push(`High rejection rate: ${rejected}/${discovered} sources rejected`);
  }

  const insufficientCats = corpusAudits.filter((a) => a.analysis_allowed === "insufficient");
  if (insufficientCats.length > 0) {
    warnings.push(`${insufficientCats.length} categories have insufficient evidence for analysis: ${insufficientCats.map((a) => a.category).join(", ")}`);
  }

  if (strongEvidence === 0 && usableEvidence > 0) {
    warnings.push("No strong evidence packets — all evidence has quality caveats");
  }

  if (strongEvidence === 0 && usableEvidence === 0) {
    warnings.push("No usable evidence — deck content is entirely fallback/deterministic");
  }

  return {
    run_id:        run_id || `qa-${Date.now()}`,
    generated_at,
    sources: {
      discovered,
      rejected,
      rejection_breakdown,
      routed_to_review:   reviewRouted,
      accepted_primary:   primarySources.length,
      accepted_supporting: supportingSources.length,
      context_only:       contextOnly.length,
    },
    evidence: {
      extracted,
      archived_unsupported_quote:  archivedUnsupported,
      archived_changed_meaning:    archivedChangedMeaning,
      context_only_partial:        contextOnlyPartial,
      usable:                      usableEvidence,
      strong:                      strongEvidence,
    },
    claims: {
      generated,
      blocked_by_qa:    blockedClaims.length,
      blocking_breakdown,
      supported,
      partially_supported,
    },
    corpus_audit:      { per_category },
    slide_limitations: [...new Set(slide_limitations)],
    evidence_gaps,
    top_rejected_domains,
    warnings,
  };
}

/**
 * Format a QA report as a readable Markdown string.
 *
 * @param {object} qaReport
 * @returns {string} Markdown text
 */
export function formatQaReportMarkdown(qaReport) {
  const { sources, evidence, claims, corpus_audit, slide_limitations, evidence_gaps, warnings } = qaReport;

  const lines = [
    `# Pipeline QA Report`,
    ``,
    `**Run ID:** ${qaReport.run_id}`,
    `**Generated:** ${qaReport.generated_at}`,
    ``,
    `## Sources`,
    ``,
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Discovered | ${sources.discovered} |`,
    `| Rejected | ${sources.rejected} |`,
    `| Routed to review | ${sources.routed_to_review} |`,
    `| Accepted (primary/high) | ${sources.accepted_primary} |`,
    `| Accepted (supporting) | ${sources.accepted_supporting} |`,
    `| Context-only | ${sources.context_only} |`,
  ];

  if (Object.keys(sources.rejection_breakdown || {}).length > 0) {
    lines.push(``, `**Rejection breakdown:**`);
    for (const [reason, count] of Object.entries(sources.rejection_breakdown)) {
      lines.push(`- ${reason}: ${count}`);
    }
  }

  lines.push(
    ``,
    `## Evidence`,
    ``,
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Extracted | ${evidence.extracted} |`,
    `| Archived (unsupported quote) | ${evidence.archived_unsupported_quote} |`,
    `| Archived (changed meaning) | ${evidence.archived_changed_meaning} |`,
    `| Context-only (partial) | ${evidence.context_only_partial} |`,
    `| Usable | ${evidence.usable} |`,
    `| Strong | ${evidence.strong} |`,
    ``,
    `## Claims`,
    ``,
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Generated | ${claims.generated} |`,
    `| Blocked by QA | ${claims.blocked_by_qa} |`,
    `| Supported | ${claims.supported} |`,
    `| Partially supported | ${claims.partially_supported} |`,
  );

  if (Object.keys(claims.blocking_breakdown || {}).length > 0) {
    lines.push(``, `**Blocking reasons:**`);
    for (const [reason, count] of Object.entries(claims.blocking_breakdown)) {
      lines.push(`- ${reason}: ${count}`);
    }
  }

  lines.push(``, `## Corpus Audit`, ``);
  for (const [cat, data] of Object.entries(corpus_audit?.per_category || {})) {
    lines.push(`**${cat}:** analysis=${data.analysis_allowed}, sources=${data.source_count}`);
    if (data.flags?.length > 0) {
      lines.push(`  Flags: ${data.flags.join(", ")}`);
    }
  }

  if (evidence_gaps?.length > 0) {
    lines.push(``, `## Evidence Gaps`, ``);
    for (const gap of evidence_gaps) {
      lines.push(`- ${gap}`);
    }
  }

  if (slide_limitations?.length > 0) {
    lines.push(``, `## Slide Limitations`, ``);
    for (const lim of slide_limitations.slice(0, 20)) {
      lines.push(`- ${lim}`);
    }
  }

  if (warnings?.length > 0) {
    lines.push(``, `## Warnings`, ``);
    for (const w of warnings) {
      lines.push(`> ${w}`);
    }
  }

  if (qaReport.top_rejected_domains?.length > 0) {
    lines.push(``, `## Top Rejected Domains`, ``);
    for (const d of qaReport.top_rejected_domains) {
      lines.push(`- ${d}`);
    }
  }

  return lines.join("\n");
}
