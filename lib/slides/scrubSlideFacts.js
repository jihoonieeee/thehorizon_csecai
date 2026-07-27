// Deterministic grounding scrub for slide supporting-facts.
//
// The category-report prompt is told not to introduce a statistic/count/name the
// insight does not contain, but LLMs still occasionally invent a specific figure
// (e.g. "13,873 actions", "five skills" when the source says two). This pass is a
// safety net: it drops any supporting fact carrying a SPECIFIC figure that does
// not appear in the fact's grounding text (the validated insight block + the
// sources the fact cites). It targets invented/mis-stated NUMBERS — entity
// conflation and superlatives are handled by the prompt, not here.

// Spelled-out counts worth checking (skip "one" — too common/ambiguous).
const NUMBER_WORDS = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  thousand: 1000, million: 1e6, billion: 1e9, dozen: 12,
};

const normalize = (s) => String(s || "").toLowerCase().replace(/,/g, "");

// A "specific figure" is one worth grounding: percentage, decimal, comma-grouped
// number, integer with ≥3 digits, or a spelled count word. Small bare integers
// ("two pivots") in prose are low-risk and skipped — unless they are a count word.
function extractSpecificFigures(text) {
  const figs = [];
  const t = String(text || "");

  // Numeric tokens with their original punctuation.
  for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?%?/g)) {
    const raw = m[0];
    const hasPct   = raw.includes("%");
    const hasComma = raw.includes(",");
    const hasDec   = raw.includes(".");
    const digits   = raw.replace(/[,%]/g, "");
    const intPart  = digits.split(".")[0];
    if (hasPct || hasComma || hasDec || intPart.length >= 3) {
      figs.push({ display: raw, norm: normalize(raw).replace("%", "") });
    }
  }

  // Spelled-out count words.
  for (const m of t.matchAll(/\b([a-z]+)\b/gi)) {
    const w = m[1].toLowerCase();
    if (w in NUMBER_WORDS) figs.push({ display: w, norm: w, word: true, digit: String(NUMBER_WORDS[w]) });
  }

  return figs;
}

// Is a figure present in the grounding text? Numbers match on their comma-stripped
// form; count-words match either the word or its digit form (and vice-versa).
function figureGrounded(fig, groundingNorm) {
  if (fig.word) {
    const wordRe  = new RegExp(`\\b${fig.norm}\\b`);
    const digitRe = new RegExp(`\\b${fig.digit}\\b`);
    return wordRe.test(groundingNorm) || digitRe.test(groundingNorm);
  }
  // Numeric: match the normalized digit string on a boundary so "5" doesn't hit "search5".
  const re = new RegExp(`\\b${fig.norm.replace(/\./g, "\\.")}\\b`);
  return re.test(groundingNorm);
}

/**
 * Check a single fact against grounding text.
 * @returns {{ grounded: boolean, ungrounded: string[] }}
 */
export function checkFactGrounding(factText, groundingText) {
  const figs = extractSpecificFigures(factText);
  if (!figs.length) return { grounded: true, ungrounded: [] };
  const g = normalize(groundingText);
  const ungrounded = figs.filter(f => !figureGrounded(f, g)).map(f => f.display);
  return { grounded: ungrounded.length === 0, ungrounded };
}

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
