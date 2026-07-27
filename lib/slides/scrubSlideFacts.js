// Deterministic grounding scrub for slide supporting-facts.
//
// The category-report prompt is told not to introduce a statistic/count/name the
// insight does not contain, but LLMs still occasionally invent a specific figure
// (e.g. "13,873 actions"). This pass is a safety net: it drops any supporting fact
// carrying a SPECIFIC figure that does not appear in the fact's grounding text
// (the validated insight block + the sources the fact cites). Figure-matching
// logic is shared with the insight layer via lib/utils/figureGrounding.js.

import { checkFactGrounding } from "../utils/figureGrounding.js";

export { checkFactGrounding };

/**
 * Scrub a category report in place: drop supporting facts whose specific figures
 * are not grounded in (insight block + the fact's cited sources). Returns the list
 * of dropped facts for logging.
 *
 * @param {object} report   generateCategoryReport() output (mutated)
 * @param {object} context  buildCategoryContext() output (insightsBlock + sourceIndex)
 */
export function scrubSlideReport(report, context) {
  const dropped = [];
  const insightText = context?.insightsBlock || "";
  const idx = context?.sourceIndex || {};

  for (const shift of report?.strategic_shifts || []) {
    const kept = [];
    for (const ev of shift.supporting_evidence || []) {
      // Grounding = insight block + the sources this fact cites.
      const citedText = (ev.cited_sources || [])
        .map(l => `${idx[l]?.summary || ""} ${idx[l]?.evidence_text || ""}`)
        .join(" ");
      const { grounded, ungrounded } = checkFactGrounding(ev.fact, `${insightText} ${citedText}`);
      if (grounded) kept.push(ev);
      else dropped.push({ shift: shift.headline, fact: ev.fact, ungrounded, cited: ev.cited_sources });
    }
    shift.supporting_evidence = kept;
  }
  return dropped;
}
