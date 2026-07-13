#!/usr/bin/env node
/**
 * dailyClassify.js — classify, QA-verify, and fan out digests for sources
 * collected by the Vercel daily ingest (/api/refresh).
 *
 * Runs in GitHub Actions ~30 min after the Vercel cron collects sources.
 * Picks up any source with no main_category created in the last N hours.
 *
 * Steps:
 *   1. understandAllSources  — mechanism-first classification
 *   2. qaClassificationLLM   — cross-model QA verifier (auto-fixes)
 *   3. digest fanout          — splits multi-topic reports into child sources
 *
 * Usage:
 *   node scripts/dailyClassify.js [--since-hours 3] [--limit 200]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { understandAllSources } from "../lib/pipeline/understand/understandSource.js";
import { qaClassificationLLM } from "../lib/pipeline/understand/qaClassification.js";
import { detectDigest, fanOutDigest } from "../lib/pipeline/ingest/digestFanout.js";
import { extractAndSaveReportInsights } from "../lib/pipeline/ingest/extractLongReportInsights.js";
import { callLLM } from "../lib/llm/callLLM.js";
import { flushCostBuffer } from "../lib/llm/usagePersistence.js";

const args    = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SINCE_H = parseFloat(getArg("--since-hours", "3"));
const LIMIT   = parseInt(getArg("--limit", "200"), 10);
const DIGEST_CAP = 10;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function main() {
  const since = new Date(Date.now() - SINCE_H * 3600 * 1000).toISOString();
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Daily classify — unclassified sources since ${since.slice(0, 16)} UTC`);
  console.log(`  since-hours: ${SINCE_H}  limit: ${LIMIT}`);
  console.log(`${"═".repeat(60)}\n`);

  const { data, error } = await supabase
    .from("sources")
    .select("id,title,url,publisher,source_type,trust_tier,full_text,clean_text,summary,main_category,validation_status,candidate_domain,ai_threat_focus,date_published,is_digest,parent_source_id,intelligence")
    .is("main_category", null)
    .neq("validation_status", "reject")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  if (error) { console.error("DB load failed:", error.message); process.exit(1); }
  if (!data?.length) { console.log("  No unclassified sources in window. Done."); return; }
  console.log(`  ${data.length} sources to process\n`);

  // Reset category/status so understandAllSources makes fresh LLM calls.
  const toClassify = data.map(s => ({ ...s, main_category: null, validation_status: null }));

  // Pre-detect digests before single classification so multi-topic reports are
  // never collapsed to one dominant mechanism by understandSource.
  const preDigests   = toClassify.filter(s => detectDigest(s).is_digest && !s.parent_source_id).slice(0, DIGEST_CAP);
  const preDigestIds = new Set(preDigests.map(s => s.id));
  const singles      = toClassify.filter(s => !preDigestIds.has(s.id));

  // Step 1: classify single-topic sources
  const { relevant, adjacent, discarded, counts } = await understandAllSources(
    singles,
    { skipLlm: false, supabase, concurrency: 4 },
  );
  console.log(`  Classified: ${relevant.length} relevant / ${adjacent.length} adjacent / ${discarded.length} discarded`);

  // Step 2: cross-model QA verifier
  const { report } = await qaClassificationLLM(relevant, {
    skipLlm: false, full: true, concurrency: 3, supabase,
  });
  console.log(`  QA: ${report.agreed}/${report.checked} agreed, ${report.fixed} auto-fixed (${(report.agreement_rate * 100).toFixed(0)}%)`);

  // Step 3: digest fanout
  const postDigests = adjacent.filter(s => detectDigest(s).is_digest && !s.parent_source_id);
  const allDigests  = [...preDigests, ...postDigests].slice(0, DIGEST_CAP);
  const llmFn       = (sys, usr, opts) => callLLM(sys, usr, opts);
  const scoredAt    = new Date().toISOString();

  let fanoutCount = 0;
  const fallbackSingles = [];
  for (const digestSrc of allDigests) {
    try {
      const { is_digest, children, parent_patch } = await fanOutDigest(digestSrc, { llmFn, scoredAt });
      if (!is_digest || !children.length) {
        if (preDigestIds.has(digestSrc.id)) fallbackSingles.push(digestSrc);
        continue;
      }
      await supabase.from("sources").upsert(children, { onConflict: "id", ignoreDuplicates: false });
      if (parent_patch) {
        await supabase.from("sources")
          .update({ is_digest: true, intelligence: { ...(digestSrc.intelligence || {}), ...parent_patch.intelligence } })
          .eq("id", digestSrc.id);
      }
      fanoutCount += children.length;
      extractAndSaveReportInsights(
        { ...digestSrc, intelligence: { ...(digestSrc.intelligence || {}), ...parent_patch?.intelligence }, is_digest: true },
        supabase,
      ).catch(() => {});
    } catch (err) {
      console.warn(`  [fanout] ${digestSrc.id} failed: ${err.message.slice(0, 80)}`);
    }
  }

  if (fallbackSingles.length > 0) {
    console.log(`  Reclassifying ${fallbackSingles.length} digests that are single-topic`);
    await understandAllSources(fallbackSingles, { skipLlm: false, supabase, concurrency: 4 });
  }

  console.log(`  Digest fanout: ${fanoutCount} children from ${allDigests.length} digest(s)`);
  console.log(`  By category:   ${JSON.stringify(counts?.by_category || {})}`);
  console.log("\n  Done.");
}

main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error(err); process.exit(1); });
