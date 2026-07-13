import { collectRawSources }      from "../lib/pipeline/ingest/collectRawSources.js";
import { saveSnapshotToDatabase } from "../lib/storage/snapshotDatabase.js";
import {
  startIngestionRun,
  finishIngestionRun,
  failIngestionRun,
  findRecentSuccessfulRun,
} from "../lib/storage/ingestionRunStore.js";
import { flushPipelineCostToDB } from "../lib/llm/usagePersistence.js";

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization;

  if (!secret) return true;

  return auth === `Bearer ${secret}` || req.headers["x-vercel-cron"] === "1";
}

export default async function handler(req, res) {
  let runId = null;

  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ?days=N runs a wider ingestion window. Defaults to 30 (monthly lookback)
    // so each run recovers sources missed when connectors were temporarily broken.
    // Deduplication by URL hash prevents re-ingesting already-stored items.
    const days = Math.min(Number(req.query.days || 30), 30);
    const period = days <= 1 ? "daily" : days <= 7 ? "weekly" : "monthly";

    // Build an explicit N-day window anchored to end-of-today UTC.
    const customWindow = (() => {
      const now = new Date();
      const end = new Date(now);
      end.setUTCHours(23, 59, 59, 999);
      const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
      return {
        timezone: "Asia/Singapore",
        start_utc: start.toISOString(),
        end_utc: end.toISOString(),
        start_sgt: new Date(start.getTime() + 8 * 60 * 60 * 1000).toISOString(),
        end_sgt: new Date(end.getTime() + 8 * 60 * 60 * 1000).toISOString(),
      };
    })();

    // Idempotency guard: suppress the duplicate daily cron invocation that fires
    // a few minutes after the first and would re-run Layer-3 LLM validation over
    // the same window for no new data. `?force=1` bypasses for manual re-runs.
    if (req.query.force !== "1") {
      const duplicate = await findRecentSuccessfulRun({ days, withinMinutes: 20 });
      if (duplicate) {
        return res.status(200).json({
          skipped: true,
          reason: "duplicate_run_suppressed",
          days_window: days,
          matched_run_id: duplicate.id,
          matched_finished_at: duplicate.finished_at,
          matched_source_count: duplicate.source_count,
        });
      }
    }

    runId = await startIngestionRun();

    // Collect-only: Layer 1–3 (RSS feeds, APIs, validation).
    // Classification (Layer 4), QA, and digest fanout run in GitHub Actions
    // (scripts/dailyClassify.js) 30 min after this cron completes.
    const result = await collectRawSources(customWindow);

    const snapshot = {
      generated_at: new Date().toISOString(),
      period,
      stage: `published_date_ingestion_${days}d`,
      reporting_window: result.reporting_window,

      count: result.sources.length,

      removed_by_publish_date_count: result.removed_by_publish_date_count,
      removed_by_publish_date: result.removed_by_publish_date,

      rejected_count: result.rejected_count,
      rejected_sources: result.rejected_sources,

      discarded_count: result.discarded_count,
      discarded_by_validity: result.discarded_by_validity,

      discarded_by_relevance_count: result.discarded_by_relevance_count,
      discarded_by_relevance: result.discarded_by_relevance,
      validation_stats: result.validation_stats,

      pipeline_counts: result.pipeline_counts,

      sources: result.sources,
      archive: result.archive,
      connector_results: result.connector_results,
    };

    const stored = await saveSnapshotToDatabase(snapshot);

    await finishIngestionRun(runId, snapshot);
    flushPipelineCostToDB(runId).catch(() => {}); // fire-and-forget

    return res.status(200).json({
      run_id: runId,
      days_window: days,
      ...snapshot,
      stored,
    });
  } catch (error) {
    if (runId) {
      await failIngestionRun(runId, error);
    }

    return res.status(500).json({
      run_id: runId,
      error: error.message,
      stack: error.stack,
    });
  }
}
