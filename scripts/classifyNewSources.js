#!/usr/bin/env node
/**
 * classifyNewSources.js — run v2 understand-layer classification over PASS sources
 * that have no v2 taxonomy category yet.
 *
 * Sources ingested via the discovery path (discoverOperationalSources.js) are
 * validated by the legacy Layer-3 (validateAndTypeSource) but never receive a v2
 * main_category / tags / defensive flag — so they are invisible to the dashboard,
 * insight generation, and slides. This script feeds them through understandAllSources
 * (which assigns category + tags + is_defensive and writes back to Supabase),
 * routes defensive ones through the defensive sub-pipeline QA, and reports counts.
 *
 * Evidence extraction is left to extractEvidenceBatch.js (run it afterwards).
 *
 * Usage:
 *   node scripts/classifyNewSources.js [--limit 100] [--since-hours 6]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { understandAllSources } from "../lib/pipeline/understandSource.js";
import { splitByDefensive, classifyDefensiveSources } from "../lib/pipeline/classifyDefensive.js";

const args  = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const LIMIT  = parseInt(getArg("--limit", "200"), 10);
const SINCE_H = getArg("--since-hours", null);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

console.log("Loading PASS sources with no v2 category...");
let q = sb.from("sources")
  .select("id,title,url,publisher,source_type,trust_tier,full_text,clean_text,summary,main_category,validation_status,date_published")
  .is("main_category", null)
  .neq("validation_status", "reject")
  .order("created_at", { ascending: false })
  .limit(LIMIT);
if (SINCE_H) q = q.gte("created_at", new Date(Date.now() - parseFloat(SINCE_H) * 3600 * 1000).toISOString());

const { data, error } = await q;
if (error) { console.error("DB load failed:", error.message); process.exit(1); }
if (!data?.length) { console.log("No uncategorised PASS sources found. Done."); process.exit(0); }

console.log(`  ${data.length} sources to classify\n`);

const { relevant, discarded, counts } = await understandAllSources(data, {
  supabase: sb,
  concurrency: 5,
  onProgress: (done, total) => process.stdout.write(`    ${done}/${total}\r`),
});
process.stdout.write("\n");

// Route defensive sources through the defensive sub-pipeline QA (writeback already
// persisted category + tags + intelligence.is_defensive in understandAllSources).
const { offensive, defensive } = splitByDefensive(relevant);
let defQa = { counts: { total: 0, qa_pass: 0, qa_fail: 0, qa_warn: 0 } };
if (defensive.length) {
  defQa = await classifyDefensiveSources(defensive, { concurrency: 5 });

  // Persist the enriched defensive fields back to Supabase. understandAllSources
  // already wrote category/tags/is_defensive; this fills defensive_techniques +
  // defensive_analysis that the deeper enrichment produced.
  const writes = (defQa.classified || [])
    .filter(s => s.defensive_techniques?.length || s.defensive_analysis)
    .map(s => ({
      id: s.id,
      tags: [...new Set([...(s.primary_tags || []), "defensive"])],
      intelligence: {
        is_defensive:         true,
        defended_category:    s.defended_category || s.category || null,
        defensive_techniques: s.defensive_techniques || [],
        defensive_analysis:   s.defensive_analysis || null,
        key_entities:         s.key_entities || [],
        main_claims:          s.main_claims || [],
      },
    }));
  if (writes.length) {
    const { error } = await sb.from("sources").upsert(writes, { onConflict: "id", ignoreDuplicates: false });
    if (error) console.warn(`  [defensive writeback] ${error.message}`);
    else console.log(`  [defensive writeback] persisted ${writes.length} enriched defensive sources`);
  }
}

console.log(`\n  Classified:  ${relevant.length} relevant / ${discarded.length} discarded`);
console.log(`  Split:       ${offensive.length} offensive / ${defensive.length} defensive`);
if (defensive.length) console.log(`  Defensive QA: ${defQa.counts.qa_pass}/${defQa.counts.total} pass`);
console.log(`  By category: ${JSON.stringify(counts.by_category)}`);
console.log(`\n  Next: run  node scripts/extractEvidenceBatch.js  to extract evidence for these.`);
