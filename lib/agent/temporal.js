/**
 * temporal.js — deterministic temporal-intent parser for the chatbot.
 *
 * Extracted from api/agent.js so both the Haiku query planner (as a fallback /
 * cross-check) and the request handler share one implementation.
 *
 * parseTemporalIntent(query) → { date_from, date_to, scope_label, all_time }
 *   date_from / date_to are YYYY-MM-DD strings or null.
 *   date_to=null   → "up to today".
 *   all_time=true  → no date restriction at all.
 */

export function parseTemporalIntent(query) {
  const q = (query || "").toLowerCase();
  const now = new Date();

  const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const MONTHS_SHORT = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

  function lastDayOfMonth(year, monthIdx) {
    return new Date(year, monthIdx + 1, 0).getDate();
  }

  // Explicit "all time" / "entire corpus" / "ever"
  if (/\ball[- ]time\b|\bentire (?:database|corpus|history)\b|\bever\b|\bsince (?:the )?beginning\b|\ball (?:available |)(?:data|sources|records)\b|\bhistorical(?:ly)?\b/.test(q)) {
    return { date_from: null, date_to: null, scope_label: "all available data", all_time: true };
  }

  // "past N days/weeks/months/years" or "last N …"
  const rel = q.match(/\b(?:past|last)\s+(\d+)\s+(day|week|month|year)s?\b/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2];
    const ms = unit === "day"   ? 86400000 * n
              : unit === "week"  ? 86400000 * 7 * n
              : unit === "month" ? 86400000 * 30 * n
              : 86400000 * 365 * n;
    const d = new Date(Date.now() - ms).toISOString().slice(0, 10);
    return { date_from: d, date_to: null, scope_label: `last ${n} ${unit}${n !== 1 ? "s" : ""}`, all_time: false };
  }

  // "in the past/last N …" (variant)
  const inPast = q.match(/\bin (?:the )?(?:past|last)\s+(\d+)\s+(day|week|month|year)s?\b/);
  if (inPast) {
    const n = parseInt(inPast[1], 10);
    const unit = inPast[2];
    const ms = unit === "day"   ? 86400000 * n
              : unit === "week"  ? 86400000 * 7 * n
              : unit === "month" ? 86400000 * 30 * n
              : 86400000 * 365 * n;
    const d = new Date(Date.now() - ms).toISOString().slice(0, 10);
    return { date_from: d, date_to: null, scope_label: `last ${n} ${unit}${n !== 1 ? "s" : ""}`, all_time: false };
  }

  // "this week"
  if (/\bthis week\b/.test(q)) {
    const d = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    return { date_from: d, date_to: null, scope_label: "this week", all_time: false };
  }

  // "this month"
  if (/\bthis month\b/.test(q)) {
    const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    return { date_from: from, date_to: null, scope_label: "this month", all_time: false };
  }

  // Specific month (with optional year): "in May", "for May", "May 2026", "of May", "month of May"
  // "in May 2026", "during May", "from May 2026"
  const MONTH_PAT = `(${MONTHS.join("|")}|${MONTHS_SHORT.join("|")})`;
  const specificMonth = q.match(
    new RegExp(`\\b(?:in|for|of|during|from|month of|throughout)?\\s*${MONTH_PAT}(?:\\s+(\\d{4}))?\\b`)
  );
  if (specificMonth) {
    const rawMonth = specificMonth[1];
    const monthIdx = MONTHS.includes(rawMonth) ? MONTHS.indexOf(rawMonth) : MONTHS_SHORT.indexOf(rawMonth);
    if (monthIdx !== -1) {
      // Infer year: if the month is in the future this year, assume last year
      let year = specificMonth[2] ? parseInt(specificMonth[2], 10) : now.getFullYear();
      if (!specificMonth[2] && monthIdx > now.getMonth()) year--;
      const mm = String(monthIdx + 1).padStart(2, "0");
      const lastDay = lastDayOfMonth(year, monthIdx);
      const from = `${year}-${mm}-01`;
      const to   = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;
      const label = `${rawMonth.charAt(0).toUpperCase() + rawMonth.slice(1)} ${year}`;
      // Only treat as a closed month window if user isn't asking "since Month"
      // (handled below) — check the word before the month name
      const isSince = /\bsince\b/.test(q.slice(0, q.indexOf(rawMonth)));
      if (!isSince) {
        return { date_from: from, date_to: to, scope_label: label, all_time: false };
      }
    }
  }

  // "since Month [Year]"
  const sinceMonth = q.match(
    new RegExp(`\\bsince\\s+${MONTH_PAT}(?:\\s+(\\d{4}))?\\b`)
  );
  if (sinceMonth) {
    const rawMonth = sinceMonth[1];
    const monthIdx = MONTHS.includes(rawMonth) ? MONTHS.indexOf(rawMonth) : MONTHS_SHORT.indexOf(rawMonth);
    if (monthIdx !== -1) {
      const year = sinceMonth[2] ? parseInt(sinceMonth[2], 10) : now.getFullYear();
      const mm = String(monthIdx + 1).padStart(2, "0");
      return { date_from: `${year}-${mm}-01`, date_to: null, scope_label: `since ${rawMonth} ${year}`, all_time: false };
    }
  }

  // Default: last 90 days
  const d90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  return { date_from: d90, date_to: null, scope_label: "last 90 days (default)", all_time: false };
}
