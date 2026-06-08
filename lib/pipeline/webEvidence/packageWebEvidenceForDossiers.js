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

import { randomUUID } from "crypto";
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

// Build a structured unsupported_query object from a raw query string + context
function buildUnsupportedQuery(query, category, mission = null, searchedAt = null) {
  return {
    query_id:           `uq_${randomUUID().slice(0, 8)}`,
    category:           category || null,
    query:              typeof query === "string" ? query : (query?.query || String(query)),
    search_intent:      mission || null,
    reason_unsupported: query?.reason || "no_reliable_sources_found",
    searched_at:        searchedAt || new Date().toISOString(),
    sources_checked:    [],
    next_action:        "manual_review",
  };
}

/**
 * @param {object} params { selectedEvidence, allEvidence, visuals, unsupportedByCategory, missions }
 * @returns {object} { byCategory, flat, unsupported_queries_structured, source_quality_report }
 */
export function packageWebEvidenceForDossiers(params = {}) {
  const { selectedEvidence = [], allEvidence = [], visuals = [], unsupportedByCategory = {}, missions = [] } = params;

  // Build structured unsupported_queries (replacing raw string lists)
  const searchedAt = new Date().toISOString();
  const missionByCategory = {};
  for (const m of missions) {
    missionByCategory[m.category] = m.mission;
  }

  const unsupported_queries_structured = [];
  for (const [cat, queries] of Object.entries(unsupportedByCategory)) {
    for (const q of queries) {
      unsupported_queries_structured.push(
        buildUnsupportedQuery(q, cat, missionByCategory[cat], searchedAt)
      );
    }
  }

  const byCategory = {};
  for (const cat of ANALYSIS_CATEGORIES) {
    const sel     = selectedEvidence.filter((e) => e.category === cat && analysisUsableEvidence(e));
    const vis     = visuals.filter((v) => v.category === cat && analysisUsableVisual(v));
    const rejected= allEvidence.filter((e) => e.category === cat &&
      (e.validation_status === "rejected" || e.qa_status === "rejected" || (!DEPTH_ALLOWED_IN_ANALYSIS.has(e.evidence_depth) && e.is_cluster_representative !== false)));
    const manual  = [
      ...allEvidence.filter((e) => e.category === cat && e.manual_review_required),
      ...visuals.filter((v) => v.category === cat && (v.manual_review_required || v.slide_suitability?.decision === "manual_review")),
    ];
    const catUq   = unsupported_queries_structured.filter((q) => q.category === cat);

    byCategory[cat] = {
      evidence_items:    sel,
      visual_evidence:   vis,
      rejected_items:    rejected,
      manual_review_items: manual,
      unsupported_queries: catUq,
    };
  }

  // Flat convenience
  const flat = {
    evidence_items:   selectedEvidence.filter(analysisUsableEvidence),
    visual_evidence:  visuals.filter(analysisUsableVisual),
    rejected_items:   allEvidence.filter((e) => e.validation_status === "rejected" || e.qa_status === "rejected"),
    manual_review_items: [
      ...allEvidence.filter((e) => e.manual_review_required),
      ...visuals.filter((v) => v.manual_review_required || v.slide_suitability?.decision === "manual_review"),
    ],
    unsupported_queries: unsupported_queries_structured,
  };

  return { byCategory, flat, unsupported_queries_structured };
}
