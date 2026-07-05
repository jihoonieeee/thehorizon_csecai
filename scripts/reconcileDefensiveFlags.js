#!/usr/bin/env node
/**
 * reconcileDefensiveFlags.js — deterministic corpus audit (NO LLM / NO API cost)
 *
 * Enforces, retroactively across the whole `sources` table, the SAME invariant that
 * understandSource.normalise() + fromDbRow() now enforce at classify time:
 *
 *   is_defensive  ⟺  ("defensive" ∈ tags)  ⟺  (source_type == "defensive_capability")
 *
 * These three are three views of one fact. When they disagree, api/dashboard.js
 * (which excludes is_defensive rows from the attack tag matrix) silently miscounts
 * defenses as attacks. Historically ~700 rows drifted (older classifier versions
 * and overwritten `intelligence` jsonb dropped the flag while keeping the tag).
 *
 * Rules applied to every source:
 *   1. If ANY of {is_defensive flag, "defensive" tag, defensive_capability type}
 *      is set → the source IS defensive:
 *        • intelligence.is_defensive = true
 *        • ensure "defensive" ∈ tags
 *        • defended_category = main_category (when the category is offensive and
 *          no defended_category is recorded)
 *   2. short_summary === "[object Object]" (a stringified-object leak) → cleared.
 *
 * Curated sources are updated in place too (this never deletes anything).
 *
 * Usage:
 *   node scripts/reconcileDefensiveFlags.js --dry-run   # report only
 *   node scripts/reconcileDefensiveFlags.js             # apply fixes
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const DRY_RUN = process.argv.includes("--dry-run");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const OFFENSIVE = new Set([
  "traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats",
]);

function hasDefensiveTag(tags) {
  return (tags || []).map(t => String(t).toLowerCase()).includes("defensive");
}

async function main() {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  Defensive-flag reconciliation  ${DRY_RUN ? "(DRY RUN)" : "(LIVE)"}`);
  console.log(`${"═".repeat(64)}\n`);

  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("sources")
      .select("id,tags,source_type,main_category,intelligence,short_summary")
      .range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`  Scanning ${all.length} sources\n`);

  const updates = [];
  let flagFixed = 0, tagAdded = 0, defCatSet = 0, summaryCleared = 0;

  for (const s of all) {
    const tags = s.tags || [];
    const flag = s.intelligence?.is_defensive === true;
    const typeDef = s.source_type === "defensive_capability";
    const tagDef = hasDefensiveTag(tags);
    const isDef = flag || typeDef || tagDef;

    const patch = {};
    let touched = false;

    if (isDef) {
      const intel = { ...(s.intelligence || {}) };
      if (!flag) { intel.is_defensive = true; flagFixed++; touched = true; }
      if (OFFENSIVE.has(s.main_category) && !intel.defended_category) {
        intel.defended_category = s.main_category; defCatSet++; touched = true;
      }
      if (touched) patch.intelligence = intel;

      if (!tagDef) {
        patch.tags = [...new Set([...tags, "defensive"])];
        tagAdded++; touched = true;
      }
    }

    if (s.short_summary === "[object Object]") {
      patch.short_summary = null;
      summaryCleared++; touched = true;
    }

    if (touched) updates.push({ id: s.id, ...patch });
  }

  console.log(`  Rows needing fixes: ${updates.length}`);
  console.log(`    is_defensive flag set:      ${flagFixed}`);
  console.log(`    "defensive" tag added:      ${tagAdded}`);
  console.log(`    defended_category set:      ${defCatSet}`);
  console.log(`    "[object Object]" cleared:  ${summaryCleared}\n`);

  if (DRY_RUN) { console.log("  DRY RUN — no writes.\n"); return; }

  // Apply per-row (patches differ per row; upsert would need full rows)
  let done = 0;
  for (const u of updates) {
    const { id, ...patch } = u;
    const { error } = await sb.from("sources").update(patch).eq("id", id);
    if (error) console.warn(`    update ${id}: ${error.message.slice(0, 60)}`);
    else done++;
    if (done % 100 === 0) process.stdout.write(`  applied ${done}/${updates.length}\r`);
  }
  process.stdout.write("\n");
  console.log(`\n  Applied ${done}/${updates.length} updates.\n`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
