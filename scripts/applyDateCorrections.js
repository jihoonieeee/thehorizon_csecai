#!/usr/bin/env node
/**
 * applyDateCorrections.js — apply the high-confidence findings from
 * auditSourceDates.js (reads its --out JSON).
 *
 *   • Sources whose corrected publish date is >= the reporting-window floor
 *     (2025 Q3, i.e. 2025-07-01) → date_published / date_published_actual are
 *     rewritten to the authoritative page-meta / URL-path date, date_confidence
 *     set to "exact".
 *   • Sources whose corrected date falls BEFORE 2025 Q3 → purged (out of the
 *     scan timeframe), together with their dependent evidence rows.
 *
 * Curated sources are never hard-deleted (project invariant): if a curated row
 * lands in the purge set it is corrected-in-place and reported instead.
 *
 * Report-only by default. Pass --execute to write.
 *
 *   node scripts/applyDateCorrections.js --in=/tmp/date-audit.json
 *   node scripts/applyDateCorrections.js --in=/tmp/date-audit.json --execute
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith("--")).map(a => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; })
);
const IN      = args["in"] || "/tmp/date-audit.json";
const EXECUTE = Boolean(args["execute"]);
const Q3_2025 = "2025-07-01";   // reporting-window floor: start of 2025 Q3

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const findings = JSON.parse(readFileSync(IN, "utf8"))
  .filter(x => x.confidence === "high" && /^\d{4}-\d{2}-\d{2}$/.test(x.evidence_date || ""));

// Look up current trust_tier so curated rows are protected from purge.
const { data: rows } = await sb.from("sources").select("id,trust_tier").in("id", findings.map(f => f.id));
const tier = Object.fromEntries((rows || []).map(r => [r.id, r.trust_tier]));

const toCorrect = [];   // in-window (or curated) → rewrite date
const toPurge   = [];   // pre-Q3-2025 → delete
for (const f of findings) {
  const outOfWindow = f.evidence_date < Q3_2025;
  if (outOfWindow && tier[f.id] !== "curated") toPurge.push(f);
  else toCorrect.push({ ...f, curatedKept: outOfWindow && tier[f.id] === "curated" });
}

console.log(`\n${"═".repeat(70)}`);
console.log(`  Apply date corrections   mode=${EXECUTE ? "EXECUTE" : "DRY RUN"}`);
console.log(`  correct=${toCorrect.length}  purge=${toPurge.length}  (floor ${Q3_2025})`);
console.log(`${"═".repeat(70)}\n`);

console.log(`  ── CORRECT (rewrite date_published → page/URL date) ──`);
for (const f of toCorrect) {
  console.log(`   ${f.stored.slice(0,10)} → ${f.evidence_date}  ${f.curatedKept ? "[curated, kept]" : ""} ${(f.title||"").slice(0,50)}`);
}
console.log(`\n  ── PURGE (corrected date before 2025 Q3) ──`);
for (const f of toPurge) {
  console.log(`   ${f.evidence_date}  ${(f.title||"").slice(0,55)}`);
}

if (!EXECUTE) { console.log(`\n  [dry-run] nothing written. Re-run with --execute.\n`); process.exit(0); }

// ── Corrections ─────────────────────────────────────────────────────────────────
let corrected = 0;
for (const f of toCorrect) {
  const iso = `${f.evidence_date}T12:00:00+00:00`;   // noon UTC = same calendar day in SGT window
  const { error } = await sb.from("sources").update({
    date_published: iso,
    date_published_actual: iso,
    date_confidence: "exact",
  }).eq("id", f.id);
  if (error) console.log(`   correct error ${f.id}: ${error.message}`); else corrected++;
}

// ── Purge (evidence first, then sources) ──────────────────────────────────────────
const purgeIds = toPurge.map(f => f.id);
let evDel = 0, srcDel = 0;
for (let i = 0; i < purgeIds.length; i += 100) {
  const batch = purgeIds.slice(i, i + 100);
  const { data: ev } = await sb.from("evidence").select("evidence_id").in("source_id", batch);
  const evIds = (ev || []).map(e => e.evidence_id);
  if (evIds.length) { await sb.from("evidence").delete().in("evidence_id", evIds); evDel += evIds.length; }
  const { error } = await sb.from("sources").delete().in("id", batch);
  if (error) { console.log(`   purge error: ${error.message}`); break; }
  srcDel += batch.length;
}

console.log(`\n  Corrected ${corrected} sources.`);
console.log(`  Purged ${srcDel} sources + ${evDel} evidence rows.\n`);
