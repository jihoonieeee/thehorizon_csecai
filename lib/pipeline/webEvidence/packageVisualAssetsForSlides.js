/**
 * Layer 5C.12 — Package visuals as slide asset candidates for Layer 7.
 *
 * Routing by slide_suitability.decision:
 *   embed / redraw  → automatic slide candidates
 *   cite_only       → references / appendix only
 *   manual_review   → manual pack only (never auto-embedded)
 *   reject          → excluded
 *
 * Candidate types: web_visual_embed_candidate, web_visual_redraw_candidate,
 * web_attack_chain_visual_candidate, web_case_study_visual_candidate,
 * web_framework_visual_candidate, web_table_redraw_candidate, web_manual_review_visual.
 * Attribution + source + caption + relevance + supported evidence IDs are always preserved.
 */

import { SLIDE_AUTO_DECISIONS } from "./webEvidenceSchemas.js";

function candidateType(v) {
  const decision = v.slide_suitability?.decision;
  const use = v.slide_suitability?.best_slide_use;
  if (decision === "redraw") {
    return (v.visual_kind || "").includes("table") ? "web_table_redraw_candidate" : "web_visual_redraw_candidate";
  }
  if (decision === "embed") {
    if (use === "attack_walkthrough") return "web_attack_chain_visual_candidate";
    if (use === "case_study") return "web_case_study_visual_candidate";
    if (use === "taxonomy" || v.visual_kind === "framework_map") return "web_framework_visual_candidate";
    return "web_visual_embed_candidate";
  }
  if (decision === "manual_review") return "web_manual_review_visual";
  return null;
}

function toAsset(v, candidate_type) {
  return {
    candidate_type,
    visual_evidence_id: v.visual_evidence_id,
    category: v.category,
    visual_kind: v.visual_kind,
    decision: v.slide_suitability?.decision,
    best_slide_use: v.slide_suitability?.best_slide_use || null,
    // assets
    visual_url: v.visual_url || null,
    local_image_path: v.local_image_path || null,
    screenshot_path: v.screenshot_path || null,
    cropped_visual_path: v.cropped_visual_path || null,
    table_data: v._table_data || null,
    page_number: v.page_number ?? null,
    // provenance / attribution (always preserved)
    source_url: v.source_url,
    caption_or_nearby_text: v.caption_or_nearby_text,
    what_it_shows: v.what_it_shows,
    why_it_is_relevant: v.why_it_is_relevant,
    required_attribution: v.slide_suitability?.required_attribution || `Source: ${v.source_url}`,
    supports_evidence_ids: v.supports_evidence_ids || [],
    usage_recommendation: v.usage?.preferred_use || v.slide_suitability?.decision,
    copyright_status: v.usage?.copyright_status || "unknown",
    risk_flags: v.slide_suitability?.risk_flags || [],
  };
}

/**
 * @param {object[]} visuals  validated visuals
 * @param {object} [opts]   { maxFinalVisualsPerCategory=3, maxHeroVisualsPerCategory=1 }
 * @returns {object} { auto_slide_candidates, reference_only, manual_review_pack, excluded }
 */
export function packageVisualAssetsForSlides(visuals = [], opts = {}) {
  const maxFinal = opts.maxFinalVisualsPerCategory ?? 3;
  const maxHero = opts.maxHeroVisualsPerCategory ?? 1;

  const auto = [], reference = [], manual = [], excluded = [];

  for (const v of visuals) {
    const decision = v.slide_suitability?.decision;
    if (decision === "reject") { excluded.push(v.visual_evidence_id); continue; }
    if (decision === "cite_only") { reference.push(toAsset(v, "web_cite_only_visual")); continue; }
    const ct = candidateType(v);
    if (!ct) { excluded.push(v.visual_evidence_id); continue; }
    if (ct === "web_manual_review_visual") { manual.push(toAsset(v, ct)); continue; }
    if (SLIDE_AUTO_DECISIONS.has(decision)) auto.push(toAsset(v, ct));
  }

  // Per-category caps: at most maxFinal auto candidates, at most maxHero "hero" (embed) per category.
  const byCat = {};
  const capped = [];
  for (const a of auto) {
    const cat = a.category || "_";
    byCat[cat] ||= { total: 0, hero: 0 };
    const isHero = a.decision === "embed";
    if (byCat[cat].total >= maxFinal) continue;
    if (isHero && byCat[cat].hero >= maxHero) continue;
    byCat[cat].total++;
    if (isHero) byCat[cat].hero++;
    capped.push(a);
  }

  return { auto_slide_candidates: capped, reference_only: reference, manual_review_pack: manual, excluded };
}
