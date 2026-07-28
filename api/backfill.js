import { collectRawSources } from "../lib/pipeline/ingest/collectRawSources.js";
import { saveSnapshotToDatabase } from "../lib/storage/snapshotDatabase.js";

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (!secret) return false;
  return auth === `Bearer ${secret}`;
}

function makeDayWindow(dateString) {
  // Build a UTC window that spans the calendar day in SGT (UTC+8)
  // Start: dateString 00:00 SGT = dateString-1 16:00 UTC
  // End:   dateString 24:00 SGT = dateString   16:00 UTC
  const endSgt = new Date(`${dateString}T00:00:00+08:00`);
  endSgt.setDate(endSgt.getDate() + 1); // next day 00:00 SGT
  const startSgt = new Date(`${dateString}T00:00:00+08:00`);

  return {
    timezone: "Asia/Singapore",
    start_sgt: startSgt.toISOString(),
    end_sgt: endSgt.toISOString(),
    start_utc: new Date(startSgt.getTime() - 8 * 60 * 60 * 1000).toISOString(),
    end_utc: new Date(endSgt.getTime() - 8 * 60 * 60 * 1000).toISOString(),
  };
}

function dateRange(startStr, endStr, maxDays = 14) {
  const dates = [];
  const current = new Date(startStr);
  const final = new Date(endStr);
  while (current <= final && dates.length < maxDays) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export default async function handler(req, res) {
  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const today = new Date().toISOString().slice(0, 10);
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const start = req.query.start || twoWeeksAgo;
    const end = req.query.end || today;
    const maxDays = Math.min(Number(req.query.maxDays || 14), 30);

    // includeFeeds=true by default so RSS feeds are included for recent windows.
    // Set ?includeFeeds=false to run only API connectors (NVD, arXiv, AIID).
    const includeFeeds = req.query.includeFeeds !== "false";

    const dates = dateRange(start, end, maxDays);
    const results = [];
    let totalSources = 0;

    for (const date of dates) {
      const window = makeDayWindow(date);

      const result = await collectRawSources(window, { includeFeeds });

      const snapshot = {
        generated_at: new Date().toISOString(),
        period: "daily",
        stage: "backfill_by_date_published",
        reporting_window: result.reporting_window,
        count: result.sources.length,
        removed_by_publish_date_count: result.removed_by_publish_date_count,
        rejected_count: result.rejected_count,
        discarded_count: result.discarded_count,
        pipeline_counts: result.pipeline_counts,
        sources: result.sources,
        archive: result.archive,
        connector_results: result.connector_results,
      };

      const stored = await saveSnapshotToDatabase(snapshot);
      totalSources += snapshot.count;

      results.push({
        date,
        count: snapshot.count,
        pipeline_counts: snapshot.pipeline_counts,
        stored,
      });
    }

    const lastDate = dates[dates.length - 1];
    const nextStart = lastDate
      ? new Date(new Date(lastDate).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      : null;

    return res.status(200).json({
      message: "Backfill complete",
      start,
      end,
      include_feeds: includeFeeds,
      processed_days: dates.length,
      total_sources_ingested: totalSources,
      results,
      next_start: nextStart,
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message,
      stack: error.stack,
    });
  }
}
