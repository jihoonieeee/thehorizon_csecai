// Shared deterministic figure-grounding check.
//
// Used by (a) the slide fact scrub and (b) the insight-layer citation grounding
// to drop facts carrying a SPECIFIC figure (percentage, decimal, comma/3+-digit
// number, or spelled count-word) that does not appear in the grounding text. It
// targets invented/mis-stated NUMBERS — entity conflation and superlatives are out
// of scope and handled by prompts.

// Spelled-out counts worth checking (skip "one" — too common/ambiguous).
const NUMBER_WORDS = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  thousand: 1000, million: 1e6, billion: 1e9, dozen: 12,
};

const normalize = (s) => String(s || "").toLowerCase().replace(/,/g, "");

// Numbers immediately followed by one of these units are "specific" even at 1–2
// digits ("22 MB", "8 hours") — a precise measurement worth grounding.
const UNIT = "(?:%|MB|GB|KB|TB|PB|bytes?|hours?|hrs?|days?|minutes?|mins?|seconds?|secs?|weeks?|months?|years?|USD|EUR)";

// A "specific figure" is worth grounding: percentage, decimal, comma-grouped
// number, integer with ≥3 digits, a number+unit (any size), or a spelled count
// word. Small bare integers ("two pivots") in prose are low-risk and skipped.
export function extractSpecificFigures(text) {
  const figs = [];
  const t = String(text || "");
  const seen = new Set();
  const add = (raw) => {
    const norm = normalize(raw).replace("%", "");
    if (seen.has(norm)) return;
    seen.add(norm);
    figs.push({ display: raw, norm });
  };

  // Number + unit (any digit count) — e.g. "22 MB", "8 hours". Keep just the number.
  for (const m of t.matchAll(new RegExp(`\\d[\\d,]*(?:\\.\\d+)?\\s?${UNIT}`, "gi"))) {
    add(m[0].replace(new RegExp(`\\s?${UNIT}$`, "i"), ""));
  }
  // Standalone numbers specific on their own: %, decimal, comma-grouped, ≥3 digits.
  for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?%?/g)) {
    const raw = m[0];
    const hasPct = raw.includes("%");
    const hasComma = raw.includes(",");
    const hasDec = raw.includes(".");
    const intPart = raw.replace(/[,%]/g, "").split(".")[0];
    if (hasPct || hasComma || hasDec || intPart.length >= 3) add(raw);
  }

  for (const m of t.matchAll(/\b([a-z]+)\b/gi)) {
    const w = m[1].toLowerCase();
    if (w in NUMBER_WORDS) figs.push({ display: w, norm: w, word: true, digit: String(NUMBER_WORDS[w]) });
  }

  return figs;
}

function figureGrounded(fig, groundingNorm) {
  if (fig.word) {
    return new RegExp(`\\b${fig.norm}\\b`).test(groundingNorm) ||
           new RegExp(`\\b${fig.digit}\\b`).test(groundingNorm);
  }
  return new RegExp(`\\b${fig.norm.replace(/\./g, "\\.")}\\b`).test(groundingNorm);
}

/**
 * @returns {{ grounded: boolean, ungrounded: string[] }}
 */
export function checkFactGrounding(factText, groundingText) {
  const figs = extractSpecificFigures(factText);
  if (!figs.length) return { grounded: true, ungrounded: [] };
  const g = normalize(groundingText);
  const ungrounded = figs.filter(f => !figureGrounded(f, g)).map(f => f.display);
  return { grounded: ungrounded.length === 0, ungrounded };
}
