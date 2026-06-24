#!/usr/bin/env node
/**
 * processUnvalidated.js — Run every unprocessed source through Layer 3 validation.
 *
 * "Unprocessed" = validation_status IS NULL or 'pending' — rows that were ingested
 * (typically by RSS/sitemap backfill) but never gated. They are invisible to the
 * deck/dashboard (which read 'pass') and never enriched. This script validates
 * them under the current gate (incl. the P1 operational AI-nexus pass) and persists
 * the result, so no source is left in limbo.
 *
 * Unlike revalidateBacklog.js (operational types + high/primary trust only), this
 * processes ALL unvalidated rows regardless of source_type or trust tier.
 *
 * Usage:
 *   node scripts/processUnvalidated.js --dry-run
 *   node scripts/processUnvalidated.js --limit 100 --concurrency 4
 *   node scripts/processUnvalidated.js --include-pending   # also status='pending'
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { validateAndTypeSource } from "../lib/pipeline/validation/validateAndTypeSource.js";

const args        = process.argv.slice(2);
const getArg      = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const hasFlag     = (f) => args.includes(f);
const DRY         = hasFlag("--dry-run");
const LIMIT       = parseInt(getArg("--limit", "99999"), 10);
const CONCURRENCY = parseInt(getArg("--concurrency", "4"), 10);
const MIN_TEXT    = parseInt(getArg("--min-text", "0"), 10); // 0 = process everything

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

console.log("════════════════════════════════════════════════════════════");
console.log("  Process Unvalidated Sources" + (DRY ? "  [DRY RUN]" : ""));
console.log(`  Limit: ${LIMIT}  Concurrency: ${CONCURRENCY}  Min text: ${MIN_TEXT}`);
console.log("════════════════════════════════════════════════════════════\n");

// Load all rows whose validation_status is NULL (or 'pending' if requested).
// .is('validation_status', null) catches the never-gated rows.
let all = [], from = 0; const page = 1000;
const statusesPending = hasFlag("--include-pending");
while (true) {
  let q = sb.from("sources").select("*").range(from, from + page - 1);
  q = statusesPending
    ? q.or("validation_status.is.null,validation_status.eq.pending")
    : q.is("validation_status", null);
  const r = await q;
  if (r.error) { console.error("DB load failed:", r.error.message); process.exit(1); }
  if (!r.data.length) break;
  all = all.concat(r.data);
  if (r.data.length < page) break;
  from += page;
}

const queue = all
  .filter((s) => (s.full_text || "").length >= MIN_TEXT)
  .slice(0, LIMIT);

console.log(`Unvalidated rows: ${all.length}  → processing ${queue.length}\n`);
if (queue.length === 0) { console.log("Nothing to do — all sources have a validation_status."); process.exit(0); }

const tally = { pass: 0, review: 0, reject: 0, errored: 0 };

async function processOne(s) {
  try {
    const result = await validateAndTypeSource(s, { runQa: true });
    const status = result.validation_status;
    tally[status] = (tally[status] || 0) + 1;
    if (!DRY) {
      const { error } = await sb.from("sources").update({
        validation_status:    result.validation_status,
        layer3_status:        result.layer3_status || result.validation_status,
        downstream_route:     result.downstream_route,
        source_type:          result.source_type || s.source_type,
        ai_specificity_score: result.ai_specificity_score ?? null,
        relevance_tier:       result.relevance_tier ?? null,
        ai_threat_focus:      result.ai_threat_focus ?? null,
        validation_summary:   result.validation_summary ?? s.validation_summary ?? null,
        main_category:        result.candidate_domain ?? s.main_category ?? null,
      }).eq("id", s.id);
      if (error) console.log(`  ! update failed ${s.id}: ${error.message}`);
    }
    process.stdout.write(`  ${(status || "?").padEnd(6)}  ${(s.publisher || "").slice(0, 22).padEnd(22)} ${(s.title || "").slice(0, 50)}\n`);
  } catch (e) {
    tally.errored++;
    console.log(`  ! error ${s.id}: ${e.message}`);
  }
}

for (let i = 0; i < queue.length; i += CONCURRENCY) {
  await Promise.all(queue.slice(i, i + CONCURRENCY).map(processOne));
}

console.log("\n────────────────────────────────────────────────────────────");
console.log(`  Processed: ${queue.length}`);
console.log(`  → pass: ${tally.pass}   → review: ${tally.review}   → reject: ${tally.reject}   errored: ${tally.errored}${DRY ? "  (DRY RUN — no writes)" : ""}`);

const { flushCostBuffer } = await import("../lib/llm/usagePersistence.js").catch(() => ({}));
if (flushCostBuffer) await flushCostBuffer().catch(() => {});
