#!/usr/bin/env node
/**
 * Re-enrichment script: populate Layer 3 metadata fields that are NULL in the DB
 * for sources that were backfilled before validation-v1.3 ran.
 *
 * Fields populated (deterministic only, no LLM calls):
 *   publisher_class, evidence_role, independence_level, origin_role,
 *   primary_origin_url, source_quality_status, source_quality_reasons,
 *   evidence_potential, source_usefulness_roles, source_route, source_content_status
 *
 * Usage:
 *   node scripts/reenrichSourceMetadata.js [--dry-run] [--limit N] [--batch N]
 *
 * Processes sources in batches to avoid memory issues.
 * Writes results back to Supabase in batches.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { annotateSourceContext } from "../lib/pipeline/validation/trustAssessment.js";
import { inferOriginRole } from "../lib/pipeline/validation/originTracking.js";
import { assessSourceQuality } from "../lib/pipeline/validation/sourceQuality.js";
import { computeEvidencePotential, deriveSourceRoute, classifyContentStatus } from "../lib/pipeline/validation/evidencePotential.js";
import { VALIDATION_VERSION } from "../lib/pipeline/validation/validateAndTypeSource.js";

const args       = process.argv.slice(2);
const DRY_RUN    = args.includes("--dry-run");
const limitIdx   = args.indexOf("--limit");
const batchIdx   = args.indexOf("--batch");
const LIMIT      = limitIdx >= 0 ? (parseInt(args[limitIdx + 1], 10) || 0) : 0;
const BATCH_SIZE = batchIdx >= 0 ? (parseInt(args[batchIdx + 1], 10) || 50) : 50;

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log(`\nRe-enrichment run — validation-v1.3`);
console.log(`Dry run: ${DRY_RUN}  |  Limit: ${LIMIT || "all"}  |  Batch: ${BATCH_SIZE}\n`);

let total = 0, updated = 0, errors = 0;
let offset = 0;

while (true) {
  const query = sb
    .from("sources")
    .select("id,title,url,publisher,source_type,trust_tier,full_text,summary,content_quality,primary_origin_url,origin_role,independence_level,publisher_class,source_quality_status,is_curated")
    .is("publisher_class", null)          // only sources that need enrichment
    .order("date_published", { ascending: false })
    .range(offset, offset + BATCH_SIZE - 1);

  if (LIMIT > 0) query.limit(Math.min(BATCH_SIZE, LIMIT - total));

  const { data: batch, error } = await query;
  if (error) { console.error("DB error:", error.message); break; }
  if (!batch || batch.length === 0) break;

  const updates = [];
  for (const source of batch) {
    try {
      // Run deterministic enrichment (no LLM)
      const trust   = annotateSourceContext(source);
      const origin  = inferOriginRole({ ...source, publisher_class: trust.publisher_class, trust_tier: trust.trust_tier });
      const enriched = {
        ...source,
        publisher_class:   trust.publisher_class,
        evidence_role:     trust.evidence_role,
        independence_level: origin.independence_level !== "unknown" ? origin.independence_level : trust.independence_level,
        origin_role:        origin.origin_role,
        primary_origin_url: origin.primary_origin_url || source.primary_origin_url || null,
        trust_tier:         trust.trust_tier,
      };

      const quality  = assessSourceQuality(enriched);
      const potential = computeEvidencePotential({ ...enriched, source_quality_status: quality.source_quality_status });
      const contentStatus = classifyContentStatus(enriched);

      updates.push({
        id:                       source.id,
        publisher_class:          trust.publisher_class,
        evidence_role:            trust.evidence_role,
        independence_level:       enriched.independence_level,
        origin_role:              origin.origin_role,
        primary_origin_url:       enriched.primary_origin_url,
        source_quality_status:    quality.source_quality_status,
        source_quality_reasons:   quality.source_quality_reasons,
        evidence_potential:       potential.evidence_potential,
        source_usefulness_roles:  potential.source_usefulness_roles,
        source_route:             deriveSourceRoute(potential.evidence_potential, source.validation_status || "pass", source.downstream_route || "layer4"),
        source_content_status:    contentStatus,
        validation_version:       VALIDATION_VERSION,
      });
    } catch (err) {
      console.error(`  Error on ${source.id}: ${err.message}`);
      errors++;
    }
  }

  if (!DRY_RUN && updates.length > 0) {
    const { error: upErr } = await sb.from("sources").upsert(updates, { onConflict: "id" });
    if (upErr) {
      console.error(`  Batch upsert error: ${upErr.message}`);
      errors += updates.length;
    } else {
      updated += updates.length;
    }
  } else if (DRY_RUN) {
    const sample = updates[0];
    if (sample) {
      console.log(`  [dry] sample: ${sample.id} → publisher_class=${sample.publisher_class} evidence_potential=${sample.evidence_potential} source_route=${sample.source_route}`);
    }
    updated += updates.length;
  }

  total += batch.length;
  process.stdout.write(`  Processed: ${total} | Updated: ${updated} | Errors: ${errors}\r`);

  if (LIMIT > 0 && total >= LIMIT) break;
  if (batch.length < BATCH_SIZE) break;
  offset += BATCH_SIZE;
}

console.log(`\n\nDone. Total: ${total} | Updated: ${updated} | Errors: ${errors}`);
console.log(DRY_RUN ? "(dry run — no DB writes)" : "");
