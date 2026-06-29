#!/usr/bin/env node
/**
 * backfillDefensiveTechniques.js — fill defensive_techniques + defensive_analysis
 * for sources already flagged is_defensive but missing the enrichment.
 *
 * Sources flagged defensive by the cheap understand call often have empty
 * defensive_techniques (the model omits them). This loads those sources and runs
 * the defensive sub-pipeline's deeper enrichment (now Anthropic-capable via
 * routedLLM), then writes the results back to Supabase.
 *
 * Usage:
 *   node scripts/backfillDefensiveTechniques.js [--limit 100]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { classifyDefensiveSources } from "../lib/pipeline/classifyDefensive.js";

const args  = process.argv.slice(2);
const LIMIT = parseInt((args[args.indexOf("--limit") + 1]) || "200", 10);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

console.log("Loading defensive sources missing defensive_techniques...");
// PostgREST can't filter on a nested jsonb array length directly, so load defensive
// sources and filter in JS.
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("sources")
    .select("id,title,publisher,full_text,clean_text,summary,main_category,tags,intelligence")
    .eq("validation_status", "pass")
    .not("intelligence", "is", null)
    .range(from, from + 999);
  if (error) { console.error("DB load failed:", error.message); process.exit(1); }
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < 1000) break;
}

const needing = rows
  .filter(r => r.intelligence?.is_defensive && !(r.intelligence?.defensive_techniques?.length))
  .slice(0, LIMIT);

console.log(`  ${needing.length} defensive sources need techniques (of ${rows.length} enriched)\n`);
if (!needing.length) { console.log("Nothing to backfill. Done."); process.exit(0); }

// Shape into the understand-output form classifyDefensiveSources expects.
const sources = needing.map(r => ({
  id: r.id, title: r.title, publisher: r.publisher,
  full_text: r.full_text || r.clean_text || r.summary || "",
  short_summary: r.intelligence?.source_summary || "",
  category: r.main_category,
  primary_tags: r.tags || [],
  is_defensive: true,
  defended_category: r.intelligence?.defended_category || r.main_category,
  defensive_techniques: [],
}));

const { classified, counts } = await classifyDefensiveSources(sources, { concurrency: 4 });
console.log(`Enriched: ${counts.enriched}/${counts.total}  (QA pass ${counts.qa_pass}, warn ${counts.qa_warn ?? 0})`);

const writes = classified
  .filter(s => s.defensive_techniques?.length || s.defensive_analysis)
  .map(s => {
    const prev = needing.find(n => n.id === s.id)?.intelligence || {};
    return {
      id: s.id,
      tags: [...new Set([...(s.primary_tags || []), "defensive"])],
      intelligence: {
        ...prev,
        is_defensive:         true,
        defended_category:    s.defended_category || s.category || null,
        defensive_techniques: s.defensive_techniques || [],
        defensive_analysis:   s.defensive_analysis || prev.defensive_analysis || null,
      },
    };
  });

let saved = 0;
for (let i = 0; i < writes.length; i += 100) {
  const { error } = await sb.from("sources").upsert(writes.slice(i, i + 100), { onConflict: "id" });
  if (error) console.warn(`  writeback error: ${error.message}`);
  else saved += Math.min(100, writes.length - i);
}
console.log(`\nWrote back ${saved} sources with defensive_techniques.`);

const withTechs = writes.filter(w => w.intelligence.defensive_techniques.length).length;
console.log(`  ${withTechs}/${writes.length} now have >=1 technique.`);

import("../lib/llm/usagePersistence.js").then(m => m.flushCostBuffer?.()).catch(() => {});
