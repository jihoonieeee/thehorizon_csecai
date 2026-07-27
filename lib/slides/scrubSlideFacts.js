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
 * @param {object} report          generateCategoryReport() output (mutated)
 * @param {object} context         buildCategoryContext() output (insightsBlock + sourceIndex)
 * @param {Map}    [fullTextByUrl] url → full_text; when given, a cited source's
 *                                 full text is used as grounding (same basis as
 *                                 the insight layer) instead of its short summary.
 */
export function scrubSlideReport(report, context, fullTextByUrl = null) {
  const dropped = [];
  const insightText = context?.insightsBlock || "";
  const idx = context?.sourceIndex || {};

  for (const shift of report?.strategic_shifts || []) {
    const kept = [];
    for (const ev of shift.supporting_evidence || []) {
      // Grounding = insight block + the sources this fact cites (full text when
      // available, else summary + evidence items).
      const citedText = (ev.cited_sources || [])
        .map(l => {
          const src = idx[l];
          const ft = fullTextByUrl?.get(src?.source_url);
          return ft || `${src?.summary || ""} ${src?.evidence_text || ""}`;
        })
        .join(" ");
      const { grounded, ungrounded } = checkFactGrounding(ev.fact, `${insightText} ${citedText}`);
      if (grounded) kept.push(ev);
      else dropped.push({ shift: shift.headline, fact: ev.fact, ungrounded, cited: ev.cited_sources });
    }
    shift.supporting_evidence = kept;
  }
  return dropped;
}
