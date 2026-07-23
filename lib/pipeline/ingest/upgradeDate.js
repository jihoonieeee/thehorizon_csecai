/**
 * upgradeDate.js — extract a publication date from full_text and upgrade
 * date_confidence to "exact" when the text contains an unambiguous date string.
 *
 * Runs deterministically — no LLM call. Called after web-fetch stores full_text
 * so sources that entered with date_confidence="estimated" or "low" can be
 * promoted without a re-fetch.
 *
 * Returns null when no improvement is possible (text absent, no date found,
 * or extracted date is too far from stored date to be trusted).
 *
 * @param {object} source  — DB row with at least { date_published, date_confidence, full_text }
 * @returns {{ date_published: string, date_confidence: "exact" } | null}
 */

const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Ordered from most specific to least, to prefer ISO formats over prose.
const DATE_PATTERNS = [
  // ISO: 2026-07-21
  { re: /\b(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/, toIso: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  // US numeric: 07/21/2026
  { re: /\b(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/(20\d\d)\b/, toIso: (m) => `${m[3]}-${m[1]}-${m[2]}` },
  // Published on: Jul 21, 2026  /  July 21, 2026  /  21 Jul 2026
  {
    re: /(?:published|posted|updated|date)[^\n]{0,20}?(?:on[:\s]+)?([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(20\d\d)/i,
    toIso: (m) => {
      const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (!mon) return null;
      return `${m[3]}-${mon}-${String(m[2]).padStart(2, "0")}`;
    },
  },
  {
    re: /(?:published|posted|updated|date)[^\n]{0,20}?(?:on[:\s]+)?(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(20\d\d)/i,
    toIso: (m) => {
      const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (!mon) return null;
      return `${m[3]}-${mon}-${String(m[1]).padStart(2, "0")}`;
    },
  },
  // Plain prose: Jul 21, 2026  /  July 21, 2026  (without published keyword)
  {
    re: /\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(20\d\d)\b/,
    toIso: (m) => {
      const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (!mon) return null;
      return `${m[3]}-${mon}-${String(m[2]).padStart(2, "0")}`;
    },
  },
];

/**
 * Tolerate a ±2-day difference between the stored date and the extracted date
 * before rejecting the match (accounts for timezone shifts and publish vs update dates).
 */
const MAX_DELTA_DAYS = 2;

function dayDiff(isoA, isoB) {
  return Math.abs((new Date(isoA) - new Date(isoB)) / 86_400_000);
}

export function upgradeDate(source) {
  // Only attempt when confidence is not already exact
  if (source.date_confidence === "exact") return null;

  const text = (source.full_text || "").slice(0, 5000); // header region is enough
  if (!text || text.length < 50) return null;

  for (const { re, toIso } of DATE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const extracted = toIso(m);
    if (!extracted) continue;

    // Validate the extracted date is plausible
    const d = new Date(extracted);
    if (isNaN(d.getTime())) continue;
    if (d.getFullYear() < 2020 || d.getFullYear() > new Date().getFullYear() + 1) continue;

    // If we have a stored date, only upgrade when they agree within tolerance
    if (source.date_published) {
      const stored = source.date_published.slice(0, 10);
      if (dayDiff(extracted, stored) > MAX_DELTA_DAYS) continue;
    }

    return {
      date_published:  extracted,
      date_confidence: "exact",
    };
  }

  return null;
}
