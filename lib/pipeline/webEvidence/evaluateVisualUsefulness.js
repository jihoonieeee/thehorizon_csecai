/**
 * Layer 5C.8 — Visual usefulness + slide-suitability decisions.
 *
 * No arbitrary numeric scores. Categorical decisions over deterministic filters +
 * (optional) lightweight classification flags:
 *
 *   visual_usefulness.level   — high | medium | low | not_useful
 *   slide_suitability.decision — embed | redraw | cite_only | manual_review | reject
 *
 * The "5-second question": what can the audience understand from this visual that
 * text would not explain equally well?
 */

// Visual kinds whose IMAGE is itself the analytical evidence → embed when strong.
const EMBED_KINDS = new Set(["diagram", "framework_map", "timeline", "figure"]);
// Visual kinds whose DATA can be re-drawn → redraw when extractable.
const REDRAW_KINDS = new Set(["chart", "graph", "table", "html_table", "pdf_table", "data_table"]);

// Classification flags (from classifyVisuals) that signal high analytical density.
const HIGH_SIGNAL_FLAGS = new Set([
  "contains_attack_flow", "contains_benchmark", "contains_trend", "contains_comparison", "architecture",
]);

function hasClaimBinding(v) {
  if (Array.isArray(v.supports_evidence_ids) && v.supports_evidence_ids.length > 0) return true;
  const hasClaim = !!(v.visual_claim && v.visual_claim.trim());
  const hasSupport = !!(v.caption_or_nearby_text || v.visual_quality?.has_axis_or_labels || v.visual_quality?.data_extractable);
  return hasClaim && hasSupport;
}

function hasAsset(v) {
  return !!(v.visual_url || v.local_image_path || v.screenshot_path || v.cropped_visual_path ||
    v.capture_method === "html_table_extract" || v.capture_method === "pdf_table_extract");
}

/**
 * STAGE 1 deterministic filtering — returns a hard reject reason or null.
 */
export function deterministicVisualFilter(v) {
  if (!v.source_url) return "missing_source_url";
  if (!hasAsset(v)) return "no_image_screenshot_or_table";
  if (!v.caption_or_nearby_text && !hasClaimBinding(v)) return "no_caption_or_context";
  if (v.visual_quality?.readable === false) return "not_readable";
  if (v.visual_quality?.not_decorative === false) return "decorative";
  return null;
}

/**
 * Evaluate usefulness level (categorical). Mutates a copy and returns it.
 */
export function evaluateVisualUsefulness(visual, classification = {}) {
  const v = { ...visual };
  const flags = new Set([...(classification.flags || []), ...(v._classification_flags || [])]);

  const hardReject = deterministicVisualFilter(v);
  if (hardReject) {
    v.visual_usefulness = { ...v.visual_usefulness, level: "not_useful", usefulness_reason: hardReject, recommended_slide_role: "reject" };
    v.rejection_reason = v.rejection_reason || hardReject;
    return v;
  }

  const bound = hasClaimBinding(v);
  const analytical = EMBED_KINDS.has(v.visual_kind) || REDRAW_KINDS.has(v.visual_kind) ||
    [...flags].some((f) => HIGH_SIGNAL_FLAGS.has(f));

  let level, reason, role;
  if (!bound) {
    level = "not_useful"; reason = "no visual-to-claim binding"; role = "reject";
  } else if (analytical && (flags.has("contains_attack_flow") || flags.has("contains_benchmark") ||
             flags.has("contains_trend") || flags.has("contains_comparison") ||
             EMBED_KINDS.has(v.visual_kind) || v.visual_kind === "chart" || v.visual_kind === "graph")) {
    level = "high"; reason = "compresses analytical information (attack flow / benchmark / trend / architecture / timeline)"; role = "hero_visual";
  } else if (v.visual_quality?.has_axis_or_labels || v.visual_quality?.data_extractable || REDRAW_KINDS.has(v.visual_kind)) {
    level = "medium"; reason = "supports one analytical claim clearly"; role = "supporting_visual";
  } else {
    level = "low"; reason = "relevant but weak / likely repeats a single bullet"; role = "appendix_reference";
  }

  v.visual_usefulness = {
    ...v.visual_usefulness,
    level, usefulness_reason: reason,
    recommended_slide_role: role,
    adds_value_by: [...flags].filter((f) => HIGH_SIGNAL_FLAGS.has(f)),
  };
  return v;
}

/**
 * Slide-suitability decision (categorical). Depends on usefulness + kind +
 * data extractability + copyright + binding. Mutates a copy and returns it.
 */
export function decideSlideSuitability(visual) {
  const v = { ...visual };
  const level = v.visual_usefulness?.level || "not_useful";
  const bound = hasClaimBinding(v);
  const copyright = v.usage?.copyright_status || "unknown";

  const set = (decision, reason, best_slide_use = null, extraFlags = []) => {
    const risk_flags = [...extraFlags];
    if (copyright === "restricted") risk_flags.push("restricted_copyright");
    if (copyright === "unknown" && (decision === "embed")) risk_flags.push("copyright_unverified");
    v.slide_suitability = {
      ...v.slide_suitability,
      decision, reason, best_slide_use,
      supports_slide_claim: v.visual_claim || (v.supports_evidence_ids?.[0] ? `evidence:${v.supports_evidence_ids[0]}` : ""),
      required_attribution: v.source_url ? `Source: ${v.source_url}` : "",
      risk_flags,
    };
    v.usage = { ...v.usage, slide_usable: decision === "embed" || decision === "redraw", preferred_use: decision };
    return v;
  };

  // reject
  if (level === "not_useful" || !bound || v.rejection_reason) {
    return set("reject", v.rejection_reason || "not useful or no claim binding");
  }
  // manual_review — uncertainty in capture/crop/OCR
  if (v.capture_method === "manual_review" || v.crop_method === "manual_review" ||
      v.visual_quality?.ocr_quality === "poor" || v.manual_review_required) {
    return set("manual_review", "uncertain capture / crop / OCR quality");
  }
  // redraw — extractable data charts/tables (recreate values; never infer from pixels)
  if (REDRAW_KINDS.has(v.visual_kind) && v.visual_quality?.data_extractable) {
    return set("redraw", "data extractable from labels/table — redraw to avoid pixel inference",
      v.visual_kind.includes("table") ? "comparison" : "benchmark");
  }
  // embed — the image itself is the analytical evidence (diagram/architecture/attack chain/timeline)
  if (EMBED_KINDS.has(v.visual_kind) && level === "high" && copyright !== "restricted") {
    const use = v.visual_kind === "timeline" ? "timeline"
      : v.visual_kind === "framework_map" ? "taxonomy"
      : /attack|exploit|kill chain/i.test(v.visual_claim || v.caption_or_nearby_text || "") ? "attack_walkthrough"
      : "architecture";
    return set("embed", "image is the analytical evidence (diagram/architecture/attack chain/timeline)", use);
  }
  // cite_only — restricted copyright, low usefulness, or non-embeddable supporting visual
  if (copyright === "restricted") return set("cite_only", "restricted copyright — reference, do not embed");
  if (level === "low") return set("cite_only", "useful as reference only");
  return set("cite_only", "supporting visual — reference unless reviewed");
}

/** Convenience: run both stages. */
export function evaluateVisual(visual, classification = {}) {
  return decideSlideSuitability(evaluateVisualUsefulness(visual, classification));
}
