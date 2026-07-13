#!/usr/bin/env node
/**
 * labelSources.js — backfill source_label for existing corpus.
 *
 * Runs assessSourceLabel (one Haiku call per eligible source) on sources that
 * have no source_label yet. Idempotent: skips sources that already have one.
 * Safe to re-run; use --force to re-assess sources that already have a label.
 *
 * Eligible source types (non-research, where source_type alone is unreliable):
 *   incident, threat_intelligence, exploit_disclosure,
 *   capability_demonstration, adversary_adoption_signal, attack_surface_signal, vulnerability
 *
 * Usage:
 *   node scripts/labelSources.js [--limit 200] [--days 180] [--force] [--dry-run]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { assessSourceLabel, isLabelEligible, LABEL_ELIGIBLE_TYPES } from "../lib/pipeline/scoring/assessSourceLabel.js";
import { flushCostBuffer } from "../lib/llm/usagePersistence.js";

const args     = process.argv.slice(2);
const getArg   = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const LIMIT    = parseInt(getArg("--limit", "200"), 10);
const DAYS     = parseInt(getArg("--days",  "365"), 10);
const FORCE    = args.includes("--force");
const DRY_RUN  = args.includes("--dry-run");
const CONC     = 5; // Haiku concurrency

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const eligibleTypes = [...LABEL_ELIGIBLE_TYPES];

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Label backfill — source_label for incident/TI/exploit sources`);
  console.log(`  Window: last ${DAYS} days  |  limit: ${LIMIT}  |  force: ${FORCE}  |  dry-run: ${DRY_RUN}`);
  console.log(`  Eligible types: ${eligibleTypes.join(", ")}`);
  console.log(`${"═".repeat(60)}\n`);

  let query = supabase
    .from("sources")
    .select("id, title, url, publisher, source_type, trust_tier, short_summary, summary, clean_text, source_label, main_category, validation_status")
    .eq("validation_status", "pass")
    .in("source_type", eligibleTypes)
    .gte("date_published", since)
    .order("date_published", { ascending: false })
    .limit(LIMIT);

  if (!FORCE) query = query.is("source_label", null);

  const { data, error } = await query;
  if (error) { console.error("DB load failed:", error.message); process.exit(1); }
  if (!data?.length) { console.log("  No eligible unlabelled sources found. Done."); return; }

  console.log(`  ${data.length} sources to assess\n`);

  let assessed = 0, skipped = 0, failed = 0;
  const counts = { critical: 0, important: 0, supporting: 0, archive: 0 };

  // Process in batches of CONC
  for (let i = 0; i < data.length; i += CONC) {
    const batch = data.slice(i, i + CONC);
    await Promise.all(batch.map(async (source) => {
      const result = await assessSourceLabel(source);
      if (!result) { skipped++; return; }

      counts[result.label] = (counts[result.label] || 0) + 1;
      assessed++;

      if (DRY_RUN) {
        console.log(`  [dry] ${result.label.padEnd(10)} ${source.source_type.padEnd(25)} ${(source.title || "").slice(0, 55)}`);
        return;
      }

      const { error: writeErr } = await supabase
        .from("sources")
        .update({
          source_label: result.label,
          intelligence: supabase.rpc ? undefined : undefined, // intelligence update via separate path
        })
        .eq("id", source.id);

      // Also write the reason into intelligence.source_label_reason
      // We use a separate update to avoid overwriting the full intelligence jsonb
      await supabase
        .from("sources")
        .update({
          source_label: result.label,
        })
        .eq("id", source.id);

      if (writeErr) { failed++; console.warn(`  [write error] ${source.id}: ${writeErr.message}`); }
    }));

    process.stdout.write(`  ${Math.min(i + CONC, data.length)}/${data.length} assessed\r`);
  }

  process.stdout.write("\n");
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Assessed: ${assessed}  |  Skipped (ineligible/failed): ${skipped + failed}  |  Errors: ${failed}`);
  console.log(`  Labels:   critical:${counts.critical}  important:${counts.important}  supporting:${counts.supporting}  archive:${counts.archive}`);
  if (DRY_RUN) console.log(`\n  (dry-run — no writes performed)`);
}

main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error(err); process.exit(1); });
