#!/usr/bin/env node
/**
 * classifyDigestChildren.js — run understandAllSources on digest children
 * that have never been classified (main_category IS NULL).
 *
 * dailyClassify.js misses these because its query uses neq("validation_status","reject")
 * which excludes NULLs in Postgres. Children reset for reprocessing have null
 * validation_status and fall through the gap.
 *
 * Usage:
 *   node scripts/classifyDigestChildren.js [--limit 200] [--dry-run]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { callLLM } from "../lib/llm/callLLM.js";
import { understandAllSources } from "../lib/pipeline/understand/understandSource.js";

const args = process.argv.slice(2);
const LIMIT = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1], 10) : 200;
const DRY = args.includes("--dry-run");

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const llmFn = (sys, usr, opts) => callLLM(sys, usr, opts);

async function main() {
  console.log(`\nClassify digest children — limit ${LIMIT}${DRY ? " (dry run)" : ""}\n`);

  const { data, error } = await sb
    .from("sources")
    .select("id,title,url,publisher,date_published,source_type,trust_tier,full_text,clean_text,summary,main_category,layer3_status,candidate_domain,ai_threat_focus,is_digest,parent_source_id,intelligence")
    .not("parent_source_id", "is", null)
    .is("main_category", null)
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  if (error) { console.error("DB load failed:", error.message); process.exit(1); }
  if (!data?.length) { console.log("No unclassified children. Done."); return; }

  console.log(`${data.length} unclassified children loaded\n`);

  const { relevant, discarded, counts } = await understandAllSources(data, {
    llmFn,
    concurrency: 5,
    supabase: DRY ? null : sb,
    onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total}`),
  });

  console.log(`\n\nDone — pass: ${counts?.pass ?? relevant.length}, discard: ${counts?.discard ?? discarded.length}`);

  if (DRY) {
    relevant.slice(0, 20).forEach(s =>
      console.log(`  [${s.category}] ${s.title?.slice(0, 70)}`)
    );
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
