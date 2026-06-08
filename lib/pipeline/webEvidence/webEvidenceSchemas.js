/**
 * Layer 5C — Web Evidence + Visual Evidence schemas.
 *
 * Flexible evidence objects (no hard-coded narrow evidence types). The shape is
 * fixed but the CONTENT is open — depth/usefulness/grounding gates decide quality,
 * not an enum of allowed evidence kinds.
 */

import { randomUUID } from "crypto";
import { normalizeUrlForGrounding } from "../discovery/candidateGates.js";

// ── Controlled vocabularies ───────────────────────────────────────────────────

export const EVIDENCE_DEPTH = ["thin", "concrete", "detailed", "walkthrough_grade"];
export const VALID_EVIDENCE_DEPTH = new Set(EVIDENCE_DEPTH);
// Only these depths may enter Layer 6.
export const DEPTH_ALLOWED_IN_ANALYSIS = new Set(["concrete", "detailed", "walkthrough_grade"]);

export const ANALYSIS_USEFULNESS = ["high", "medium", "low", "not_useful"];
export const VALID_ANALYSIS_USEFULNESS = new Set(ANALYSIS_USEFULNESS);

export const WALKTHROUGH_STATUS = ["complete_walkthrough", "partial_walkthrough", "not_walkthrough"];
export const VALID_WALKTHROUGH_STATUS = new Set(WALKTHROUGH_STATUS);

export const SOURCE_LINEAGE = ["original", "derivative_with_value", "derivative_archive_only", "unknown"];
export const VALID_SOURCE_LINEAGE = new Set(SOURCE_LINEAGE);

export const CONFIDENCE = ["low", "medium", "high"];
export const VALID_CONFIDENCE = new Set(CONFIDENCE);

export const VISUAL_KIND = [
  "diagram", "graph", "chart", "table", "html_table", "pdf_table", "data_table",
  "figure", "screenshot", "framework_map", "timeline",
];
export const VALID_VISUAL_KIND = new Set(VISUAL_KIND);

export const CAPTURE_METHOD = [
  "direct_image", "page_screenshot", "pdf_page_screenshot",
  "html_table_extract", "pdf_table_extract", "manual_review",
];
export const VALID_CAPTURE_METHOD = new Set(CAPTURE_METHOD);

export const VISUAL_USEFULNESS_LEVEL = ["high", "medium", "low", "not_useful"];
export const VALID_VISUAL_USEFULNESS_LEVEL = new Set(VISUAL_USEFULNESS_LEVEL);

export const SLIDE_DECISION = ["embed", "redraw", "cite_only", "manual_review", "reject"];
export const VALID_SLIDE_DECISION = new Set(SLIDE_DECISION);
// Only these enter automatic slide generation.
export const SLIDE_AUTO_DECISIONS = new Set(["embed", "redraw"]);

export const RECOMMENDED_SLIDE_ROLE = ["hero_visual", "supporting_visual", "appendix_reference", "cite_only", "reject"];
export const COPYRIGHT_STATUS = ["open_license", "public_report", "unknown", "restricted"];

export const SEARCH_PROVIDERS = ["tavily", "serpapi", "arxiv", "github", "nvd", "cisa", "gemini_grounding", "claude_web"];
export const VALID_SEARCH_PROVIDERS = new Set(SEARCH_PROVIDERS);

// ── Normalized search result (one shape across all providers) ─────────────────

export function normalizeSearchResult(raw, provider, query, rank = 0) {
  if (!raw) return null;
  const url = (raw.result_url || raw.url || raw.link || "").trim();
  if (!url) return null;
  return {
    provider,
    query: query || raw.query || "",
    result_url: url,
    title: (raw.title || "").trim(),
    snippet: (raw.snippet || raw.content || raw.description || "").trim().slice(0, 800),
    published_date: raw.published_date || raw.date || null,
    source_class_hint: raw.source_class_hint || null,
    rank: rank || raw.rank || 0,
    raw_provider_metadata: raw.raw_provider_metadata || {},
  };
}

/** Canonical-URL dedup key shared across providers + clustering. */
export function canonicalUrlKey(url) {
  return normalizeUrlForGrounding(url);
}

/** Dedup an array of normalized search results across providers by canonical URL. */
export function dedupeSearchResults(results = []) {
  const seen = new Map();   // key → result (first/best kept)
  for (const r of results) {
    if (!r?.result_url) continue;
    const key = canonicalUrlKey(r.result_url);
    if (!seen.has(key)) { seen.set(key, r); continue; }
    // Keep the better-ranked (lower rank number) / earlier-provider result.
    const prev = seen.get(key);
    if ((r.rank || 99) < (prev.rank || 99)) seen.set(key, r);
  }
  return [...seen.values()];
}

// ── Web evidence object factory ───────────────────────────────────────────────

export function makeWebEvidenceObject(partial = {}) {
  return {
    web_evidence_id: partial.web_evidence_id || `webev_${randomUUID().slice(0, 10)}`,
    evidence_label: partial.evidence_label || "",
    evidence_depth: VALID_EVIDENCE_DEPTH.has(partial.evidence_depth) ? partial.evidence_depth : "thin",
    analysis_usefulness: VALID_ANALYSIS_USEFULNESS.has(partial.analysis_usefulness) ? partial.analysis_usefulness : "low",
    why_this_is_useful: partial.why_this_is_useful || "",
    concrete_claim: partial.concrete_claim || "",
    operational_details: {
      actor: null, target: null, affected_system: null, technique: null,
      tools_or_models: [], vulnerabilities_or_weaknesses: [], attack_steps: [],
      impact: null, date_or_timeframe: null,
      ...(partial.operational_details || {}),
    },
    walkthrough_status: VALID_WALKTHROUGH_STATUS.has(partial.walkthrough_status) ? partial.walkthrough_status : "not_walkthrough",
    // Authoritative statistics extracted for quantitative/benchmark missions.
    // Each: { metric, value, timeframe, source_basis, quote }. Validated (and dropped
    // if ungrounded) by validateWebEvidence.js. Replaces the retired Layer 5E stat search.
    statistics: Array.isArray(partial.statistics)
      ? partial.statistics.filter((s) => s && typeof s === "object")
      : [],
    source_grounding: {
      source_url: "", opened_url_confirmed: false, publisher: "", title: "",
      published_date: null, verbatim_quotes: [],
      ...(partial.source_grounding || {}),
    },
    taxonomy_context: {
      primary_domain: null, primary_tags: [], sub_techniques: [],
      ai_enabled: false, ai_enabled_roles: [],
      ...(partial.taxonomy_context || {}),
    },
    source_lineage: {
      source_lineage_status: "unknown", original_source_url: null, derivative_source_url: null,
      ...(partial.source_lineage || {}),
    },
    confidence: VALID_CONFIDENCE.has(partial.confidence) ? partial.confidence : "low",
    selection_reason: partial.selection_reason || null,
    manual_review_required: partial.manual_review_required === true,
    rejection_reason: partial.rejection_reason || null,
    // cluster bookkeeping
    duplicate_cluster_id: partial.duplicate_cluster_id || null,
    is_cluster_representative: partial.is_cluster_representative ?? true,
    duplicate_reason: partial.duplicate_reason || null,
    category: partial.category || null,
    discovery_mission: partial.discovery_mission || null,
  };
}

// ── Visual evidence object factory ────────────────────────────────────────────

export function makeVisualEvidenceObject(partial = {}) {
  return {
    visual_evidence_id: partial.visual_evidence_id || `webvis_${randomUUID().slice(0, 10)}`,
    visual_label: partial.visual_label || "",
    visual_kind: VALID_VISUAL_KIND.has(partial.visual_kind) ? partial.visual_kind : "figure",
    source_url: partial.source_url || "",
    visual_url: partial.visual_url || null,
    local_image_path: partial.local_image_path || null,
    screenshot_path: partial.screenshot_path || null,
    full_page_screenshot_path: partial.full_page_screenshot_path || null,
    cropped_visual_path: partial.cropped_visual_path || null,
    crop_method: ["auto", "manual_review", "none"].includes(partial.crop_method) ? partial.crop_method : "none",
    bounding_box: partial.bounding_box || {},
    capture_method: VALID_CAPTURE_METHOD.has(partial.capture_method) ? partial.capture_method : "manual_review",
    page_number: partial.page_number ?? null,
    caption_or_nearby_text: partial.caption_or_nearby_text || "",
    what_it_shows: partial.what_it_shows || "",
    why_it_is_relevant: partial.why_it_is_relevant || "",
    supports_evidence_ids: Array.isArray(partial.supports_evidence_ids) ? partial.supports_evidence_ids : [],
    visual_claim: partial.visual_claim || "",
    claim_supported_by_visual: partial.claim_supported_by_visual === true,
    image_hash: partial.image_hash || null,
    taxonomy_context: {
      primary_domain: null, primary_tags: [], sub_techniques: [],
      ...(partial.taxonomy_context || {}),
    },
    visual_quality: {
      readable: false, has_title: false, has_axis_or_labels: false,
      not_decorative: false, data_extractable: false, ocr_quality: "not_needed",
      ...(partial.visual_quality || {}),
    },
    usage: {
      slide_usable: false, preferred_use: "manual_review", copyright_status: "unknown",
      ...(partial.usage || {}),
    },
    visual_usefulness: {
      level: "not_useful", usefulness_reason: "", adds_value_by: [],
      text_equivalent: "", slide_space_justification: "", recommended_slide_role: "reject",
      ...(partial.visual_usefulness || {}),
    },
    slide_suitability: {
      decision: "manual_review", reason: "", supports_slide_claim: "",
      best_slide_use: null, required_attribution: "", risk_flags: [],
      ...(partial.slide_suitability || {}),
    },
    duplicate_cluster_id: partial.duplicate_cluster_id || null,
    is_cluster_representative: partial.is_cluster_representative ?? true,
    duplicate_reason: partial.duplicate_reason || null,
    category: partial.category || null,
    manual_review_required: partial.manual_review_required === true,
    rejection_reason: partial.rejection_reason || null,
  };
}

// ── Shape validators (structural, not quality) ────────────────────────────────

export function validateWebEvidenceShape(e) {
  const errs = [];
  if (!e?.web_evidence_id) errs.push("missing web_evidence_id");
  if (!VALID_EVIDENCE_DEPTH.has(e?.evidence_depth)) errs.push(`invalid evidence_depth: ${e?.evidence_depth}`);
  if (!e?.source_grounding?.source_url) errs.push("missing source_grounding.source_url");
  if (!VALID_WALKTHROUGH_STATUS.has(e?.walkthrough_status)) errs.push("invalid walkthrough_status");
  return errs;
}

export function validateVisualEvidenceShape(v) {
  const errs = [];
  if (!v?.visual_evidence_id) errs.push("missing visual_evidence_id");
  if (!v?.source_url) errs.push("missing source_url");
  if (!VALID_VISUAL_KIND.has(v?.visual_kind)) errs.push(`invalid visual_kind: ${v?.visual_kind}`);
  if (!VALID_SLIDE_DECISION.has(v?.slide_suitability?.decision)) errs.push("invalid slide_suitability.decision");
  return errs;
}
