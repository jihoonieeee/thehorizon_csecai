const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function toSgtWallClockUtcDate(now = new Date()) {
  return new Date(now.getTime() + SGT_OFFSET_MS);
}

function sgtBoundaryToUtcIso(sgtDate) {
  return new Date(sgtDate.getTime() - SGT_OFFSET_MS).toISOString();
}

export function getSingaporeDailyWindow(now = new Date()) {
  const sgtNow = toSgtWallClockUtcDate(now);

  const y = sgtNow.getUTCFullYear();
  const m = sgtNow.getUTCMonth();
  const d = sgtNow.getUTCDate();

  let endSgtWallClock = new Date(Date.UTC(y, m, d, 6, 0, 0));

  if (sgtNow < endSgtWallClock) {
    endSgtWallClock = new Date(endSgtWallClock.getTime() - DAY_MS);
  }

  const startSgtWallClock = new Date(endSgtWallClock.getTime() - DAY_MS);

  return {
    timezone: "Asia/Singapore",
    start_sgt: startSgtWallClock.toISOString(),
    end_sgt: endSgtWallClock.toISOString(),
    start_utc: sgtBoundaryToUtcIso(startSgtWallClock),
    end_utc: sgtBoundaryToUtcIso(endSgtWallClock),
  };
}

export function getSingaporePeriodWindow(period = "daily", now = new Date()) {
  const daily = getSingaporeDailyWindow(now);
  const endSgt = new Date(daily.end_sgt);

  let days = 1;

  if (period === "weekly") days = 7;
  else if (period === "monthly") days = 30;
  else if (period === "quarterly") days = 90;

  const startSgt = new Date(endSgt.getTime() - days * DAY_MS);

  return {
    timezone: "Asia/Singapore",
    period,
    start_sgt: startSgt.toISOString(),
    end_sgt: endSgt.toISOString(),
    start_utc: sgtBoundaryToUtcIso(startSgt),
    end_utc: daily.end_utc,
  };
}

/**
 * ISO week string for a given date in SGT: "2026-W20"
 *
 * Uses the Thursday-anchor algorithm (ISO 8601): week 1 contains the year's
 * first Thursday. This avoids returning week 0 near Jan 1 boundaries.
 */
export function isoWeekKey(now = new Date()) {
  const sgt = new Date(now.getTime() + SGT_OFFSET_MS);
  // Shift to the Thursday of this ISO week to anchor the year correctly.
  const thu = new Date(sgt);
  thu.setUTCDate(sgt.getUTCDate() - ((sgt.getUTCDay() + 6) % 7) + 3);
  const year = thu.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((thu - jan4) / 604800000);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * Return the Mon 00:00 SGT → Sun 23:59:59 SGT window for a given ISO week.
 *
 * weekOffset = 0  → current (possibly in-progress) week: Mon 00:00 SGT → now
 * weekOffset = -1 → last completed week
 * weekOffset = -2 → two weeks ago, etc.
 *
 * Returns:
 *   { week_key, start_utc, end_utc, is_complete }
 *   is_complete = true when the full Sun 23:59 has passed in SGT
 */
export function getIsoWeekWindow(weekOffset = 0, now = new Date()) {
  const sgtNow = new Date(now.getTime() + SGT_OFFSET_MS);
  const dow = sgtNow.getUTCDay(); // 0=Sun 1=Mon … 6=Sat

  // Monday of the current SGT week
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const monSgt = new Date(sgtNow);
  monSgt.setUTCDate(sgtNow.getUTCDate() - daysFromMon + weekOffset * 7);
  monSgt.setUTCHours(0, 0, 0, 0);

  // Sunday 23:59:59.999 of the same week
  const sunSgt = new Date(monSgt);
  sunSgt.setUTCDate(monSgt.getUTCDate() + 6);
  sunSgt.setUTCHours(23, 59, 59, 999);

  // For the current (offset=0) week, cap the end at now if Sunday hasn't passed yet
  const isComplete = sunSgt < sgtNow;
  const endSgt = isComplete ? sunSgt : sgtNow;

  const start_utc = new Date(monSgt.getTime() - SGT_OFFSET_MS).toISOString();
  const end_utc   = new Date(endSgt.getTime() - SGT_OFFSET_MS).toISOString();

  const weekKey = isoWeekKey(new Date(monSgt.getTime() - SGT_OFFSET_MS));

  return {
    week_key:    weekKey,
    start_utc,
    end_utc,
    start_sgt:   monSgt.toISOString(),
    end_sgt:     endSgt.toISOString(),
    is_complete: isComplete,
  };
}

/**
 * A 12-month lookback window anchored to now (UTC).
 * Used by the horizon scan pipeline to fetch sources from the past year.
 */
export function get12MonthWindow(now = new Date()) {
  const start = new Date(now);
  start.setFullYear(start.getFullYear() - 1);
  return {
    timezone: "UTC",
    period: "12_months",
    start_utc: start.toISOString(),
    end_utc: now.toISOString(),
  };
}

/**
 * Calendar-month window in SGT.
 *
 * monthOffset = 0  → current month: 1st 00:00 SGT → now
 * monthOffset = -1 → previous month: 1st 00:00 SGT → last day 23:59:59.999 SGT
 *
 * Returns: { month_key, start_utc, end_utc, start_sgt, end_sgt, is_complete }
 */
export function getMonthWindow(monthOffset = 0, now = new Date()) {
  const sgtNow = new Date(now.getTime() + SGT_OFFSET_MS);
  const y = sgtNow.getUTCFullYear();
  const m = sgtNow.getUTCMonth(); // 0-indexed

  const targetMonth = m + monthOffset;
  const firstSgt = new Date(Date.UTC(y, targetMonth, 1, 0, 0, 0, 0));

  // Last instant of that month
  const lastSgt = new Date(Date.UTC(y, targetMonth + 1, 0, 23, 59, 59, 999));

  const isComplete = lastSgt < sgtNow;
  const endSgt = isComplete ? lastSgt : sgtNow;

  const month_key = `${firstSgt.getUTCFullYear()}-${String(firstSgt.getUTCMonth() + 1).padStart(2, "0")}`;

  return {
    month_key,
    start_utc: new Date(firstSgt.getTime() - SGT_OFFSET_MS).toISOString(),
    end_utc:   new Date(endSgt.getTime()  - SGT_OFFSET_MS).toISOString(),
    start_sgt: firstSgt.toISOString(),
    end_sgt:   endSgt.toISOString(),
    is_complete: isComplete,
  };
}

/**
 * Calendar-quarter window in SGT.
 *
 * quarterOffset = 0  → current quarter: 1st of quarter 00:00 SGT → now
 * quarterOffset = -1 → previous quarter: full quarter
 *
 * Q1: Jan–Mar  Q2: Apr–Jun  Q3: Jul–Sep  Q4: Oct–Dec
 *
 * Returns: { quarter_key, start_utc, end_utc, start_sgt, end_sgt, is_complete }
 */
export function getQuarterWindow(quarterOffset = 0, now = new Date()) {
  const sgtNow = new Date(now.getTime() + SGT_OFFSET_MS);
  const y = sgtNow.getUTCFullYear();
  const m = sgtNow.getUTCMonth(); // 0-indexed

  // 0-indexed quarter of the current month: 0/1/2/3
  const currentQ = Math.floor(m / 3);
  const targetQ  = currentQ + quarterOffset;

  // Normalise across year boundaries
  const totalMonths = y * 4 + targetQ;
  const targetYear  = Math.floor(totalMonths / 4);
  const targetQInYear = ((totalMonths % 4) + 4) % 4;

  const startMonth = targetQInYear * 3; // 0-indexed month of Q start
  const firstSgt   = new Date(Date.UTC(targetYear, startMonth, 1, 0, 0, 0, 0));
  const lastSgt    = new Date(Date.UTC(targetYear, startMonth + 3, 0, 23, 59, 59, 999));

  const isComplete = lastSgt < sgtNow;
  const endSgt = isComplete ? lastSgt : sgtNow;

  const quarter_key = `${targetYear}-Q${targetQInYear + 1}`;

  return {
    quarter_key,
    start_utc: new Date(firstSgt.getTime() - SGT_OFFSET_MS).toISOString(),
    end_utc:   new Date(endSgt.getTime()  - SGT_OFFSET_MS).toISOString(),
    start_sgt: firstSgt.toISOString(),
    end_sgt:   endSgt.toISOString(),
    is_complete: isComplete,
  };
}

/**
 * Calendar-half-year window in SGT.
 *
 * halfOffset = 0  → current half: 1st of half 00:00 SGT → now
 * halfOffset = -1 → previous half: full half
 *
 * H1: Jan–Jun  H2: Jul–Dec
 *
 * Returns: { half_key, start_utc, end_utc, start_sgt, end_sgt, is_complete }
 */
export function getHalfYearWindow(halfOffset = 0, now = new Date()) {
  const sgtNow = new Date(now.getTime() + SGT_OFFSET_MS);
  const y = sgtNow.getUTCFullYear();
  const m = sgtNow.getUTCMonth(); // 0-indexed

  // 0-indexed half of the current month: 0 (Jan–Jun) or 1 (Jul–Dec)
  const currentH = Math.floor(m / 6);
  const targetH  = currentH + halfOffset;

  // Normalise across year boundaries
  const totalHalves = y * 2 + targetH;
  const targetYear  = Math.floor(totalHalves / 2);
  const targetHInYear = ((totalHalves % 2) + 2) % 2;

  const startMonth = targetHInYear * 6; // 0-indexed month of half start (0 or 6)
  const firstSgt   = new Date(Date.UTC(targetYear, startMonth, 1, 0, 0, 0, 0));
  const lastSgt    = new Date(Date.UTC(targetYear, startMonth + 6, 0, 23, 59, 59, 999));

  const isComplete = lastSgt < sgtNow;
  const endSgt = isComplete ? lastSgt : sgtNow;

  const half_key = `${targetYear}-H${targetHInYear + 1}`;

  return {
    half_key,
    start_utc: new Date(firstSgt.getTime() - SGT_OFFSET_MS).toISOString(),
    end_utc:   new Date(endSgt.getTime()  - SGT_OFFSET_MS).toISOString(),
    start_sgt: firstSgt.toISOString(),
    end_sgt:   endSgt.toISOString(),
    is_complete: isComplete,
  };
}

/**
 * Calendar-year window in SGT.
 *
 * yearOffset = 0  → current year: 1 Jan 00:00 SGT → now
 * yearOffset = -1 → previous year: full calendar year (1 Jan → 31 Dec)
 *
 * Returns: { year_key, start_utc, end_utc, start_sgt, end_sgt, is_complete }
 */
export function getYearWindow(yearOffset = 0, now = new Date()) {
  const sgtNow = new Date(now.getTime() + SGT_OFFSET_MS);
  const targetYear = sgtNow.getUTCFullYear() + yearOffset;

  const firstSgt = new Date(Date.UTC(targetYear, 0, 1, 0, 0, 0, 0));
  const lastSgt  = new Date(Date.UTC(targetYear, 12, 0, 23, 59, 59, 999)); // 31 Dec

  const isComplete = lastSgt < sgtNow;
  const endSgt = isComplete ? lastSgt : sgtNow;

  return {
    year_key: `${targetYear}`,
    start_utc: new Date(firstSgt.getTime() - SGT_OFFSET_MS).toISOString(),
    end_utc:   new Date(endSgt.getTime()  - SGT_OFFSET_MS).toISOString(),
    start_sgt: firstSgt.toISOString(),
    end_sgt:   endSgt.toISOString(),
    is_complete: isComplete,
  };
}

/**
 * Unified "most recently completed period" window, shared by the dashboard API
 * and the insight generator so live stats and LLM bullets always describe the
 * same dates.
 *
 *   week      → last completed Mon→Mon week (e.g. on Mon 22 Jun → 15–22 Jun)
 *   month     → previous complete calendar month (e.g. in Jun → May)
 *   quarter   → previous complete calendar quarter (e.g. in Q2 → Q1, Jan–Mar)
 *   half_year → previous complete calendar half (e.g. in H2 → H1, Jan–Jun)
 *   year      → previous complete calendar year (e.g. in 2026 → 2025)
 *   annual    → fixed horizon: 2025-Q3 through 2026-Q2 (2025-07-01 → 2026-06-30)
 *             This is the primary backfill window and the intended full-year scan frame.
 *
 * date_from / date_to are SGT calendar dates (YYYY-MM-DD), matching how
 * sources.date_published is stored, and are inclusive on both ends for SQL
 * `.gte(date_from).lte(date_to)`.
 *
 * @returns {{ win, key, label, date_from, date_to, start_sgt, end_sgt }}
 */
export function getCompletedPeriodWindow(win = "quarter", now = new Date()) {
  const fmtDay   = (sgtDate) => sgtDate.toLocaleDateString("en-SG", { day: "numeric", month: "short", timeZone: "UTC" });
  const sgtDate  = (iso) => new Date(iso);            // start_sgt/end_sgt carry SGT wall-clock in their UTC fields
  const isoDate  = (iso) => iso.slice(0, 10);

  if (win === "week") {
    const w = getIsoWeekWindow(-1, now);
    const start = sgtDate(w.start_sgt);
    // Display the Mon→Sun span (end = start + 6d) so the label matches the actual
    // inclusive window (date_to = Sunday). Previously showed start + 7d (the next
    // Monday), which printed an 8-day-looking "6 Jul – 13 Jul" for a 6–12 window.
    const endSun = new Date(start.getTime() + 6 * DAY_MS);
    const year   = start.getUTCFullYear();
    return {
      win,
      key:       w.week_key,
      label:     `${fmtDay(start)} – ${fmtDay(endSun)} ${year}`,
      date_from: isoDate(w.start_sgt),
      date_to:   isoDate(w.end_sgt),     // Sun 23:59 SGT → last included calendar date
      start_sgt: w.start_sgt,
      end_sgt:   w.end_sgt,
    };
  }

  if (win === "month") {
    const m = getMonthWindow(-1, now);
    const start = sgtDate(m.start_sgt);
    return {
      win,
      key:       m.month_key,
      label:     start.toLocaleDateString("en-SG", { month: "long", year: "numeric", timeZone: "UTC" }),
      date_from: isoDate(m.start_sgt),
      date_to:   isoDate(m.end_sgt),
      start_sgt: m.start_sgt,
      end_sgt:   m.end_sgt,
    };
  }

  if (win === "half_year") {
    const h = getHalfYearWindow(-1, now);
    const start = sgtDate(h.start_sgt);
    const hNum  = Number(h.half_key.split("H")[1]);
    const months = { 1: "Jan – Jun", 2: "Jul – Dec" }[hNum] || "";
    return {
      win,
      key:       h.half_key,
      label:     `H${hNum} ${start.getUTCFullYear()} · ${months}`,
      date_from: isoDate(h.start_sgt),
      date_to:   isoDate(h.end_sgt),
      start_sgt: h.start_sgt,
      end_sgt:   h.end_sgt,
    };
  }

  if (win === "year") {
    // Previous complete calendar year (e.g. in 2026 → 1 Jan – 31 Dec 2025).
    // Distinct from "annual", which is a fixed backfill horizon.
    const yWin  = getYearWindow(-1, now);
    const start = sgtDate(yWin.start_sgt);
    return {
      win,
      key:       yWin.year_key,
      label:     `${start.getUTCFullYear()}`,
      date_from: isoDate(yWin.start_sgt),
      date_to:   isoDate(yWin.end_sgt),
      start_sgt: yWin.start_sgt,
      end_sgt:   yWin.end_sgt,
    };
  }

  if (win === "annual") {
    // Fixed horizon year: 2025-Q3 → 2026-Q2 (Jul 2025 – Jun 2026).
    // This is the intended full-year scan frame matching the backfill window.
    // The window is always this fixed range regardless of current date.
    return {
      win:       "annual",
      key:       "2025-Q3-2026-Q2",
      label:     "2025 Q3 – 2026 Q2 · Jul 2025 – Jun 2026",
      date_from: "2025-07-01",
      date_to:   "2026-06-30",
      start_sgt: "2025-07-01T00:00:00.000Z",
      end_sgt:   "2026-06-30T23:59:59.999Z",
    };
  }

  // quarter (default)
  const q = getQuarterWindow(-1, now);
  const start = sgtDate(q.start_sgt);
  const end   = sgtDate(q.end_sgt);
  const qNum  = Number(q.quarter_key.split("Q")[1]);
  const months = { 1: "Jan – Mar", 2: "Apr – Jun", 3: "Jul – Sep", 4: "Oct – Dec" }[qNum] || "";
  return {
    win:       "quarter",
    key:       q.quarter_key,
    label:     `Q${qNum} ${start.getUTCFullYear()} · ${months}`,
    date_from: isoDate(q.start_sgt),
    date_to:   isoDate(q.end_sgt),
    start_sgt: q.start_sgt,
    end_sgt:   q.end_sgt,
  };
}

/**
 * Compute the immutable period-label keys for a source's date_published.
 * These are stored on the source row at ingest and never change.
 *
 * @param {string|Date} datePublished
 * @returns {{ week: string, month: string, quarter: string } | null}
 *   Returns null if datePublished is missing or unparseable.
 */
export function periodKeysForDate(datePublished) {
  if (!datePublished) return null;
  const d = new Date(datePublished);
  if (isNaN(d.getTime())) return null;

  const sgt = new Date(d.getTime() + SGT_OFFSET_MS);
  const y = sgt.getUTCFullYear();
  const m = sgt.getUTCMonth(); // 0-indexed

  const week    = isoWeekKey(d);
  const month   = `${y}-${String(m + 1).padStart(2, "0")}`;
  const quarter = `${y}-Q${Math.floor(m / 3) + 1}`;

  return { week, month, quarter };
}

export function isWithinWindow(datePublished, window) {
  if (!datePublished) return false;

  const date = new Date(datePublished).getTime();
  const start = new Date(window.start_utc).getTime();
  const end = new Date(window.end_utc).getTime();

  if (Number.isNaN(date)) return false;

  return date >= start && date < end;
}
