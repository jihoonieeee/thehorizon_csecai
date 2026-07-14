/**
 * temporal.js — temporal intent normalization for the chatbot.
 *
 * Architecture
 * ─────────────
 * 1. PRIMARY: Haiku (in queryPlanner.js) returns a structured `temporal` object.
 *    normalizeTemporalOutput() validates it and produces the final retrieval
 *    parameters. Validation rules are guardrails applied AFTER the model — they
 *    fix contradictions, impossible date ranges, and missing required dates; they
 *    are not the primary parser.
 *
 * 2. FALLBACK: when the Haiku call fails entirely, or when model output fails
 *    validation, temporalFallback() handles common patterns deterministically.
 *    It is comprehensive but is the recovery path, not the first-choice path.
 *
 * Exported surface
 * ────────────────
 * TEMPORAL_INTENTS           — allowed intent strings
 * normalizeTemporalOutput()  — validate + convert Haiku output → TemporalPlan
 * temporalFallback()         — deterministic recovery covering common patterns
 *
 * TemporalPlan shape (produced by both paths):
 * {
 *   date_from:             "YYYY-MM-DD" | null,
 *   date_to:               "YYYY-MM-DD" | null,
 *   scope_label:           string,
 *   all_time:              boolean,
 *   temporal_intent:       TEMPORAL_INTENTS member,
 *   requires_fresh_sources: boolean,  // true when recency matters
 *   forecast_horizon:      string | null,  // e.g. "18 months"
 * }
 */

export const TEMPORAL_INTENTS = [
  "none",            // no time reference: "how does prompt injection work?"
  "historical",      // past period with defined bounds: "over the past 18 months", "Q3 2025"
  "current",         // YTD / present-state: "in 2026 so far", "current AI threat landscape"
  "recent",          // recent past without hard bounds: "lately", "emerging now", "latest incidents"
  "bounded_period",  // explicit closed window: "between Q3 2025 and today", "June 2026"
  "forward_looking", // future orientation: "next 18 months", "what should CISOs prepare for next"
];

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
function isoOk(s) { return typeof s === "string" && ISO_RE.test(s); }

function offsetDays(todayStr, days) {
  const d = todayStr ? new Date(todayStr + "T12:00:00Z") : new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Month name tables, shared by the explicit-period resolver and the fallback.
const ML = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const MS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const MP = `(${ML.join("|")}|${MS.join("|")})`;
const monthIndex = (raw) => (ML.includes(raw) ? ML.indexOf(raw) : MS.indexOf(raw));

// Build a closed bounded_period plan for calendar month `mi` (0-11) of `yr`.
function monthPlan(mi, yr, todayStr) {
  const mm      = String(mi + 1).padStart(2, "0");
  const lastDay = new Date(Date.UTC(yr, mi + 1, 0)).getUTCDate();
  const now     = new Date((todayStr || new Date().toISOString().slice(0, 10)) + "T12:00:00Z");
  const isCurrentMonth = yr === now.getUTCFullYear() && mi === now.getUTCMonth();
  return {
    date_from: `${yr}-${mm}-01`,
    date_to:   `${yr}-${mm}-${String(lastDay).padStart(2, "0")}`,
    scope_label: `${ML[mi][0].toUpperCase()}${ML[mi].slice(1)} ${yr}`,
    all_time: false,
    temporal_intent: "bounded_period",
    requires_fresh_sources: isCurrentMonth,   // current month → recency still matters
    forecast_horizon: null,
  };
}

/**
 * Resolve an UNAMBIGUOUS absolute calendar period named in the query
 * ("July 2026", "month of June", "in July", "Q3 2025") to a TemporalPlan, or
 * null when the query names no such period. This is authoritative: an explicit
 * month/quarter must never be at the mercy of the probabilistic planner, which
 * was occasionally resolving "month of July" to the previous month.
 *
 * Deliberately conservative to avoid false positives:
 *   - a month name only counts when it carries a year, "month of X", or a
 *     temporal preposition (in/during/for/throughout/of) before it;
 *   - bare "may" is ignored unless it has a year or "month of" — it is far more
 *     often the modal verb than the month.
 *
 * @param {string} query
 * @param {string} today — "YYYY-MM-DD"
 * @returns {TemporalPlan|null}
 */
export function resolveExplicitAbsolutePeriod(query, today) {
  const q = (query || "").toLowerCase();
  const todayStr = today || new Date().toISOString().slice(0, 10);
  const now = new Date(todayStr + "T12:00:00Z");

  // Quarter: "q3 2025"
  const qtr = q.match(/\bq([1-4])\s+(\d{4})\b/);
  if (qtr) {
    const qi = parseInt(qtr[1], 10) - 1, yr = qtr[2];
    const sm = [1, 4, 7, 10][qi], em = [3, 6, 9, 12][qi], ed = [31, 30, 30, 31][qi];
    return {
      date_from: `${yr}-${String(sm).padStart(2, "0")}-01`,
      date_to:   `${yr}-${String(em).padStart(2, "0")}-${String(ed).padStart(2, "0")}`,
      scope_label: `Q${qtr[1]} ${yr}`, all_time: false,
      temporal_intent: "bounded_period", requires_fresh_sources: false, forecast_horizon: null,
    };
  }

  // Month with an explicit year — unambiguous even for "may 2026".
  const withYear = q.match(new RegExp(`\\b${MP}\\s+(\\d{4})\\b`));
  if (withYear) {
    const mi = monthIndex(withYear[1]);
    if (mi !== -1) return monthPlan(mi, parseInt(withYear[2], 10), todayStr);
  }

  // "month of June" — explicit calendar-month phrasing, any month.
  const monthOf = q.match(new RegExp(`\\bmonth of\\s+${MP}\\b`));
  if (monthOf) {
    const mi = monthIndex(monthOf[1]);
    if (mi !== -1) return monthPlan(mi, defaultYearFor(mi, now), todayStr);
  }

  // Preposition + month name (in/during/for/throughout/of), excluding bare "may"
  // (modal-verb trap) unless it was already caught above with a year.
  const prep = q.match(new RegExp(`\\b(?:in|during|for|throughout|of)\\s+${MP}\\b`));
  if (prep && prep[1] !== "may") {
    const mi = monthIndex(prep[1]);
    if (mi !== -1) return monthPlan(mi, defaultYearFor(mi, now), todayStr);
  }

  return null;
}

// A bare month with no year means the most recent occurrence: this year if the
// month has already started, otherwise last year.
function defaultYearFor(mi, now) {
  const y = now.getUTCFullYear();
  return mi > now.getUTCMonth() ? y - 1 : y;
}

// ── Guardrail validation + normalization ──────────────────────────────────────

/**
 * Validate the structured temporal object Haiku returns and produce a
 * TemporalPlan. Calls temporalFallback(query, today) on any validation failure
 * so the caller always gets a usable plan regardless of model quality.
 *
 * @param {object}  raw   — `temporal` key from Haiku's JSON output
 * @param {string}  today — "YYYY-MM-DD"; inject explicitly for testability
 * @param {string}  [query] — raw user query; used by the fallback path only
 * @returns {TemporalPlan}
 */
export function normalizeTemporalOutput(raw, today, query) {
  // Authoritative override: if the query names an explicit calendar period
  // ("July 2026", "month of June", "Q3 2025"), trust the deterministic parse
  // over the model — this is what "date parsing is still off" was about.
  const explicit = resolveExplicitAbsolutePeriod(query, today);
  if (explicit) return explicit;

  if (!raw || typeof raw !== "object") return temporalFallback(query, today);

  const intent = TEMPORAL_INTENTS.includes(raw.temporal_intent) ? raw.temporal_intent : null;
  if (!intent) return temporalFallback(query, today);

  const start = isoOk(raw.start_date) ? raw.start_date : null;
  const end   = isoOk(raw.end_date)   ? raw.end_date   : null;

  // Guardrail: impossible date range
  if (start && end && start > end) return temporalFallback(query, today);
  // Guardrail: start date in the future (model hallucinated a future start)
  if (start && today && start > today) return temporalFallback(query, today);

  const requires_fresh_sources =
    raw.requires_fresh_sources === true ||
    intent === "current" ||
    intent === "recent";

  const forecast_horizon =
    typeof raw.forecast_horizon === "string" && raw.forecast_horizon.trim()
      ? raw.forecast_horizon.trim()
      : null;

  const label =
    typeof raw.reasoning_summary === "string" && raw.reasoning_summary.trim()
      ? raw.reasoning_summary.trim()
      : null;

  switch (intent) {
    case "none":
      return {
        date_from: null, date_to: null,
        scope_label: "all available data", all_time: true,
        temporal_intent: "none", requires_fresh_sources: false, forecast_horizon: null,
      };

    case "forward_looking": {
      // Use recent corpus (default last 6 months) as context for forward-looking synthesis.
      // `start` may be set by Haiku if the user said "from now"; otherwise default.
      const from = start || offsetDays(today, -180);
      return {
        date_from: from, date_to: null,
        scope_label: label || (forecast_horizon ? `forward outlook: ${forecast_horizon}` : "forward-looking"),
        all_time: false,
        temporal_intent: "forward_looking", requires_fresh_sources: true, forecast_horizon,
      };
    }

    case "current":
    case "recent":
      // Require start_date for current/recent — the model must resolve relative
      // phrases to a date. If missing, the fallback handles it.
      if (!start) return temporalFallback(query, today);
      return {
        date_from: start, date_to: end || null,
        scope_label: label || (intent === "current" ? "current / year-to-date" : "recent"),
        all_time: false,
        temporal_intent: intent, requires_fresh_sources, forecast_horizon,
      };

    case "historical":
    case "bounded_period":
      if (!start) return temporalFallback(query, today);
      return {
        date_from: start, date_to: end || null,
        scope_label: label || (end ? `${start} to ${end}` : `since ${start}`),
        all_time: false,
        temporal_intent: intent, requires_fresh_sources, forecast_horizon,
      };

    default:
      return temporalFallback(query, today);
  }
}

// ── Deterministic fallback ────────────────────────────────────────────────────

/**
 * Deterministic fallback covering common temporal patterns.
 * Called when: (a) Haiku fails entirely, or (b) model output fails validation.
 * Not intended to cover every possible phrasing — Haiku handles the rest.
 *
 * @param {string} [query]
 * @param {string} [today] — "YYYY-MM-DD"
 * @returns {TemporalPlan}
 */
export function temporalFallback(query, today) {
  const q    = (query || "").toLowerCase();
  const todayStr = today || new Date().toISOString().slice(0, 10);
  const now  = new Date(todayStr + "T12:00:00Z");

  // ── Forward-looking signals ────────────────────────────────────────────────
  if (/\bnext\s+\d+\s+(?:month|year|week)s?\b|\bprepare for\b|\bupcoming\b|\boutlook\b|\bhorizon\b|\bgoing forward\b/.test(q)) {
    const hm = q.match(/next\s+(\d+\s+(?:month|year)s?)/);
    return {
      date_from: offsetDays(todayStr, -180), date_to: null,
      scope_label: "forward-looking (recent context)", all_time: false,
      temporal_intent: "forward_looking", requires_fresh_sources: true,
      forecast_horizon: hm ? hm[1] : null,
    };
  }

  // ── All-time ───────────────────────────────────────────────────────────────
  if (/\ball[- ]time\b|\bentire (?:database|corpus|history)\b|\bever\b|\bsince (?:the )?beginning\b|\ball (?:available |)(?:data|sources|records)\b/.test(q)) {
    return { date_from: null, date_to: null, scope_label: "all available data", all_time: true,
             temporal_intent: "none", requires_fresh_sources: false, forecast_horizon: null };
  }

  // ── "past / last N units" ──────────────────────────────────────────────────
  const rel = q.match(/\b(?:past|last)\s+(\d+)\s+(day|week|month|year)s?\b/) ||
              q.match(/\bin (?:the )?(?:past|last)\s+(\d+)\s+(day|week|month|year)s?\b/);
  if (rel) {
    const n = parseInt(rel[1], 10), unit = rel[2];
    const ms = unit === "day" ? 86400000*n : unit === "week" ? 86400000*7*n
             : unit === "month" ? 86400000*30*n : 86400000*365*n;
    const from = new Date(now.getTime() - ms).toISOString().slice(0, 10);
    const intent = (unit === "year" || (unit === "month" && n > 6)) ? "historical" : "recent";
    return { date_from: from, date_to: null,
             scope_label: `last ${n} ${unit}${n !== 1 ? "s" : ""}`, all_time: false,
             temporal_intent: intent, requires_fresh_sources: intent === "recent", forecast_horizon: null };
  }

  // ── "between Q3 2025 and today/now" — check before bare quarter pattern ───
  const betweenQ = q.match(/\bbetween\s+q([1-4])\s+(\d{4})\s+and\s+(?:today|now)\b/);
  if (betweenQ) {
    const qi = parseInt(betweenQ[1], 10) - 1;
    const yr = betweenQ[2];
    const sm = [1, 4, 7, 10][qi];
    const from = `${yr}-${String(sm).padStart(2,"0")}-01`;
    return { date_from: from, date_to: null, scope_label: `Q${betweenQ[1]} ${yr} to today`, all_time: false,
             temporal_intent: "bounded_period", requires_fresh_sources: false, forecast_horizon: null };
  }

  // ── Quarter reference: "Q3 2025", "q4 2024" ───────────────────────────────
  const qtr = q.match(/\bq([1-4])\s+(\d{4})\b/);
  if (qtr) {
    const qi  = parseInt(qtr[1], 10) - 1;
    const yr  = qtr[2];
    const sm  = [1, 4, 7, 10][qi];
    const em  = [3, 6, 9, 12][qi];
    const ed  = [31, 30, 30, 31][qi];
    const from = `${yr}-${String(sm).padStart(2,"0")}-01`;
    const to   = `${yr}-${String(em).padStart(2,"0")}-${String(ed).padStart(2,"0")}`;
    return { date_from: from, date_to: to, scope_label: `Q${qtr[1]} ${yr}`, all_time: false,
             temporal_intent: "bounded_period", requires_fresh_sources: false, forecast_horizon: null };
  }

  // ── "this week / month / year" and "year-to-date / YTD" ──────────────────
  if (/\bthis week\b/.test(q)) {
    return { date_from: offsetDays(todayStr, -7), date_to: null,
             scope_label: "this week", all_time: false,
             temporal_intent: "current", requires_fresh_sources: true, forecast_horizon: null };
  }
  if (/\bthis month\b/.test(q)) {
    const from = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}-01`;
    return { date_from: from, date_to: null, scope_label: "this month", all_time: false,
             temporal_intent: "current", requires_fresh_sources: true, forecast_horizon: null };
  }
  if (/\bthis year\b|\bso far this year\b|\byear[- ]to[- ]date\b|\bYTD\b/i.test(q)) {
    return { date_from: `${now.getUTCFullYear()}-01-01`, date_to: null,
             scope_label: `${now.getUTCFullYear()} year-to-date`, all_time: false,
             temporal_intent: "current", requires_fresh_sources: true, forecast_horizon: null };
  }

  // ── "in 2026", "2026 so far", "during 2026", "throughout 2026" ───────────
  const yearRef = q.match(/\b(?:in|during|throughout)\s+(\d{4})\b|\b(\d{4})\s+so\s+far\b/);
  if (yearRef) {
    const y = yearRef[1] || yearRef[2];
    const isCurrent = y === String(now.getUTCFullYear());
    return {
      date_from: `${y}-01-01`,
      date_to: isCurrent ? null : `${y}-12-31`,
      scope_label: isCurrent ? `${y} year-to-date` : y,
      all_time: false,
      temporal_intent: isCurrent ? "current" : "historical",
      requires_fresh_sources: isCurrent,
      forecast_horizon: null,
    };
  }

  // ── Specific month (with optional year) — ML/MS/MP are module-scope ───────
  const sinceM = q.match(new RegExp(`\\bsince\\s+${MP}(?:\\s+(\\d{4}))?\\b`));
  if (sinceM) {
    const rawM = sinceM[1];
    const mi   = ML.includes(rawM) ? ML.indexOf(rawM) : MS.indexOf(rawM);
    if (mi !== -1) {
      const yr   = sinceM[2] ? parseInt(sinceM[2], 10) : now.getUTCFullYear();
      const from = `${yr}-${String(mi+1).padStart(2,"0")}-01`;
      return { date_from: from, date_to: null, scope_label: `since ${rawM} ${yr}`, all_time: false,
               temporal_intent: "historical", requires_fresh_sources: false, forecast_horizon: null };
    }
  }

  const specM = q.match(new RegExp(`\\b(?:in|for|of|during|from|month of|throughout)?\\s*${MP}(?:\\s+(\\d{4}))?\\b`));
  if (specM) {
    const rawM = specM[1];
    const mi   = ML.includes(rawM) ? ML.indexOf(rawM) : MS.indexOf(rawM);
    if (mi !== -1) {
      let yr = specM[2] ? parseInt(specM[2], 10) : now.getUTCFullYear();
      if (!specM[2] && mi > now.getUTCMonth()) yr--;
      const mm      = String(mi+1).padStart(2,"0");
      const lastDay = new Date(Date.UTC(yr, mi+1, 0)).getUTCDate();
      const isSince = /\bsince\b/.test(q.slice(0, q.indexOf(rawM)));
      return {
        date_from: `${yr}-${mm}-01`,
        date_to: isSince ? null : `${yr}-${mm}-${String(lastDay).padStart(2,"0")}`,
        scope_label: isSince ? `since ${rawM} ${yr}` : `${rawM} ${yr}`,
        all_time: false,
        temporal_intent: isSince ? "historical" : "bounded_period",
        requires_fresh_sources: false,
        forecast_horizon: null,
      };
    }
  }

  // ── Recency signals without explicit date ─────────────────────────────────
  if (/\bemerging\b|\blatest\b|\bcurrent\b|\bnow\b|\brecently\b|\blately\b/.test(q)) {
    return { date_from: offsetDays(todayStr, -90), date_to: null,
             scope_label: "recent (last 90 days)", all_time: false,
             temporal_intent: "recent", requires_fresh_sources: true, forecast_horizon: null };
  }

  // ── Default: last 90 days ─────────────────────────────────────────────────
  return {
    date_from: offsetDays(todayStr, -90), date_to: null,
    scope_label: "last 90 days (default)", all_time: false,
    temporal_intent: "recent", requires_fresh_sources: false, forecast_horizon: null,
  };
}
