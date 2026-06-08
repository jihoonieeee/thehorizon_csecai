import {
  getIsoWeekWindow,
  getMonthWindow,
  getQuarterWindow,
  periodKeysForDate,
  isWithinWindow,
} from "../../time/reportingWindow.js";

const HORIZON_SCAN_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

function isWithinDays(datePublished, days) {
  if (!datePublished) return false;
  const pub = new Date(datePublished).getTime();
  if (isNaN(pub)) return false;
  return Date.now() - pub < days * DAY_MS;
}

/**
 * Compute eligibility flags and period-label keys for a source.
 *
 * Eligibility flags are calendar-anchored (not rolling days):
 *   - weekly:    Monday 00:00 SGT of the current week → now
 *   - monthly:   1st of the current month 00:00 SGT → now
 *   - quarterly: 1st of the current quarter 00:00 SGT → now
 *
 * Period keys are immutable labels derived from date_published and stored on
 * the source row so any past period is queryable without re-running flags:
 *   - report_period_week:    "2026-W23"
 *   - report_period_month:   "2026-05"
 *   - report_period_quarter: "2026-Q2"
 */
export function computeEligibilityFlags(source, _window = null) {
  const dateConf = source.date_confidence ||
    source.collection_metadata?.date_confidence ||
    "exact";

  const datePub    = source.date_published;
  const trust      = source.trust_tier;
  const sourceType = source.source_type;

  const hasDate    = Boolean(datePub);
  const hasGoodDate = hasDate && dateConf !== "none";

  // ── Calendar-anchored eligibility flags ────────────────────────────────────
  let eligible_for_weekly_report    = false;
  let eligible_for_monthly_report   = false;
  let eligible_for_quarterly_report = false;

  if (hasGoodDate) {
    const weekWin    = getIsoWeekWindow(0);
    const monthWin   = getMonthWindow(0);
    const quarterWin = getQuarterWindow(0);

    eligible_for_weekly_report    = isWithinWindow(datePub, weekWin);
    eligible_for_monthly_report   = isWithinWindow(datePub, monthWin);
    eligible_for_quarterly_report = isWithinWindow(datePub, quarterWin);
  }

  // ── Horizon scan: rolling 12 months ────────────────────────────────────────
  const eligible_for_horizon_scan = hasGoodDate && isWithinDays(datePub, HORIZON_SCAN_DAYS);

  // ── Unconditional ──────────────────────────────────────────────────────────
  const eligible_for_archive           = true;
  const eligible_for_trend_analysis    = (source.full_text?.length || 0) > 200;
  const eligible_for_reference_context = ["curated", "primary", "high"].includes(trust);

  // ── Review flag ────────────────────────────────────────────────────────────
  const needs_review = (
    dateConf === "none" ||
    dateConf === "low"  ||
    sourceType === "unknown" ||
    !source.publisher ||
    !datePub
  );

  // ── Immutable period keys (from date_published, stored for trend queries) ──
  const periodKeys = periodKeysForDate(datePub);

  return {
    eligible_for_weekly_report,
    eligible_for_monthly_report,
    eligible_for_quarterly_report,
    eligible_for_horizon_scan,
    eligible_for_archive,
    eligible_for_trend_analysis,
    eligible_for_reference_context,
    needs_review,
    report_period_week:    periodKeys?.week    ?? null,
    report_period_month:   periodKeys?.month   ?? null,
    report_period_quarter: periodKeys?.quarter ?? null,
  };
}
