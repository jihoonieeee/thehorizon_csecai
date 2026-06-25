/**
 * One-off: normalise legacy connector source_types to the canonical vocabulary.
 * Uses OLD_SOURCE_TYPE_MAP (lib/config/sourceTypes.js) as the single source of truth.
 * Lossless at the corpusComposition bucket level; makes OPERATIONAL_TYPES /
 * HORIZON_TYPES gates see operational rows that were previously non-canonical.
 *
 *   node scripts/normalizeSourceTypes.mjs            # dry-run (counts only)
 *   node scripts/normalizeSourceTypes.mjs --apply    # write
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { OLD_SOURCE_TYPE_MAP, ALL_SOURCE_TYPES } from "../lib/config/sourceTypes.js";
const APPLY = process.argv.includes("--apply");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function pageAll(sel){let all=[],from=0,sz=1000;for(;;){const{data,error}=await sb.from("sources").select(sel).range(from,from+sz-1);if(error)throw error;all=all.concat(data);if(data.length<sz)break;from+=sz;}return all;}

const rows = await pageAll("id,source_type,validation_status");
const counts = {};
for (const r of rows){const k=r.source_type??"null";counts[k]=(counts[k]||0)+1;}
console.log("=== current source_type tally (all rows, n="+rows.length+") ===");
console.log(Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`  ${k}: ${v}`).join("\n"));

// Build the work list: rows whose source_type is a legacy key in the map.
const plan = {};
for (const r of rows){
  const t = r.source_type;
  if (t && OLD_SOURCE_TYPE_MAP[t]) {
    const to = OLD_SOURCE_TYPE_MAP[t];
    (plan[`${t} → ${to}`] ??= []).push(r.id);
  }
}
console.log(`\n=== normalisation plan (${APPLY ? "APPLY" : "DRY-RUN"}) ===`);
let total=0;
for (const [k,ids] of Object.entries(plan)){console.log(`  ${k}: ${ids.length}`);total+=ids.length;}
console.log(`  TOTAL rows to update: ${total}`);
// sanity: every target must be canonical
const badTargets = [...new Set(Object.values(OLD_SOURCE_TYPE_MAP))].filter(v=>!ALL_SOURCE_TYPES.includes(v));
if (badTargets.length){console.error("ABORT — non-canonical map targets:",badTargets);process.exit(1);}

if (!APPLY){console.log("\n(dry-run; re-run with --apply to write)");process.exit(0);}

// Apply per legacy value (batch update by value) to keep it simple + auditable.
const byValue = {};
for (const r of rows){const t=r.source_type;if(t&&OLD_SOURCE_TYPE_MAP[t])(byValue[t]??=OLD_SOURCE_TYPE_MAP[t]);}
for (const [from,to] of Object.entries(byValue)){
  const { error, count } = await sb.from("sources").update({ source_type: to }, { count: "exact" }).eq("source_type", from);
  if (error){console.error(`  FAIL ${from}→${to}: ${error.message}`);}
  else console.log(`  ✓ ${from} → ${to}: ${count} rows`);
}
console.log("done.");
