/**
 * Truncate a string to at most `max` characters WITHOUT cutting a word in half.
 *
 * Trims back to the last word boundary at or before `max` and appends an
 * ellipsis. Avoids the "…langchain_core.pro" / "…minimal per" mid-word cuts that
 * a raw String.slice(0, max) produces. Returns the original string untouched when
 * it already fits.
 *
 * @param {string} str
 * @param {number} max   max characters of source text to keep (before the ellipsis)
 * @param {string} [ellipsis="…"]
 * @returns {string}
 */
export function truncateAtWord(str, max, ellipsis = "…") {
  const s = String(str ?? "").trim();
  if (s.length <= max) return s;

  const slice = s.slice(0, max);
  // Back up to the last whitespace so we never end mid-word.
  const lastSpace = slice.lastIndexOf(" ");
  let head = lastSpace > max * 0.5 ? slice.slice(0, lastSpace) : slice;
  // Drop trailing punctuation/partial-token chars so the ellipsis reads cleanly.
  head = head.replace(/[\s.,;:!?/\-_(]+$/, "");
  return head + ellipsis;
}
