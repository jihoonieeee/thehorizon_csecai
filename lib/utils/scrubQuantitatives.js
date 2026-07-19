/**
 * scrubImpliedQuantitatives()
 *
 * Replaces implied quantitative language (surging, widespread, majority, etc.)
 * in a text string when those terms are not grounded by a supporting number in
 * the accompanying evidence text. Prevents ungrounded claims in summaries.
 *
 * Originally from lib/pipeline/analysis/statisticalClaimQa.js — moved here
 * because it is a text-processing utility used by source-processing scripts,
 * not a slide or analysis concern.
 */

export const IMPLIED_QUANTITATIVE_PATTERNS = [
  /\bsurging?\b/gi,
  /\bspiki?(?:ng|es?)?\b/gi,
  /\brapidly (?:growing|increasing|expanding|accelerating)\b/gi,
  /\b(?:most|majority|many|significant|substantial|large)\s+(?:of|number|portion|share)\b/gi,
  /\b(?:widespread|ubiquitous|pervasive|dominant|leading)\b/gi,
  /\b(?:doubled|tripled|quadrupled)\b/gi,
  /\b(?:highest|lowest|most common|most frequent|fastest)\b/gi,
  /\b(?:increased?|decreased?|grown?)\s+significantly\b/gi,
];

const NEUTRAL_REPLACEMENTS = new Map([
  ["surge",       "increase"],
  ["surges",      "increases"],
  ["surging",     "increasing"],
  ["spiking",     "increasing"],
  ["spike",       "increase"],
  ["spikes",      "increases"],
  ["rapidly",     "notably"],
  ["widespread",  "observed across sources"],
  ["ubiquitous",  "frequently observed"],
  ["pervasive",   "observed across sources"],
  ["dominant",    "frequently seen"],
  ["leading",     "prominent"],
]);

function hasGroundingNumber(evidenceText) {
  return /\d+\s*(?:%|percent|x\b|times|fold|million|billion|thousand|incidents?|cases?|attacks?|campaigns?)/i.test(evidenceText || "");
}

/**
 * @param {string} text         - The claim or summary text to scrub
 * @param {string} evidenceText - Supporting evidence text (used for grounding check)
 * @returns {{ text: string, scrubbed: string[] }}
 */
export function scrubImpliedQuantitatives(text, evidenceText = "") {
  if (!text) return { text: text || "", scrubbed: [] };

  const grounded = hasGroundingNumber(evidenceText);
  if (grounded) return { text, scrubbed: [] };

  const scrubbed = [];
  let result = text;

  for (const pattern of IMPLIED_QUANTITATIVE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const lower = match.toLowerCase();
      const replacement = NEUTRAL_REPLACEMENTS.get(lower) || "observed";
      if (replacement !== lower) scrubbed.push(`"${match}" → "${replacement}"`);
      return replacement;
    });
  }

  return { text: result, scrubbed };
}
