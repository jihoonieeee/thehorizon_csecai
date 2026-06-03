/**
 * scripts/cleanupCorpus.js — audited corpus cleanup for The Horizon.
 *
 * Two actions, both curated-safe (trust_tier='curated' is NEVER touched):
 *   1. PURGE  non-curated sources with ai_specificity_score < THRESHOLD (default 10).
 *   2. RESET  deterministic-poisoned enrichment: claim_extraction_status='success'
 *             with ai_specificity_score < RESET_MAX (default 20) on SURVIVING rows,
 *             clearing claim_extraction_status + taxonomy_version so the next real
 *             LLM run re-enriches them instead of skipping.
 *
 * SAFE BY DEFAULT: dry-run unless --apply is passed. Dry-run prints exact counts
 * and samples and changes nothing.
 *
 * Usage:
 *   node scripts/cleanupCorpus.js                 # dry run (default)
 *   node scripts/cleanupCorpus.js --apply         # execute deletes + resets
 *   node scripts/cleanupCorpus.js --threshold 10 --reset-max 20 --apply
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const args      = process.argv.slice(2);
const APPLY     = args.includes("--apply");
const argVal    = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : def; };
const THRESHOLD = argVal("--threshold", 10);
const RESET_MAX = argVal("--reset-max", 20);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const count = async (q) => { const { count, error } = await q; if (error) throw new Error(error.message); return count; };
const S = () => sb.from("sources").select("*", { count: "exact", head: true });

async function main() {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  Corpus Cleanup — ${APPLY ? "APPLY (writes!)" : "DRY RUN (no changes)"}`);
  console.log(`  purge: non-curated ai_specificity_score < ${THRESHOLD}`);
  console.log(`  reset: claim_extraction_status='success' AND ai_specificity_score < ${RESET_MAX} (survivors)`);
  console.log(`${"═".repeat(64)}\n`);

  const total = await count(S());
  console.log(`Total sources: ${total}`);

  // ── 1. PURGE candidates ──────────────────────────────────────────────────────
  const purgeCount = await count(S().lt("ai_specificity_score", THRESHOLD).neq("trust_tier", "curated"));
  const protectedCount = await count(S().lt("ai_specificity_score", THRESHOLD).eq("trust_tier", "curated"));
  console.log(`\n[1] PURGE candidates (non-curated, ai_spec < ${THRESHOLD}): ${purgeCount}`);
  console.log(`    Protected curated below threshold (kept): ${protectedCount}`);

  const { data: purgeSample } = await sb.from("sources")
    .select("id,title,main_category,ai_specificity_score,trust_tier")
    .lt("ai_specificity_score", THRESHOLD).neq("trust_tier", "curated").limit(5);
  for (const r of purgeSample || []) {
    console.log(`      · [${r.ai_specificity_score}] ${(r.title || "").slice(0, 60)} (${r.main_category})`);
  }

  // ── 2. RESET candidates (among survivors) ────────────────────────────────────
  // Survivors = not purged: either curated OR ai_spec >= THRESHOLD.
  const resetCount = await count(
    S().eq("claim_extraction_status", "success").lt("ai_specificity_score", RESET_MAX).gte("ai_specificity_score", THRESHOLD)
  );
  console.log(`\n[2] RESET candidates (survivors, poisoned enrichment): ${resetCount}`);
  console.log(`    (success + ai_spec in [${THRESHOLD}, ${RESET_MAX}) — re-enriched on next real run)`);

  if (!APPLY) {
    console.log(`\nDRY RUN complete — nothing changed. Re-run with --apply to execute.\n`);
    return;
  }

  // ── Execute PURGE (batched by id to avoid statement limits) ──────────────────
  console.log(`\nApplying PURGE…`);
  let purged = 0;
  while (true) {
    const { data, error } = await sb.from("sources")
      .select("id").lt("ai_specificity_score", THRESHOLD).neq("trust_tier", "curated").limit(500);
    if (error) throw new Error(error.message);
    if (!data.length) break;
    const ids = data.map((r) => r.id);
    const { error: delErr } = await sb.from("sources").delete().in("id", ids);
    if (delErr) throw new Error(delErr.message);
    purged += ids.length;
    process.stdout.write(`  deleted ${purged}/${purgeCount}\r`);
    if (ids.length < 500) break;
  }
  console.log(`\n  PURGE done: ${purged} rows deleted.`);

  // ── Execute RESET ────────────────────────────────────────────────────────────
  console.log(`Applying RESET…`);
  const { error: resetErr, count: resetDone } = await sb.from("sources")
    .update({ claim_extraction_status: null, taxonomy_version: null }, { count: "exact" })
    .eq("claim_extraction_status", "success").lt("ai_specificity_score", RESET_MAX).gte("ai_specificity_score", THRESHOLD);
  if (resetErr) throw new Error(resetErr.message);
  console.log(`  RESET done: ${resetDone ?? "?"} rows reset (claim_extraction_status + taxonomy_version cleared).`);

  const after = await count(S());
  console.log(`\nFinal source count: ${after} (was ${total}).\n`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
