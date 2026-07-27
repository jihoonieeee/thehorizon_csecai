#!/usr/bin/env node
/**
 * dueReportWindows.js — which slide-deck windows are due to generate today.
 *
 * Slide decks cover fixed, previous-complete calendar periods. Quarterly (~90d)
 * and yearly (365d) crons would exceed GitHub's 60-day inactivity auto-disable,
 * so instead the workflow fires a single MONTHLY cron and asks this script which
 * windows are actually due — keeping the trigger frequent enough to stay active
 * while only doing real work at the start of the correct period.
 *
 * Anchored to SGT (UTC+8), matching getCompletedPeriodWindow. Intended to run on
 * the 1st of each month; the rules key off the SGT month:
 *
 *   month   → every month           (previous complete calendar month)
 *   quarter → Jan / Apr / Jul / Oct (previous complete calendar quarter)
 *   year    → Jan only              (previous complete calendar year)
 *
 * Output: a space-separated list on stdout, e.g. "month", "month quarter",
 * "month quarter year" — ready for a `for w in $(...)` loop in the workflow.
 *
 * Usage:
 *   node scripts/dueReportWindows.js            # uses now
 *   node scripts/dueReportWindows.js 2026-01-01 # override date (testing)
 */

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

const arg = process.argv[2];
const now = arg ? new Date(`${arg}T12:00:00Z`) : new Date();
const sgt = new Date(now.getTime() + SGT_OFFSET_MS);
const month = sgt.getUTCMonth(); // 0-indexed

const windows = ["month"];
if (month % 3 === 0) windows.push("quarter"); // Jan(0) Apr(3) Jul(6) Oct(9)
if (month === 0)     windows.push("year");    // Jan

process.stdout.write(windows.join(" ") + "\n");
