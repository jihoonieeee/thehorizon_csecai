/**
 * Layer 5C.11 — Package web evidence for Layer 6 dossiers.
 *
 * Produces a per-category `web_evidence` section:
 *   { evidence_items, visual_evidence, rejected_items, unsupported_queries, manual_review_items }
 *
 * Layer 6 may use evidence_items only if depth ∈ {concrete,detailed,walkthrough_grade},
 * quote verified, source URL confirmed, validation passed. It may use visuals only if
 * usefulness ∈ {medium,high}, claim-bound, asset present, and slide_suitability ≠ reject.
 */

import { DEPTH_ALLOWED_IN_ANALYSIS } from "./webEvidenceSchemas.js";

const ANALYSIS_CATEGORIES = ["traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats"];

function analysisUsableEvidence(e) {
  return e.validation_status !== "rejected" && e.qa_status !== "rejected" &&
    DEPTH_ALLOWED_IN_ANALYSIS.has(e.evidence_depth) &&
    e.source_grounding?.opened_url_confirmed === true &&
    (e.source_grounding?.verbatim_quotes || []).some((q) => String(q || "").trim().length >= 20);
}

function analysisUsableVisual(v) {
  return v.slide_suitability?.decision !== "reject" &&
    v.validation_status !== "rejected" &&
    ["medium", "high"].includes(v.visual_usefulness?.level) &&
    !!v.source_url &&
    (!!v.visual_url || !!v.local_image_path || !!v.screenshot_path || v.capture_method === "html_table_extract" || v.capture_method === "pdf_table_extract");
}

/**
 * @param {object} params { selectedEvidence, allEvidence, visuals, unsupportedByCategory }
 * @returns {object} { byCategory: { cat: web_evidence }, flat: { evidence_items, visual_evidence, ... } }
 */
export function packageWebEvidenceForDossiers(params = {}) {
  const { selectedEvidence = [], allEvidence = [], visuals = [], unsupportedByCategory = {} } = params;

  const byCategory = {};
  for (const cat of ANALYSIS_CATEGORIES) {
    const sel = selectedEvidence.filter((e) => e.category === cat && analysisUsableEvidence(e));
    const vis = visuals.filter((v) => v.category === cat && analysisUsableVisual(v));
    const rejected = allEvidence.filter((e) => e.category === cat &&
      (e.validation_status === "rejected" || e.qa_status === "rejected" || (!DEPTH_ALLOWED_IN_ANALYSIS.has(e.evidence_depth) && e.is_cluster_representative !== false)));
    const manual = [
      ...allEvidence.filter((e) => e.category === cat && e.manual_review_required),
      ...visuals.filter((v) => v.category === cat && (v.manual_review_required || v.slide_suitability?.decision === "manual_review")),
    ];
    byCategory[cat] = {
      evidence_items: sel,
      visual_evidence: vis,
      rejected_items: rejected,
      manual_review_items: manual,
      unsupported_queries: unsupportedByCategory[cat] || [],
    };
  }

  // Flat convenience (allowed IDs: webev_*, webvis_*).
  const flat = {
    evidence_items: selectedEvidence.filter(analysisUsableEvidence),
    visual_evidence: visuals.filter(analysisUsableVisual),
    rejected_items: allEvidence.filter((e) => e.validation_status === "rejected" || e.qa_status === "rejected"),
    manual_review_items: [
      ...allEvidence.filter((e) => e.manual_review_required),
      ...visuals.filter((v) => v.manual_review_required || v.slide_suitability?.decision === "manual_review"),
    ],
    unsupported_queries: Object.values(unsupportedByCategory).flat(),
  };

  return { byCategory, flat };
}
