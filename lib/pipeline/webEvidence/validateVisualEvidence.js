/**
 * Layer 5C.7b — Anti-hallucination validation for visual evidence.
 *
 * Deterministic gates (no invented visual descriptions, no visual-only claims):
 *   - source_url required
 *   - an image / screenshot / table asset required
 *   - caption / nearby text / labels / data / linked evidence required (context)
 *   - visual-to-claim binding required (supports_evidence_ids OR visual_claim+support)
 *   - what_it_shows must be present (grounded in caption/labels, not invented)
 *   - slide_usable only if analytical + readable + useful
 *   - tables: preserve columns/labels/source; uncertain extraction → manual_review
 *   - OCR: poor OCR blocks numeric extraction (redraw requires reliable labels)
 */

import { SLIDE_AUTO_DECISIONS } from "./webEvidenceSchemas.js";

function hasAsset(v) {
  return !!(v.visual_url || v.local_image_path || v.screenshot_path || v.cropped_visual_path ||
    v.capture_method === "html_table_extract" || v.capture_method === "pdf_table_extract");
}

function hasContext(v) {
  return !!(v.caption_or_nearby_text || v.visual_quality?.has_axis_or_labels ||
    v.visual_quality?.data_extractable || (v.supports_evidence_ids || []).length > 0);
}

function hasClaimBinding(v) {
  if ((v.supports_evidence_ids || []).length > 0) return true;
  return !!(v.visual_claim && (v.caption_or_nearby_text || v.visual_quality?.has_axis_or_labels || v.visual_quality?.data_extractable));
}

export function validateVisualEvidence(visual) {
  const violations = [];
  const v = { ...visual };

  if (!v.source_url) violations.push("missing_source_url");
  if (!hasAsset(v)) violations.push("no_image_screenshot_or_table");
  if (!hasContext(v)) violations.push("no_caption_or_context");
  if (!hasClaimBinding(v)) violations.push("no_visual_to_claim_binding");
  if (!v.what_it_shows || !v.what_it_shows.trim()) violations.push("missing_what_it_shows");

  // OCR gate: poor OCR cannot be the sole basis for precise numbers → block redraw.
  const reliesOnOcrNumbers = v.slide_suitability?.decision === "redraw" &&
    v.visual_quality?.ocr_quality === "poor" && !v.visual_quality?.data_extractable;
  if (reliesOnOcrNumbers) violations.push("ocr_poor_blocks_numeric_extraction");

  // Uncertain table extraction → manual_review.
  const uncertainTable = (v.visual_kind === "pdf_table" || v.visual_kind === "html_table" || v.visual_kind === "table") &&
    v.visual_quality?.data_extractable === false;

  // Hard failures (cannot be a slide asset) → reject.
  const hard = ["missing_source_url", "no_image_screenshot_or_table", "no_visual_to_claim_binding"]
    .some((x) => violations.includes(x));

  if (hard) {
    v.slide_suitability = { ...v.slide_suitability, decision: "reject", reason: violations[0] };
    v.usage = { ...v.usage, slide_usable: false };
    v.rejection_reason = v.rejection_reason || violations[0];
    v.validation_status = "rejected";
  } else if (uncertainTable || violations.includes("ocr_poor_blocks_numeric_extraction") ||
             violations.includes("missing_what_it_shows") || violations.includes("no_caption_or_context")) {
    v.slide_suitability = { ...v.slide_suitability, decision: "manual_review", reason: violations[0] || "uncertain_extraction" };
    v.usage = { ...v.usage, slide_usable: false };
    v.manual_review_required = true;
    v.validation_status = "manual_review";
  } else {
    v.validation_status = "validated";
  }

  // Enforce: slide_usable only when the final decision is embed/redraw.
  v.usage = { ...v.usage, slide_usable: SLIDE_AUTO_DECISIONS.has(v.slide_suitability?.decision) };
  v.validation_violations = violations;
  return v;
}

export function validateVisualEvidenceBatch(items = []) {
  return items.map(validateVisualEvidence);
}
