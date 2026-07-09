import { collectRawSources }      from "../lib/pipeline/ingest/collectRawSources.js";
import { understandAllSources }   from "../lib/pipeline/understand/understandSource.js";
import { qaClassificationLLM }    from "../lib/pipeline/understand/qaClassification.js";
import { saveSnapshotToDatabase } from "../lib/storage/snapshotDatabase.js";
import { createClient }           from "@supabase/supabase-js";
import {
  startIngestionRun,
  finishIngestionRun,
  failIngestionRun,
  findRecentSuccessfulRun,
} from "../lib/storage/ingestionRunStore.js";
import { flushPipelineCostToDB } from "../lib/llm/usagePersistence.js";
import { detectDigest, fanOutDigest } from "../lib/pipeline/ingest/digestFanout.js";
import { callLLM } from "../lib/llm/callLLM.js";

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

    // ── Step 2: Classify + QA all new sources ──────────────────────────────
    // collectRawSources saves sources with main_category="unclassified" and
    // validation_status="pass". Strip both so understandAllSources makes a
    // fresh LLM call (its cache check requires a real domain + pass status).
    // The QA verifier then cross-checks every new source (full mode — daily
    // batches are always small) and auto-fixes any misclassifications.
    //
    // Digests are pre-detected BEFORE single classification so multi-topic
    // reports are never collapsed to one dominant mechanism by understandSource.
    // detectDigest() is cheap (no LLM); only the fan-out step spends tokens.
    const DIGEST_CAP = 10;
    let classifyCounts = null;
    let qaCounts       = null;
    let fanoutCount    = 0;
    if (result.sources.length > 0) {
      const toClassify = result.sources.map(s => ({
        ...s,
        main_category:     null,
        validation_status: null,
      }));

      // ── Step 2a: Pre-detect digests ────────────────────────────────────────
      // Split before the single-mechanism LLM call. Detected digests skip
      // understandSource entirely — they go straight to fanOutDigest so each
      // extracted item is classified independently. Sources where the LLM later
      // disagrees (single-topic after all) fall back to normal classification.
      const preDigests   = toClassify.filter(s => detectDigest(s).is_digest && !s.parent_source_id).slice(0, DIGEST_CAP);
      const preDigestIds = new Set(preDigests.map(s => s.id));
      const singles      = toClassify.filter(s => !preDigestIds.has(s.id));

      // ── Step 2b: Classify single-topic sources ─────────────────────────────
      const { relevant, adjacent, discarded, counts } = await understandAllSources(
        singles,
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

      // ── Step 3: Digest fanout ──────────────────────────────────────────────
      // Fan out pre-detected digests. For any that the LLM decides are
      // single-topic after all, fall back to normal single classification.
      // Also check adjacent sources that slipped past the heuristic — a long
      // mixed report can land as adjacent_context before the LLM sees it whole.
      const llmFn    = (sys, usr, opts) => callLLM(sys, usr, opts);
      const scoredAt = new Date().toISOString();

      // Post-classify catch: adjacent sources not already in preDigests that
      // structurally look like digests (slipped the title/URL heuristic).
      const postDigests = adjacent.filter(s => detectDigest(s).is_digest && !s.parent_source_id);
      const allDigests  = [...preDigests, ...postDigests].slice(0, DIGEST_CAP);

      const fallbackSingles = [];
      for (const digestSrc of allDigests) {
        try {
          const { is_digest, children, parent_patch } = await fanOutDigest(digestSrc, { llmFn, scoredAt });
          if (!is_digest || !children.length) {
            // LLM said single-topic — classify the source normally instead.
            if (preDigestIds.has(digestSrc.id)) fallbackSingles.push(digestSrc);
            continue;
          }
          await supabase.from("sources")
            .upsert(children, { onConflict: "id", ignoreDuplicates: false });
          if (parent_patch) {
            await supabase.from("sources")
              .update({ is_digest: true, intelligence: { ...(digestSrc.intelligence || {}), ...parent_patch.intelligence } })
              .eq("id", digestSrc.id);
          }
          fanoutCount += children.length;
        } catch { /* non-fatal: fanout failure must not abort the run */ }
      }

      // Classify any pre-detected digests that the LLM decided were single-topic.
      if (fallbackSingles.length > 0) {
        await understandAllSources(fallbackSingles, { skipLlm: false, supabase, concurrency: 4 });
      }
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
      fanout_children: fanoutCount ?? 0,
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
