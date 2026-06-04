/**
 * Layer 5C.8a — Lightweight visual classification.
 *
 * STAGE 2 of the visual usefulness pipeline. A cheap vision model could classify
 * downloaded image bytes, but that is optional and off by default; the default
 * path is a deterministic heuristic over the caption / nearby text / labels /
 * kind, which is reliable, free, and fully testable. Classification flags feed
 * evaluateVisualUsefulness (it does NOT decide usefulness itself).
 */

const FLAG_PATTERNS = [
  ["contains_attack_flow", /attack chain|exploit flow|attack flow|kill chain|attack path/i],
  ["contains_benchmark",   /benchmark|attack success rate|\bASR\b|leaderboard|evaluation results?/i],
  ["contains_trend",       /trend|over time|year[- ]over[- ]year|growth|timeline|monthly|quarterly/i],
  ["contains_comparison",  /\bvs\.?\b|comparison|compared to|relative to|baseline/i],
  ["architecture",         /architecture|pipeline|system diagram|data flow|component diagram/i],
  ["contains_data",        /\b\d+(?:\.\d+)?%|\$\d|\btable\b|\bfigure\b/i],
];

const KIND_HINTS = [
  ["timeline",      /timeline|over time|chronolog/i],
  ["framework_map", /framework|taxonomy|matrix|att&ck|owasp/i],
  ["chart",         /chart|graph|plot|bar (chart|graph)|line (chart|graph)/i],
  ["table",         /table|column|row/i],
  ["diagram",       /diagram|architecture|flow|schematic/i],
];

/**
 * Classify a visual from its caption/context + declared kind.
 * @returns {{ kind, flags: string[], decorative: boolean }}
 */
export function classifyVisual(visual) {
  const text = `${visual.caption_or_nearby_text || ""} ${visual.what_it_shows || ""} ${visual.visual_label || ""} ${visual.visual_claim || ""}`;
  const flags = [];
  for (const [flag, pat] of FLAG_PATTERNS) if (pat.test(text)) flags.push(flag);

  let kind = visual.visual_kind && visual.visual_kind !== "figure" ? visual.visual_kind : null;
  if (!kind) {
    for (const [k, pat] of KIND_HINTS) { if (pat.test(text)) { kind = k; break; } }
  }
  kind = kind || visual.visual_kind || "figure";

  const decorative = /\b(logo|stock photo|stock image|illustration|banner|hero image|decorative)\b/i.test(text) ||
    (flags.length === 0 && !/\b(chart|graph|table|diagram|figure|timeline|architecture|framework)\b/i.test(text) &&
     !(visual.visual_quality?.has_axis_or_labels || visual.visual_quality?.data_extractable));

  return { kind, flags, decorative };
}

/**
 * Apply classification onto a visual (sets visual_kind, _classification_flags,
 * and visual_quality.not_decorative). Returns a copy.
 */
export function applyVisualClassification(visual) {
  const { kind, flags, decorative } = classifyVisual(visual);
  return {
    ...visual,
    visual_kind: kind,
    _classification_flags: flags,
    visual_quality: {
      ...visual.visual_quality,
      not_decorative: visual.visual_quality?.not_decorative === false ? false : !decorative,
    },
  };
}

export function classifyVisualsBatch(visuals = []) {
  return visuals.map(applyVisualClassification);
}
