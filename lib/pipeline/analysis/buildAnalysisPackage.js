/**
 * L6.8 — Analysis Package Builder
 *
 * Assembles the final Layer 6 output from all analysis sublayer results.
 * This is the ONLY object that Layer 7 (deck planning) receives from Layer 6.
 * Layer 7 must not read raw dossiers, synthesis internals, or unvalidated outputs.
 *
 * Contents:
 *   approved_claims[]         — claims that passed all QA gates
 *   blocked_claims[]          — claims that failed QA (for debug report only)
 *   category_analyses[]       — validated per-category analyses with approved claims
 *   cross_category_synthesis  — cross-category output (uses only approved claims)
 *   evidence_registry         — Map<evidence_id, EvidencePacket> for provenance lookup
 *   source_registry           — Map<source_id, RegistryEntry> for URL lookup
 *   visualization_registry    — Map<visualization_id, VisSpec> available for L7.3
 *   qa_report                 — combined QA report from all L6 sublayers
 *   analysis_version          — version string
 *   run_timestamp
 *
 * ── WHAT THIS MODULE DOES ─────────────────────────────────────────────────────
 * DOES: Collect approved/blocked claims, strip L6-internal fields from category
 *       analyses, build evidence/source/visualization registries, extend qa_report.
 * DOES NOT: Re-analyze, modify claim priority, build slide structures, select
 *           evidence for slides, or attach visuals to claims.
 *
 * ── APPROVED vs BLOCKED CLAIMS ───────────────────────────────────────────────
 * A claim is APPROVED if it appears in a category analysis's `claims[]` array.
 * A claim is BLOCKED if it appears in `claims_blocked_by_qa[]`.
 * Blocked claims are carried in blocked_claims[] for the QA report only —
 * they must NEVER reach Layer 7 or appear in any slide.
 */

import { buildSourceRegistry, buildEvidenceRegistry } from "../evidence/sourceRegistry.js";
import { buildDashboardIntelPackage }                from "./buildDashboardIntelPackage.js";
import { qaAllDashboardIntelObjects }                from "./dashboardIntelQa.js";
import { buildIntelligenceLayer }                    from "../intelligence/buildIntelligenceLayer.js";

export const ANALYSIS_PACKAGE_VERSION = "analysis-pkg-v1.1";

// Fields that are L6 internals and must not pass through to L7
const L6_INTERNAL_FIELDS = new Set([
  "rawfact",
  "rawfact_evidence",
  "rawfact_evidence_items",
  "analytical_state",
]);

// Fields that should be retained in category_analyses for L7 consumption
const L7_PERMITTED_CATEGORY_FIELDS = new Set([
  "category",
  "category_headline",
  "overview",
  "top_insights",
  "biggest_happenings",
  "early_signals",
  "recommendations",
  "outlook",
  "evidence_gaps",
  "analysis_confidence",
  "assessment_status",
  "assessment_status_reason",
  "assessment_note",
  "claims",
  "claims_blocked_by_qa",
  "selected_evidence_by_claim",
  "case_studies",
  "corpus_audit",
  "claim_chain_counts",
  "llm_used",
  "model_used",
  "analysis_version",
  "taxonomy",
  "key_source_ids",
  "citations",
  "qa_report",
  // Additive new-contract fields
  "top_trends_or_patterns",
  "outlook_6_months",
  "selected_evidence_by_output",
  "validation_report",
  // Strategic judgment fields (new schema)
  "strategic_judgments",
  "assessment_status",
]);

/**
 * Strip L6-internal fields from a category analysis, keeping only L7-safe fields.
 *
 * @param {object} analysis
 * @returns {object}
 */
function stripInternalFields(analysis) {
  const result = {};
  for (const [key, value] of Object.entries(analysis || {})) {
    if (!L6_INTERNAL_FIELDS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Collect all approved claims from category analyses.
 * A claim is approved if it appears in `claims[]` (not `claims_blocked_by_qa[]`).
 * Annotates each claim with the `category` it came from.
 *
 * @param {object[]} categoryAnalyses
 * @returns {object[]}
 */
function collectApprovedClaims(categoryAnalyses) {
  const approved = [];
  for (const a of (categoryAnalyses || [])) {
    for (const claim of (a.claims || [])) {
      approved.push({ ...claim, category: a.category });
    }
  }
  return approved;
}

/**
 * Collect all blocked claims from category analyses.
 * These are claims that failed claim QA in analyzeCategory.
 * Annotates each with `category`, `blocking_reasons`, `claim_type`, `claim_text`.
 *
 * @param {object[]} categoryAnalyses
 * @returns {object[]}
 */
function collectBlockedClaims(categoryAnalyses) {
  const blocked = [];
  for (const a of (categoryAnalyses || [])) {
    for (const claim of (a.claims_blocked_by_qa || [])) {
      blocked.push({
        ...claim,
        category: a.category,
        // Ensure these fields are always present for downstream QA checks
        blocking_reasons: claim.blocking_reasons || [],
        claim_type:       claim.claim_type || "unknown",
        claim_text:       claim.claim_text || "",
      });
    }
  }
  return blocked;
}

/**
 * Build the analysis package — the sole L6 output consumed by Layer 7.
 *
 * @param {object} params
 * @param {object[]} params.categoryAnalyses         - Validated per-category analyses from L6.4+L6.6
 * @param {object}   params.crossCategorySynthesis   - Cross-category synthesis output from L6.7
 * @param {object[]} params.fusedDossiers            - Fused dossiers from L6.1 (for evidence registry)
 * @param {object[]} params.evidencePackets          - All L5A/B/C evidence packets
 * @param {object[]} params.sources                  - All enriched sources (for source registry)
 * @param {object[]} params.visualizationSpecs       - Visualization specs from L5B/L5C
 * @param {object}   params.qaReport                 - Combined QA report from all L6 sublayers
 * @returns {object} analysis_package
 */
export function buildAnalysisPackage({
  categoryAnalyses = [],
  crossCategorySynthesis = {},
  fusedDossiers = [],
  evidencePackets = [],
  sources = [],
  visualizationSpecs = [],
  qaReport = {},
}) {
  // ── Collect approved and blocked claims ───────────────────────────────────
  const approved_claims = collectApprovedClaims(categoryAnalyses);
  const blocked_claims  = collectBlockedClaims(categoryAnalyses);

  // ── Strip L6-internal fields from category analyses ───────────────────────
  // Layer 7 may only see the fields listed in L7_PERMITTED_CATEGORY_FIELDS.
  // rawfact, rawfact_evidence, and analytical_state are L6 internals.
  const category_analyses = (categoryAnalyses || []).map(stripInternalFields);

  // ── Build evidence registry ────────────────────────────────────────────────
  // evidencePackets may arrive as either:
  //   a) a flat array of evidence item objects (each has evidence_id)  — canonical
  //   b) an array of evidence PACK objects ({ category, strong_evidence[], … })
  //      — what synthesisLayer passes as enrichedPacks
  // We must flatten pack objects before building the registry so that items
  // keyed by evidence_id are actually found.
  function flattenPacksToItems(packets) {
    const items = [];
    for (const p of (packets || [])) {
      if (!p) continue;
      if (p.evidence_id) {
        items.push(p);                          // already a flat item
      } else {
        // Pack object — collect all bucket arrays
        items.push(
          ...(p.strong_evidence        || []),
          ...(p.usable_evidence        || []),
          ...(p.context_evidence       || []),
          ...(p.case_study_candidates  || []),
          ...(p.statistics             || []),
          ...(p.recommendation_inputs  || []),
          ...(p.outlook_inputs         || []),
          ...(p.exposure_inputs        || []),
          ...(p.governance_context     || []),
          ...(p.archived_items         || []),
          ...(p.external_evidence      || []),
        );
      }
    }
    return items;
  }

  let evidence_registry;
  const flatItems = flattenPacksToItems(evidencePackets);
  if (flatItems.length > 0) {
    try {
      evidence_registry = buildEvidenceRegistry(flatItems);
    } catch {
      evidence_registry = new Map(
        flatItems.filter((p) => p?.evidence_id).map((p) => [p.evidence_id, p])
      );
    }
  } else {
    // Fall back to building from fused dossiers
    const allItems = [];
    for (const d of (fusedDossiers || [])) {
      const rf = d.rawfact || {};
      allItems.push(
        ...(rf.strong_evidence || []),
        ...(rf.usable_evidence || []),
        ...(rf.context_evidence || []),
        ...(rf.case_study_candidates || []),
        ...(rf.statistics || []),
        ...(d.rawfact_evidence || []),
        ...(d.external_evidence || []),
      );
    }
    evidence_registry = new Map(
      allItems.filter((p) => p?.evidence_id).map((p) => [p.evidence_id, p])
    );
  }

  // ── Build source registry ─────────────────────────────────────────────────
  let source_registry;
  try {
    source_registry = buildSourceRegistry(sources);
  } catch {
    source_registry = new Map(
      (sources || []).filter((s) => s.id).map((s) => [s.id, s])
    );
  }

  // ── Build visualization registry ──────────────────────────────────────────
  const visualization_registry = new Map(
    (visualizationSpecs || [])
      .filter((v) => v?.visualization_id)
      .map((v) => [v.visualization_id, v])
  );

  // ── Build dashboard intelligence objects ─────────────────────────────────────
  // Separate from slides — dashboard consumers receive structured intel objects
  // with approval statuses, trend_status, short_takeaway, and visual suggestions.
  const rawDashboardPkg = buildDashboardIntelPackage({
    categoryAnalyses,
    crossCategorySynthesis,
    evidenceRegistry: evidence_registry,
    sourceRegistry:   source_registry,
  });

  // Run dashboard-specific QA gate
  const dashboardQaResult = qaAllDashboardIntelObjects(
    rawDashboardPkg.dashboard_intelligence_objects,
    evidence_registry,
    categoryAnalyses
  );

  // ── Extend QA report with package-level counts ────────────────────────────
  const extended_qa_report = {
    ...qaReport,
    approved_claim_count:       approved_claims.length,
    blocked_claim_count:        blocked_claims.length,
    categories_assessed:        categoryAnalyses.filter((a) => a.assessment_status === "assessed").length,
    categories_insufficient:    categoryAnalyses.filter((a) => a.assessment_status === "evidence_insufficient").length,
    evidence_registry_size:     evidence_registry.size,
    source_registry_size:       source_registry.size,
    visualization_registry_size: visualization_registry.size,
    dashboard_intel_qa:         dashboardQaResult.qa_summary,
  };

  return {
    // Claim separation — the key L6 output contract
    approved_claims,
    blocked_claims,

    // Category-level results (L6-internal fields stripped)
    category_analyses,

    // Cross-category synthesis (L6.7 — uses only approved claims from the prompt)
    cross_category_synthesis: crossCategorySynthesis,

    // ── Approved Intelligence Objects — single canonical layer for all consumers ──
    // Dashboard, chatbot, reports, and slides all consume from this layer.
    // Raw L6 internals (strategic_judgments, dossiers) never reach consumers.
    intelligence_layer: buildIntelligenceLayer({
      category_analyses: categoryAnalyses,
      evidence_registry,
      source_registry,
    }),

    // ── Dashboard intelligence (backward-compat; new code should use intelligence_layer) ─
    dashboard_intel: {
      approved_for_main_panels:   dashboardQaResult.passed,
      appendix_only:              dashboardQaResult.appendix,
      blocked:                    dashboardQaResult.blocked,
      cross_category_intel:       rawDashboardPkg.cross_category_intel,
      counts:                     rawDashboardPkg.counts,
      intel_version:              rawDashboardPkg.intel_version,
    },

    // Registries for L7+ provenance lookup
    evidence_registry,
    source_registry,
    visualization_registry,

    // Combined QA report
    qa_report: extended_qa_report,

    // Version and timestamp
    analysis_version: ANALYSIS_PACKAGE_VERSION,
    run_timestamp:    new Date().toISOString(),
  };
}
