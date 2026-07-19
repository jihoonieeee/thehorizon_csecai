#!/usr/bin/env node
/**
 * understandCorpus.js — runs the understand layer over every validated source
 * that has not yet been understood.
 *
 * Runs understandSource (L3+L4 combined call) on every source where
 * claim_extraction_status IS NULL, then writes back:
 *   short_summary, analyst_brief, main_category, tags,
 *   source_type, trust_tier, intelligence (key_entities, main_claims, key_numbers),
 *   claim_extraction_status = 'success'
 *
 * Usage:
 *   node scripts/understandCorpus.js [--dry-run] [--limit N] [--batch N] [--concurrency N]
 *
 * Defaults: batch=20, concurrency=5, no limit.
 * Safe to re-run: skips already-understood sources (claim_extraction_status IS NOT NULL).
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { understandSource } from "../lib/pipeline/understand/understandSource.js";
import { scrubImpliedQuantitatives } from "../lib/utils/scrubQuantitatives.js";
import { fanOutDigest } from "../lib/pipeline/ingest/digestFanout.js";
import { callLLM } from "../lib/llm/callLLM.js";
import { fetchPageText } from "../lib/pipeline/discovery/fetchCandidateText.js";

const args        = process.argv.slice(2);
const DRY_RUN     = args.includes("--dry-run");
const NO_FANOUT   = args.includes("--no-fanout");   // skip landscape-report splitting
const limitIdx    = args.indexOf("--limit");
const batchIdx    = args.indexOf("--batch");
const concIdx     = args.indexOf("--concurrency");
const LIMIT       = limitIdx  >= 0 ? (parseInt(args[limitIdx  + 1], 10) || 0) : 0;
const BATCH_SIZE  = batchIdx  >= 0 ? (parseInt(args[batchIdx  + 1], 10) || 20) : 20;
const CONCURRENCY = concIdx   >= 0 ? (parseInt(args[concIdx   + 1], 10) ||  5) :  5;

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function pMap(items, fn, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = await Promise.all(items.slice(i, i + concurrency).map(fn));
    results.push(...chunk);
  }
  return results;
}

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Corpus Understanding`);
  console.log(`  Dry run: ${DRY_RUN} | Limit: ${LIMIT || "all"} | Batch: ${BATCH_SIZE} | Concurrency: ${CONCURRENCY}`);
  console.log(`${"═".repeat(60)}\n`);

  // ── Load not-yet-understood validated sources ────────────────────────────────────────
  // Include 'review' as well as 'pass': understand IS the layer that resolves
  // relevance uncertainty (it re-judges and demotes irrelevant ones). Sources
  // ingested without an LLM gate — e.g. the deterministic operational-discovery
  // job — land in 'review' and would otherwise never be classified or reach the
  // dashboard. Only hard 'reject' is excluded.
  let query = sb
    .from("sources")
    .select("id,title,url,publisher,date_published,main_category,trust_tier,source_type,full_text,summary,tags,validation_status,parent_source_id,is_digest,intelligence")
    .in("validation_status", ["pass", "review"])
    .is("claim_extraction_status", null)
    .order("date_published", { ascending: false });

  if (LIMIT > 0) query = query.limit(LIMIT);

  const { data: sources, error } = await query;
  if (error) { console.error("DB error:", error.message); process.exit(1); }
  if (!sources?.length) { console.log("  No not-yet-understood sources found. All done."); return; }

  console.log(`  Found ${sources.length} sources to understand\n`);

  const t0 = Date.now();
  let processed = 0, succeeded = 0, failed = 0;

  // ── Process in batches ───────────────────────────────────────────────────────
  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const batch = sources.slice(i, i + BATCH_SIZE);

    const results = await pMap(batch, async (src) => {
      try {
        const understood = await understandSource(src);
        return { src, understood, ok: true };
      } catch (err) {
        return { src, err: err.message, ok: false };
      }
    }, CONCURRENCY);

    // ── Write batch back to DB ─────────────────────────────────────────────────
    const updates = results
      .filter(e => e.ok && e.understood.relevant !== false)
      .map(({ src, understood: u }) => {
        const sourceText = src.full_text || src.summary || "";
        // Scrub hype/implied-quantitative language from summary that isn't backed
        // by numbers in the source text — prevents false precision in summaries
        const rawSummary = u.short_summary || null;
        const { text: cleanSummary } = rawSummary
          ? scrubImpliedQuantitatives(rawSummary, sourceText)
          : { text: rawSummary };

        const rawAnalystBrief = u.analyst_brief || null;
        const { text: cleanAnalystBrief } = rawAnalystBrief
          ? scrubImpliedQuantitatives(rawAnalystBrief, sourceText)
          : { text: rawAnalystBrief };

        return {
          id:                      src.id,
          // Promote understood-relevant 'review' sources to 'pass' so they reach
          // the dashboard / downstream (which filter on validation_status='pass').
          // Understand has now confirmed relevance, so the review state is resolved.
          validation_status:       "pass",
          main_category:           u.category,
          tags:                    u.primary_tags || [],
          source_type:             u.source_type  || src.source_type || "unknown",
          trust_tier:              u.trust_tier   || src.trust_tier  || "unknown",
          short_summary:           cleanSummary,
          analyst_brief:           cleanAnalystBrief || cleanSummary,
          intelligence: {
            key_entities: u.key_entities || [],
            key_terms:    u.key_terms    || [],
            main_claims:  u.main_claims  || [],
            key_numbers:  u.key_numbers  || [],
            ...(u.event_date ? { event_date: u.event_date, event_date_confidence: u.event_date_confidence } : {}),
            ...(u.source_coverage_type ? {
              source_coverage_type: u.source_coverage_type,
              ...(u.covered_period_start ? { covered_period_start: u.covered_period_start } : {}),
              ...(u.covered_period_end   ? { covered_period_end:   u.covered_period_end   } : {}),
            } : {}),
          },
          claim_extraction_status: "success",
        };
      });

    // Sources the LLM flagged as irrelevant get their status set to reject
    const irrelevantIds = results
      .filter(e => e.ok && e.understood.relevant === false)
      .map(e => e.src.id);

    if (!DRY_RUN) {
      // Upsert understood sources
      if (updates.length > 0) {
        const { error: upErr } = await sb.from("sources").upsert(updates, { onConflict: "id" });
        if (upErr) {
          console.error(`  Batch upsert error: ${upErr.message}`);
          failed += updates.length;
        } else {
          succeeded += updates.length;
        }
      }
      // Mark irrelevant ones as rejected
      if (irrelevantIds.length > 0) {
        await sb.from("sources")
          .update({ validation_status: "reject", claim_extraction_status: "irrelevant" })
          .in("id", irrelevantIds);
      }

      // ── Landscape-report fan-out ─────────────────────────────────────────────
      // A report (threat landscape / tracker / round-up / IR report) is a knowledge
      // base of many findings, not one source. Split kept, not-already-child sources
      // detected as reports into per-finding child sources (each independently
      // classified), and flag the parent is_digest so it's a CONTAINER — counted
      // once, never as N independent corroborating sources.
      if (!NO_FANOUT) {
        const digestParents = results.filter(e =>
          e.ok && e.understood.relevant !== false &&
          !e.src.parent_source_id && e.src.is_digest !== true);
        const scoredAt = new Date().toISOString();
        for (const e of digestParents) {
          let out;
          try {
            out = await fanOutDigest(e.src, {
              // Route to Haiku + cached system prompt (report_extraction task) — the
              // extraction is bulk JSON over many chunks × many reports, so cost matters.
              llmFn: (s, u, o) => callLLM(s, u, { ...o, task: "report_extraction", json: true }),
              // Reports are truncated to ~15k at ingest — fetch the FULL document
              // (uncapped) so the LLM can surface every finding, then chunk it.
              fetchFullText: (url) => fetchPageText(url, { timeoutMs: 25000, maxChars: 150000 }),
              maxChunks: 6,          // cap cost: at most 6 chunks (~240k chars) per report
              scoredAt,
            });
          } catch (err) { continue; }   // fan-out never blocks the main understand run
          if (!out.is_digest || !out.children.length) continue;
          const childRows = out.children.map(({ _norm, ...row }) => row);
          const { error: ce } = await sb.from("sources").upsert(childRows, { onConflict: "id", ignoreDuplicates: false });
          if (ce) { console.log(`\n  [fanout] child write failed for ${e.src.id.slice(0,8)}: ${ce.message.slice(0,50)}`); continue; }
          await sb.from("sources").update({ is_digest: true, intelligence: { ...(e.src.intelligence || {}), is_digest: true, digest_item_count: childRows.length } }).eq("id", e.src.id);
          console.log(`\n  [fanout] ${e.src.title?.slice(0,45)} → ${childRows.length} findings across ${new Set(childRows.map(c=>c.main_category)).size} categories`);
        }
      }
    } else {
      // Dry run: just preview
      const sample = updates[0];
      if (sample) console.log(`  [dry] ${sample.id.slice(0, 8)}… → ${sample.main_category} | "${(sample.short_summary || "").slice(0, 60)}…"`);
      succeeded += updates.length;
    }

    failed += results.filter(e => !e.ok).length;
    processed += batch.length;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const rate    = processed / ((Date.now() - t0) / 1000);
    const eta     = Math.round((sources.length - processed) / rate);
    process.stdout.write(
      `  ${processed}/${sources.length} processed | ${succeeded} understood | ${failed} failed | ${elapsed}s elapsed | ETA ~${eta}s\r`
    );
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n\n${"─".repeat(60)}`);
  console.log(`  Done in ${elapsed}s`);
  console.log(`  Processed : ${processed}`);
  console.log(`  Understood  : ${succeeded}${DRY_RUN ? " (dry run)" : ""}`);
  console.log(`  Failed    : ${failed}`);
  if (!DRY_RUN) {
    console.log(`\n  Next step: run the synthesis pipeline:`);
    console.log(`  node scripts/runHorizonScan.js --days 365 --limit 1000 --no-slides`);
  }
}

import { flushCostBuffer } from "../lib/llm/usagePersistence.js";
main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error(err); process.exit(1); });
