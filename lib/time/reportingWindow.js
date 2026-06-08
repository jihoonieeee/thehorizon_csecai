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
