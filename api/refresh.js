import { collectRawSources }      from "../lib/pipeline/ingest/collectRawSources.js";
import { understandAllSources }   from "../lib/pipeline/understandSource.js";
import { qaClassificationLLM }    from "../lib/pipeline/qaClassification.js";
import { saveSnapshotToDatabase } from "../lib/storage/snapshotDatabase.js";
import { createClient }           from "@supabase/supabase-js";
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

    // ?days=N runs a wider ingestion window (e.g. 14 for the past two weeks).
    // Defaults to 1 (standard daily run) when not specified.
    const days = Math.min(Number(req.query.days || 1), 30);
    const period = days <= 1 ? "daily" : days <= 7 ? "weekly" : "monthly";

    // For days > 1, build an explicit N-day window anchored to end-of-today UTC.
    // For days = 1, pass null so collectRawSources uses the default SGT daily window.
    const customWindow = days <= 1 ? null : (() => {
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

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    runId = await startIngestionRun();

    // Web discovery (Layer 1B/1C) is NOT run here — Vercel Hobby caps functions
    // at 10s; discovery takes 3–8 min. Run it outside Vercel instead:
    //   node scripts/ingestOperational.js --days 1
    const result = await collectRawSources(customWindow);

    const snapshot = {
      generated_at: new Date().toISOString(),
      period,
      stage: days > 1 ? `wide_window_ingestion_${days}d` : "published_date_based_ingestion",
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

    // ── Step 2: Classify + QA all new sources ──────────────────────────────
    // collectRawSources saves sources with main_category="unclassified" and
    // validation_status="pass". Strip both so understandAllSources makes a
    // fresh LLM call (its cache check requires a real domain + pass status).
    // The QA verifier then cross-checks every new source (full mode — daily
    // batches are always small) and auto-fixes any misclassifications.
    let classifyCounts = null;
    let qaCounts       = null;
    if (result.sources.length > 0) {
      const toClassify = result.sources.map(s => ({
        ...s,
        main_category:     null,
        validation_status: null,
      }));

      const { relevant, discarded, counts } = await understandAllSources(
        toClassify,
        { skipLlm: false, supabase, concurrency: 4 },
      );
      classifyCounts = counts;

      // QA verifier — full mode on daily batches (always ≤200 sources)
      const { report } = await qaClassificationLLM(relevant, {
        skipLlm:     false,
        full:        true,
        concurrency: 3,
        supabase,
      });
      qaCounts = {
        checked:        report.checked,
        agreed:         report.agreed,
        fixed:          report.fixed,
        agreement_rate: report.agreement_rate,
      };
    }

    await finishIngestionRun(runId, snapshot);
    flushPipelineCostToDB(runId).catch(() => {}); // fire-and-forget

    return res.status(200).json({
      run_id: runId,
      days_window: days,
      ...snapshot,
      stored,
      classify_counts: classifyCounts,
      qa_counts:       qaCounts,
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
