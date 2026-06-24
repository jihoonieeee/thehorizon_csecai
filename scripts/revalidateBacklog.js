#!/usr/bin/env node
/**
 * revalidateBacklog.js — Re-run Layer 3 validation on the operational backlog.
 *
 * Recovers operational evidence that was rejected or held in `review`/`null` under
 * the old AI-relevance gate, by re-validating it under the current gate (which
 * includes the P1 "operational_ai_nexus_pass" calibration — see
 * docs/VALIDATION_CALIBRATION_AUDIT.md). Strictly a recovery tool: it only loads
 * sources that are NOT already `pass`, and only ever writes the fresh gate result.
 *
 * Default backlog = (validation_status IN review/null) AND trust_tier IN
 * (primary,high) AND operational source_type AND full_text >= 300 chars.
 *
 * Usage:
 *   node scripts/revalidateBacklog.js --dry-run            # preview, no writes
 *   node scripts/revalidateBacklog.js --limit 50
 *   node scripts/revalidateBacklog.js --include-medium     # also medium trust
 *   node scripts/revalidateBacklog.js --concurrency 4
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { validateAndTypeSource } from "../lib/pipeline/validation/validateAndTypeSource.js";

const args        = process.argv.slice(2);
const getArg      = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const hasFlag     = (f) => args.includes(f);
const DRY         = hasFlag("--dry-run");
const LIMIT       = parseInt(getArg("--limit", "9999"), 10);
const CONCURRENCY = parseInt(getArg("--concurrency", "4"), 10);
const TIERS       = hasFlag("--include-medium") ? ["primary", "high", "medium"] : ["primary", "high"];

const OPERATIONAL_TYPES = [
  "incident", "incident_report", "threat_intelligence", "threat_intel",
  "threat_intelligence_report", "vulnerability", "exploit_disclosure",
  "adversary_adoption_signal", "governance_signal", "government_advisory",
  "vendor_report", "security_blog", "news_article", "news",
];

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

console.log("════════════════════════════════════════════════════════════");
console.log("  Operational Backlog Re-validation" + (DRY ? "  [DRY RUN]" : ""));
console.log(`  Trust: ${TIERS.join(",")}  Limit: ${LIMIT}  Concurrency: ${CONCURRENCY}`);
console.log("════════════════════════════════════════════════════════════\n");

// Load backlog: not-yet-pass, high/primary trust, operational type.
let all = [], from = 0; const page = 1000;
while (true) {
  // Select * — validateAndTypeSource needs the full row (url, content_hash,
  // publisher_class, etc.); a column subset makes checkSourceValidity hard-fail.
  const r = await sb.from("sources")
    .select("*")
    .in("trust_tier", TIERS)
    .in("source_type", OPERATIONAL_TYPES)
    .range(from, from + page - 1);
  if (r.error) { console.error("DB load failed:", r.error.message); process.exit(1); }
  if (!r.data.length) break;
  all = all.concat(r.data);
  if (r.data.length < page) break;
  from += page;
}

const backlog = all
  .filter((s) => s.validation_status !== "pass")  // review + null + reject (re-test all non-pass)
  .filter((s) => (s.full_text || "").length >= 300)
  .slice(0, LIMIT);

console.log(`Backlog to re-validate: ${backlog.length} sources (review/null, operational, ${TIERS.join("/")} trust)\n`);
if (backlog.length === 0) { console.log("Nothing to do."); process.exit(0); }

const transitions = { to_pass: 0, to_review: 0, to_reject: 0, unchanged: 0, errored: 0 };
const recovered = [];

async function processOne(s) {
  try {
    const before = s.validation_status || "null";
    const result = await validateAndTypeSource(s, { runQa: true });
    const after = result.validation_status;
    if (after === "pass" && before !== "pass") {
      transitions.to_pass++;
      recovered.push({ publisher: s.publisher, source_type: result.source_type || s.source_type, title: s.title });
    } else if (after === "review") transitions.to_review++;
    else if (after === "reject") transitions.to_reject++;
    else transitions.unchanged++;

    if (!DRY) {
      const { error } = await sb.from("sources").update({
        validation_status: result.validation_status,
        layer3_status:     result.layer3_status || result.validation_status,
        downstream_route:  result.downstream_route,
        source_type:       result.source_type || s.source_type,
        ai_specificity_score: result.ai_specificity_score ?? null,
        relevance_tier:    result.relevance_tier ?? null,
        ai_threat_focus:   result.ai_threat_focus ?? null,
      }).eq("id", s.id);
      if (error) console.log(`  ! update failed ${s.id}: ${error.message}`);
    }
    process.stdout.write(`  ${before.padEnd(6)} → ${(after||"?").padEnd(6)}  ${(s.publisher||"").slice(0,22).padEnd(22)} ${(s.title||"").slice(0,48)}\n`);
  } catch (e) {
    transitions.errored++;
    console.log(`  ! error ${s.id}: ${e.message}`);
  }
}

// bounded concurrency
for (let i = 0; i < backlog.length; i += CONCURRENCY) {
  await Promise.all(backlog.slice(i, i + CONCURRENCY).map(processOne));
}

console.log("\n────────────────────────────────────────────────────────────");
console.log(`  Re-validated: ${backlog.length}`);
console.log(`  → pass (RECOVERED): ${transitions.to_pass}`);
console.log(`  → review: ${transitions.to_review}   → reject: ${transitions.to_reject}   errored: ${transitions.errored}`);
console.log(`  Recovery rate: ${(transitions.to_pass / backlog.length * 100).toFixed(1)}%${DRY ? "  (DRY RUN — no writes)" : ""}`);
if (recovered.length) {
  console.log("\n  Recovered (now pass):");
  for (const r of recovered.slice(0, 25)) console.log(`    [${r.source_type}] ${r.publisher} — ${(r.title||"").slice(0,52)}`);
}

const { flushCostBuffer } = await import("../lib/llm/usagePersistence.js").catch(() => ({}));
if (flushCostBuffer) await flushCostBuffer().catch(() => {});
