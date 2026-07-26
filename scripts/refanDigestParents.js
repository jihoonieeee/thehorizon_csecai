#!/usr/bin/env node
/**
 * refanDigestParents.js — recover digest children deleted by the link audit.
 *
 * The auditSourceLinks --execute run on 2026-07-26 incorrectly treated same-URL
 * different-title digest children as URL-variant duplicates and deleted them.
 * Child IDs are deterministic (${parent.id}-i1, i2, …) so re-fanning recreates
 * the exact same rows and upserts them back cleanly.
 *
 * Process per parent:
 *   1. Load parent + full_text from DB
 *   2. fanOutDigest (LLM) → extract items, build children with original IDs
 *   3. Upsert children to sources (main_category=null → classify picks them up)
 *   4. Patch parent with is_digest=true (already set, but ensures consistency)
 *
 * After this script: run classify.js then extractEvidence.js to fully restore.
 *
 * LLM: Gemini Flash (set LLM_PROVIDER_ORDER=gemini, never Anthropic).
 *
 * Usage:
 *   node scripts/refanDigestParents.js              # all parents missing children
 *   node scripts/refanDigestParents.js --dry-run    # show what would be created
 *   node scripts/refanDigestParents.js --id <id>    # single parent (debug)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { callLLM }       from "../lib/llm/callLLM.js";
import { fanOutDigest }  from "../lib/pipeline/ingest/digestFanout.js";

// Force Gemini for all LLM calls — never Anthropic.
process.env.LLM_PROVIDER_ORDER = "gemini";

const DRY     = process.argv.includes("--dry-run");
const SINGLE  = (() => { const i = process.argv.indexOf("--id"); return i >= 0 ? process.argv[i+1] : null; })();
const ALL     = process.argv.includes("--all");  // include partial parents too
const DELAY   = 2000;   // ms between parents (Gemini rate-limit headroom)

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const llmFn = (sys, usr, opts) => callLLM(sys, usr, opts);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log(`\n${"═".repeat(64)}`);
console.log(`  Digest parent re-fan${DRY ? " [DRY RUN]" : ""}`);
console.log(`  LLM: Gemini Flash (LLM_PROVIDER_ORDER=gemini)`);
console.log(`${"═".repeat(64)}\n`);

// ── 1. Load all digest parents ────────────────────────────────────────────────
const { data: allParents, error: pErr } = await sb.from("sources")
  .select("id,title,url,publisher,source_type,trust_tier,full_text,clean_text,summary,date_published,date_confidence,intelligence,validation_status,layer3_status,is_digest,source_origin")
  .eq("is_digest", true)
  .neq("validation_status", "reject");

if (pErr) { console.error("Failed to load parents:", pErr.message); process.exit(1); }

// ── 2. Filter to parents that are missing children (or forced via --id) ───────
const parents = SINGLE
  ? allParents.filter(p => p.id === SINGLE)
  : ALL
    ? allParents   // --all: re-fan every digest parent (safe — upsert won't hurt existing children)
    : await (async () => {
        const { data: children } = await sb.from("sources")
          .select("parent_source_id")
          .in("parent_source_id", allParents.map(p => p.id));
        const hasChildren = new Set((children||[]).map(c => c.parent_source_id));
        return allParents.filter(p => !hasChildren.has(p.id));
      })();

if (!parents.length) {
  console.log("No orphaned digest parents found — nothing to recover.");
  process.exit(0);
}

console.log(`Found ${parents.length} parent(s) missing children:\n`);
parents.forEach(p => console.log(
  " ", (p.date_published||"????-??-??").slice(0,10),
  (p.publisher||"").slice(0,22).padEnd(22),
  (p.title||"").slice(0,55)
));
console.log();

// ── 3. Re-fan each parent ────────────────────────────────────────────────────
const scoredAt = new Date().toISOString();
const summary  = { processed: 0, children_created: 0, failed: 0 };

for (const parent of parents) {
  const label = `${parent.publisher?.slice(0,20)} — ${parent.title?.slice(0,45)}`;
  console.log(`\n── ${label}`);
  console.log(`   id: ${parent.id}`);
  console.log(`   url: ${parent.url?.slice(0,70)}`);

  const textLen = (parent.full_text || parent.clean_text || parent.summary || "").length;
  console.log(`   text: ${textLen} chars`);

  if (textLen < 200) {
    console.warn(`   ⚠ text too short (${textLen} chars) — skipping (refetch full_text manually if needed)`);
    summary.failed++;
    continue;
  }

  try {
    const { is_digest, children, reason } = await fanOutDigest(parent, { llmFn, scoredAt });

    if (!is_digest || !children.length) {
      console.warn(`   ⚠ fanout returned is_digest=${is_digest}, ${children.length} children (reason: ${reason})`);
      summary.failed++;
      continue;
    }

    console.log(`   → ${children.length} children extracted:`);
    children.forEach((c, i) => {
      const cat = (c.main_category || "unclassified").replace("_threats","").padEnd(12);
      console.log(`     [${i+1}] ${c.id} | ${cat} | ${(c.title||"").slice(0,55)}`);
    });

    if (!DRY) {
      const { error: upErr } = await sb.from("sources")
        .upsert(children, { onConflict: "id", ignoreDuplicates: false });

      if (upErr) {
        console.error(`   ✗ upsert failed: ${upErr.message}`);
        summary.failed++;
        continue;
      }

      // Ensure parent is correctly flagged
      await sb.from("sources").update({
        is_digest:         true,
        validation_status: parent.validation_status || "pass",
      }).eq("id", parent.id);

      console.log(`   ✓ ${children.length} children upserted to DB`);
    } else {
      console.log(`   [dry-run] would upsert ${children.length} children`);
    }

    summary.processed++;
    summary.children_created += children.length;
  } catch (err) {
    console.error(`   ✗ fanout error: ${err.message}`);
    summary.failed++;
  }

  if (parents.indexOf(parent) < parents.length - 1) await sleep(DELAY);
}

// ── 4. Summary ─────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(64)}`);
console.log(`  Re-fan complete${DRY ? " [DRY RUN — no changes written]" : ""}`);
console.log(`  Parents processed: ${summary.processed} / ${parents.length}`);
console.log(`  Children ${DRY ? "would be created" : "upserted"}: ${summary.children_created}`);
console.log(`  Failed: ${summary.failed}`);
if (!DRY && summary.children_created > 0) {
  console.log(`\n  Next steps:`);
  console.log(`    1. node scripts/classify.js --limit 200       # classify the children`);
  console.log(`    2. node scripts/extractEvidence.js --limit 150 --since-hours 2  # extract evidence`);
}
console.log(`${"═".repeat(64)}\n`);
