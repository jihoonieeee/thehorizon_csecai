#!/usr/bin/env node
/**
 * scoreResearchSignificance.js — backfill the significance overlay on research sources.
 *
 * Runs one cheap Haiku call per research_finding/benchmark_evaluation source to
 * rank it landmark|notable|routine|incremental (+ novelty), stored at
 * intelligence.significance. This is ADVISORY — it never changes the deterministic
 * importance tier; it only breaks ties WITHIN a tier (dashboard sort + slide
 * selection) so a landmark paper stops ranking level with a routine one.
 *
 * Idempotent: sources that already carry intelligence.significance are skipped
 * unless --force. Safe to run in batches.
 *
 * Usage:
 *   node scripts/scoreResearchSignificance.js               # dry run — print, no writes
 *   node scripts/scoreResearchSignificance.js --live        # write intelligence.significance
 *   node scripts/scoreResearchSignificance.js --live --limit 100
 *   node scripts/scoreResearchSignificance.js --live --force   # re-score already-scored sources
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { routedLLM } from "../lib/llm/llmRouter.js";
import { assessSignificance, SIGNIFICANCE_ELIGIBLE_TYPES } from "../lib/pipeline/researchSignificance.js";

const args = process.argv.slice(2);
const LIVE  = args.includes("--live");
const FORCE = args.includes("--force");
const limit = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1], 10) : 200;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SELECT = "id,title,publisher,tags,source_type,short_summary,summary,full_text,intelligence";

// Production extractor → Haiku via the research_significance task profile.
const llmFn = async (sys, usr, opts) => {
  const { result } = await routedLLM(sys, usr, { task: "research_significance", requires_json: true, schema: opts.schema });
  return result;
};

async function main() {
  const scoredAt = new Date().toISOString();
  const { data: rows, error } = await sb.from("sources").select(SELECT)
    .in("source_type", [...SIGNIFICANCE_ELIGIBLE_TYPES])
    .eq("validation_status", "pass")
    .order("date_published", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);

  const todo = (rows || []).filter(s => FORCE || !s.intelligence?.significance).slice(0, limit);
  console.log(`\n${rows.length} research sources; ${todo.length} to score ${LIVE ? "(LIVE)" : "(DRY RUN)"}${FORCE ? " [FORCE]" : ""}\n`);

  const dist = {};
  let n = 0;
  for (const s of todo) {
    let sig;
    try {
      sig = await assessSignificance(s, { llmFn, scoredAt });
    } catch (e) {
      console.log(`  ✗ ${s.id.slice(0, 8)} — ${e.message.slice(0, 50)}`);
      continue;
    }
    if (!sig) continue;
    dist[sig.level] = (dist[sig.level] || 0) + 1;
    const mark = sig.level === "landmark" ? "★" : sig.level === "notable" ? "▸" : " ";
    console.log(`  ${mark} [${sig.level}/${sig.novelty}] ${s.title?.slice(0, 66)}`);
    if (sig.level === "landmark") console.log(`      ↳ ${sig.reason}`);

    if (LIVE) {
      const { error: we } = await sb.from("sources")
        .update({ intelligence: { ...(s.intelligence || {}), significance: sig } })
        .eq("id", s.id);
      if (we) console.log(`      ! write: ${we.message.slice(0, 60)}`); else n++;
    }
  }

  console.log(`\nDistribution: ${JSON.stringify(dist)}`);
  console.log(`${LIVE ? `Wrote ${n} significance records.` : "DRY RUN — re-run with --live to apply."}`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
