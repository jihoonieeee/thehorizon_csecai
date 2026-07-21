#!/usr/bin/env node
/**
 * labelSources.js — backfill reading_value for existing corpus sources.
 *
 * reading_value is set by Layer 3 (layer3.md) at ingest via LLM judgment.
 * This script backfills the field for sources that went through the v2 understand
 * path (understandAllSources) which does not yet set reading_value, by re-running
 * the Layer 3 validation call on them.
 *
 * Idempotent: skips sources that already have reading_value. Use --force to re-assess.
 *
 * Usage:
 *   node scripts/labelSources.js [--limit 200] [--days 180] [--force] [--dry-run]
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { validateAndTypeSource } from "../lib/pipeline/validation/validateAndTypeSource.js";
import { computeImportance }     from "../lib/pipeline/scoring/importance.js";
import { flushCostBuffer } from "../lib/llm/usagePersistence.js";

const OFFENSIVE_CATEGORIES = new Set([
  "traditional_ai_threats", "llm_threats", "agentic_ai_threats", "ai_enabled_threats",
]);

/**
 * Deterministic reading_value for sources that already have main_category set.
 * Re-running L3 on already-classified sources causes false rejections (ATLAS
 * case studies, Jina-fetched references, structured backfill sources). Use this
 * instead of validateAndTypeSource for sources with a confirmed classification.
 */
function deterministicReadingValue(source) {
  const imp = computeImportance(source);
  if (imp.tier === "noise")    return "background";
  if (imp.tier === "realized") return "essential";
  if (imp.tier === "proven")   return source.source_type === "threat_intelligence" ? "essential" : "recommended";
  if (imp.tier === "research") return "analyst";
  return "analyst";
}

const args    = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i+1] ? args[i+1] : d; };
const LIMIT   = parseInt(getArg("--limit", "200"), 10);
const DAYS    = parseInt(getArg("--days",  "365"), 10);
const FORCE   = args.includes("--force");
const DRY_RUN = args.includes("--dry-run");
const CONC    = 4;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  reading_value backfill (LLM)`);
  console.log(`  Window: last ${DAYS} days  |  limit: ${LIMIT}  |  force: ${FORCE}  |  dry-run: ${DRY_RUN}`);
  console.log(`${"═".repeat(60)}\n`);

  let query = supabase
    .from("sources")
    .select("id, title, url, publisher, source_type, trust_tier, full_text, summary, short_summary, date_published, validation_status, reading_value, intelligence")
    .in("validation_status", ["pass", "review"])
    .gte("date_published", since)
    .order("date_published", { ascending: false })
    .limit(LIMIT);

  if (!FORCE) query = query.is("reading_value", null);

  const { data, error } = await query;
  if (error) { console.error("DB load failed:", error.message); process.exit(1); }
  if (!data?.length) { console.log("  No sources missing reading_value. Done."); return; }

  console.log(`  ${data.length} sources to assess\n`);

  let assessed = 0, skipped = 0, failed = 0;
  const counts = { essential: 0, recommended: 0, analyst: 0, background: 0 };

  for (let i = 0; i < data.length; i += CONC) {
    const batch = data.slice(i, i + CONC);
    await Promise.all(batch.map(async (source) => {
      try {
        let rv = null;

        if (source.main_category && OFFENSIVE_CATEGORIES.has(source.main_category)) {
          // Already classified as offensive — derive deterministically to avoid L3
          // re-validation false rejections (ATLAS case studies, backfill references).
          rv = deterministicReadingValue(source);
        } else {
          // Not yet classified or unclear — run full L3 validation to get LLM verdict.
          const result = await validateAndTypeSource(source, { skipUrlCheck: true });
          rv = result.reading_value || null;
        }

        if (!rv) { skipped++; return; }

        counts[rv] = (counts[rv] || 0) + 1;
        assessed++;

        if (DRY_RUN) {
          console.log(`  [dry] ${rv.padEnd(12)} ${(source.source_type || "").padEnd(25)} ${(source.title || "").slice(0, 50)}`);
          return;
        }

        const { error: writeErr } = await supabase
          .from("sources")
          .update({ reading_value: rv })
          .eq("id", source.id);

        if (writeErr) { failed++; console.warn(`  [write error] ${source.id}: ${writeErr.message}`); }
      } catch (err) {
        failed++;
        console.warn(`  [error] ${source.id}: ${err.message}`);
      }
    }));

    process.stdout.write(`  ${Math.min(i + CONC, data.length)}/${data.length} assessed\r`);
  }

  process.stdout.write("\n");
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Assessed: ${assessed}  |  Skipped/no-rv: ${skipped}  |  Errors: ${failed}`);
  console.log(`  Reading values:  essential:${counts.essential}  recommended:${counts.recommended}  analyst:${counts.analyst}  background:${counts.background}`);
  if (DRY_RUN) console.log(`\n  (dry-run — no writes performed)`);
}

main()
  .then(() => flushCostBuffer())
  .catch(err => { console.error(err); process.exit(1); });
